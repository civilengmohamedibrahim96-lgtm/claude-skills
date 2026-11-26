// Mail sync orchestrator: fetch Inbox + Sent through the mail client, then run each
// new message through prefilter -> shortlist -> AI -> validator -> apply/review.
import { focusMessage } from './forwarded.ts';
import type {
  AiInput,
  AiResult,
  ApplyResult,
  BoardProject,
  Decision,
  Folder,
  IsoDateTime,
  MailClient,
  MailMessage,
  MailRepository,
  MailRunSummary,
  PrefilterResult,
  ProcessedOutcome,
  ProcessedRecord,
  ReviewCandidate,
  ReviewReason,
  ShortlistEntry,
  StoredMessage,
  ValidateContext,
  ValidatedForm,
  AiForm,
  IsoDate,
} from './types.ts';
import { localDate } from './applier.ts';

export type MailSyncDeps = {
  repo: MailRepository;
  mail: MailClient;
  ai: (input: AiInput) => Promise<AiResult>;
  normalize: (raw: unknown, folder: Folder) => MailMessage | null;
  prefilter: (m: MailMessage) => PrefilterResult;
  shortlist: (m: MailMessage, projects: BoardProject[], conversationProjectIds: string[]) => ShortlistEntry[];
  validate: (form: AiForm, ctx: ValidateContext) => Decision;
  apply: (repo: MailRepository, form: ValidatedForm, m: MailMessage, now: Date, timeZone: string) => Promise<ApplyResult>;
  now: () => Date;
  timeZone: string;
  config: { lookbackHours: number; maxPerRun: number; overlapMinutes: number; maxAttempts: number; timeBudgetMs: number };
  log?: (msg: string, data?: unknown) => void;
};

const MAX_REVIEW_CANDIDATES = 3;

export function toStoredMessage(m: MailMessage): StoredMessage {
  const { bodyHtml: _bodyHtml, ...rest } = m;
  return { ...rest, bodyText: m.bodyText.slice(0, 20000) };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function emptySummary(trigger: 'cron' | 'manual', startedAt: IsoDateTime): MailRunSummary {
  return {
    runId: null,
    trigger,
    skipped: null,
    fetched: 0,
    alreadyProcessed: 0,
    prefiltered: 0,
    aiCalls: 0,
    applied: 0,
    created: 0,
    updated: 0,
    review: 0,
    ignored: 0,
    errors: 0,
    deferred: 0,
    startedAt,
    finishedAt: startedAt,
  };
}

function record(m: MailMessage, patch: Partial<ProcessedRecord> & { outcome: ProcessedOutcome }): ProcessedRecord {
  return {
    messageId: m.id,
    folder: m.folder,
    subject: m.subject,
    fromAddress: m.from?.address ?? null,
    receivedAt: m.date,
    attempts: 0,
    lastError: null,
    prefilterReason: null,
    projectId: null,
    mailEventId: null,
    reviewId: null,
    ...patch,
  };
}

function reviewCandidates(entries: ShortlistEntry[]): ReviewCandidate[] {
  return entries.slice(0, MAX_REVIEW_CANDIDATES).map((e) => ({
    projectId: e.project.id,
    title: e.project.title,
    score: e.score,
  }));
}

export async function runMailSync(deps: MailSyncDeps, trigger: 'cron' | 'manual'): Promise<MailRunSummary> {
  const started = deps.now();
  const summary = emptySummary(trigger, started.toISOString());
  let runId: string | null = null;
  let runError: string | null = null;

  try {
    const settings = await deps.repo.getMailSettings();
    if (trigger === 'cron' && !settings.hourlyEnabled) {
      summary.skipped = 'disabled';
    } else {
      runId = await deps.repo.startRun(trigger);
      if (runId === null) {
        summary.skipped = 'already_running';
      } else {
        summary.runId = runId;
        runError = await execute(deps, summary, settings.lastRunAt, started);
      }
    }
  } catch (err) {
    runError = errorText(err);
    summary.errors += 1;
    deps.log?.('mail sync failed', runError);
  }

  summary.finishedAt = deps.now().toISOString();
  if (runId !== null) {
    try {
      await deps.repo.finishRun(runId, summary, runError);
    } catch (err) {
      deps.log?.('could not finish mail run', errorText(err));
    }
  }
  return summary;
}

// Returns the error text when the run stopped early, otherwise null.
async function execute(
  deps: MailSyncDeps,
  summary: MailRunSummary,
  lastRunAt: IsoDateTime | null,
  started: Date,
): Promise<string | null> {
  const { repo, mail, config } = deps;
  const sinceMs = lastRunAt
    ? Date.parse(lastRunAt) - config.overlapMinutes * 60_000
    : started.getTime() - config.lookbackHours * 3_600_000;
  const since = new Date(sinceMs).toISOString();

  // 4. list both folders; any failure ends the run without moving lastRunAt
  const raws: { raw: unknown; folder: Folder }[] = [];
  const capped: Folder[] = [];
  for (const folder of ['inbox', 'sent'] as Folder[]) {
    try {
      const items = await mail.listMessages(folder, since, config.maxPerRun);
      // a full page means older-than-newest messages may be waiting beyond the cap
      if (items.length >= config.maxPerRun) capped.push(folder);
      for (const raw of items) raws.push({ raw, folder });
    } catch (err) {
      summary.errors += 1;
      const text = errorText(err);
      deps.log?.('mail list failed', { folder, error: text });
      return text;
    }
  }
  summary.fetched = raws.length;

  // 5. normalise, dedupe by id, oldest first; bodies are fetched later, per message
  const newestByFolder = new Map<Folder, number>();
  const byId = new Map<string, MailMessage>();
  for (const { raw, folder } of raws) {
    const m = deps.normalize(raw, folder);
    if (m === null) continue;
    const t = Date.parse(m.date);
    if (!Number.isNaN(t) && t > (newestByFolder.get(folder) ?? Number.NEGATIVE_INFINITY)) {
      newestByFolder.set(folder, t);
    }
    if (!byId.has(m.id)) byId.set(m.id, m);
  }
  const messages = [...byId.values()].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));

  // 6. skip what is done already
  const processed = await repo.getProcessed(messages.map((m) => m.id));
  const todo: MailMessage[] = [];
  for (const m of messages) {
    const rec = processed.get(m.id);
    if (rec && (rec.outcome !== 'error' || rec.attempts >= config.maxAttempts)) {
      summary.alreadyProcessed += 1;
      continue;
    }
    todo.push(m);
  }

  // 7. process one by one
  const failureDates: string[] = [];
  let aiQuotaHit = false;
  for (const m of todo) {
    if (aiQuotaHit || deps.now().getTime() - started.getTime() > config.timeBudgetMs) {
      summary.deferred += 1;
      failureDates.push(m.date);
      continue;
    }
    try {
      if (await processOne(deps, summary, m, processed.get(m.id), failureDates) === 'ai_quota') aiQuotaHit = true;
    } catch (err) {
      const text = errorText(err);
      deps.log?.('message failed', { id: m.id, error: text });
      const attempts = (processed.get(m.id)?.attempts ?? 0) + 1;
      try {
        await repo.markProcessed(record(m, { outcome: 'error', attempts, lastError: text }));
      } catch (recordErr) {
        deps.log?.('could not record failure', errorText(recordErr));
      }
      summary.errors += 1;
      failureDates.push(m.date);
    }
  }

  // 8. move lastRunAt, never past a deferred or failed message, nor past the newest
  //    message of a folder that hit the per-run cap (its older messages were listed, its
  //    newer ones were not)
  let nextMs = started.getTime();
  for (const d of failureDates) {
    const t = Date.parse(d);
    if (!Number.isNaN(t)) nextMs = Math.min(nextMs, t - 1000);
  }
  for (const folder of capped) {
    const newest = newestByFolder.get(folder);
    if (newest !== undefined) nextMs = Math.min(nextMs, newest);
  }
  await repo.setLastRunAt(new Date(nextMs).toISOString());
  return null;
}

// Bodies are missing from the listing; fetch the full message only when it is about to be
// processed (already processed messages never get here). Called inside the per-message try.
async function withBody(deps: MailSyncDeps, m: MailMessage): Promise<MailMessage> {
  if (m.bodyText === '' && m.bodyHtml === null) {
    const full = await deps.mail.getMessage(m.id);
    return deps.normalize(full, m.folder) ?? m;
  }
  return m;
}

const AI_QUOTA = /quota|resource[_ ]exhausted|rate limit|\b429\b/i;
const AI_BUSY = /high demand|overloaded|unavailable|try again later|\b503\b/i;
export const isAiQuotaError = (detail: string): boolean => AI_QUOTA.test(detail);
export const isAiCapacityError = (detail: string): boolean => AI_QUOTA.test(detail) || AI_BUSY.test(detail);

async function processOne(
  deps: MailSyncDeps,
  summary: MailRunSummary,
  listed: MailMessage,
  prev: ProcessedRecord | undefined,
  failureDates: string[],
): Promise<'ai_quota' | undefined> {
  const { repo } = deps;

  const full = await withBody(deps, listed);
  const pre = deps.prefilter(full);
  if (pre.skip) {
    await repo.markProcessed(record(full, { outcome: 'prefiltered', prefilterReason: pre.reason }));
    summary.prefiltered += 1;
    return;
  }
  // Only the forwarded original: no To/Cc lists, signatures or older quoted emails.
  const m = focusMessage(full);

  const projects = await repo.listOpenProjects();
  const convIds = m.conversationId ? await repo.findProjectIdsByConversation(m.conversationId) : [];
  const shortlist = deps.shortlist(m, projects, convIds);
  const tenderTeam = await repo.listTenderTeam();
  const examples = await repo.listMatchExamples(5);
  const today: IsoDate = localDate(deps.now().toISOString(), deps.timeZone);

  const result = await deps.ai({ message: m, shortlist, tenderTeam, examples, today });
  summary.aiCalls += 1;

  if (!result.ok) {
    if (result.retryable) {
      // Gemini busy or out of quota says nothing about this email: keep its attempts, and
      // on a quota error stop calling the AI for the rest of this run.
      const busy = isAiCapacityError(result.detail);
      await repo.markProcessed(record(m, {
        outcome: 'error',
        attempts: (prev?.attempts ?? 0) + (busy ? 0 : 1),
        lastError: result.detail,
      }));
      summary.errors += 1;
      failureDates.push(m.date);
      return isAiQuotaError(result.detail) ? 'ai_quota' : undefined;
    }
    const reason: ReviewReason = result.error === 'refusal'
      ? 'ai_refused'
      : result.error === 'max_tokens'
        ? 'ai_incomplete'
        : 'ai_bad_output';
    const reviewId = await repo.addReview({
      messageId: m.id,
      folder: m.folder,
      message: toStoredMessage(m),
      aiForm: null,
      validated: null,
      candidates: reviewCandidates(shortlist),
      reasons: [reason],
    });
    await repo.markProcessed(record(m, { outcome: 'review', reviewId }));
    summary.review += 1;
    return;
  }

  const decision = deps.validate(result.form, { message: m, shortlist, tenderTeam, today });

  if (decision.action === 'ignore') {
    await repo.markProcessed(record(m, { outcome: 'ignored' }));
    summary.ignored += 1;
    return;
  }

  if (decision.action === 'review') {
    const reviewId = await repo.addReview({
      messageId: m.id,
      folder: m.folder,
      message: toStoredMessage(m),
      aiForm: result.form,
      validated: decision.form,
      candidates: reviewCandidates(decision.candidates),
      reasons: decision.reasons,
    });
    await repo.markProcessed(record(m, { outcome: 'review', reviewId }));
    summary.review += 1;
    return;
  }

  const applied = await deps.apply(repo, decision.form, m, deps.now(), deps.timeZone);
  await repo.markProcessed(record(m, {
    outcome: 'applied',
    projectId: applied.projectId,
    mailEventId: applied.mailEventId,
  }));
  summary.applied += 1;
  if (applied.created) summary.created += 1;
  else summary.updated += 1;
}
