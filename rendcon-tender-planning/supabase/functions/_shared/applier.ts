// Applies a validated mail decision to the board: creates or updates a project,
// records the mail event, date change, tags, links and the system comment.
import type {
  ActionKind,
  ApplyResult,
  IsoDate,
  IsoDateTime,
  MailMessage,
  MailRepository,
  ProjectPatch,
  TagId,
  ValidatedForm,
} from './types.ts';

export function fmtDateEn(d: IsoDate): string {
  const fmt = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return fmt.format(new Date(d + 'T00:00:00Z')).replace('Sept', 'Sep');
}

export function localDate(at: IsoDateTime, timeZone: string): IsoDate {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(at));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export const KIND_TAGS: Record<ActionKind, TagId[]> = {
  new_project: ['new', 'un'],
  update: ['upd'],
  postponed: ['pp'],
  queries_answers: ['qa'],
  offer_submitted: ['sub'],
  queries_sent: [],
  extension_requested: [],
  reply_or_follow_up: [],
};

export function defaultStatus(form: ValidatedForm): string | null {
  if (form.suggestedStatus) return form.suggestedStatus;
  switch (form.kind) {
    case 'new_project':
      return 'Received by email – needs an engineer';
    case 'update':
      return 'New update received by email';
    case 'postponed':
      return form.submissionDate
        ? 'Postponed to ' + fmtDateEn(form.submissionDate)
        : 'Postponed by client – new date to be announced';
    case 'queries_answers':
      return 'Answers to queries received – review';
    case 'queries_sent':
      return 'Queries sent to client – waiting for answers';
    case 'offer_submitted':
      return 'Submitted';
    case 'extension_requested':
      return 'Extension requested from client';
    case 'reply_or_follow_up':
      return null;
    default:
      return null;
  }
}

const DATE_KINDS: ActionKind[] = ['update', 'postponed', 'queries_answers'];

export async function applyForm(
  repo: MailRepository,
  form: ValidatedForm,
  m: MailMessage,
  now: Date,
  timeZone: string,
): Promise<ApplyResult> {
  void now; // reserved: timestamps are written by the database
  const changes: string[] = [];
  const kind: ActionKind = form.projectId === null ? 'new_project' : form.kind;
  const linkInputs = form.links.map((l) => ({ url: l.url, title: l.label }));

  if (form.projectId === null) {
    const status = defaultStatus({ ...form, kind }) ?? '';
    const projectId = await repo.createProject({
      title: (form.projectName ?? '').trim() || m.subject,
      client: form.client ?? '',
      tenderType: form.tenderType ?? 'public',
      tenderId: form.tenderId,
      supervisor: form.supervisor,
      dueOn: form.submissionDate,
      receivedOn: localDate(m.date, timeZone),
      status,
      source: 'email',
      tags: [...KIND_TAGS.new_project],
      updatedBy: 'email',
    });
    changes.push('created');
    const mailEventId = await repo.addMailEvent(mailEventInput(projectId, 'new_project', form, m));
    await repo.addSystemComment(projectId, `Created from email: ${m.subject}`);
    const added = await repo.addLinks(projectId, linkInputs, mailEventId);
    if (added > 0) changes.push(`links:${added}`);
    if (form.tenderId) changes.push('tender');
    return { projectId, created: true, mailEventId, changes };
  }

  const project = await repo.getProject(form.projectId);
  if (!project) throw new Error('project not found');
  const projectId = project.id;
  const mailEventId = await repo.addMailEvent(mailEventInput(projectId, kind, form, m));

  const patch: ProjectPatch = { updatedBy: 'email' };
  const status = defaultStatus({ ...form, kind });
  if (status !== null) {
    patch.status = status;
    changes.push('status');
  }
  if (form.tenderId) {
    patch.tenderId = form.tenderId;
    patch.tenderType = form.tenderType ?? project.tenderType;
    patch.supervisor = form.supervisor ?? project.supervisor;
    changes.push('tender');
  } else if (!project.supervisor && form.supervisor) {
    patch.supervisor = form.supervisor;
    changes.push('supervisor');
  }

  const newDate = form.submissionDate;
  const dateChanged = DATE_KINDS.includes(kind) && newDate !== null && newDate !== project.dueOn;
  if (dateChanged) {
    patch.dueOn = newDate;
    changes.push(`due:${newDate}`);
  }

  await repo.updateProject(projectId, patch);

  if (dateChanged) {
    await repo.addDateChange({
      projectId,
      fromDate: project.dueOn,
      toDate: newDate,
      changedBy: 'email',
      mailEventId,
    });
  }

  const tags = KIND_TAGS[kind];
  if (tags.length > 0) {
    await repo.addTags(projectId, tags);
    changes.push(`tags:${tags.join(',')}`);
  }

  await repo.addSystemComment(projectId, `Email: ${m.subject}`);
  const added = await repo.addLinks(projectId, linkInputs, mailEventId);
  if (added > 0) changes.push(`links:${added}`);

  return { projectId, created: false, mailEventId, changes };
}

function mailEventInput(projectId: string, kind: ActionKind, form: ValidatedForm, m: MailMessage) {
  return {
    projectId,
    messageId: m.id,
    folder: m.folder,
    direction: form.direction,
    kind,
    summary: form.summary,
    subject: m.subject,
    fromAddress: m.from?.address ?? null,
    receivedAt: m.date,
    webLink: m.webLink,
    conversationId: m.conversationId,
    linksCount: form.links.length,
    aiForm: form.raw,
    matchReason: form.matchReason,
    confidence: form.confidence,
  };
}
