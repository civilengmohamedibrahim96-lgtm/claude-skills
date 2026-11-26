import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allowedOrigins,
  authorize,
  corsHeaders,
  findPersonByEmail,
  json,
  timingSafeEqual,
} from '../../functions/_shared/http.ts';
import type { Person } from '../../functions/_shared/types.ts';

const person: Person = {
  id: 'p1',
  name: 'Eng. Ahmed Hassan',
  email: 'ahmed@redcon.example',
  role: 'engineer',
  active: true,
  prefs: { push: true, email: true },
};

function req(headers: Record<string, string>): Request {
  return new Request('https://example.test/functions/v1/mail-sync', { method: 'POST', headers });
}

function deps(overrides: Partial<{ cronSecret: string; jwtEmail: string | null; people: Person[] }> = {}) {
  const jwtEmail = overrides.jwtEmail === undefined ? 'ahmed@redcon.example' : overrides.jwtEmail;
  const people = overrides.people ?? [person];
  return {
    cronSecret: overrides.cronSecret ?? 'cron-secret-123',
    getUserEmail: async (_jwt: string) => jwtEmail,
    findPersonByEmail: async (email: string) => people.find((p) => p.email === email) ?? null,
  };
}

describe('timingSafeEqual', () => {
  test('true for equal strings, false for different strings', () => {
    assert.equal(timingSafeEqual('abc', 'abc'), true);
    assert.equal(timingSafeEqual('abc', 'abd'), false);
  });

  test('false for different lengths, including prefixes', () => {
    assert.equal(timingSafeEqual('abc', 'abcd'), false);
    assert.equal(timingSafeEqual('abcd', 'abc'), false);
    assert.equal(timingSafeEqual('', 'a'), false);
  });

  test('compares UTF-8 bytes', () => {
    assert.equal(timingSafeEqual('مرحبا', 'مرحبا'), true);
    assert.equal(timingSafeEqual('مرحبا', 'مرحباً'), false);
  });
});

describe('corsHeaders and allowedOrigins', () => {
  test('allowedOrigins merges APP_URL and ALLOWED_ORIGINS without trailing slashes', () => {
    const list = allowedOrigins({
      APP_URL: 'https://rendcon-planning.pages.dev/',
      ALLOWED_ORIGINS: ' http://localhost:5173 , https://rendcon-planning.pages.dev ,',
    });
    assert.deepEqual(list, ['https://rendcon-planning.pages.dev', 'http://localhost:5173']);
  });

  test('echoes an allowed origin', () => {
    const h = corsHeaders('http://localhost:5173', ['https://app.example', 'http://localhost:5173']);
    assert.equal(h['Access-Control-Allow-Origin'], 'http://localhost:5173');
    assert.equal(h.Vary, 'Origin');
    assert.equal(h['Access-Control-Allow-Methods'], 'POST, OPTIONS');
    assert.equal(h['Access-Control-Allow-Headers'], 'authorization, x-client-info, apikey, content-type');
  });

  test('falls back to the first allowed origin for anything else', () => {
    const allowed = ['https://app.example', 'http://localhost:5173'];
    assert.equal(corsHeaders('https://evil.example', allowed)['Access-Control-Allow-Origin'], 'https://app.example');
    assert.equal(corsHeaders(null, allowed)['Access-Control-Allow-Origin'], 'https://app.example');
  });
});

describe('json', () => {
  test('returns JSON with status and headers', async () => {
    const res = json(409, { ok: false, error: 'x' }, { 'Access-Control-Allow-Origin': 'https://app.example' });
    assert.equal(res.status, 409);
    assert.equal(res.headers.get('content-type'), 'application/json');
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://app.example');
    assert.deepEqual(await res.json(), { ok: false, error: 'x' });
  });
});

describe('authorize', () => {
  test('correct cron secret → cron', async () => {
    const r = await authorize(req({ 'x-cron-secret': 'cron-secret-123' }), deps(), { cron: true, user: true });
    assert.deepEqual(r, { kind: 'cron' });
  });

  test('wrong cron secret → 401 even when a valid Bearer is also sent', async () => {
    const r = await authorize(
      req({ 'x-cron-secret': 'wrong', authorization: 'Bearer good-jwt' }),
      deps(),
      { cron: true, user: true },
    );
    assert.deepEqual(r, { kind: 'denied', status: 401 });
  });

  test('empty configured secret never matches', async () => {
    const r = await authorize(req({ 'x-cron-secret': '' }), deps({ cronSecret: '' }), { cron: true, user: false });
    assert.deepEqual(r, { kind: 'denied', status: 401 });
  });

  test('Bearer with an unknown email → 403', async () => {
    const r = await authorize(
      req({ authorization: 'Bearer jwt' }),
      deps({ jwtEmail: 'stranger@elsewhere.example' }),
      { cron: true, user: true },
    );
    assert.deepEqual(r, { kind: 'denied', status: 403 });
  });

  test('Bearer with an inactive person → 403', async () => {
    const r = await authorize(
      req({ authorization: 'Bearer jwt' }),
      deps({ people: [{ ...person, active: false }] }),
      { cron: false, user: true },
    );
    assert.deepEqual(r, { kind: 'denied', status: 403 });
  });

  test('valid Bearer for a member → user', async () => {
    const r = await authorize(req({ authorization: 'Bearer jwt' }), deps(), { cron: false, user: true });
    assert.deepEqual(r, { kind: 'user', person });
  });

  test('no headers → 401', async () => {
    const r = await authorize(req({}), deps(), { cron: true, user: true });
    assert.deepEqual(r, { kind: 'denied', status: 401 });
  });

  test('rejected JWT (no email) → 401', async () => {
    const r = await authorize(req({ authorization: 'Bearer jwt' }), deps({ jwtEmail: null }), { cron: true, user: true });
    assert.deepEqual(r, { kind: 'denied', status: 401 });
  });

  test('allow.cron false ignores the secret header and checks the Bearer', async () => {
    const onlySecret = await authorize(req({ 'x-cron-secret': 'cron-secret-123' }), deps(), { cron: false, user: true });
    assert.deepEqual(onlySecret, { kind: 'denied', status: 401 });
    const withBearer = await authorize(
      req({ 'x-cron-secret': 'cron-secret-123', authorization: 'Bearer jwt' }),
      deps(),
      { cron: false, user: true },
    );
    assert.deepEqual(withBearer, { kind: 'user', person });
  });

  test('allow.user false refuses a Bearer', async () => {
    const r = await authorize(req({ authorization: 'Bearer jwt' }), deps(), { cron: true, user: false });
    assert.deepEqual(r, { kind: 'denied', status: 401 });
  });
});

describe('findPersonByEmail', () => {
  test('matches case-insensitively among active people', async () => {
    const calls: { method: string; args: unknown[] }[] = [];
    const client = {
      from(_table: string) {
        const b: any = {};
        for (const m of ['select', 'eq', 'ilike', 'limit']) {
          b[m] = (...args: unknown[]) => {
            calls.push({ method: m, args });
            return b;
          };
        }
        b.then = (resolve: (v: unknown) => void) =>
          resolve({
            data: [{ id: 'p1', name: 'Eng. Ahmed Hassan', email: 'Ahmed@Redcon.example', role: 'engineer', active: true, prefs: { push: false, email: true } }],
            error: null,
          });
        return b;
      },
      rpc() {
        throw new Error('unused');
      },
    };
    const found = await findPersonByEmail(client, 'AHMED@redcon.example');
    assert.deepEqual(found, {
      id: 'p1',
      name: 'Eng. Ahmed Hassan',
      email: 'Ahmed@Redcon.example',
      role: 'engineer',
      active: true,
      prefs: { push: false, email: true },
    });
    assert.deepEqual(calls.find((c) => c.method === 'eq'), { method: 'eq', args: ['active', true] });
    assert.deepEqual(calls.find((c) => c.method === 'ilike'), { method: 'ilike', args: ['email', 'ahmed@redcon.example'] });
  });

  test('database error is thrown', async () => {
    const client = {
      from() {
        const b: any = {};
        for (const m of ['select', 'eq', 'ilike', 'limit']) b[m] = () => b;
        b.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: { message: 'down' } });
        return b;
      },
      rpc() {
        throw new Error('unused');
      },
    };
    await assert.rejects(() => findPersonByEmail(client, 'a@b.example'), /down/);
  });
});
