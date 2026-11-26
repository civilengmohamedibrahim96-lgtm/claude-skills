// Reminder scheduling and expansion. Pure functions: no I/O, no clock reads (callers pass `now`).
import type { AutoKind, AutoReminder, IsoDate, Person, Repeat, ReminderProject } from './types.ts';

export const REPEAT_MS: Record<Exclude<Repeat, 'none'>, number> = {
  hourly: 3600000,
  daily: 86400000,
  weekly: 604800000,
};

const DAY_MS = 86400000;
const AUTO_DAYS: Record<AutoKind, number> = { due3: 3, due1: 1 };

// Next occurrence strictly after nowMs; an `at` still in the future is returned as is.
export function nextOccurrence(atMs: number, repeat: Repeat, nowMs: number): number | null {
  if (repeat === 'none') return null;
  const step = REPEAT_MS[repeat];
  if (atMs > nowMs) return atMs;
  const k = Math.floor((nowMs - atMs) / step) + 1;
  return atMs + k * step;
}

export function addDays(d: IsoDate, days: number): IsoDate {
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd + days)).toISOString().slice(0, 10);
}

// Offset of timeZone from UTC at the given instant, in minutes (Cairo in winter: +120).
export function tzOffsetMinutes(utcMs: number, timeZone: string): number {
  const whole = Math.floor(utcMs / 1000) * 1000;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(whole));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return (asUtc - whole) / 60000;
}

export function zonedTimeToUtc(date: IsoDate, hour: number, minute: number, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  const off1 = tzOffsetMinutes(guess, timeZone);
  let t = guess - off1 * 60000;
  const off2 = tzOffsetMinutes(t, timeZone);
  if (off2 !== off1) t = guess - off2 * 60000;
  return new Date(t);
}

// Calendar date of an instant in the given time zone.
export function localDate(at: Date, timeZone: string): IsoDate {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

export function shortTitle(title: string, max = 40): string {
  return title.length > max ? title.slice(0, max - 2) + '…' : title;
}

// 'all' → every active person; 'assignee' → the project's assignee (none if unassigned); otherwise a person id.
// Deduplicated, inactive people dropped, returned in the order of `people`.
export function resolveRecipients(recipients: string[], people: Person[], project: ReminderProject | null): Person[] {
  const all = recipients.includes('all');
  const wanted = new Set<string>();
  for (const r of recipients) {
    if (r === 'all') continue;
    if (r === 'assignee') {
      if (project?.assigneeId) wanted.add(project.assigneeId);
    } else {
      wanted.add(r);
    }
  }
  return people.filter((p) => p.active && (all || wanted.has(p.id)));
}

export function autoKey(projectId: string, kind: AutoKind, dueOn: IsoDate): string {
  return `${projectId}|${kind}|${dueOn}`;
}

// Automatic "3 days" / "1 day" before-submission reminders, due at 09:00 local time, valid for 24 h.
export function dueAutoReminders(
  projects: ReminderProject[],
  now: Date,
  timeZone: string,
  sentKeys: Set<string>,
): AutoReminder[] {
  const nowMs = now.getTime();
  const out: AutoReminder[] = [];
  for (const p of projects) {
    if (!p.dueOn || p.archived || p.tags.includes('sub')) continue;
    const hits: AutoReminder[] = [];
    for (const kind of ['due3', 'due1'] as AutoKind[]) {
      const fireAt = zonedTimeToUtc(addDays(p.dueOn, -AUTO_DAYS[kind]), 9, 0, timeZone).getTime();
      if (nowMs < fireAt || nowMs - fireAt >= DAY_MS) continue;
      if (sentKeys.has(autoKey(p.id, kind, p.dueOn))) continue;
      hits.push({
        projectId: p.id,
        kind,
        dueOn: p.dueOn,
        fireAt: new Date(fireAt).toISOString(),
        message: kind === 'due1' ? `Submission tomorrow: ${p.title}` : `Submission in 3 days: ${p.title}`,
      });
    }
    const pick = hits.find((h) => h.kind === 'due1') ?? hits[0];
    if (pick) out.push(pick);
  }
  return out;
}

export function reminderTitle(project: ReminderProject | null): string {
  return project ? 'Reminder · ' + shortTitle(project.title) : 'Reminder';
}
