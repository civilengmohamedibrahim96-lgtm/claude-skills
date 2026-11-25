// mail-review: a planning team member resolves one "Needs review" item
// (assign to a project, create a new project, or dismiss).
import { createClient } from 'npm:@supabase/supabase-js@2.119.2';
import type { ReviewResolution } from '../_shared/types.ts';
import { allowedOrigins, authorize, corsHeaders, findPersonByEmail, json } from '../_shared/http.ts';
import { applyForm } from '../_shared/applier.ts';
import { createSupabaseMailRepository } from '../_shared/mail_repo_supabase.ts';
import { resolveReview } from '../_shared/review.ts';

Deno.serve(async (req) => {
  const env = Deno.env.toObject();
  const cors = corsHeaders(req.headers.get('origin'), allowedOrigins(env));
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' }, cors);

  try {
    const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const auth = await authorize(req, {
      cronSecret: '',
      getUserEmail: async (jwt) => (await db.auth.getUser(jwt)).data.user?.email ?? null,
      findPersonByEmail: (email) => findPersonByEmail(db, email),
    }, { cron: false, user: true });
    if (auth.kind !== 'user') {
      const status = auth.kind === 'denied' ? auth.status : 401;
      return json(status, { error: status === 401 ? 'unauthorized' : 'forbidden' }, cors);
    }

    let body: any;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: 'bad_request' }, cors);
    }
    const reviewId = typeof body?.reviewId === 'string' ? body.reviewId : '';
    const action = body?.action;
    if (reviewId === '' || (action !== 'assign' && action !== 'new' && action !== 'dismiss')) {
      return json(400, { error: 'bad_request' }, cors);
    }
    if (action === 'assign' && (typeof body.projectId !== 'string' || body.projectId === '')) {
      return json(400, { error: 'bad_request' }, cors);
    }
    const resolution: ReviewResolution = action === 'assign'
      ? { action: 'assign', projectId: body.projectId }
      : action === 'new'
        ? { action: 'new' }
        : { action: 'dismiss' };

    const res = await resolveReview({
      repo: createSupabaseMailRepository(db),
      apply: applyForm,
      now: () => new Date(),
      timeZone: env.APP_TIMEZONE || 'Africa/Cairo',
    }, reviewId, resolution, auth.person.name);

    return json(res.ok ? 200 : 409, res, cors);
  } catch (err) {
    console.error('mail-review failed', err);
    return json(500, { error: 'internal' }, cors);
  }
});
