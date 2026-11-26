import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockDataLayer, MOCK_KEY } from '../src/data/mock.js';
import { assertDataLayer, DATA_LAYER_METHODS, SYSTEM_TEXT } from '../src/data/contract.js';

const memStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};
const make = (storage = memStorage()) => createMockDataLayer({ storage, timers: false });
const byTitle = (b, part) => b.projects.find((p) => p.title.includes(part));
const comments = (p) => p.comments.map((c) => c.text);

test('the mock layer implements every data-layer method', () => {
  const layer = make();
  assert.equal(assertDataLayer(layer), true);
  for (const m of DATA_LAYER_METHODS) assert.equal(typeof layer[m], 'function', m);
});

test('loadBoard returns the demo board', async () => {
  const b = await make().loadBoard();
  assert.equal(b.mode, 'mock');
  assert.equal(b.me.name, 'Mohamed Ibrahim');
  assert.equal(b.users.length, 4);
  assert.equal(b.users[0].role, 'admin');
  assert.equal(b.projects.length, 7);
  assert.equal(b.tags.length, 7);
  assert.equal(b.tenderTeam.length, 4);
  assert.equal(b.folders.root.startsWith('https://'), true);
  assert.equal(b.mail.address, 'tenders@redcon.example');
});

test('createProject with and without a column', async () => {
  const dl = make();
  const id1 = await dl.createProject({ title: 'Test tower', tender: 'tm1', type: 'public', due: '2027-01-10', client: 'Client A', columnId: 'u1' });
  let b = await dl.loadBoard();
  let p = b.projects.find((x) => x.id === id1);
  assert.deepEqual(p.tags, ['new']);
  assert.equal(p.type, 'private', 'tender member type wins');
  assert.equal(p.pos, Math.min(...b.projects.filter((x) => x.columnId === 'u1').map((x) => x.pos)));
  assert.ok(comments(p).includes(SYSTEM_TEXT.created));

  const id2 = await dl.createProject({ title: 'Loose job', tender: null, type: 'public', due: '', client: '', columnId: null });
  b = await dl.loadBoard();
  p = b.projects.find((x) => x.id === id2);
  assert.deepEqual(p.tags, ['new', 'un']);
  assert.equal(p.columnId, null);
});

test('moveProject assigns, unassigns and renumbers', async () => {
  const dl = make();
  let b = await dl.loadBoard();
  const steel = byTitle(b, 'Steel shed');
  await dl.moveProject(steel.id, 'u2', [steel.id, ...b.projects.filter((p) => p.columnId === 'u2').map((p) => p.id)]);
  b = await dl.loadBoard();
  let p = b.projects.find((x) => x.id === steel.id);
  assert.equal(p.columnId, 'u2');
  assert.equal(p.tags.includes('un'), false);
  assert.ok(comments(p).includes('Assigned to Eng. Sara Mostafa'));
  assert.equal(b.projects.filter((x) => x.columnId === 'u2').sort((a, c) => a.pos - c.pos)[0].id, steel.id);

  await dl.moveProject(steel.id, null, [steel.id]);
  b = await dl.loadBoard();
  p = b.projects.find((x) => x.id === steel.id);
  assert.equal(p.columnId, null);
  assert.equal(p.tags.includes('un'), true);
  assert.ok(comments(p).includes(SYSTEM_TEXT.unassigned));
});

test('setDueDate records history, writes the comment and clears', async () => {
  const dl = make();
  let b = await dl.loadBoard();
  const p0 = byTitle(b, 'Boundary wall');
  assert.equal(await dl.setDueDate(p0.id, p0.due), false, 'same date changes nothing');
  assert.equal(await dl.setDueDate(p0.id, '2026-12-03'), true);
  b = await dl.loadBoard();
  const p = b.projects.find((x) => x.id === p0.id);
  assert.equal(p.due, '2026-12-03');
  assert.equal(p.dueHistory[0].by, 'Mohamed Ibrahim');
  assert.equal(p.dueHistory[0].to, '2026-12-03');
  assert.ok(comments(p).some((t) => t.includes('03 Dec 2026')), comments(p).join(' | '));
  await dl.setDueDate(p0.id, '');
  b = await dl.loadBoard();
  assert.equal(b.projects.find((x) => x.id === p0.id).due, '');
  assert.ok(comments(b.projects.find((x) => x.id === p0.id)).includes(SYSTEM_TEXT.dueCleared));
});

test('updateProject: status comment, tender sets the type', async () => {
  const dl = make();
  let b = await dl.loadBoard();
  const p0 = byTitle(b, 'Steel shed');
  await dl.updateProject(p0.id, { status: 'Pricing' });
  await dl.updateProject(p0.id, { tender: 'tm3' });
  b = await dl.loadBoard();
  const p = b.projects.find((x) => x.id === p0.id);
  assert.equal(p.status, 'Pricing');
  assert.equal(p.tender, 'tm3');
  assert.equal(p.type, 'public');
  assert.ok(comments(p).includes('Status: Pricing'));
  assert.ok(comments(p).includes('Tender team: Eng. Mohamed Mustafa (public)'));
  await dl.updateProject(p0.id, { folder: 'https://redcon.sharepoint.com/sites/x' });
  b = await dl.loadBoard();
  assert.equal(b.projects.find((x) => x.id === p0.id).folder, 'https://redcon.sharepoint.com/sites/x');
});

test('toggleTag adds and removes', async () => {
  const dl = make();
  const b = await dl.loadBoard();
  const p0 = byTitle(b, 'Boundary wall');
  await dl.toggleTag(p0.id, 'urgent', true);
  await dl.toggleTag(p0.id, 'sub', false);
  const after = (await dl.loadBoard()).projects.find((x) => x.id === p0.id);
  assert.ok(after.tags.includes('urgent'));
  assert.ok(!after.tags.includes('sub'));
});

test('addPerson validates, derives names and sets colour and order', async () => {
  const dl = make();
  assert.deepEqual(await dl.addPerson({ name: '', email: '', role: 'engineer', hasColumn: true }), { ok: false, error: 'missing_name' });
  assert.deepEqual(await dl.addPerson({ name: 'X', email: 'not-an-email', role: 'engineer', hasColumn: true }), { ok: false, error: 'invalid_email' });
  assert.deepEqual(await dl.addPerson({ name: 'Dup', email: 'SARA@redcon.example', role: 'engineer', hasColumn: true }), { ok: false, error: 'duplicate_email' });
  const ok = await dl.addPerson({ name: 'Eng. Test Person', email: 'Test@Redcon.example', role: 'engineer', hasColumn: true });
  assert.equal(ok.ok, true);
  const named = await dl.addPerson({ name: '', email: 'first.last@redcon.example', role: 'engineer', hasColumn: false });
  const b = await dl.loadBoard();
  const u = b.users.find((x) => x.id === ok.id);
  assert.equal(u.email, 'test@redcon.example');
  assert.equal(u.order, 4);
  assert.equal(u.prefs.email, true);
  assert.equal(b.users.find((x) => x.id === named.id).name, 'First Last');
  assert.equal(b.users.find((x) => x.id === named.id).hasColumn, false);
});

test('reorderPeople and setColumn(false) move projects to Unassigned', async () => {
  const dl = make();
  await dl.reorderPeople(['u3', 'u0', 'u1', 'u2']);
  let b = await dl.loadBoard();
  assert.deepEqual(b.users.map((u) => u.id), ['u3', 'u0', 'u1', 'u2']);
  await dl.setColumn('u2', false);
  b = await dl.loadBoard();
  assert.equal(b.users.find((u) => u.id === 'u2').hasColumn, false);
  const p4 = b.projects.find((p) => p.id === 'p4');
  assert.equal(p4.columnId, null);
  assert.ok(p4.tags.includes('un'));
});

test('tender team edits cascade and removal clears the tender', async () => {
  const dl = make();
  await dl.updateTenderMember('tm3', { type: 'private' });
  let b = await dl.loadBoard();
  assert.equal(b.projects.find((p) => p.id === 'p1').type, 'private');
  await dl.removeTenderMember('tm3');
  b = await dl.loadBoard();
  assert.equal(b.projects.find((p) => p.id === 'p1').tender, null);
  assert.equal(b.tenderTeam.some((t) => t.id === 'tm3'), false);
});

test('addReminder fires when due, logs the send and steps a daily one', async () => {
  const dl = make();
  const events = [];
  dl.subscribe((e) => events.push(e));
  const at = Date.now() + 60 * 60000;
  const id = await dl.addReminder({ projectId: null, at, msg: 'Due now', repeat: 'none', to: ['all'], email: false });
  const daily = await dl.addReminder({ projectId: 'p2', at, msg: 'Daily check', repeat: 'daily', to: ['all'], email: true });
  dl._tick(at + 2 * 3600000);
  const b = await dl.loadBoard();
  assert.equal(b.reminders.some((r) => r.id === id), false, 'one-off reminder is fired');
  assert.ok(b.sentLog.some((l) => l.msg === 'Due now' && l.names.length === 4));
  const d = b.projects.find((p) => p.id === 'p2').notifications.find((n) => n.id === daily);
  assert.ok(d && d.at > at + 2 * 3600000, 'daily reminder stepped forward');
  const fired = events.filter((e) => e.type === 'FIRED');
  assert.equal(fired.length, 2);
  assert.ok(fired.some((e) => e.record.title === 'Reminder'));
  assert.ok(fired.some((e) => e.record.title.startsWith('Reminder · ')));
});

test('syncMailNow reads the demo mailbox once', async () => {
  const dl = make();
  const first = await dl.syncMailNow();
  assert.deepEqual(first, { read: 7, created: 2, updated: 3, review: 1 });
  const second = await dl.syncMailNow();
  assert.equal(second.read, 0);
  const b = await dl.loadBoard();
  assert.equal(b.mail.reviews.length, 1);
  assert.equal(b.mail.log.length, 7);
  assert.equal(b.mail.runs.length, 2);
  assert.ok(b.mail.log.some((l) => l.outcome === 'applied' && l.label.startsWith('Added to the board → ')));
  assert.ok(b.mail.log.some((l) => l.outcome === 'prefiltered'));
});

test('resolveReview creates a project from a review item', async () => {
  const dl = make();
  await dl.syncMailNow();
  const b = await dl.loadBoard();
  const item = b.mail.reviews[0];
  const res = await dl.resolveReview(item.id, { action: 'new' });
  const after = await dl.loadBoard();
  const p = after.projects.find((x) => x.id === res.projectId);
  assert.ok(p.title.includes('تطوير ميدان المحطة'));
  assert.equal(after.mail.reviews.length, 0);
  assert.deepEqual(p.tags, ['new', 'un']);
});

test('subscribe is called after a mutation; a second layer on the same storage sees it', async () => {
  const storage = memStorage();
  const a = make(storage);
  const b2 = make(storage);
  let calls = 0;
  a.subscribe(() => { calls++; });
  await a.updateProject('p6', { status: 'Shared status' });
  assert.ok(calls >= 1);
  const seen = await b2.loadBoard();
  assert.equal(seen.projects.find((p) => p.id === 'p6').status, 'Shared status');
  assert.ok(storage.getItem(MOCK_KEY));
});

test('resetDemo restores the seven demo projects; reads survive unreadable storage', async () => {
  const dl = make();
  await dl.createProject({ title: 'Extra', tender: null, type: 'public', due: '', client: '', columnId: null });
  await dl.resetDemo();
  assert.equal((await dl.loadBoard()).projects.length, 7);
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const mem = make(broken);
  assert.equal((await mem.loadBoard()).projects.length, 7);
  await mem.createProject({ title: 'Still works', tender: null, type: 'public', due: '', client: '', columnId: null });
  assert.equal((await mem.loadBoard()).projects.length, 8);
});

test('errors are plain Error messages', async () => {
  const dl = make();
  await assert.rejects(() => dl.addComment('p1', '   '), /Write a comment/);
  await assert.rejects(() => dl.addLink('p1', { url: 'https://tenders.example/electrical-admin' }), /already on this project/);
  await assert.rejects(() => dl.updateProject('nope', { status: 'x' }), /Project not found/);
});
