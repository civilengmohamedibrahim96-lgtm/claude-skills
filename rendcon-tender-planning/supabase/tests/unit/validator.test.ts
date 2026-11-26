import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateForm, isRealIsoDate } from '../../functions/_shared/validator.ts';
import type {
  AiForm, BoardProject, Decision, MailMessage, ShortlistEntry, TenderMember, ValidateContext,
} from '../../functions/_shared/types.ts';

const board = JSON.parse(readFileSync(new URL('../fixtures/board.json', import.meta.url), 'utf8'));
const project = (id: string): BoardProject => board.projects.find((p: BoardProject) => p.id === id);
const team: TenderMember[] = board.tenderTeam;

const entry = (ref: string, id: string, score = 0.5, conversationMatch = false): ShortlistEntry =>
  ({ ref, project: project(id), score, conversationMatch });

const BODY = 'ورد الينا ملحق. الملف: https://tenders.example/annex.pdf و https://tenders.example/other';

function message(over: Partial<MailMessage> = {}): MailMessage {
  return {
    id: 'm', conversationId: null, folder: 'inbox', subject: 'ورد الينا', from: null, to: [], cc: [],
    date: '2026-11-25T07:00:00Z', bodyText: BODY, bodyHtml: null, webLink: null, headers: {},
    isMeetingMessage: false, hasAttachments: false, ...over,
  };
}

function form(over: Partial<AiForm> = {}): AiForm {
  return {
    direction: 'received', kind: 'update', matched_project: 'P1', match_reason: 'same tender',
    other_possible_projects: [], project_name: null, client: null, submission_date: null,
    submission_date_source: null, tender_type: 'unknown', supervisor_first_name: null, links: [],
    suggested_status: null, summary: 'Update', confidence: { match: 'high', facts: 'high' }, ...over,
  };
}

function ctx(over: Partial<ValidateContext> = {}): ValidateContext {
  return {
    message: message(), shortlist: [entry('P1', 'p-tank', 0.6)], tenderTeam: team, today: '2026-11-25', ...over,
  };
}

const reasonsOf = (d: Decision): string[] => (d.action === 'review' ? d.reasons : []);

test('rule 1: not_a_tender is ignored', () => {
  assert.deepEqual(validateForm(form({ kind: 'not_a_tender', matched_project: 'none' }), ctx()), { action: 'ignore', reason: 'not_a_tender' });
});

test('rule 2: a sent kind in an inbox email becomes update; a received kind in a sent email becomes reply_or_follow_up', () => {
  const inbox = validateForm(form({ kind: 'queries_sent' }), ctx());
  assert.equal(inbox.action === 'apply' || inbox.action === 'review', true);
  if (inbox.action !== 'ignore') assert.equal(inbox.form?.kind, 'update');

  const sent = validateForm(form({ kind: 'postponed', direction: 'sent' }), ctx({ message: message({ folder: 'sent' }) }));
  if (sent.action !== 'ignore') {
    assert.equal(sent.form?.kind, 'reply_or_follow_up');
    assert.equal(sent.form?.direction, 'sent');
  }
});

test('rule 3: an unknown ref (including none) is unknown_project with no project', () => {
  const d = validateForm(form({ matched_project: 'P9' }), ctx());
  assert.equal(d.action, 'review');
  assert.deepEqual(reasonsOf(d), ['unknown_project']);
  if (d.action === 'review') assert.equal(d.form?.projectId, null);
});

test('rule 4: runners-up are known refs other than the matched one, first two only', () => {
  const sl = [entry('P1', 'p-tank'), entry('P2', 'p-wall'), entry('P3', 'p-elec'), entry('P4', 'p-sewer')];
  // P1 is the matched ref (dropped), P9 is unknown (dropped), P2 is a third runner-up (dropped by the max of 2).
  const d = validateForm(form({ other_possible_projects: ['P1', 'P9', 'P4', 'P3', 'P2'], confidence: { match: 'low', facts: 'high' } }), ctx({ shortlist: sl }));
  assert.deepEqual(reasonsOf(d), ['low_match_confidence', 'tie']);
  if (d.action === 'review') assert.deepEqual(d.candidates.map((c) => c.ref), ['P1', 'P4', 'P3']);
});

test('rule 5: new_project matched to a board project becomes update', () => {
  const d = validateForm(form({ kind: 'new_project', matched_project: 'P1', project_name: 'x' }), ctx());
  assert.equal(d.action, 'apply');
  if (d.action === 'apply') {
    assert.equal(d.form.kind, 'update');
    assert.equal(d.form.projectId, 'p-tank');
  }
});

test('rule 6: new tender without project: missing_title, and possible_duplicate at score >= 0.75', () => {
  const sl = [entry('P1', 'p-tank', 0.8)];
  const noName = validateForm(form({ kind: 'new_project', matched_project: 'new', project_name: '  ' }), ctx({ shortlist: sl }));
  assert.deepEqual(reasonsOf(noName), ['missing_title', 'possible_duplicate']);

  const notNew = validateForm(form({ kind: 'update', matched_project: 'new' }), ctx());
  assert.deepEqual(reasonsOf(notNew), ['update_without_project']);

  const dup = validateForm(form({ kind: 'new_project', matched_project: 'new', project_name: 'Tank' }), ctx({ shortlist: sl }));
  assert.deepEqual(reasonsOf(dup), ['possible_duplicate']);

  const fine = validateForm(form({ kind: 'new_project', matched_project: 'new', project_name: 'Tank' }), ctx({ shortlist: [entry('P1', 'p-tank', 0.7)] }));
  assert.equal(fine.action, 'apply');
});

test('rule 7: low match confidence; medium without conversation match is low; medium with one is apply', () => {
  assert.deepEqual(reasonsOf(validateForm(form({ confidence: { match: 'low', facts: 'high' } }), ctx())), ['low_match_confidence']);
  assert.deepEqual(
    reasonsOf(validateForm(form({ confidence: { match: 'medium', facts: 'high' } }), ctx())),
    ['low_match_confidence'],
  );
  const threadHit = validateForm(
    form({ confidence: { match: 'medium', facts: 'high' } }),
    ctx({ shortlist: [entry('P1', 'p-tank', 0.95, true)] }),
  );
  assert.equal(threadHit.action, 'apply');
});

test('rule 8: runners-up with a non-high match give tie', () => {
  const sl = [entry('P1', 'p-tank'), entry('P2', 'p-wall')];
  assert.deepEqual(reasonsOf(validateForm(form({ other_possible_projects: ['P2'], confidence: { match: 'medium', facts: 'high' } }), ctx({ shortlist: sl }))), ['low_match_confidence', 'tie']);
  // a high match suppresses the tie even with runners-up
  assert.equal(validateForm(form({ other_possible_projects: ['P2'] }), ctx({ shortlist: sl })).action, 'apply');
});

test('rule 9: impossible dates and far years are bad_date; past dates are past_date; low facts add low_fact_confidence', () => {
  const feb30 = validateForm(form({ submission_date: '2026-02-30' }), ctx());
  assert.deepEqual(reasonsOf(feb30), ['bad_date']);
  if (feb30.action === 'review') assert.equal(feb30.form?.submissionDate, null);

  const far = validateForm(form({ submission_date: '2031-01-01' }), ctx());
  assert.ok(reasonsOf(far).includes('bad_date'));
  if (far.action === 'review') assert.equal(far.form?.submissionDate, null);

  const lowFacts = validateForm(form({ submission_date: '2027-01-10', confidence: { match: 'high', facts: 'low' } }), ctx());
  assert.deepEqual(reasonsOf(lowFacts), ['low_fact_confidence']);

  const ok = validateForm(form({ submission_date: '2027-01-10' }), ctx());
  assert.equal(ok.action, 'apply');
  if (ok.action === 'apply') assert.equal(ok.form.submissionDate, '2027-01-10');
});

test('rule 10: links must be http(s) and literally in the email; labels cut to 40 chars', () => {
  const d = validateForm(form({
    links: [
      { url: 'https://evil.example/steal', label: 'Portal' },
      { url: 'https://tenders.example/annex.pdf', label: 'A'.repeat(60) },
      { url: 'https://tenders.example/annex.pdf', label: 'dup' },
      { url: 'ftp://tenders.example/annex.pdf', label: 'ftp' },
      { url: 'https://tenders.example/other', label: '   ' },
    ],
  }), ctx());
  assert.equal(d.action, 'apply');
  if (d.action === 'apply') {
    assert.deepEqual(d.form.links, [
      { url: 'https://tenders.example/annex.pdf', label: 'A'.repeat(40) },
      { url: 'https://tenders.example/other', label: 'Link' },
    ]);
  }
});

test('rule 11: supervisor م/ شيرين maps to t-shreine and public; unknown supervisor keeps the AI tender type', () => {
  const d = validateForm(form({ supervisor_first_name: 'شيرين', tender_type: 'private' }), ctx());
  assert.equal(d.action, 'apply');
  if (d.action === 'apply') {
    assert.equal(d.form.tenderId, 't-shreine');
    assert.equal(d.form.tenderType, 'public');
    assert.equal(d.form.supervisor, 'شيرين');
  }
  const other = validateForm(form({ supervisor_first_name: 'نورا', tender_type: 'private' }), ctx());
  if (other.action === 'apply') {
    assert.equal(other.form.tenderId, null);
    assert.equal(other.form.tenderType, 'private');
  }
  const titled = validateForm(form({ supervisor_first_name: 'م/ شيرين محمود' }), ctx());
  if (titled.action === 'apply') assert.equal(titled.form.tenderId, 't-shreine');
});

test('rule 12: text fields are trimmed and capped; empty summary falls back', () => {
  const d = validateForm(form({ project_name: 'x'.repeat(400), summary: '   ', suggested_status: '', client: ' C ' }), ctx());
  assert.equal(d.action, 'apply');
  if (d.action === 'apply') {
    assert.equal(d.form.projectName, 'x'.repeat(300));
    assert.equal(d.form.summary, 'Email received');
    assert.equal(d.form.suggestedStatus, null);
    assert.equal(d.form.client, 'C');
  }
});

test('rule 13: review carries up to 3 candidates, matched first, then runners-up, then shortlist order', () => {
  const sl = [entry('P1', 'p-tank'), entry('P2', 'p-wall'), entry('P3', 'p-elec'), entry('P4', 'p-sewer')];
  const d = validateForm(form({ matched_project: 'P3', other_possible_projects: ['P2'], confidence: { match: 'low', facts: 'high' } }), ctx({ shortlist: sl }));
  assert.equal(d.action, 'review');
  if (d.action === 'review') {
    assert.deepEqual(d.candidates.map((c) => c.ref), ['P3', 'P2', 'P1']);
    assert.equal(d.form?.projectId, 'p-elec');
  }
  const apply = validateForm(form(), ctx());
  assert.equal(apply.action, 'apply');
});

test('fixture 08 injection: P9 and a foreign link are reviewed or dropped', () => {
  const f = JSON.parse(readFileSync(new URL('../fixtures/emails/08-injection.json', import.meta.url), 'utf8'));
  const msg = message({
    folder: 'inbox', bodyText: f.raw.body.content, subject: f.raw.subject, date: f.raw.receivedDateTime,
  });
  const d = validateForm(f.expect.aiForm, ctx({ message: msg, shortlist: [] }));
  assert.equal(d.action, 'review');
  if (d.action === 'review') {
    assert.deepEqual(d.reasons, ['unknown_project', 'past_date']);
    assert.deepEqual(d.form?.links.map((l) => l.url), ['https://tenders.example/notice']);
  }
});

test('isRealIsoDate', () => {
  assert.equal(isRealIsoDate('2027-01-10'), true);
  assert.equal(isRealIsoDate('2026-02-30'), false);
  assert.equal(isRealIsoDate('2028-02-29'), true);
  assert.equal(isRealIsoDate('2027-1-10'), false);
  assert.equal(isRealIsoDate('10/01/2027'), false);
});
