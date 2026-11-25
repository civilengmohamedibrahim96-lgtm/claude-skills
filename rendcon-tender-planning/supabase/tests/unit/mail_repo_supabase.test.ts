import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseMailRepository } from '../../functions/_shared/mail_repo_supabase.ts';
import type { ProcessedRecord, SupabaseLike } from '../../functions/_shared/types.ts';

type Call = {
  kind: 'from' | 'rpc';
  table?: string;
  fn?: string;
  args?: unknown[];
  ops: { method: string; args: unknown[] }[];
};

type Prepared = { data?: unknown; error?: { message: string } | null };

// Records every chain and resolves each one with respond(call).
function fakeClient(respond: (call: Call) => Prepared = () => ({ data: null, error: null })) {
  const calls: Call[] = [];
  const makeBuilder = (head: Omit<Call, 'ops'>) => {
    const ops: Call['ops'] = [];
    const call: Call = { ...head, ops };
    const builder: any = {};
    for (const method of [
      'select', 'insert', 'upsert', 'update', 'eq', 'in', 'order', 'limit',
      'single', 'maybeSingle', 'ilike', 'neq', 'gte', 'lte',
    ]) {
      builder[method] = (...args: unknown[]) => {
        ops.push({ method, args });
        return builder;
      };
    }
    builder.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
      calls.push(call);
      try {
        resolve(respond(call));
      } catch (e) {
        reject(e);
      }
    };
    return builder;
  };
  const client: SupabaseLike = {
    from(table: string) {
      return makeBuilder({ kind: 'from', table });
    },
    rpc(fn: string, args?: Record<string, unknown>) {
      return makeBuilder({ kind: 'rpc', fn, args: args ? [args] : [] });
    },
  };
  return { client, calls };
}

function opsOf(call: Call | undefined, method: string): unknown[][] {
  return (call?.ops ?? []).filter((o) => o.method === method).map((o) => o.args);
}

describe('createSupabaseMailRepository', () => {
  test('createProject inserts the snake_case row then its tags', async () => {
    const { client, calls } = fakeClient((call) =>
      call.table === 'projects' ? { data: { id: 'proj-uuid-1' }, error: null } : { data: null, error: null });
    const repo = createSupabaseMailRepository(client);
    const id = await repo.createProject({
      title: 'Admin building',
      client: 'NUCA',
      tenderType: 'public',
      tenderId: 'tender-uuid',
      supervisor: 'شيرين',
      dueOn: '2026-12-20',
      receivedOn: '2026-11-25',
      status: 'Received by email – needs an engineer',
      source: 'email',
      tags: ['new', 'un'],
      updatedBy: 'email',
    });
    assert.equal(id, 'proj-uuid-1');

    const projects = calls.find((c) => c.table === 'projects');
    assert.ok(projects);
    assert.deepEqual(opsOf(projects, 'insert'), [[{
      title: 'Admin building',
      client: 'NUCA',
      tender_type: 'public',
      tender_id: 'tender-uuid',
      supervisor: 'شيرين',
      due_on: '2026-12-20',
      received_on: '2026-11-25',
      status: 'Received by email – needs an engineer',
      source: 'email',
      updated_by: 'email',
    }]]);
    assert.deepEqual(opsOf(projects, 'select'), [['id']]);

    const tags = calls.find((c) => c.table === 'project_tags');
    assert.ok(tags);
    assert.deepEqual(opsOf(tags, 'insert'), [[
      [{ project_id: 'proj-uuid-1', tag_id: 'new' }, { project_id: 'proj-uuid-1', tag_id: 'un' }],
    ]]);
  });

  test('createProject without tags does not touch project_tags', async () => {
    const { client, calls } = fakeClient((call) =>
      call.table === 'projects' ? { data: { id: 'p' }, error: null } : { data: null, error: null });
    await createSupabaseMailRepository(client).createProject({
      title: 'T', client: '', tenderType: 'public', tenderId: null, supervisor: null, dueOn: null,
      receivedOn: '2026-11-25', status: '', source: 'email', tags: [], updatedBy: 'email',
    });
    assert.equal(calls.some((c) => c.table === 'project_tags'), false);
  });

  test('markProcessed upserts on message_id', async () => {
    const { client, calls } = fakeClient();
    const rec: ProcessedRecord = {
      messageId: 'AAMk-1',
      folder: 'inbox',
      subject: 'Subject',
      fromAddress: 'a@b.example',
      receivedAt: '2026-11-25T07:00:00Z',
      outcome: 'error',
      attempts: 2,
      lastError: 'timeout',
      prefilterReason: null,
      projectId: null,
      mailEventId: null,
      reviewId: null,
    };
    await createSupabaseMailRepository(client).markProcessed(rec);
    const call = calls.find((c) => c.table === 'processed_messages');
    assert.ok(call);
    const [row, opts] = opsOf(call, 'upsert')[0] as [Record<string, unknown>, Record<string, unknown>];
    assert.equal(row.message_id, 'AAMk-1');
    assert.equal(row.outcome, 'error');
    assert.equal(row.attempts, 2);
    assert.equal(row.last_error, 'timeout');
    assert.equal(opts.onConflict, 'message_id');
  });

  test('startRun calls rpc rpc_start_mail_run with p_trigger', async () => {
    const { client, calls } = fakeClient(() => ({ data: 'run-uuid-7', error: null }));
    const id = await createSupabaseMailRepository(client).startRun('cron');
    assert.equal(id, 'run-uuid-7');
    const call = calls[0];
    assert.equal(call.kind, 'rpc');
    assert.equal(call.fn, 'rpc_start_mail_run');
    assert.deepEqual(call.args, [{ p_trigger: 'cron' }]);
  });

  test('startRun returns null when the rpc returns null', async () => {
    const { client } = fakeClient(() => ({ data: null, error: null }));
    assert.equal(await createSupabaseMailRepository(client).startRun('manual'), null);
  });

  test('an error result throws its message', async () => {
    const { client } = fakeClient(() => ({ data: null, error: { message: 'boom' } }));
    await assert.rejects(() => createSupabaseMailRepository(client).markProcessed({
      messageId: 'x', folder: 'inbox', subject: '', fromAddress: null, receivedAt: '2026-11-25T07:00:00Z',
      outcome: 'ignored', attempts: 0, lastError: null, prefilterReason: null, projectId: null,
      mailEventId: null, reviewId: null,
    }), /boom/);
  });

  test('getMailSettings reads both settings keys', async () => {
    const { client, calls } = fakeClient(() => ({
      data: [
        { key: 'mail', value: { hourlyEnabled: false } },
        { key: 'mail_state', value: { lastRunAt: '2026-11-25T06:00:00Z' } },
      ],
      error: null,
    }));
    const s = await createSupabaseMailRepository(client).getMailSettings();
    assert.deepEqual(s, { hourlyEnabled: false, lastRunAt: '2026-11-25T06:00:00Z' });
    assert.deepEqual(opsOf(calls[0], 'in'), [['key', ['mail', 'mail_state']]]);
  });

  test('getProcessed chunks ids by 100 and maps rows', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `id-${i}`);
    const { client, calls } = fakeClient((call) => ({
      data: (opsOf(call, 'in')[0][1] as string[]).map((m) => ({
        message_id: m, folder: 'sent', subject: 's', from_address: null, received_at: '2026-11-25T07:00:00Z',
        outcome: 'applied', attempts: 0, last_error: null, prefilter_reason: null,
        project_id: 'p', mail_event_id: 'e', review_id: null,
      })),
      error: null,
    }));
    const map = await createSupabaseMailRepository(client).getProcessed(ids);
    assert.equal(calls.length, 2);
    assert.equal(map.size, 150);
    assert.equal(map.get('id-0')?.projectId, 'p');
    assert.equal(map.get('id-0')?.folder, 'sent');
  });

  test('addLinks upserts on (project_id, url) ignoring duplicates and counts returned rows', async () => {
    const { client, calls } = fakeClient(() => ({ data: [{ id: 'l1' }], error: null }));
    const n = await createSupabaseMailRepository(client).addLinks('p1', [
      { url: 'https://a.example/x.pdf', title: 'X' },
      { url: 'https://a.example/x.pdf', title: 'X again' },
    ], 'ev-1');
    assert.equal(n, 1);
    const call = calls[0];
    const [rows, opts] = opsOf(call, 'upsert')[0] as [Record<string, unknown>[], Record<string, unknown>];
    assert.equal(rows.length, 2);
    assert.equal(rows[0].project_id, 'p1');
    assert.equal(rows[0].mail_event_id, 'ev-1');
    assert.equal(opts.onConflict, 'project_id,url');
    assert.equal(opts.ignoreDuplicates, true);
  });

  test('addLinks with no links does not query', async () => {
    const { client, calls } = fakeClient();
    assert.equal(await createSupabaseMailRepository(client).addLinks('p1', [], null), 0);
    assert.equal(calls.length, 0);
  });

  test('listOpenProjects filters archived and picks the latest email subject', async () => {
    const { client, calls } = fakeClient(() => ({
      data: [{
        id: 'p1', title: 'Roads', client: 'C', supervisor: null, tender_id: null, tender_type: 'private',
        due_on: '2026-12-24', status: 'Open', assignee_id: null, updated_at: '2026-11-25T06:00:00Z',
        project_tags: [{ tag_id: 'pp' }, { tag_id: 'upd' }],
        mail_events: [
          { subject: 'older', created_at: '2026-11-20T00:00:00Z' },
          { subject: 'newest', created_at: '2026-11-24T00:00:00Z' },
        ],
      }],
      error: null,
    }));
    const [p] = await createSupabaseMailRepository(client).listOpenProjects();
    assert.deepEqual(opsOf(calls[0], 'eq'), [['archived', false]]);
    assert.equal(p.lastEmailSubject, 'newest');
    assert.deepEqual(p.tags, ['pp', 'upd']);
    assert.equal(p.tenderType, 'private');
    assert.equal(p.dueOn, '2026-12-24');
  });

  test('updateProject writes only the given columns plus updated_by', async () => {
    const { client, calls } = fakeClient();
    await createSupabaseMailRepository(client).updateProject('p1', { status: 'X', dueOn: null, updatedBy: 'email' });
    assert.deepEqual(opsOf(calls[0], 'update'), [[{ updated_by: 'email', status: 'X', due_on: null }]]);
    assert.deepEqual(opsOf(calls[0], 'eq'), [['id', 'p1']]);
  });

  test('addReview upserts on message_id with status open', async () => {
    const { client, calls } = fakeClient(() => ({ data: { id: 'r-1' }, error: null }));
    const id = await createSupabaseMailRepository(client).addReview({
      messageId: 'm1', folder: 'inbox', message: {} as any, aiForm: null, validated: null,
      candidates: [], reasons: ['ai_refused'],
    });
    assert.equal(id, 'r-1');
    const [row, opts] = opsOf(calls[0], 'upsert')[0] as [Record<string, unknown>, Record<string, unknown>];
    assert.equal(row.status, 'open');
    assert.deepEqual(row.reasons, ['ai_refused']);
    assert.equal(opts.onConflict, 'message_id');
  });

  test('closeReview sets status, resolver and resolution', async () => {
    const { client, calls } = fakeClient();
    await createSupabaseMailRepository(client).closeReview('r-1', 'dismissed', 'Sara', { action: 'dismiss' });
    const [row] = opsOf(calls[0], 'update')[0] as [Record<string, unknown>];
    assert.equal(row.status, 'dismissed');
    assert.equal(row.resolved_by, 'Sara');
    assert.deepEqual(row.resolution, { action: 'dismiss' });
    assert.deepEqual(opsOf(calls[0], 'eq'), [['id', 'r-1']]);
  });

  test('addSystemComment inserts a System comment', async () => {
    const { client, calls } = fakeClient();
    await createSupabaseMailRepository(client).addSystemComment('p1', 'Email: hi');
    assert.deepEqual(opsOf(calls[0], 'insert'), [[{ project_id: 'p1', author_name: 'System', body: 'Email: hi', system: true }]]);
  });

  test('listTenderTeam maps name_ar and orders by sort', async () => {
    const { client, calls } = fakeClient(() => ({
      data: [{ id: 't1', name: 'Shereen', name_ar: 'شيرين', type: 'public' }],
      error: null,
    }));
    const team = await createSupabaseMailRepository(client).listTenderTeam();
    assert.deepEqual(team, [{ id: 't1', name: 'Shereen', nameAr: 'شيرين', type: 'public' }]);
    assert.deepEqual(opsOf(calls[0], 'order'), [['sort', { ascending: true }]]);
  });

  test('addMatchExample maps camelCase to columns', async () => {
    const { client, calls } = fakeClient();
    await createSupabaseMailRepository(client).addMatchExample({
      subject: 's', excerpt: 'e', chosen: 'new', chosenTitle: null, aiSuggestion: 'P1',
      reviewId: 'r-1', createdBy: 'Mohamed',
    });
    assert.deepEqual(opsOf(calls[0], 'insert'), [[{
      review_id: 'r-1', subject: 's', excerpt: 'e', chosen: 'new', chosen_title: null,
      ai_suggestion: 'P1', created_by: 'Mohamed',
    }]]);
  });
});
