import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runReminders, reminderEmailHtml } from '../../functions/_shared/send_reminders.ts';
import type { ReminderDeps } from '../../functions/_shared/send_reminders.ts';
import type {
  AutoReminder,
  DeliveryRecord,
  IsoDate,
  Person,
  PushOutcome,
  PushPayload,
  PushSender,
  PushSubscriptionRow,
  ReminderProject,
  ReminderRepository,
  ReminderRow,
} from '../../functions/_shared/types.ts';

const NOW = '2026-11-25T08:05:00.000Z';

const amal: Person = { id: 'a', name: 'Amal', email: 'amal@example.com', role: 'admin', active: true, prefs: { push: true, email: true } };
const bassem: Person = { id: 'b', name: 'Bassem', email: 'bassem@example.com', role: 'engineer', active: true, prefs: { push: true, email: true } };
const people = [amal, bassem];

const subs: PushSubscriptionRow[] = [
  { id: 's-a1', personId: 'a', endpoint: 'https://push.example/a1', p256dh: 'pa1', auth: 'aa1' },
  { id: 's-a2', personId: 'a', endpoint: 'https://push.example/a2', p256dh: 'pa2', auth: 'aa2' },
  { id: 's-b1', personId: 'b', endpoint: 'https://push.example/b1', p256dh: 'pb1', auth: 'ab1' },
];

const water: ReminderProject = { id: 'p1', title: 'Water tank', dueOn: null, assigneeId: null, tags: [], archived: false };
const pump: ReminderProject = { id: 'p2', title: 'Pump station', dueOn: '2026-11-28', assigneeId: null, tags: [], archived: false };

function oneOff(over: Partial<ReminderRow> = {}): ReminderRow {
  return {
    id: 'r1',
    projectId: 'p1',
    message: 'Call client',
    at: '2026-11-25T08:00:00.000Z',
    repeat: 'none',
    recipients: ['all'],
    email: true,
    fired: false,
    createdBy: null,
    ...over,
  };
}

function fakeRepo(opts: {
  people?: Person[];
  reminders?: ReminderRow[];
  projects?: ReminderProject[];
  subs?: PushSubscriptionRow[];
  claimResult?: boolean;
  autoClaimResult?: string | null;
}) {
  const rec = {
    claims: [] as { id: string; expectedAt: string; next: unknown }[],
    deleted: [] as string[],
    recorded: [] as DeliveryRecord[],
    updated: [] as { id: string; recipientNames: string[]; pushCount: number; emailCount: number }[],
    autoClaims: [] as AutoReminder[],
  };
  const all = opts.subs ?? subs;
  const repo: ReminderRepository = {
    async listPeople() {
      return opts.people ?? people;
    },
    async listDueReminders() {
      return opts.reminders ?? [];
    },
    async claimReminder(id, expectedAt, next) {
      rec.claims.push({ id, expectedAt, next });
      return opts.claimResult ?? true;
    },
    async getProject(id) {
      return [water, pump].find((p) => p.id === id) ?? null;
    },
    async listProjectsWithDue(_from: IsoDate) {
      return opts.projects ?? [];
    },
    async listAutoKeys() {
      return new Set<string>();
    },
    async claimAuto(a) {
      rec.autoClaims.push(a);
      return opts.autoClaimResult === undefined ? 'auto-1' : opts.autoClaimResult;
    },
    async listPushSubscriptions(ids) {
      return all.filter((s) => ids.includes(s.personId));
    },
    async deletePushSubscription(endpoint) {
      rec.deleted.push(endpoint);
    },
    async recordDelivery(d) {
      rec.recorded.push(d);
      return 'del-' + rec.recorded.length;
    },
    async updateDelivery(id, d) {
      rec.updated.push({ id, ...d });
    },
  };
  return { repo, rec };
}

function fakePush(outcome: (sub: PushSubscriptionRow) => PushOutcome = () => 'ok') {
  const sent: { sub: PushSubscriptionRow; payload: PushPayload }[] = [];
  const push: PushSender = {
    async send(sub, payload) {
      sent.push({ sub, payload });
      return outcome(sub);
    },
  };
  return { push, sent };
}

function fakeMail(failFor: string[] = []) {
  const sent: { to: string; subject: string; html: string }[] = [];
  return {
    mail: {
      async sendMail(msg: { to: string; subject: string; html: string }) {
        if (failFor.includes(msg.to)) throw new Error('smtp down');
        sent.push(msg);
      },
    },
    sent,
  };
}

function deps(repo: ReminderRepository, push: PushSender | null, mail: { sendMail(m: { to: string; subject: string; html: string }): Promise<void> } | null): ReminderDeps {
  return { repo, push, mail, now: () => new Date(NOW), timeZone: 'Africa/Cairo', appUrl: 'https://app.example' };
}

test('due one-off reminder: claimed as fired, pushed to every subscription, emailed, delivery recorded', async () => {
  const { repo, rec } = fakeRepo({ reminders: [oneOff()], projects: [] });
  const { push, sent: pushes } = fakePush();
  const { mail, sent: mails } = fakeMail();
  const summary = await runReminders(deps(repo, push, mail), { kind: 'due' });

  assert.deepEqual(rec.claims, [{ id: 'r1', expectedAt: '2026-11-25T08:00:00.000Z', next: { fired: true } }]);
  assert.equal(pushes.length, 3);
  assert.deepEqual(pushes.map((p) => p.sub.id).sort(), ['s-a1', 's-a2', 's-b1']);
  assert.equal(pushes[0].payload.title, 'Reminder · Water tank');
  assert.equal(pushes[0].payload.body, 'Call client');
  assert.equal(pushes[0].payload.url, 'https://app.example/#p/p1');
  assert.deepEqual(mails.map((m) => m.to), ['amal@example.com', 'bassem@example.com']);
  assert.equal(mails[0].subject, 'Reminder · Water tank: Call client');
  assert.equal(mails[0].html, reminderEmailHtml('Call client', 'https://app.example/#p/p1'));
  assert.equal(rec.recorded.length, 1);
  assert.equal(rec.recorded[0].reminderId, 'r1');
  assert.deepEqual(rec.recorded[0].recipientNames, ['Amal', 'Bassem']);
  assert.equal(rec.recorded[0].pushCount, 3);
  assert.equal(rec.recorded[0].emailCount, 2);
  assert.equal(summary.reminders, 1);
  assert.equal(summary.pushes, 3);
  assert.equal(summary.emails, 2);
});

test('daily reminder is claimed with the next occurrence instead of fired', async () => {
  const { repo, rec } = fakeRepo({ reminders: [oneOff({ repeat: 'daily' })], projects: [] });
  const { push } = fakePush();
  await runReminders(deps(repo, push, null), { kind: 'due' });
  assert.deepEqual(rec.claims, [
    { id: 'r1', expectedAt: '2026-11-25T08:00:00.000Z', next: { at: '2026-11-26T08:00:00.000Z' } },
  ]);
});

test('claim returning false sends nothing', async () => {
  const { repo, rec } = fakeRepo({ reminders: [oneOff()], projects: [], claimResult: false });
  const { push, sent } = fakePush();
  const { mail, sent: mails } = fakeMail();
  const summary = await runReminders(deps(repo, push, mail), { kind: 'due' });
  assert.equal(sent.length, 0);
  assert.equal(mails.length, 0);
  assert.equal(rec.recorded.length, 0);
  assert.equal(summary.reminders, 0);
});

test("'gone' subscription is deleted and counted", async () => {
  const { repo, rec } = fakeRepo({ reminders: [oneOff()], projects: [] });
  const { push } = fakePush((sub) => (sub.id === 's-a2' ? 'gone' : 'ok'));
  const summary = await runReminders(deps(repo, push, null), { kind: 'due' });
  assert.deepEqual(rec.deleted, ['https://push.example/a2']);
  assert.equal(summary.removedSubscriptions, 1);
  assert.equal(summary.pushes, 2);
});

test('a failing push counts pushesFailed', async () => {
  const { repo } = fakeRepo({ reminders: [oneOff()], projects: [] });
  const { push } = fakePush((sub) => (sub.id === 's-b1' ? 'error' : 'ok'));
  const summary = await runReminders(deps(repo, push, null), { kind: 'due' });
  assert.equal(summary.pushesFailed, 1);
  assert.equal(summary.pushes, 2);
});

test('a throwing sendMail counts emailsFailed and the run continues', async () => {
  const { repo, rec } = fakeRepo({ reminders: [oneOff()], projects: [] });
  const { push } = fakePush();
  const { mail, sent: mails } = fakeMail(['amal@example.com']);
  const summary = await runReminders(deps(repo, push, mail), { kind: 'due' });
  assert.equal(summary.emailsFailed, 1);
  assert.equal(summary.emails, 1);
  assert.deepEqual(mails.map((m) => m.to), ['bassem@example.com']);
  assert.equal(rec.recorded[0].emailCount, 1);
});

test('push null and mail null work without throwing', async () => {
  const { repo, rec } = fakeRepo({ reminders: [oneOff()], projects: [] });
  const summary = await runReminders(deps(repo, null, null), { kind: 'due' });
  assert.equal(summary.reminders, 1);
  assert.equal(summary.pushes + summary.emails, 0);
  assert.equal(rec.recorded[0].pushCount, 0);
  assert.equal(rec.recorded[0].emailCount, 0);
});

test('automatic reminder: unassigned project goes to everybody, claimed and updated', async () => {
  const { repo, rec } = fakeRepo({ projects: [pump] });
  const { push, sent: pushes } = fakePush();
  const { mail, sent: mails } = fakeMail();
  const summary = await runReminders(deps(repo, push, mail), { kind: 'due' });

  assert.deepEqual(rec.autoClaims, [
    {
      projectId: 'p2',
      kind: 'due3',
      dueOn: '2026-11-28',
      fireAt: '2026-11-25T07:00:00.000Z',
      message: 'Submission in 3 days: Pump station',
    },
  ]);
  assert.equal(pushes.length, 3);
  assert.equal(pushes[0].payload.title, 'Reminder · Pump station');
  assert.equal(pushes[0].payload.url, 'https://app.example/#p/p2');
  assert.equal(mails.length, 2);
  assert.deepEqual(rec.updated, [
    { id: 'auto-1', recipientNames: ['Amal', 'Bassem'], pushCount: 3, emailCount: 2 },
  ]);
  assert.equal(summary.autoReminders, 1);
});

test('automatic reminder for an assigned project goes only to the assignee', async () => {
  const assigned = { ...pump, assigneeId: 'b' };
  const { repo, rec } = fakeRepo({ projects: [assigned] });
  const { push, sent: pushes } = fakePush();
  await runReminders(deps(repo, push, null), { kind: 'due' });
  assert.deepEqual(pushes.map((p) => p.sub.personId), ['b']);
  assert.deepEqual(rec.updated[0].recipientNames, ['Bassem']);
});

test('automatic reminder skipped when claimAuto returns null', async () => {
  const { repo, rec } = fakeRepo({ projects: [pump], autoClaimResult: null });
  const { push, sent } = fakePush();
  const summary = await runReminders(deps(repo, push, null), { kind: 'due' });
  assert.equal(rec.autoClaims.length, 1);
  assert.equal(sent.length, 0);
  assert.equal(rec.updated.length, 0);
  assert.equal(summary.autoReminders, 0);
});

test("'now' mode pushes immediately to the chosen people and records a delivery without a reminder id", async () => {
  const { repo, rec } = fakeRepo({});
  const { push, sent: pushes } = fakePush();
  const { mail, sent: mails } = fakeMail();
  const summary = await runReminders(deps(repo, push, mail), {
    kind: 'now',
    reminder: { projectId: null, message: 'Site visit tomorrow', recipients: ['a'], email: false },
    requestedBy: amal,
  });
  assert.deepEqual(pushes.map((p) => p.sub.personId), ['a', 'a']);
  assert.equal(pushes[0].payload.title, 'Reminder');
  assert.equal(pushes[0].payload.url, 'https://app.example/');
  assert.equal(mails.length, 0);
  assert.equal(rec.recorded.length, 1);
  assert.equal(rec.recorded[0].reminderId, null);
  assert.equal(rec.recorded[0].projectId, null);
  assert.deepEqual(rec.recorded[0].recipientNames, ['Amal']);
  assert.equal(rec.claims.length, 0);
  assert.deepEqual(summary.recipientNames, ['Amal']);
});

test("'now' mode with email sends to recipients who have an address and the pref", async () => {
  const { repo } = fakeRepo({});
  const { push } = fakePush();
  const { mail, sent: mails } = fakeMail();
  await runReminders(deps(repo, push, mail), {
    kind: 'now',
    reminder: { projectId: 'p1', message: 'Send the offer', recipients: ['all'], email: true },
    requestedBy: amal,
  });
  assert.deepEqual(mails.map((m) => m.to), ['amal@example.com', 'bassem@example.com']);
  assert.equal(mails[0].subject, 'Reminder · Water tank: Send the offer');
});

test("'test' mode pushes only to the requester, never emails, records nothing", async () => {
  const { repo, rec } = fakeRepo({});
  const { push, sent: pushes } = fakePush();
  const { mail, sent: mails } = fakeMail();
  const summary = await runReminders(deps(repo, push, mail), { kind: 'test', person: bassem });
  assert.deepEqual(pushes.map((p) => p.sub.personId), ['b']);
  assert.equal(pushes[0].payload.title, 'Test reminder');
  assert.equal(pushes[0].payload.body, 'Notifications are working for Redcon Tender Planning.');
  assert.equal(pushes[0].payload.url, 'https://app.example/');
  assert.equal(mails.length, 0);
  assert.equal(rec.recorded.length, 0);
  assert.deepEqual(summary.recipientNames, ['Bassem']);
});

test('reminderEmailHtml escapes the message and the url', () => {
  const html = reminderEmailHtml('<b>"x" & \'y\'</b>', 'https://app.example/?a=1&b="2"');
  assert.ok(html.includes('&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;'));
  assert.ok(html.includes('href="https://app.example/?a=1&amp;b=&quot;2&quot;"'));
  assert.ok(html.includes('Open in Redcon Tender Planning'));
});
