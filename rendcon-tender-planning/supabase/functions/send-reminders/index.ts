// Thin Deno wrapper: reads env, builds clients and calls runReminders. Not run in tests.
import { createClient } from 'npm:@supabase/supabase-js@2.119.2';
import webpush from 'npm:web-push@3.6.7';
import { allowedOrigins, authorize, corsHeaders, findPersonByEmail, json } from '../_shared/http.ts';
import { composioConfigFromEnv, createComposioMailClient } from '../_shared/composio.ts';
import { createWebPushSender } from '../_shared/push.ts';
import type { WebPushLike } from '../_shared/push.ts';
import { createSupabaseReminderRepository } from '../_shared/reminder_repo_supabase.ts';
import { runReminders } from '../_shared/send_reminders.ts';
import type { HttpRequest, HttpResponse, MailClient, NowReminderInput, ReminderMode } from '../_shared/types.ts';

const fetchTransport = (r: HttpRequest): Promise<HttpResponse> =>
  fetch(r.url, { method: r.method, headers: r.headers, body: r.body }).then(async (res) => ({
    status: res.status,
    json: await res.json().catch(() => null),
  }));

function parseNowInput(body: any): NowReminderInput | null {
  const r = body?.reminder;
  if (!r || typeof r !== 'object') return null;
  if (typeof r.message !== 'string' || r.message.trim() === '') return null;
  if (!Array.isArray(r.recipients) || !r.recipients.every((x: unknown) => typeof x === 'string')) return null;
  if (typeof r.email !== 'boolean') return null;
  if (!(r.projectId === null || typeof r.projectId === 'string')) return null;
  return { projectId: r.projectId, message: r.message.trim(), recipients: r.recipients, email: r.email };
}

Deno.serve(async (req) => {
  const env = Deno.env.toObject();
  const cors = corsHeaders(req.headers.get('origin'), allowedOrigins(env));
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' }, cors);

  try {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: 'bad_request' }, cors);
    }
    const mode = body?.mode;
    if (mode !== 'due' && mode !== 'now' && mode !== 'test') return json(400, { error: 'bad_request' }, cors);
    let nowInput: NowReminderInput | null = null;
    if (mode === 'now') {
      nowInput = parseNowInput(body);
      if (!nowInput) return json(400, { error: 'bad_request' }, cors);
    }

    const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const auth = await authorize(req, {
      cronSecret: env.CRON_SECRET ?? '',
      getUserEmail: async (jwt) => (await db.auth.getUser(jwt)).data.user?.email ?? null,
      findPersonByEmail: (email) => findPersonByEmail(db, email),
    }, { cron: mode === 'due', user: mode !== 'due' });
    if (auth.kind === 'denied') return json(auth.status, { error: auth.status === 401 ? 'unauthorized' : 'forbidden' }, cors);

    let runMode: ReminderMode;
    if (mode === 'due') {
      runMode = { kind: 'due' };
    } else if (auth.kind !== 'user') {
      return json(401, { error: 'unauthorized' }, cors);
    } else if (mode === 'now') {
      runMode = { kind: 'now', reminder: nowInput as NowReminderInput, requestedBy: auth.person };
    } else {
      runMode = { kind: 'test', person: auth.person };
    }

    const push = env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT
      ? createWebPushSender(webpush as unknown as WebPushLike, {
        subject: env.VAPID_SUBJECT,
        publicKey: env.VAPID_PUBLIC_KEY,
        privateKey: env.VAPID_PRIVATE_KEY,
      })
      : null;

    // The app never sends email unless MAIL_SEND_ENABLED=true (reminders go by push only).
    let mail: MailClient | null = null;
    if ((env.MAIL_SEND_ENABLED ?? '').trim().toLowerCase() === 'true') {
      try {
        mail = createComposioMailClient(composioConfigFromEnv(env), fetchTransport);
      } catch {
        mail = null;
      }
    }

    const summary = await runReminders({
      repo: createSupabaseReminderRepository(db),
      push,
      mail,
      now: () => new Date(),
      timeZone: env.APP_TIMEZONE || 'Africa/Cairo',
      appUrl: env.APP_URL ?? '',
      log: (msg, data) => console.log(msg, data ?? ''),
    }, runMode);
    return json(200, summary, cors);
  } catch (err) {
    console.error('send-reminders failed', err);
    return json(500, { error: 'internal' }, cors);
  }
});
