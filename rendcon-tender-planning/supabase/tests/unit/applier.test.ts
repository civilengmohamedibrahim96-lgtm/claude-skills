import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KIND_TAGS,
  applyForm,
  defaultStatus,
  fmtDateEn,
  localDate,
} from '../../functions/_shared/applier.ts';
import { createMemoryMailRepository } from '../../functions/_shared/mail_repo_memory.ts';
import type { AiForm, BoardProject, MailMessage, MailRepository, NewProjectInput, ValidatedForm } from '../../functions/_shared/types.ts';

const TODAY = '2026-11-25';

function rawForm(): AiForm {
  return {
    direction: 'received',
    kind: 'update',
    matched_project: 'P1',
    match_reason: 'test',
    other_possible_projects: [],
    project_name: null,
    client: null,
    submission_date: null,
    submission_date_source: null,
    tender_type: 'unknown',
    supervisor_first_name: null,
    links: [],
    suggested_status: null,
    summary: 'summary',
    confidence: { match: 'high', facts: 'high' },
  };
}

function form(over: Partial<ValidatedForm> = {}): ValidatedForm {
  return {
    direction: 'received',
    kind: 'update',
    projectId: 'p-1',
    projectName: null,
    client: null,
    submissionDate: null,
    submissionDateSource: null,
    tenderType: null,
    tenderId: null,
    supervisor: null,
    links: [],
    suggestedStatus: null,
    summary: 'Email summary',
    matchReason: 'matched',
    confidence: { match: 'high', facts: 'high' },
    raw: rawForm(),
    ...over,
  };
}

function message(over: Partial<MailMessage> = {}): MailMessage {
  return {
    id: 'AAMk-1',
    conversationId: 'conv-1',
    folder: 'inbox',
    subject: 'Subject line',
    from: { name: 'Procurement', address: 'procurement@nuca.example' },
    to: ['tenders@redcon.example'],
    cc: [],
    date: '2026-11-24T23:30:00Z',
    bodyText: 'Body with https://tenders.example/specs.pdf inside',
    bodyHtml: null,
    webLink: 'https://outlook.example/item',
    headers: {},
    isMeetingMessage: false,
    hasAttachments: false,
    ...over,
  };
}

function existing(over: Partial<BoardProject> = {}): BoardProject {
  return {
    id: 'p-1',
    title: 'Internal roads',
    client: 'Client',
    supervisor: null,
    tenderId: null,
    tenderType: 'public',
    dueOn: '2026-12-24',
    status: 'Old status',
    tags: ['upd'],
    assigneeId: null,
    updatedAt: '2026-11-20T00:00:00Z',
    lastEmailSubject: null,
    ...over,
  };
}

// Wraps the memory repo to capture what createProject received.
function spyRepo(seedProjects: BoardProject[]) {
  const memory = createMemoryMailRepository({
    projects: seedProjects,
    tenderTeam: [{ id: 't-1', name: 'Shereen', nameAr: 'شيرين', type: 'public' }],
  });
  const created: NewProjectInput[] = [];
  const repo: MailRepository = {
    ...memory,
    createProject: async (input: NewProjectInput) => {
      created.push(input);
      return memory.createProject(input);
    },
  };
  return { repo, memory, created };
}

const NOW = new Date('2026-11-25T11:00:00Z');

describe('helpers', () => {
  test('fmtDateEn formats as "03 Dec 2026"', () => {
    assert.equal(fmtDateEn('2026-12-03'), '03 Dec 2026');
    assert.equal(fmtDateEn('2027-01-10'), '10 Jan 2027');
    assert.equal(fmtDateEn('2026-09-05'), '05 Sep 2026');
  });

  test('localDate uses the time zone calendar date', () => {
    assert.equal(localDate('2026-11-24T23:30:00Z', 'Africa/Cairo'), '2026-11-25');
    assert.equal(localDate('2026-11-24T10:00:00Z', 'UTC'), '2026-11-24');
  });

  test('KIND_TAGS', () => {
    assert.deepEqual(KIND_TAGS.new_project, ['new', 'un']);
    assert.deepEqual(KIND_TAGS.update, ['upd']);
    assert.deepEqual(KIND_TAGS.postponed, ['pp']);
    assert.deepEqual(KIND_TAGS.queries_answers, ['qa']);
    assert.deepEqual(KIND_TAGS.offer_submitted, ['sub']);
    assert.deepEqual(KIND_TAGS.queries_sent, []);
    assert.deepEqual(KIND_TAGS.extension_requested, []);
    assert.deepEqual(KIND_TAGS.reply_or_follow_up, []);
  });

  test('defaultStatus per kind and suggestion precedence', () => {
    assert.equal(defaultStatus(form({ kind: 'new_project', projectId: null })), 'Received by email – needs an engineer');
    assert.equal(defaultStatus(form({ kind: 'update' })), 'New update received by email');
    assert.equal(defaultStatus(form({ kind: 'postponed', submissionDate: '2027-01-10' })), 'Postponed to 10 Jan 2027');
    assert.equal(defaultStatus(form({ kind: 'postponed', submissionDate: null })), 'Postponed by client – new date to be announced');
    assert.equal(defaultStatus(form({ kind: 'queries_answers' })), 'Answers to queries received – review');
    assert.equal(defaultStatus(form({ kind: 'queries_sent' })), 'Queries sent to client – waiting for answers');
    assert.equal(defaultStatus(form({ kind: 'offer_submitted' })), 'Submitted');
    assert.equal(defaultStatus(form({ kind: 'extension_requested' })), 'Extension requested from client');
    assert.equal(defaultStatus(form({ kind: 'reply_or_follow_up' })), null);
    assert.equal(defaultStatus(form({ kind: 'offer_submitted', suggestedStatus: 'Custom' })), 'Custom');
  });
});

describe('applyForm', () => {
  test('new project: created with tags, due date, Cairo received date, status, tender, comment, event, link', async () => {
    const { repo, memory, created } = spyRepo([]);
    const f = form({
      kind: 'new_project',
      projectId: null,
      projectName: 'Admin building',
      client: 'NUCA',
      submissionDate: '2026-12-20',
      tenderType: 'public',
      tenderId: 't-1',
      supervisor: 'شيرين',
      links: [{ url: 'https://tenders.example/specs.pdf', label: 'Specs' }],
    });
    const m = message({ bodyText: 'Specs at https://tenders.example/specs.pdf' });
    const res = await applyForm(repo, f, m, NOW, 'Africa/Cairo');

    assert.equal(res.created, true);
    assert.deepEqual(created[0].tags, ['new', 'un']);
    assert.equal(created[0].receivedOn, '2026-11-25');
    assert.equal(created[0].title, 'Admin building');
    assert.equal(created[0].tenderId, 't-1');
    assert.equal(created[0].source, 'email');
    assert.equal(created[0].updatedBy, 'email');
    assert.equal(created[0].status, 'Received by email – needs an engineer');
    assert.ok(res.changes.includes('created'));

    const dump = memory.dump();
    const p = dump.projects.find((x) => x.id === res.projectId);
    assert.ok(p);
    assert.deepEqual(p.tags, ['new', 'un']);
    assert.equal(p.dueOn, '2026-12-20');
    assert.equal(p.tenderId, 't-1');
    assert.equal(dump.mailEvents.length, 1);
    assert.equal(dump.mailEvents[0].id, res.mailEventId);
    assert.equal(dump.mailEvents[0].kind, 'new_project');
    assert.equal(dump.comments[0].text, 'Created from email: Subject line');
    assert.equal(dump.links.length, 1);
    assert.equal(dump.links[0].url, 'https://tenders.example/specs.pdf');
  });

  test('postponed: tag pp, date change by email, status with new date', async () => {
    const { repo, memory } = spyRepo([existing()]);
    const res = await applyForm(repo, form({ kind: 'postponed', submissionDate: '2027-01-10' }), message(), NOW, 'Africa/Cairo');
    assert.equal(res.created, false);
    assert.equal(res.projectId, 'p-1');
    const dump = memory.dump();
    const p = dump.projects[0];
    assert.equal(p.status, 'Postponed to 10 Jan 2027');
    assert.equal(p.dueOn, '2027-01-10');
    assert.ok(p.tags.includes('pp'));
    assert.ok(p.tags.includes('upd'));
    assert.equal(dump.dateChanges.length, 1);
    assert.deepEqual(
      { ...dump.dateChanges[0] },
      { projectId: 'p-1', fromDate: '2026-12-24', toDate: '2027-01-10', changedBy: 'email', mailEventId: res.mailEventId },
    );
    assert.equal(dump.mailEvents[0].kind, 'postponed');
  });

  test('queries_sent: status only, no tags, no date change even if a date is given', async () => {
    const { repo, memory } = spyRepo([existing({ tags: [] })]);
    await applyForm(repo, form({ kind: 'queries_sent', direction: 'sent', submissionDate: '2027-02-01' }), message({ folder: 'sent' }), NOW, 'Africa/Cairo');
    const dump = memory.dump();
    assert.equal(dump.projects[0].status, 'Queries sent to client – waiting for answers');
    assert.deepEqual(dump.projects[0].tags, []);
    assert.equal(dump.projects[0].dueOn, '2026-12-24');
    assert.equal(dump.dateChanges.length, 0);
  });

  test('offer_submitted: tag sub and status Submitted', async () => {
    const { repo, memory } = spyRepo([existing({ tags: [] })]);
    await applyForm(repo, form({ kind: 'offer_submitted', direction: 'sent' }), message({ folder: 'sent' }), NOW, 'Africa/Cairo');
    const p = memory.dump().projects[0];
    assert.equal(p.status, 'Submitted');
    assert.deepEqual(p.tags, ['sub']);
  });

  test('extension_requested keeps the date', async () => {
    const { repo, memory } = spyRepo([existing()]);
    await applyForm(repo, form({ kind: 'extension_requested', submissionDate: '2027-02-01' }), message(), NOW, 'Africa/Cairo');
    const dump = memory.dump();
    assert.equal(dump.projects[0].dueOn, '2026-12-24');
    assert.equal(dump.projects[0].status, 'Extension requested from client');
    assert.equal(dump.dateChanges.length, 0);
  });

  test('duplicate link is not added twice', async () => {
    const { repo, memory } = spyRepo([existing()]);
    const f = form({ kind: 'update', links: [{ url: 'https://tenders.example/specs.pdf', label: 'Specs' }] });
    const first = await applyForm(repo, f, message(), NOW, 'Africa/Cairo');
    const second = await applyForm(repo, f, message({ id: 'AAMk-2' }), NOW, 'Africa/Cairo');
    assert.ok(first.changes.includes('links:1'));
    assert.ok(!second.changes.some((c) => c.startsWith('links:')));
    assert.equal(memory.dump().links.length, 1);
  });

  test('existing project without supervisor gets the form supervisor only when no tender is matched', async () => {
    const { repo, memory } = spyRepo([existing()]);
    await applyForm(repo, form({ kind: 'update', supervisor: 'شيرين' }), message(), NOW, 'Africa/Cairo');
    assert.equal(memory.dump().projects[0].supervisor, 'شيرين');
  });

  test('missing project throws', async () => {
    const { repo } = spyRepo([]);
    await assert.rejects(
      () => applyForm(repo, form({ projectId: 'nope' }), message(), NOW, 'Africa/Cairo'),
      /project not found/,
    );
  });
});
