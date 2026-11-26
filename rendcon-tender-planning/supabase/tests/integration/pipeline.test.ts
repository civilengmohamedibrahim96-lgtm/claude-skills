// Full pipeline over the WP2 fixtures: normalise → prefilter → shortlist → (fake AI) →
// validate → apply / review. Runs only after all packages are merged (uses WP2 modules).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeGraphMessage } from '../../functions/_shared/mail_normalize.ts';
import { prefilter } from '../../functions/_shared/prefilter.ts';
import { buildShortlist } from '../../functions/_shared/shortlist.ts';
import { validateForm } from '../../functions/_shared/validator.ts';
import { applyForm } from '../../functions/_shared/applier.ts';
import { runMailSync } from '../../functions/_shared/mail_sync.ts';
import { resolveReview } from '../../functions/_shared/review.ts';
import { createMemoryMailRepository } from '../../functions/_shared/mail_repo_memory.ts';
import type {
  AiForm,
  AiInput,
  AiResult,
  ApplyResult,
  BoardProject,
  Folder,
  MailClient,
  MailMessage,
  MailRepository,
  ShortlistEntry,
  ValidatedForm,
} from '../../functions/_shared/types.ts';

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));
const board = JSON.parse(readFileSync(FIXTURES + 'board.json', 'utf8'));
const fixtures: any[] = [
  '01-new-tender', '02-postponed', '03-queries-answers', '04-queries-sent',
  '05-offer-submitted', '06-newsletter', '07-ambiguous-roads', '08-injection',
].map((name) => JSON.parse(readFileSync(`${FIXTURES}emails/${name}.json`, 'utf8')));
const byId = new Map<string, any>(fixtures.map((f) => [f.raw.id, f]));

function resolveRefs(form: AiForm, shortlist: ShortlistEntry[]): AiForm {
  const refOf = (v: string): string => {
    if (!v.startsWith('@')) return v;
    const id = v.slice(1);
    const entry = shortlist.find((s) => s.project.id === id);
    if (!entry) throw new Error(`fixture expects ${id} in the shortlist`);
    return entry.ref;
  };
  return {
    ...form,
    matched_project: refOf(form.matched_project),
    other_possible_projects: form.other_possible_projects.map(refOf),
  };
}

function fakeMail(): MailClient {
  return {
    async listMessages(folder: Folder) {
      return fixtures.filter((f) => f.folder === folder).map((f) => f.raw);
    },
    async getMessage(id: string) {
      return byId.get(id)?.raw ?? null;
    },
    async sendMail() {
      throw new Error('not used in the pipeline');
    },
  };
}

function build(now: Date) {
  const repo = createMemoryMailRepository({
    projects: board.projects as BoardProject[],
    tenderTeam: board.tenderTeam,
    conversations: board.conversations,
    lastRunAt: null,
    hourlyEnabled: true,
  });
  const applied = new Map<string, ApplyResult>();
  const deps = {
    repo,
    mail: fakeMail(),
    ai: async (input: AiInput): Promise<AiResult> => {
      const f = byId.get(input.message.id);
      if (!f || !f.expect.aiForm) throw new Error(`no fixture AI output for ${input.message.id}`);
      return {
        ok: true,
        form: resolveRefs(f.expect.aiForm as AiForm, input.shortlist),
        model: 'fixture',
        inputTokens: 0,
        outputTokens: 0,
      };
    },
    normalize: normalizeGraphMessage,
    prefilter,
    shortlist: (m: MailMessage, projects: BoardProject[], conv: string[]) => buildShortlist(m, projects, conv),
    validate: (form: AiForm, ctx: any) => validateForm(form, ctx),
    apply: async (r: MailRepository, form: ValidatedForm, m: MailMessage, n: Date, tz: string) => {
      const result = await applyForm(r, form, m, n, tz);
      applied.set(m.id, result);
      return result;
    },
    now: () => now,
    timeZone: board.timeZone,
    config: { lookbackHours: 48, maxPerRun: 60, overlapMinutes: 30, maxAttempts: 3, timeBudgetMs: 110000 },
  };
  return { repo, deps, applied };
}

const NOW = new Date('2026-11-25T11:00:00Z');

describe('pipeline over the fixtures', () => {
  test('first run: summary matches the fixture expectations', async () => {
    const { deps } = build(NOW);
    const s = await runMailSync(deps, 'manual');
    assert.equal(s.fetched, 8);
    assert.equal(s.prefiltered, 1);
    assert.equal(s.aiCalls, 7);
    assert.equal(s.created, 1);
    assert.equal(s.updated, 4);
    assert.equal(s.review, 2);
    assert.equal(s.ignored, 0);
    assert.equal(s.errors, 0);
  });

  test('per-fixture board expectations hold', async () => {
    const { repo, deps, applied } = build(NOW);
    await runMailSync(deps, 'manual');
    const dump = repo.dump();

    for (const f of fixtures) {
      const exp = f.expect.board;
      if (!exp) continue;
      const rec = dump.processed.get(f.raw.id);
      assert.ok(rec?.projectId, `${f.name} has a project`);
      const project = dump.projects.find((p) => p.id === rec!.projectId);
      assert.ok(project, `${f.name} project exists`);
      if (exp.project !== 'new') assert.equal(project.id, exp.project, f.name);
      for (const tag of exp.tagsInclude ?? []) assert.ok(project.tags.includes(tag), `${f.name} tag ${tag}`);
      if (exp.due !== undefined) assert.equal(project.dueOn, exp.due, `${f.name} due`);
      if (exp.status !== undefined) assert.equal(project.status, exp.status, `${f.name} status`);
      const result = applied.get(f.raw.id);
      const linksAdded = Number((result?.changes ?? []).find((c) => c.startsWith('links:'))?.split(':')[1] ?? 0);
      if (exp.linksAdded !== undefined) assert.equal(linksAdded, exp.linksAdded, `${f.name} linksAdded`);
      const dc = dump.dateChanges.find((d) => d.mailEventId === rec!.mailEventId);
      if (exp.dateChange === null) assert.equal(dc, undefined, `${f.name} no date change`);
      else if (exp.dateChange) {
        assert.ok(dc, `${f.name} date change`);
        assert.equal(dc.fromDate, exp.dateChange.from, `${f.name} from`);
        assert.equal(dc.toDate, exp.dateChange.to, `${f.name} to`);
      }
    }

    const mailEventCount = fixtures.filter((f) => f.expect.board).length;
    assert.equal(dump.mailEvents.length, mailEventCount);
  });

  test('second run: everything already processed, no AI calls', async () => {
    const { repo, deps } = build(NOW);
    await runMailSync(deps, 'manual');
    const again = await runMailSync(deps, 'manual');
    assert.equal(again.alreadyProcessed, 8);
    assert.equal(again.aiCalls, 0);
    assert.equal(repo.dump().projects.length, board.projects.length + 1);
  });

  test('fixture 07 review resolves to the expected board state', async () => {
    const f7 = fixtures.find((f) => f.name === '07-ambiguous-roads');
    const { repo, deps } = build(NOW);
    await runMailSync(deps, 'manual');
    const review = repo.dump().reviews.find((r) => r.messageId === f7.raw.id);
    assert.ok(review, 'fixture 07 is in the review queue');

    const exp = f7.expect.resolveAs;
    const res = await resolveReview(
      { repo, apply: deps.apply, now: () => NOW, timeZone: board.timeZone },
      review.id,
      { action: exp.action, projectId: exp.projectId },
      'Mohamed Ibrahim',
    );
    assert.deepEqual(res, { ok: true, projectId: exp.projectId });

    const dump = repo.dump();
    const project = dump.projects.find((p) => p.id === exp.board.project);
    assert.ok(project);
    for (const tag of exp.board.tagsInclude) assert.ok(project.tags.includes(tag), `tag ${tag}`);
    assert.equal(project.dueOn, exp.board.due);
    const dc = dump.dateChanges.find((d) => d.projectId === exp.board.project && d.toDate === exp.board.dateChange.to);
    assert.ok(dc, 'date change recorded');
    assert.equal(dc.fromDate, exp.board.dateChange.from);
    assert.equal(dump.examples.length, 1);
    assert.equal(dump.examples[0].chosen, 'existing');
  });
});
