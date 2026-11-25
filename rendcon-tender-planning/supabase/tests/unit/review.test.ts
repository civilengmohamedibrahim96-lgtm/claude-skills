import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveReview } from '../../functions/_shared/review.ts';
import type { ReviewDeps } from '../../functions/_shared/review.ts';
import { createMemoryMailRepository } from '../../functions/_shared/mail_repo_memory.ts';
import type {
  AiForm,
  ApplyResult,
  BoardProject,
  MailMessage,
  ProcessedRecord,
  StoredMessage,
  ValidatedForm,
} from '../../functions/_shared/types.ts';

const MESSAGE: StoredMessage = {
  id: 'm-07',
  conversationId: 'conv-07',
  folder: 'inbox',
  subject: 'Annex 2 – internal roads',
  from: { name: 'Client', address: 'client@example.test' },
  to: ['tenders@redcon.example'],
  cc: [],
  date: '2026-11-25T07:00:00Z',
  bodyText: 'Please see https://tenders.example/internal-roads/addendum-2.pdf. Submission moved to 05 Jan 2027.',
  webLink: 'https://outlook.example/m-07',
  headers: {},
  isMeetingMessage: false,
  hasAttachments: true,
};

const AI: AiForm = {
  direction: 'received',
  kind: 'update',
  matched_project: 'P2',
  match_reason: 'thread and roads',
  other_possible_projects: ['P1'],
  project_name: null,
  client: null,
  submission_date: '2027-01-05',
  submission_date_source: 'moved',
  tender_type: 'unknown',
  supervisor_first_name: null,
  links: [],
  suggested_status: null,
  summary: 'Annex 2',
  confidence: { match: 'medium', facts: 'high' },
};

function validated(over: Partial<ValidatedForm> = {}): ValidatedForm {
  return {
    direction: 'received',
    kind: 'new_project',
    projectId: 'p-roads3',
    projectName: 'Internal roads addendum',
    client: null,
    submissionDate: '2027-01-05',
    submissionDateSource: 'moved',
    tenderType: null,
    tenderId: null,
    supervisor: null,
    links: [{ url: 'https://tenders.example/internal-roads/addendum-2.pdf', label: 'Addendum' }],
    suggestedStatus: null,
    summary: 'Annex 2',
    matchReason: 'x',
    confidence: { match: 'medium', facts: 'high' },
    raw: AI,
    ...over,
  };
}

const ROADS2: BoardProject = {
  id: 'p-roads2',
  title: 'Internal roads phase 2',
  client: 'Client',
  supervisor: null,
  tenderId: null,
  tenderType: 'public',
  dueOn: '2026-12-24',
  status: 'Open',
  tags: [],
  assigneeId: null,
  updatedAt: '2026-11-20T00:00:00Z',
  lastEmailSubject: null,
};

function setup(opts: { validated?: ValidatedForm | null; aiForm?: AiForm | null; projects?: BoardProject[] } = {}) {
  const memory = createMemoryMailRepository({
    projects: opts.projects ?? [ROADS2],
    tenderTeam: [],
    examples: [],
  });
  const applyCalls: { form: ValidatedForm; message: MailMessage }[] = [];
  const deps: ReviewDeps = {
    repo: memory,
    apply: async (_repo, form, message, _now, _tz): Promise<ApplyResult> => {
      applyCalls.push({ form: { ...form, links: [...form.links] }, message });
      return { projectId: form.projectId ?? 'mem-p-9', created: form.projectId === null, mailEventId: 'ev-1', changes: [] };
    },
    now: () => new Date('2026-11-25T11:00:00Z'),
    timeZone: 'Africa/Cairo',
  };
  return { memory, deps, applyCalls };
}

async function openReview(memory: ReturnType<typeof createMemoryMailRepository>, over: {
  validated?: ValidatedForm | null;
  aiForm?: AiForm | null;
  candidates?: { projectId: string; title: string; score: number }[];
} = {}): Promise<string> {
  const pre: ProcessedRecord = {
    messageId: MESSAGE.id,
    folder: 'inbox',
    subject: MESSAGE.subject,
    fromAddress: MESSAGE.from?.address ?? null,
    receivedAt: MESSAGE.date,
    outcome: 'review',
    attempts: 0,
    lastError: null,
    prefilterReason: null,
    projectId: null,
    mailEventId: null,
    reviewId: null,
  };
  await memory.markProcessed(pre);
  return memory.addReview({
    messageId: MESSAGE.id,
    folder: 'inbox',
    message: MESSAGE,
    aiForm: over.aiForm === undefined ? AI : over.aiForm,
    validated: over.validated === undefined ? validated() : over.validated,
    candidates: over.candidates ?? [
      { projectId: 'p-roads3', title: 'Internal roads phase 3', score: 0.8 },
      { projectId: 'p-roads2', title: 'Internal roads phase 2', score: 0.7 },
    ],
    reasons: ['low_match_confidence', 'tie'],
  });
}

describe('resolveReview', () => {
  test('assign → apply called with that project and kind update; review closed; processed applied', async () => {
    const { memory, deps, applyCalls } = setup();
    const reviewId = await openReview(memory);
    const res = await resolveReview(deps, reviewId, { action: 'assign', projectId: 'p-roads2' }, 'Mohamed Ibrahim');

    assert.deepEqual(res, { ok: true, projectId: 'p-roads2' });
    assert.equal(applyCalls.length, 1);
    assert.equal(applyCalls[0].form.projectId, 'p-roads2');
    assert.equal(applyCalls[0].form.kind, 'update');
    assert.equal(applyCalls[0].message.bodyHtml, null);
    assert.equal(applyCalls[0].message.id, 'm-07');

    const dump = memory.dump();
    assert.equal(dump.reviews[0].status, 'resolved');
    const rec = dump.processed.get('m-07');
    assert.equal(rec?.outcome, 'applied');
    assert.equal(rec?.projectId, 'p-roads2');
    assert.equal(rec?.mailEventId, 'ev-1');
    assert.equal(rec?.reviewId, reviewId);
  });

  test('assign stores a match example: chosen existing, AI suggestion from the shortlist ref', async () => {
    const { memory, deps } = setup();
    const reviewId = await openReview(memory);
    await resolveReview(deps, reviewId, { action: 'assign', projectId: 'p-roads2' }, 'Mohamed Ibrahim');
    const ex = memory.dump().examples[0];
    assert.equal(ex.subject, MESSAGE.subject);
    assert.equal(ex.chosen, 'existing');
    assert.equal(ex.chosenTitle, 'Internal roads phase 2');
    assert.equal(ex.aiSuggestion, 'Internal roads phase 2'); // P2 → second candidate
    assert.ok(ex.excerpt.length <= 300);
  });

  test('new → projectId null, kind new_project, name falls back to the subject when empty', async () => {
    const { memory, deps, applyCalls } = setup();
    const reviewId = await openReview(memory, { validated: validated({ projectName: '' }) });
    const res = await resolveReview(deps, reviewId, { action: 'new' }, 'Mohamed Ibrahim');
    assert.equal(res.ok, true);
    assert.equal(applyCalls[0].form.projectId, null);
    assert.equal(applyCalls[0].form.kind, 'new_project');
    assert.equal(applyCalls[0].form.projectName, MESSAGE.subject);
    const ex = memory.dump().examples[0];
    assert.equal(ex.chosen, 'new');
    assert.equal(ex.chosenTitle, MESSAGE.subject);
  });

  test('new keeps the AI project name when present', async () => {
    const { memory, deps, applyCalls } = setup();
    const reviewId = await openReview(memory);
    await resolveReview(deps, reviewId, { action: 'new' }, 'Mohamed Ibrahim');
    assert.equal(applyCalls[0].form.projectName, 'Internal roads addendum');
  });

  test('dismiss → no apply, status dismissed', async () => {
    const { memory, deps, applyCalls } = setup();
    const reviewId = await openReview(memory);
    const res = await resolveReview(deps, reviewId, { action: 'dismiss' }, 'Mohamed Ibrahim');
    assert.deepEqual(res, { ok: true, projectId: null });
    assert.equal(applyCalls.length, 0);
    assert.equal(memory.dump().reviews[0].status, 'dismissed');
  });

  test('a closed review → not_found_or_closed', async () => {
    const { memory, deps, applyCalls } = setup();
    const reviewId = await openReview(memory);
    await resolveReview(deps, reviewId, { action: 'dismiss' }, 'Mohamed Ibrahim');
    const again = await resolveReview(deps, reviewId, { action: 'assign', projectId: 'p-roads2' }, 'Mohamed Ibrahim');
    assert.deepEqual(again, { ok: false, error: 'not_found_or_closed' });
    assert.equal(applyCalls.length, 0);
  });

  test('unknown review id → not_found_or_closed', async () => {
    const { deps } = setup();
    const res = await resolveReview(deps, 'mem-r-404', { action: 'new' }, 'Mohamed Ibrahim');
    assert.deepEqual(res, { ok: false, error: 'not_found_or_closed' });
  });

  test('assign to a project that does not exist → project_not_found, nothing applied', async () => {
    const { memory, deps, applyCalls } = setup();
    const reviewId = await openReview(memory);
    const res = await resolveReview(deps, reviewId, { action: 'assign', projectId: 'p-missing' }, 'Mohamed Ibrahim');
    assert.deepEqual(res, { ok: false, error: 'project_not_found' });
    assert.equal(applyCalls.length, 0);
    assert.equal(memory.dump().reviews[0].status, 'open');
  });

  test('without a stored validated form, the AI form is used', async () => {
    const { memory, deps, applyCalls } = setup();
    const reviewId = await openReview(memory, { validated: null, aiForm: AI });
    await resolveReview(deps, reviewId, { action: 'assign', projectId: 'p-roads2' }, 'Mohamed Ibrahim');
    const f = applyCalls[0].form;
    assert.equal(f.kind, 'update');
    assert.equal(f.submissionDate, '2027-01-05');
    assert.equal(f.projectId, 'p-roads2');
    // the stored AI form carries no links
    assert.deepEqual(f.links, []);
  });

  test('without any AI form, a message-only form is built from the subject', async () => {
    const { memory, deps, applyCalls } = setup();
    const reviewId = await openReview(memory, { validated: null, aiForm: null });
    await resolveReview(deps, reviewId, { action: 'assign', projectId: 'p-roads2' }, 'Mohamed Ibrahim');
    const f = applyCalls[0].form;
    assert.equal(f.summary, 'Email linked by Mohamed Ibrahim');
    assert.equal(f.projectName, MESSAGE.subject);
    assert.equal(f.kind, 'update');
    assert.equal(f.submissionDate, null);
  });
});
