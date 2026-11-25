// Resolves a "Needs review" item chosen by a person: assign to a project, create a
// new project, or dismiss. Stores a match example so future suggestions improve.
import type {
  ActionKind,
  AiForm,
  ApplyResult,
  MailMessage,
  MailRepository,
  MailReviewResponse,
  ReviewRecord,
  ReviewResolution,
  ValidatedForm,
  ProcessedRecord,
  Folder,
  Direction,
} from './types.ts';
import type { MailSyncDeps } from './mail_sync.ts';

export type ReviewDeps = {
  repo: MailRepository;
  apply: MailSyncDeps['apply'];
  now: () => Date;
  timeZone: string;
};

const ACTION_KINDS: ActionKind[] = [
  'new_project', 'update', 'postponed', 'queries_answers',
  'queries_sent', 'offer_submitted', 'extension_requested', 'reply_or_follow_up',
];

function isActionKind(x: unknown): x is ActionKind {
  return typeof x === 'string' && (ACTION_KINDS as string[]).includes(x);
}

function messageOnlyForm(folder: Folder, message: MailMessage, personName: string): ValidatedForm {
  const direction: Direction = folder === 'inbox' ? 'received' : 'sent';
  const kind: ActionKind = folder === 'inbox' ? 'update' : 'reply_or_follow_up';
  const summary = `Email linked by ${personName}`;
  const raw: AiForm = {
    direction,
    kind: kind as AiForm['kind'],
    matched_project: 'none',
    match_reason: '',
    other_possible_projects: [],
    project_name: message.subject,
    client: null,
    submission_date: null,
    submission_date_source: null,
    tender_type: 'unknown',
    supervisor_first_name: null,
    links: [],
    suggested_status: null,
    summary,
    confidence: { match: 'high', facts: 'low' },
  };
  return {
    direction,
    kind,
    projectId: null,
    projectName: message.subject,
    client: null,
    submissionDate: null,
    submissionDateSource: null,
    tenderType: null,
    tenderId: null,
    supervisor: null,
    links: [],
    suggestedStatus: null,
    summary,
    matchReason: '',
    confidence: { match: 'high', facts: 'low' },
    raw,
  };
}

function formFromAi(review: ReviewRecord, message: MailMessage, personName: string): ValidatedForm {
  const ai = review.aiForm;
  if (!ai) return messageOnlyForm(review.folder, message, personName);
  const base = messageOnlyForm(review.folder, message, personName);
  const kind: ActionKind = isActionKind(ai.kind) ? ai.kind : base.kind;
  const body = message.bodyText;
  return {
    ...base,
    kind,
    projectName: ai.project_name?.trim() || message.subject,
    client: ai.client?.trim() || null,
    submissionDate: ai.submission_date,
    submissionDateSource: ai.submission_date_source,
    tenderType: ai.tender_type === 'unknown' ? null : ai.tender_type,
    supervisor: ai.supervisor_first_name?.trim() || null,
    // Only links that literally occur in the email.
    links: ai.links.filter((l) => /^https?:\/\//.test(l.url) && body.includes(l.url)),
    suggestedStatus: ai.suggested_status,
    summary: ai.summary || base.summary,
    matchReason: ai.match_reason,
    confidence: ai.confidence,
    raw: ai,
  };
}

function aiSuggestionTitle(review: ReviewRecord): string | null {
  const ref = review.aiForm?.matched_project?.trim();
  if (!ref) return null;
  if (ref === 'new') return 'new';
  const match = /^P(\d+)$/.exec(ref);
  if (!match) return null;
  const candidate = review.candidates[Number(match[1]) - 1];
  return candidate ? candidate.title : null;
}

export async function resolveReview(
  deps: ReviewDeps,
  reviewId: string,
  resolution: ReviewResolution,
  personName: string,
): Promise<MailReviewResponse> {
  const { repo } = deps;
  const review = await repo.getReview(reviewId);
  if (!review || review.status !== 'open') return { ok: false, error: 'not_found_or_closed' };

  if (resolution.action === 'dismiss') {
    await repo.closeReview(reviewId, 'dismissed', personName, resolution);
    return { ok: true, projectId: null };
  }

  let chosenTitle: string | null;
  if (resolution.action === 'assign') {
    const target = await repo.getProject(resolution.projectId);
    if (!target) return { ok: false, error: 'project_not_found' };
    chosenTitle = target.title;
  } else {
    chosenTitle = null; // filled from the form below
  }

  const message: MailMessage = { ...review.message, bodyHtml: null };
  const form: ValidatedForm = review.validated
    ? { ...review.validated, links: [...review.validated.links] }
    : formFromAi(review, message, personName);

  if (resolution.action === 'assign') {
    form.projectId = resolution.projectId;
    if (form.kind === 'new_project') form.kind = 'update';
  } else {
    form.projectId = null;
    form.kind = 'new_project';
    form.projectName = form.projectName || message.subject;
    chosenTitle = form.projectName;
  }

  const applied: ApplyResult = await deps.apply(repo, form, message, deps.now(), deps.timeZone);

  await repo.closeReview(reviewId, 'resolved', personName, resolution);

  const previous: ProcessedRecord | undefined = (await repo.getProcessed([review.messageId])).get(review.messageId);
  const processed: ProcessedRecord = previous ?? {
    messageId: review.messageId,
    folder: review.folder,
    subject: message.subject,
    fromAddress: message.from?.address ?? null,
    receivedAt: message.date,
    outcome: 'review',
    attempts: 0,
    lastError: null,
    prefilterReason: null,
    projectId: null,
    mailEventId: null,
    reviewId: null,
  };
  await repo.markProcessed({
    ...processed,
    outcome: 'applied',
    lastError: null,
    projectId: applied.projectId,
    mailEventId: applied.mailEventId,
    reviewId,
  });

  await repo.addMatchExample({
    subject: message.subject,
    excerpt: message.bodyText.slice(0, 300),
    chosen: resolution.action === 'assign' ? 'existing' : 'new',
    chosenTitle,
    aiSuggestion: aiSuggestionTitle(review),
    reviewId,
    createdBy: personName,
  });

  return { ok: true, projectId: applied.projectId };
}

