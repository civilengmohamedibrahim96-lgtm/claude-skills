import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { runMailSync, toStoredMessage } from '../../functions/_shared/mail_sync.ts';
import type { MailSyncDeps } from '../../functions/_shared/mail_sync.ts';
import { createMemoryMailRepository } from '../../functions/_shared/mail_repo_memory.ts';
import type {
  AiForm,
  AiResult,
  ApplyResult,
  Decision,
  Folder,
  MailMessage,
  ProcessedRecord,
  ValidatedForm,
} from '../../functions/_shared/types.ts';

function msg(id: string, date: string, over: Partial<MailMessage> = {}): MailMessage {
  return {
    id,
    conversationId: `conv-${id}`,
    folder: 'inbox',
    subject: `Subject ${id}`,
    from: { name: 'Sender', address: 'sender@example.test' },
    to: ['tenders@redcon.example'],
    cc: [],
    date,
    bodyText: `Body of ${id}`,
    bodyHtml: null,
    webLink: `https://outlook.example/${id}`,
    headers: {},
    isMeetingMessage: false,
    hasAttachments: false,
    ...over,
  };
}

const FORM = {} as AiForm;
const VFORM = { kind: 'update' } as unknown as ValidatedForm;
const OK: AiResult = { ok: true, form: FORM, model: 'test-model', inputTokens: 1, outputTokens: 1 };

type Harness = {
  deps: MailSyncDeps;
  memory: ReturnType<typeof createMemoryMailRepository>;
  clock: { t: number };
  listCalls: { folder: Folder; since: string; max: number }[];
  getCalls: string[];
  applyCalls: string[];
  aiCalls: string[];
  setDecision(id: string, d: Decision): void;
  setAi(id: string, r: AiResult | (() => Promise<AiResult>)): void;
  setApplyError(id: string, err: Error): void;
  applyCreated: Map<string, boolean>;
  onAi(fn: (id: string) => void): void;
};

function harness(opts: {
  inbox?: MailMessage[];
  sent?: MailMessage[];
  lastRunAt?: string | null;
  hourlyEnabled?: boolean;
  listError?: Error;
  fullBodies?: Record<string, MailMessage>;
  fullBodyErrors?: Record<string, Error>;
  timeBudgetMs?: number;
} = {}): Harness {
  const memory = createMemoryMailRepository({
    projects: [],
    tenderTeam: [],
    lastRunAt: opts.lastRunAt === undefined ? '2026-11-25T06:00:00Z' : opts.lastRunAt,
    hourlyEnabled: opts.hourlyEnabled ?? true,
  });
  const clock = { t: Date.parse('2026-11-25T08:00:00Z') };
  const listCalls: Harness['listCalls'] = [];
  const getCalls: string[] = [];
  const applyCalls: string[] = [];
  const aiCalls: string[] = [];
  const decisions = new Map<string, Decision>();
  const aiResults = new Map<string, AiResult | (() => Promise<AiResult>)>();
  const applyErrors = new Map<string, Error>();
  const applyCreated = new Map<string, boolean>();
  let aiHook: (id: string) => void = () => {};

  const deps: MailSyncDeps = {
    repo: memory,
    mail: {
      async listMessages(folder, since, max) {
        listCalls.push({ folder, since, max });
        if (opts.listError) throw opts.listError;
        return folder === 'inbox' ? (opts.inbox ?? []) : (opts.sent ?? []);
      },
      async getMessage(id) {
        getCalls.push(id);
        const err = opts.fullBodyErrors?.[id];
        if (err) throw err;
        return opts.fullBodies?.[id] ?? null;
      },
      async sendMail() {
        throw new Error('not used');
      },
    },
    ai: async (input) => {
      const id = input.message.id;
      aiCalls.push(id);
      aiHook(id);
      const r = aiResults.get(id) ?? OK;
      return typeof r === 'function' ? r() : r;
    },
    normalize: (raw, folder) => {
      const m = raw as MailMessage;
      return { ...m, folder };
    },
    prefilter: (m) =>
      m.subject.startsWith('AUTO')
        ? { skip: true, reason: 'auto_reply' }
        : { skip: false, reason: null },
    shortlist: () => [],
    validate: (_form, ctx) => decisions.get(ctx.message.id) ?? { action: 'apply', form: VFORM },
    apply: async (_repo, _form, m, _now, _tz): Promise<ApplyResult> => {
      applyCalls.push(m.id);
      const err = applyErrors.get(m.id);
      if (err) throw err;
      return {
        projectId: `proj-${m.id}`,
        created: applyCreated.get(m.id) ?? true,
        mailEventId: `ev-${m.id}`,
        changes: [],
      };
    },
    now: () => new Date(clock.t),
    timeZone: 'Africa/Cairo',
    config: {
      lookbackHours: 48,
      maxPerRun: 60,
      overlapMinutes: 30,
      maxAttempts: 3,
      timeBudgetMs: opts.timeBudgetMs ?? 110000,
    },
  };

  return {
    deps,
    memory,
    clock,
    listCalls,
    getCalls,
    applyCalls,
    aiCalls,
    setDecision: (id, d) => decisions.set(id, d),
    setAi: (id, r) => aiResults.set(id, r),
    setApplyError: (id, e) => applyErrors.set(id, e),
    applyCreated,
    onAi: (fn) => {
      aiHook = fn;
    },
  };
}

function processedRec(id: string, over: Partial<ProcessedRecord> = {}): ProcessedRecord {
  return {
    messageId: id,
    folder: 'inbox',
    subject: `Subject ${id}`,
    fromAddress: null,
    receivedAt: '2026-11-25T07:00:00Z',
    outcome: 'applied',
    attempts: 0,
    lastError: null,
    prefilterReason: null,
    projectId: null,
    mailEventId: null,
    reviewId: null,
    ...over,
  };
}

describe('runMailSync', () => {
  test('disabled + cron → skipped disabled, no run row, nothing fetched', async () => {
    const h = harness({ hourlyEnabled: false, inbox: [msg('a', '2026-11-25T07:00:00Z')] });
    const s = await runMailSync(h.deps, 'cron');
    assert.equal(s.skipped, 'disabled');
    assert.equal(s.runId, null);
    assert.equal(h.listCalls.length, 0);
    assert.equal(h.memory.dump().runs.length, 0);
  });

  test('disabled does not block a manual run', async () => {
    const h = harness({ hourlyEnabled: false, inbox: [] });
    const s = await runMailSync(h.deps, 'manual');
    assert.equal(s.skipped, null);
    assert.equal(s.trigger, 'manual');
  });

  test('startRun returns null → already_running', async () => {
    const h = harness({ inbox: [msg('a', '2026-11-25T07:00:00Z')] });
    await h.memory.startRun('cron'); // an unfinished run is active
    const s = await runMailSync(h.deps, 'manual');
    assert.equal(s.skipped, 'already_running');
    assert.equal(h.listCalls.length, 0);
  });

  test('lookback window on first run, overlap window after lastRunAt', async () => {
    const first = harness({ lastRunAt: null, inbox: [] });
    await runMailSync(first.deps, 'manual');
    assert.equal(first.listCalls[0].since, new Date(Date.parse('2026-11-25T08:00:00Z') - 48 * 3600e3).toISOString());

    const later = harness({ lastRunAt: '2026-11-25T06:00:00Z', inbox: [] });
    await runMailSync(later.deps, 'manual');
    assert.equal(later.listCalls[0].since, '2026-11-25T05:30:00.000Z');
    assert.equal(later.listCalls[0].max, 60);
    assert.deepEqual(later.listCalls.map((c) => c.folder), ['inbox', 'sent']);
  });

  test('messages are processed oldest first and dedupe by id', async () => {
    const h = harness({
      inbox: [msg('late', '2026-11-25T07:30:00Z'), msg('early', '2026-11-25T07:00:00Z')],
      sent: [msg('early', '2026-11-25T07:00:00Z', { folder: 'sent' })],
    });
    const s = await runMailSync(h.deps, 'manual');
    assert.deepEqual(h.applyCalls, ['early', 'late']);
    assert.equal(s.fetched, 3);
    assert.equal(s.applied, 2);
  });

  test('already processed messages are skipped without AI', async () => {
    const h = harness({ inbox: [msg('done', '2026-11-25T07:00:00Z'), msg('new', '2026-11-25T07:05:00Z')] });
    await h.memory.markProcessed(processedRec('done'));
    const s = await runMailSync(h.deps, 'manual');
    assert.equal(s.alreadyProcessed, 1);
    assert.deepEqual(h.aiCalls, ['new']);
  });

  test('error records retried below 3 attempts, skipped at 3', async () => {
    const h = harness({
      inbox: [msg('retry', '2026-11-25T07:00:00Z'), msg('dead', '2026-11-25T07:01:00Z')],
    });
    await h.memory.markProcessed(processedRec('retry', { outcome: 'error', attempts: 2 }));
    await h.memory.markProcessed(processedRec('dead', { outcome: 'error', attempts: 3 }));
    const s = await runMailSync(h.deps, 'manual');
    assert.deepEqual(h.aiCalls, ['retry']);
    assert.equal(s.alreadyProcessed, 1);
    assert.equal(s.applied, 1);
  });

  test('prefiltered messages are recorded with their reason', async () => {
    const h = harness({ inbox: [msg('auto', '2026-11-25T07:00:00Z', { subject: 'AUTO reply' })] });
    const s = await runMailSync(h.deps, 'manual');
    assert.equal(s.prefiltered, 1);
    assert.equal(s.aiCalls, 0);
    const rec = h.memory.dump().processed.get('auto');
    assert.equal(rec?.outcome, 'prefiltered');
    assert.equal(rec?.prefilterReason, 'auto_reply');
  });

  test('retryable AI error → error record with attempts + 1 and lastRunAt one second before it', async () => {
    const h = harness({ inbox: [msg('flaky', '2026-11-25T07:00:00Z')] });
    h.setAi('flaky', { ok: false, error: 'api_error', retryable: true, detail: 'socket hang up' });
    const s = await runMailSync(h.deps, 'manual');
    assert.equal(s.errors, 1);
    const rec = h.memory.dump().processed.get('flaky');
    assert.equal(rec?.outcome, 'error');
    assert.equal(rec?.attempts, 1);
    assert.equal(rec?.lastError, 'socket hang up');
    assert.equal(h.memory.dump().lastRunAt, '2026-11-25T06:59:59.000Z');
  });

  test('Gemini quota error keeps attempts and defers the rest of the run', async () => {
    const h = harness({ inbox: [msg('q1', '2026-11-25T07:00:00Z'), msg('q2', '2026-11-25T08:00:00Z')] });
    h.setAi('q1', { ok: false, error: 'api_error', retryable: true, detail: 'You exceeded your current quota' });
    const s = await runMailSync(h.deps, 'manual');
    assert.equal(s.errors, 1);
    assert.equal(s.deferred, 1);
    assert.equal(h.memory.dump().processed.get('q1')?.attempts, 0);
    assert.equal(h.memory.dump().processed.get('q2'), undefined);
  });

  test('AI refusal → review item with ai_refused', async () => {
    const h = harness({ inbox: [msg('refused', '2026-11-25T07:00:00Z')] });
    h.setAi('refused', { ok: false, error: 'refusal', retryable: false, detail: 'policy' });
    const s = await runMailSync(h.deps, 'manual');
    assert.equal(s.review, 1);
    const dump = h.memory.dump();
    assert.deepEqual(dump.reviews[0].reasons, ['ai_refused']);
    assert.equal(dump.reviews[0].aiForm, null);
    assert.equal(dump.processed.get('refused')?.outcome, 'review');
  });

  test('AI max_tokens → ai_incomplete; bad_output → ai_bad_output', async () => {
    const h = harness({ inbox: [msg('long', '2026-11-25T07:00:00Z'), msg('junk', '2026-11-25T07:01:00Z')] });
    h.setAi('long', { ok: false, error: 'max_tokens', retryable: false, detail: '' });
    h.setAi('junk', { ok: false, error: 'bad_output', retryable: false, detail: 'json' });
    await runMailSync(h.deps, 'manual');
    const reviews = h.memory.dump().reviews;
    assert.deepEqual(reviews.map((r) => r.reasons), [['ai_incomplete'], ['ai_bad_output']]);
  });

  test('ignore, review and apply decisions are recorded', async () => {
    const h = harness({
      inbox: [
        msg('ign', '2026-11-25T07:00:00Z'),
        msg('rev', '2026-11-25T07:01:00Z'),
        msg('app', '2026-11-25T07:02:00Z'),
      ],
    });
    h.setDecision('ign', { action: 'ignore', reason: 'not_a_tender' });
    h.setDecision('rev', { action: 'review', form: VFORM, reasons: ['tie'], candidates: [] });
    const s = await runMailSync(h.deps, 'manual');
    assert.equal(s.ignored, 1);
    assert.equal(s.review, 1);
    assert.equal(s.applied, 1);
    const dump = h.memory.dump();
    assert.equal(dump.processed.get('ign')?.outcome, 'ignored');
    assert.equal(dump.processed.get('rev')?.outcome, 'review');
    assert.ok(dump.processed.get('rev')?.reviewId);
    assert.equal(dump.processed.get('app')?.outcome, 'applied');
    assert.equal(dump.processed.get('app')?.projectId, 'proj-app');
    assert.equal(dump.processed.get('app')?.mailEventId, 'ev-app');
  });

  test('an exception from apply is caught and the next message still runs', async () => {
    const h = harness({
      inbox: [msg('boom', '2026-11-25T07:00:00Z'), msg('after', '2026-11-25T07:01:00Z')],
    });
    h.setApplyError('boom', new Error('database exploded'));
    const s = await runMailSync(h.deps, 'manual');
    assert.equal(s.errors, 1);
    assert.equal(s.applied, 1);
    const rec = h.memory.dump().processed.get('boom');
    assert.equal(rec?.outcome, 'error');
    assert.equal(rec?.lastError, 'database exploded');
    assert.equal(rec?.attempts, 1);
    assert.equal(h.memory.dump().processed.get('after')?.outcome, 'applied');
  });

  test('time budget exceeded → deferred, not marked processed, lastRunAt stops before it', async () => {
    const h = harness({
      inbox: [msg('first', '2026-11-25T07:00:00Z'), msg('second', '2026-11-25T07:01:00Z')],
      timeBudgetMs: 110000,
    });
    h.onAi(() => {
      h.clock.t += 120000; // the first AI call takes long
    });
    const s = await runMailSync(h.deps, 'manual');
    assert.equal(s.deferred, 1);
    assert.deepEqual(h.aiCalls, ['first']);
    assert.equal(h.memory.dump().processed.get('second'), undefined);
    assert.equal(h.memory.dump().lastRunAt, '2026-11-25T07:00:59.000Z');
  });

  test('list error → run finished with error, lastRunAt unchanged, nothing processed', async () => {
    const h = harness({ listError: new Error('composio 503'), lastRunAt: '2026-11-25T06:00:00Z' });
    const s = await runMailSync(h.deps, 'manual');
    assert.equal(s.errors, 1);
    assert.equal(s.fetched, 0);
    const dump = h.memory.dump();
    assert.equal(dump.lastRunAt, '2026-11-25T06:00:00Z');
    assert.equal(dump.runs.length, 1);
    assert.equal(dump.runs[0].error, 'composio 503');
    assert.ok(dump.runs[0].summary);
  });

  test('empty body → getMessage fetches the full message', async () => {
    const empty = msg('thin', '2026-11-25T07:00:00Z', { bodyText: '', bodyHtml: null });
    const full = msg('thin', '2026-11-25T07:00:00Z', { bodyText: 'Full body text' });
    const h = harness({ inbox: [empty], fullBodies: { thin: full } });
    await runMailSync(h.deps, 'manual');
    assert.deepEqual(h.getCalls, ['thin']);
    assert.equal(h.aiCalls.length, 1);
  });

  test('already processed body-less message is not fetched again', async () => {
    const h = harness({ inbox: [msg('done', '2026-11-25T07:00:00Z', { bodyText: '', bodyHtml: null })] });
    await h.memory.markProcessed(processedRec('done'));
    const s = await runMailSync(h.deps, 'manual');
    assert.equal(s.alreadyProcessed, 1);
    assert.deepEqual(h.getCalls, []);
  });

  test('getMessage failure is a per-message error; other messages still apply and the run completes', async () => {
    const h = harness({
      inbox: [
        msg('bad', '2026-11-25T07:00:00Z', { bodyText: '', bodyHtml: null }),
        msg('good', '2026-11-25T07:01:00Z', { bodyText: '', bodyHtml: null }),
        msg('plain', '2026-11-25T07:02:00Z'),
      ],
      fullBodies: { good: msg('good', '2026-11-25T07:01:00Z', { bodyText: 'Full body' }) },
      fullBodyErrors: { bad: new Error('graph 500') },
    });
    const s = await runMailSync(h.deps, 'manual');
    assert.equal(s.errors, 1);
    assert.equal(s.applied, 2);
    const dump = h.memory.dump();
    assert.equal(dump.processed.get('bad')?.outcome, 'error');
    assert.equal(dump.processed.get('bad')?.attempts, 1);
    assert.equal(dump.processed.get('bad')?.lastError, 'graph 500');
    assert.equal(dump.runs[0].error, null);
    assert.equal(dump.lastRunAt, '2026-11-25T06:59:59.000Z');
  });

  test('a folder that hit maxPerRun holds lastRunAt back to its newest fetched message', async () => {
    const base = Date.parse('2026-11-25T06:00:00Z');
    const batch = Array.from({ length: 60 }, (_, i) => msg(`m${i}`, new Date(base + i * 60_000).toISOString()));
    const h = harness({ inbox: batch });
    const s = await runMailSync(h.deps, 'manual');
    assert.equal(s.applied, 60);
    assert.equal(h.memory.dump().lastRunAt, '2026-11-25T06:59:00.000Z');
  });

  test('a failure to record a failed message is logged and the run still completes', async () => {
    const h = harness({
      inbox: [msg('boom', '2026-11-25T07:00:00Z'), msg('after', '2026-11-25T07:01:00Z')],
    });
    h.setApplyError('boom', new Error('database exploded'));
    const inner = h.memory;
    h.deps.repo = {
      ...inner,
      markProcessed: async (rec) => {
        if (rec.messageId === 'boom' && rec.outcome === 'error') throw new Error('record store down');
        return inner.markProcessed(rec);
      },
    };
    const logs: string[] = [];
    h.deps.log = (text) => logs.push(text);
    const s = await runMailSync(h.deps, 'manual');
    assert.equal(s.errors, 1);
    assert.equal(s.applied, 1);
    assert.ok(logs.includes('could not record failure'));
    assert.equal(inner.dump().processed.get('after')?.outcome, 'applied');
    assert.equal(inner.dump().runs[0].summary?.applied, 1);
  });

  test('created and updated are counted separately', async () => {
    const h = harness({ inbox: [msg('n', '2026-11-25T07:00:00Z'), msg('u', '2026-11-25T07:01:00Z')] });
    h.applyCreated.set('n', true);
    h.applyCreated.set('u', false);
    const s = await runMailSync(h.deps, 'manual');
    assert.equal(s.created, 1);
    assert.equal(s.updated, 1);
    assert.equal(s.applied, 2);
    assert.equal(h.memory.dump().runs[0].summary?.created, 1);
  });

  test('run row gets a summary and lastRunAt is set to the run start when nothing failed', async () => {
    const h = harness({ inbox: [msg('x', '2026-11-25T07:00:00Z')] });
    const s = await runMailSync(h.deps, 'manual');
    assert.ok(s.runId);
    assert.equal(h.memory.dump().lastRunAt, '2026-11-25T08:00:00.000Z');
    assert.equal(h.memory.dump().runs[0].summary?.applied, 1);
  });
});

describe('toStoredMessage', () => {
  test('drops bodyHtml and cuts bodyText to 20000 characters', () => {
    const m = msg('big', '2026-11-25T07:00:00Z', { bodyText: 'x'.repeat(25000), bodyHtml: '<p>x</p>' });
    const s = toStoredMessage(m) as unknown as Record<string, unknown>;
    assert.equal('bodyHtml' in s, false);
    assert.equal((s.bodyText as string).length, 20000);
    assert.equal(s.id, 'big');
  });
});
