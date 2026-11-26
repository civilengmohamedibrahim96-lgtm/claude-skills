import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeGraphMessage } from '../../functions/_shared/mail_normalize.ts';
import { prefilter } from '../../functions/_shared/prefilter.ts';
import { buildShortlist } from '../../functions/_shared/shortlist.ts';
import { validateForm } from '../../functions/_shared/validator.ts';
import type { AiForm, BoardProject, ShortlistEntry, TenderMember } from '../../functions/_shared/types.ts';

const board = JSON.parse(readFileSync(new URL('../fixtures/board.json', import.meta.url), 'utf8'));
const projects: BoardProject[] = board.projects;
const tenderTeam: TenderMember[] = board.tenderTeam;
const conversationIds = (id: string | null): string[] => (id ? board.conversations[id] ?? [] : []);

const NAMES = [
  '01-new-tender', '02-postponed', '03-queries-answers', '04-queries-sent',
  '05-offer-submitted', '06-newsletter', '07-ambiguous-roads', '08-injection',
];

// Replaces "@<project id>" placeholders in the expected AI form with the shortlist ref of that project.
// Fails the test when the project is not in the shortlist, so the fixture cannot quietly pass.
function fakeAiForm(expected: AiForm, shortlist: ShortlistEntry[]): AiForm {
  const refOf = (id: string): string => {
    const hit = shortlist.find((e) => e.project.id === id);
    assert.ok(hit, `project ${id} is not in the shortlist`);
    return hit.ref;
  };
  const resolve = (v: string): string => (v.startsWith('@') ? refOf(v.slice(1)) : v);
  const form = structuredClone(expected);
  form.matched_project = resolve(form.matched_project);
  form.other_possible_projects = form.other_possible_projects.map(resolve);
  return form;
}

for (const name of NAMES) {
  test(`fixture ${name}`, () => {
    const f = JSON.parse(readFileSync(new URL(`../fixtures/emails/${name}.json`, import.meta.url), 'utf8'));
    const m = normalizeGraphMessage(f.raw, f.folder);
    assert.ok(m, 'normalizes');

    const pf = prefilter(m);
    if (f.expect.prefilter) {
      assert.deepEqual(pf, { skip: true, reason: f.expect.prefilter });
      assert.equal(f.expect.decision, 'prefiltered');
      assert.equal(f.expect.aiForm, null);
      return; // no AI call for prefiltered mail
    }
    assert.deepEqual(pf, { skip: false, reason: null });

    const shortlist = buildShortlist(m, projects, conversationIds(m.conversationId));
    if (f.expect.shortlistTop) assert.equal(shortlist[0].project.id, f.expect.shortlistTop);
    for (const id of f.expect.shortlistIncludes) {
      assert.ok(shortlist.some((e) => e.project.id === id), `${id} in shortlist`);
    }

    const form = fakeAiForm(f.expect.aiForm, shortlist);
    const decision = validateForm(form, { message: m, shortlist, tenderTeam, today: board.today });

    assert.equal(decision.action, f.expect.decision);
    const reasons = decision.action === 'review' ? [...decision.reasons].sort() : [];
    assert.deepEqual(reasons, [...f.expect.reviewReasons].sort());

    if (decision.action === 'ignore') return;
    const v = decision.form!;
    const exp = f.expect.validated;
    assert.equal(v.projectId, exp.projectId, 'projectId');
    assert.equal(v.kind, exp.kind, 'kind');
    assert.equal(v.submissionDate, exp.submissionDate, 'submissionDate');
    assert.equal(v.tenderId, exp.tenderId, 'tenderId');
    assert.equal(v.tenderType, exp.tenderType, 'tenderType');
    assert.equal(v.supervisor, exp.supervisor, 'supervisor');
    assert.equal(v.links.length, exp.linksCount, 'linksCount');
  });
}

test('fixture 07: review candidates include both roads projects', () => {
  const f = JSON.parse(readFileSync(new URL('../fixtures/emails/07-ambiguous-roads.json', import.meta.url), 'utf8'));
  const m = normalizeGraphMessage(f.raw, f.folder)!;
  const shortlist = buildShortlist(m, projects, []);
  const form = fakeAiForm(f.expect.aiForm, shortlist);
  const d = validateForm(form, { message: m, shortlist, tenderTeam, today: board.today });
  assert.equal(d.action, 'review');
  if (d.action === 'review') {
    const ids = d.candidates.map((c) => c.project.id);
    assert.ok(ids.includes('p-roads2') && ids.includes('p-roads3'), ids.join(','));
  }
});
