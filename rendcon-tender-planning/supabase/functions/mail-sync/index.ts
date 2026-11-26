// mail-sync: pg_cron (x-cron-secret) or a planning team member (Bearer JWT) runs one
// mail sync. Thin wiring only; all logic lives in ../_shared.
import { createClient } from 'npm:@supabase/supabase-js@2.119.2';
import type { HttpRequest, HttpResponse } from '../_shared/types.ts';
import { allowedOrigins, authorize, corsHeaders, findPersonByEmail, json } from '../_shared/http.ts';
import { composioConfigFromEnv, createComposioMailClient } from '../_shared/composio.ts';
import { applyForm } from '../_shared/applier.ts';
import { runMailSync } from '../_shared/mail_sync.ts';
import { createSupabaseMailRepository } from '../_shared/mail_repo_supabase.ts';
import { normalizerFor } from '../_shared/mail_normalize.ts';
import { prefilter } from '../_shared/prefilter.ts';
import { buildShortlist } from '../_shared/shortlist.ts';
import { validateForm } from '../_shared/validator.ts';
import { aiOptionsFromEnv, createGeminiClient, understandEmail } from '../_shared/ai_client.ts';

async function fetchTransport(r: HttpRequest): Promise<HttpResponse> {
  const res = await fetch(r.url, { method: r.method, headers: r.headers, body: r.body });
  return { status: res.status, json: await res.json().catch(() => null) };
}

Deno.serve(async (req) => {
  const env = Deno.env.toObject();
  const cors = corsHeaders(req.headers.get('origin'), allowedOrigins(env));
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' }, cors);

  try {
    const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const auth = await authorize(req, {
      cronSecret: env.CRON_SECRET ?? '',
      getUserEmail: async (jwt) => (await db.auth.getUser(jwt)).data.user?.email ?? null,
      findPersonByEmail: (email) => findPersonByEmail(db, email),
    }, { cron: true, user: true });
    if (auth.kind === 'denied') return json(auth.status, { error: auth.status === 401 ? 'unauthorized' : 'forbidden' }, cors);

    // short timeout and no retries: the whole run must finish inside the function's time limit
    const gemini = createGeminiClient(env.GEMINI_API_KEY, fetch, 35_000);
    const composio = composioConfigFromEnv(env);
    const mail = createComposioMailClient(composio, fetchTransport);
    const aiOptions = aiOptionsFromEnv(env);
    const timeZone = env.APP_TIMEZONE || 'Africa/Cairo';

    const summary = await runMailSync({
      repo: createSupabaseMailRepository(db),
      mail,
      ai: (input) => understandEmail(gemini, input, aiOptions),
      normalize: normalizerFor(composio.provider),
      prefilter,
      shortlist: (m, p, c) => buildShortlist(m, p, c),
      validate: validateForm,
      apply: applyForm,
      now: () => new Date(),
      timeZone,
      config: {
        lookbackHours: Number(env.MAIL_LOOKBACK_HOURS) || 48,
        maxPerRun: Number(env.MAIL_MAX_PER_RUN) || 60,
        overlapMinutes: 30,
        maxAttempts: 3,
        timeBudgetMs: Number(env.MAIL_TIME_BUDGET_MS) || 110000,
      },
      log: (msg, data) => console.log(msg, data ?? ''),
    }, auth.kind === 'cron' ? 'cron' : 'manual');

    return json(200, summary, cors);
  } catch (err) {
    console.error('mail-sync failed', err);
    return json(500, { error: 'internal' }, cors);
  }
});
