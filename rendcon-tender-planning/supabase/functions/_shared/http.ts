// HTTP helpers shared by the edge functions: CORS, JSON responses, constant-time
// secret comparison and the cron-or-member authorisation check.
import type { Person, SupabaseLike } from './types.ts';

export function allowedOrigins(env: Record<string, string | undefined>): string[] {
  const raw = [env.APP_URL ?? '', ...(env.ALLOWED_ORIGINS ?? '').split(',')];
  const out: string[] = [];
  for (const value of raw) {
    const origin = value.trim().replace(/\/+$/, '');
    if (origin !== '' && !out.includes(origin)) out.push(origin);
  }
  return out;
}

export function corsHeaders(origin: string | null, allowed: string[]): Record<string, string> {
  const allowOrigin = origin !== null && allowed.includes(origin) ? origin : (allowed[0] ?? '');
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  const length = Math.max(x.length, y.length);
  // Length difference is folded into the result instead of returning early.
  let diff = x.length ^ y.length;
  for (let i = 0; i < length; i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}

export type AuthDeps = {
  cronSecret: string;
  getUserEmail(jwt: string): Promise<string | null>;
  findPersonByEmail(email: string): Promise<Person | null>;
};

export type AuthResult = { kind: 'cron' } | { kind: 'user'; person: Person } | { kind: 'denied'; status: 401 | 403 };

export async function authorize(
  req: Request,
  deps: AuthDeps,
  allow: { cron: boolean; user: boolean },
): Promise<AuthResult> {
  const secret = req.headers.get('x-cron-secret');
  if (allow.cron && secret !== null) {
    // A presented cron secret is decisive: never fall through to user auth.
    if (deps.cronSecret !== '' && timingSafeEqual(secret, deps.cronSecret)) return { kind: 'cron' };
    return { kind: 'denied', status: 401 };
  }
  if (!allow.user) return { kind: 'denied', status: 401 };
  const header = (req.headers.get('authorization') ?? '').trim();
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return { kind: 'denied', status: 401 };
  const email = await deps.getUserEmail(match[1].trim());
  if (!email) return { kind: 'denied', status: 401 };
  const person = await deps.findPersonByEmail(email);
  if (!person || !person.active) return { kind: 'denied', status: 403 };
  return { kind: 'user', person };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => '\\' + ch);
}

export async function findPersonByEmail(client: SupabaseLike, email: string): Promise<Person | null> {
  const wanted = email.trim().toLowerCase();
  if (wanted === '') return null;
  const { data, error } = await client
    .from('people')
    .select('id, name, email, role, active, prefs')
    .eq('active', true)
    .ilike('email', escapeLike(wanted))
    .limit(5);
  if (error) throw new Error(error.message);
  const rows: any[] = Array.isArray(data) ? data : [];
  const row = rows.find((r) => typeof r.email === 'string' && r.email.toLowerCase() === wanted);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    active: row.active === true,
    prefs: {
      push: row.prefs?.push ?? true,
      email: row.prefs?.email ?? true,
    },
  };
}
