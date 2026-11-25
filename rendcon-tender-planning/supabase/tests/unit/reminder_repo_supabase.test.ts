import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseReminderRepository } from '../../functions/_shared/reminder_repo_supabase.ts';
import type { SupabaseLike } from '../../functions/_shared/types.ts';

type Op = { table: string; method: string; args: unknown[] };

// Fake supabase-js: every query builder records its chain and resolves to respond(chain).
function fakeClient(respond: (ops: Op[]) => { data?: unknown; error?: { code?: string; message: string } | null }) {
  const chains: Op[][] = [];
  const client: SupabaseLike = {
    from(table: string) {
      const ops: Op[] = [{ table, method: 'from', args: [table] }];
      const b: any = {};
      for (const m of ['select', 'update', 'insert', 'delete', 'eq', 'in', 'gte', 'lte', 'not', 'order']) {
        b[m] = (...args: unknown[]) => {
          ops.push({ table, method: m, args });
          return b;
        };
      }
      b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
        chains.push(ops);
        return Promise.resolve({ error: null, ...respond(ops) }).then(resolve, reject);
      };
      return b;
    },
    rpc() {
      throw new Error('rpc not used by the reminder repository');
    },
  };
  return { client, chains };
}

const methods = (ops: Op[]) => ops.map((o) => o.method);

test('claimReminder chains a conditional update and is true only for exactly one row', async () => {
  const { client, chains } = fakeClient(() => ({ data: [{ id: 'r1' }] }));
  const repo = createSupabaseReminderRepository(client);
  assert.equal(await repo.claimReminder('r1', '2026-11-25T08:00:00.000Z', { fired: true }), true);
  const ops = chains[0];
  assert.deepEqual(methods(ops), ['from', 'update', 'eq', 'eq', 'eq', 'select']);
  assert.deepEqual(ops[1].args, [{ fired: true }]);
  assert.deepEqual(ops[2].args, ['id', 'r1']);
  assert.deepEqual(ops[3].args, ['fired', false]);
  assert.deepEqual(ops[4].args, ['at', '2026-11-25T08:00:00.000Z']);
  assert.deepEqual(ops[5].args, ['id']);
});

test('claimReminder with a next time updates at, and is false for zero rows', async () => {
  const { client, chains } = fakeClient(() => ({ data: [] }));
  const repo = createSupabaseReminderRepository(client);
  assert.equal(await repo.claimReminder('r1', '2026-11-25T08:00:00.000Z', { at: '2026-11-26T08:00:00.000Z' }), false);
  assert.deepEqual(chains[0][1].args, [{ at: '2026-11-26T08:00:00.000Z' }]);
});

test('claimReminder throws on a database error', async () => {
  const { client } = fakeClient(() => ({ data: null, error: { message: 'boom' } }));
  const repo = createSupabaseReminderRepository(client);
  await assert.rejects(repo.claimReminder('r1', 'x', { fired: true }), /boom/);
});

test('claimAuto returns null on unique violation 23505 and the id otherwise', async () => {
  const dup = fakeClient(() => ({ data: null, error: { code: '23505', message: 'duplicate key' } }));
  const repoDup = createSupabaseReminderRepository(dup.client);
  const a = { projectId: 'p2', kind: 'due3' as const, dueOn: '2026-11-28', fireAt: '2026-11-25T07:00:00.000Z', message: 'Submission in 3 days: X' };
  assert.equal(await repoDup.claimAuto(a), null);

  const ok = fakeClient(() => ({ data: [{ id: 'd1' }] }));
  const repoOk = createSupabaseReminderRepository(ok.client);
  assert.equal(await repoOk.claimAuto(a), 'd1');
  const ops = ok.chains[0];
  assert.deepEqual(methods(ops), ['from', 'insert', 'select']);
  assert.equal(ops[0].args[0], 'reminder_deliveries');
  assert.deepEqual(ops[1].args[0], { project_id: 'p2', auto_kind: 'due3', due_on: '2026-11-28', message: 'Submission in 3 days: X' });
});

test('listAutoKeys builds projectId|kind|dueOn keys from reminder_deliveries', async () => {
  const { client, chains } = fakeClient(() => ({
    data: [{ project_id: 'p2', auto_kind: 'due1', due_on: '2026-11-28' }],
  }));
  const repo = createSupabaseReminderRepository(client);
  const keys = await repo.listAutoKeys('2026-11-25');
  assert.deepEqual([...keys], ['p2|due1|2026-11-28']);
  const ops = chains[0];
  assert.deepEqual(methods(ops), ['from', 'select', 'not', 'gte']);
  assert.deepEqual(ops[2].args, ['auto_kind', 'is', null]);
  assert.deepEqual(ops[3].args, ['due_on', '2026-11-25']);
});

test('listDueReminders maps rows to ReminderRow', async () => {
  const { client, chains } = fakeClient(() => ({
    data: [{ id: 'r1', project_id: null, message: 'Hi', at: '2026-11-25T08:00:00+00:00', repeat: 'weekly', recipients: ['all'], email: false, fired: false, created_by: null }],
  }));
  const repo = createSupabaseReminderRepository(client);
  const rows = await repo.listDueReminders('2026-11-25T08:05:00.000Z');
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    id: 'r1',
    projectId: null,
    message: 'Hi',
    at: '2026-11-25T08:00:00+00:00',
    repeat: 'weekly',
    recipients: ['all'],
    email: false,
    fired: false,
    createdBy: null,
  });
  assert.deepEqual(methods(chains[0]), ['from', 'select', 'eq', 'lte', 'order']);
});

test('listPeople maps prefs with defaults true', async () => {
  const { client } = fakeClient(() => ({
    data: [{ id: 'a', name: 'Amal', email: null, role: 'admin', active: true, prefs: { push: false } }],
  }));
  const repo = createSupabaseReminderRepository(client);
  const people = await repo.listPeople();
  assert.deepEqual(people, [
    { id: 'a', name: 'Amal', email: null, role: 'admin', active: true, prefs: { push: false, email: true } },
  ]);
});

test('listPushSubscriptions returns nothing for no people and does not query', async () => {
  const { client, chains } = fakeClient(() => ({ data: [] }));
  const repo = createSupabaseReminderRepository(client);
  assert.deepEqual(await repo.listPushSubscriptions([]), []);
  assert.equal(chains.length, 0);
});
