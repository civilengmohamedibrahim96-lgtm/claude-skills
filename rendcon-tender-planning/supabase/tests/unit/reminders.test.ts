import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  autoKey,
  dueAutoReminders,
  localDate,
  nextOccurrence,
  reminderTitle,
  resolveRecipients,
  shortTitle,
  zonedTimeToUtc,
} from '../../functions/_shared/reminders.ts';
import type { Person, ReminderProject } from '../../functions/_shared/types.ts';

const people: Person[] = [
  { id: 'a', name: 'Amal', email: 'amal@example.com', role: 'admin', active: true, prefs: { push: true, email: true } },
  { id: 'b', name: 'Bassem', email: 'bassem@example.com', role: 'engineer', active: true, prefs: { push: true, email: true } },
  { id: 'c', name: 'Carla', email: null, role: 'engineer', active: false, prefs: { push: true, email: true } },
];

function project(over: Partial<ReminderProject> = {}): ReminderProject {
  return { id: 'p1', title: 'Water tank', dueOn: '2026-12-01', assigneeId: 'b', tags: [], archived: false, ...over };
}

test('nextOccurrence', () => {
  const at = Date.parse('2026-11-25T10:00:00Z');
  assert.equal(nextOccurrence(at, 'none', Date.parse('2026-11-25T12:00:00Z')), null);
  // hourly from 10:00 at 12:30 -> 13:00
  assert.equal(nextOccurrence(at, 'hourly', Date.parse('2026-11-25T12:30:00Z')), Date.parse('2026-11-25T13:00:00Z'));
  // daily
  assert.equal(
    nextOccurrence(Date.parse('2026-11-20T09:00:00Z'), 'daily', Date.parse('2026-11-25T10:00:00Z')),
    Date.parse('2026-11-26T09:00:00Z'),
  );
  // weekly: 2026-11-01 09:00 + 4 weeks = 2026-11-29 09:00
  assert.equal(
    nextOccurrence(Date.parse('2026-11-01T09:00:00Z'), 'weekly', Date.parse('2026-11-25T10:00:00Z')),
    Date.parse('2026-11-29T09:00:00Z'),
  );
  // an `at` in the future stays the first occurrence
  const future = Date.parse('2026-12-01T09:00:00Z');
  assert.equal(nextOccurrence(future, 'hourly', Date.parse('2026-11-25T10:00:00Z')), future);
});

test('addDays and calendar helpers', () => {
  assert.equal(addDays('2026-12-01', -3), '2026-11-28');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(zonedTimeToUtc('2026-12-01', 9, 0, 'Africa/Cairo').toISOString(), '2026-12-01T07:00:00.000Z');
  assert.equal(localDate(new Date('2026-11-24T23:30:00Z'), 'Africa/Cairo'), '2026-11-25');
  assert.equal(localDate(new Date('2026-11-24T21:30:00Z'), 'Africa/Cairo'), '2026-11-24');
});

test('resolveRecipients', () => {
  assert.deepEqual(resolveRecipients(['all'], people, null).map((p) => p.id), ['a', 'b']);
  assert.deepEqual(resolveRecipients(['assignee'], people, project({ assigneeId: null })), []);
  assert.deepEqual(resolveRecipients(['assignee'], people, project()).map((p) => p.id), ['b']);
  // ids deduped, inactive dropped, people order kept
  assert.deepEqual(resolveRecipients(['b', 'c', 'a', 'b', 'assignee'], people, project()).map((p) => p.id), ['a', 'b']);
});

test('dueAutoReminders: 3-day reminder at 09:00 Cairo, valid for 24 h', () => {
  const p = project();
  const sent = new Set<string>();
  const at = (iso: string) => dueAutoReminders([p], new Date(iso), 'Africa/Cairo', sent);
  assert.equal(at('2026-11-28T06:59:00Z').length, 0);
  const hit = at('2026-11-28T07:00:00Z');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].kind, 'due3');
  assert.equal(hit[0].fireAt, '2026-11-28T07:00:00.000Z');
  assert.equal(hit[0].message, 'Submission in 3 days: Water tank');
  assert.equal(at('2026-11-29T06:59:00Z').length, 1);
  assert.equal(at('2026-11-29T07:00:00Z').length, 0);
});

test('dueAutoReminders: 1-day reminder', () => {
  const hit = dueAutoReminders([project()], new Date('2026-11-30T07:00:00Z'), 'Africa/Cairo', new Set());
  assert.equal(hit.length, 1);
  assert.equal(hit[0].kind, 'due1');
  assert.equal(hit[0].fireAt, '2026-11-30T07:00:00.000Z');
  assert.equal(hit[0].message, 'Submission tomorrow: Water tank');
});

test('dueAutoReminders: already sent key, submitted tag, archived, changed due date', () => {
  const now = new Date('2026-11-28T08:00:00Z');
  const sent = new Set([autoKey('p1', 'due3', '2026-12-01')]);
  assert.equal(dueAutoReminders([project()], now, 'Africa/Cairo', sent).length, 0);
  assert.equal(dueAutoReminders([project({ tags: ['sub'] })], now, 'Africa/Cairo', new Set()).length, 0);
  assert.equal(dueAutoReminders([project({ archived: true })], now, 'Africa/Cairo', new Set()).length, 0);
  // a changed due date is a new key, so the reminder fires again
  const moved = project({ dueOn: '2026-12-02' });
  const hit = dueAutoReminders([moved], new Date('2026-11-29T08:00:00Z'), 'Africa/Cairo', sent);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].dueOn, '2026-12-02');
});

test('shortTitle and reminderTitle', () => {
  const long = 'x'.repeat(50);
  const s = shortTitle(long);
  assert.equal(s.length, 39);
  assert.equal(s, 'x'.repeat(38) + '…');
  assert.equal(shortTitle('short'), 'short');
  assert.equal(reminderTitle(null), 'Reminder');
  assert.equal(reminderTitle(project({ title: 'Water tank' })), 'Reminder · Water tank');
});
