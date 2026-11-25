// Reminder orchestrator: due reminders, automatic before-submission reminders, "send now" and "test".
import type {
  MailClient,
  Person,
  PushPayload,
  PushSender,
  ReminderMode,
  ReminderProject,
  ReminderRepository,
  ReminderRunSummary,
} from './types.ts';
import { dueAutoReminders, localDate, nextOccurrence, reminderTitle, resolveRecipients } from './reminders.ts';

export type ReminderDeps = {
  repo: ReminderRepository;
  push: PushSender | null;                                   // null when VAPID keys are not configured
  mail: Pick<MailClient, 'sendMail'> | null;                 // null when Composio is not configured
  now: () => Date;
  timeZone: string;
  appUrl: string;
  log?: (msg: string, data?: unknown) => void;
};

function esc(s: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return s.replace(/[&<>"']/g, (c) => map[c]);
}

export function reminderEmailHtml(message: string, url: string): string {
  return `<p>${esc(message)}</p><p><a href="${esc(url)}">Open in Redcon Tender Planning</a></p><p style="color:#74746F;font-size:12px">Sent by Redcon Tender Planning</p>`;
}

function projectUrl(appUrl: string, project: ReminderProject | null): string {
  return project ? `${appUrl}/#p/${project.id}` : `${appUrl}/`;
}

export async function deliver(
  deps: ReminderDeps,
  people: Person[],
  payload: PushPayload,
  sendEmail: boolean,
  summary: ReminderRunSummary,
): Promise<{ pushCount: number; emailCount: number }> {
  let pushCount = 0;
  let emailCount = 0;
  if (people.length === 0) return { pushCount, emailCount };

  const subs = deps.push ? await deps.repo.listPushSubscriptions(people.map((p) => p.id)) : [];
  for (const person of people) {
    if (deps.push && person.prefs.push) {
      for (const sub of subs.filter((s) => s.personId === person.id)) {
        const outcome = await deps.push.send(sub, payload);
        if (outcome === 'ok') {
          pushCount++;
          summary.pushes++;
        } else if (outcome === 'gone') {
          await deps.repo.deletePushSubscription(sub.endpoint);
          summary.removedSubscriptions++;
        } else {
          summary.pushesFailed++;
        }
      }
    }
    if (sendEmail && person.prefs.email && person.email && deps.mail) {
      try {
        await deps.mail.sendMail({
          to: person.email,
          subject: `${payload.title}: ${payload.body}`,
          html: reminderEmailHtml(payload.body, payload.url),
        });
        emailCount++;
        summary.emails++;
      } catch (err) {
        summary.emailsFailed++;
        deps.log?.('reminder email failed', String(err));
      }
    }
  }
  return { pushCount, emailCount };
}

export async function runReminders(deps: ReminderDeps, mode: ReminderMode): Promise<ReminderRunSummary> {
  const summary: ReminderRunSummary = {
    reminders: 0,
    autoReminders: 0,
    pushes: 0,
    pushesFailed: 0,
    emails: 0,
    emailsFailed: 0,
    removedSubscriptions: 0,
    recipientNames: [],
  };
  const now = deps.now();
  const nowIso = now.toISOString();
  const appUrl = deps.appUrl.replace(/\/+$/, '');

  if (mode.kind === 'test') {
    const person = mode.person;
    await deliver(
      deps,
      [person],
      { title: 'Test reminder', body: 'Notifications are working for Redcon Tender Planning.', url: `${appUrl}/`, tag: 'test-' + nowIso },
      false,
      summary,
    );
    summary.recipientNames = [person.name];
    return summary;
  }

  if (mode.kind === 'now') {
    const input = mode.reminder;
    const people = await deps.repo.listPeople();
    const project = input.projectId ? await deps.repo.getProject(input.projectId) : null;
    const recipients = resolveRecipients(input.recipients, people, project);
    const { pushCount, emailCount } = await deliver(
      deps,
      recipients,
      { title: reminderTitle(project), body: input.message, url: projectUrl(appUrl, project), tag: 'now-' + nowIso },
      input.email,
      summary,
    );
    summary.recipientNames = recipients.map((p) => p.name);
    await deps.repo.recordDelivery({
      reminderId: null,
      projectId: project ? project.id : null,
      autoKind: null,
      dueOn: null,
      message: input.message,
      recipientNames: summary.recipientNames,
      pushCount,
      emailCount,
      sentAt: nowIso,
    });
    return summary;
  }

  // mode.kind === 'due'
  const people = await deps.repo.listPeople();

  const rows = await deps.repo.listDueReminders(nowIso);
  for (const row of rows) {
    const next = nextOccurrence(Date.parse(row.at), row.repeat, now.getTime());
    const claimed = await deps.repo.claimReminder(
      row.id,
      row.at,
      next === null ? { fired: true } : { at: new Date(next).toISOString() },
    );
    if (!claimed) continue;

    const project = row.projectId ? await deps.repo.getProject(row.projectId) : null;
    const recipients = resolveRecipients(row.recipients, people, project);
    const { pushCount, emailCount } = await deliver(
      deps,
      recipients,
      { title: reminderTitle(project), body: row.message, url: projectUrl(appUrl, project), tag: 'rem-' + row.id },
      row.email,
      summary,
    );
    await deps.repo.recordDelivery({
      reminderId: row.id,
      projectId: project ? project.id : null,
      autoKind: null,
      dueOn: null,
      message: row.message,
      recipientNames: recipients.map((p) => p.name),
      pushCount,
      emailCount,
      sentAt: nowIso,
    });
    summary.reminders++;
  }

  const today = localDate(now, deps.timeZone);
  const projects = await deps.repo.listProjectsWithDue(today);
  const keys = await deps.repo.listAutoKeys(today);
  for (const a of dueAutoReminders(projects, now, deps.timeZone, keys)) {
    const id = await deps.repo.claimAuto(a);
    if (id === null) continue;

    const project = projects.find((p) => p.id === a.projectId) ?? null;
    // Unassigned projects go to everybody.
    const recipients = resolveRecipients(project?.assigneeId ? ['assignee'] : ['all'], people, project);
    const { pushCount, emailCount } = await deliver(
      deps,
      recipients,
      { title: reminderTitle(project), body: a.message, url: projectUrl(appUrl, project), tag: `auto-${a.projectId}-${a.kind}` },
      true,
      summary,
    );
    await deps.repo.updateDelivery(id, {
      recipientNames: recipients.map((p) => p.name),
      pushCount,
      emailCount,
    });
    summary.autoReminders++;
  }

  return summary;
}
