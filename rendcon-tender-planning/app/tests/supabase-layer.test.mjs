// Tests for src/data/supabase.js with a fake supabase-js client (no network, no real project).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseDataLayer, fmtDay } from '../src/data/supabase.js';
import { assertDataLayer, OUTCOME_LABELS } from '../src/data/contract.js';

const t = (iso) => Date.parse(iso);
const ok = (data) => ({ data, error: null });
const fail = (message, code) => ({ data: null, error: { message, code } });
const CHAIN = ['select', 'insert', 'upsert', 'update', 'delete', 'eq', 'is', 'in', 'order', 'limit', 'single', 'maybeSingle'];
const TERMINAL = ['insert', 'upsert', 'update', 'delete'];

/**
 * Fake supabase-js client. Responses are looked up by 'table.operation' first, then 'table'.
 * `log` records every chain (table + ops + terminal), rpc, function invoke, auth call and channel.
 */
function fakeClient({ tables = {}, rpcs = {}, functions = {}, auth = {}, session = null } = {}) {
  const log = { from: [], rpc: [], invoke: [], auth: [], channels: [], removed: [], authListeners: [] };
  const authDefaults = {
    getSession: { data: { session }, error: null },
    signUp: { data: { session: null }, error: null },
  };
  const respond = (rec) => {
    const terminal = rec.ops.find(([m]) => TERMINAL.includes(m))?.[0] ?? 'select';
    rec.terminal = terminal;
    const r = tables[`${rec.table}.${terminal}`] ?? tables[rec.table] ?? ok([]);
    return Promise.resolve(typeof r === 'function' ? r(rec) : r);
  };
  const client = {
    log,
    from(table) {
      const rec = { table, ops: [] };
      log.from.push(rec);
      const builder = {};
      for (const m of CHAIN) builder[m] = (...args) => { rec.ops.push([m, ...args]); return builder; };
      builder.then = (resolve, reject) => respond(rec).then(resolve, reject);
      return builder;
    },
    rpc(fn, args) {
      log.rpc.push({ fn, args });
      return Promise.resolve(rpcs[fn] ?? ok(null));
    },
    functions: {
      invoke(name, opts) {
        log.invoke.push({ name, opts });
        return Promise.resolve(functions[name] ?? ok(null));
      },
    },
    auth: {
      getSession: () => { log.auth.push({ method: 'getSession' }); return Promise.resolve(auth.getSession ?? authDefaults.getSession); },
      signUp: (args) => { log.auth.push({ method: 'signUp', args }); return Promise.resolve(auth.signUp ?? authDefaults.signUp); },
      signInWithPassword: (args) => { log.auth.push({ method: 'signInWithPassword', args }); return Promise.resolve(auth.signInWithPassword ?? ok({})); },
      signOut: () => { log.auth.push({ method: 'signOut' }); return Promise.resolve(auth.signOut ?? { error: null }); },
      resetPasswordForEmail: (email, opts) => { log.auth.push({ method: 'resetPasswordForEmail', args: [email, opts] }); return Promise.resolve(auth.resetPasswordForEmail ?? { error: null }); },
      updateUser: (args) => { log.auth.push({ method: 'updateUser', args }); return Promise.resolve(auth.updateUser ?? { error: null }); },
      onAuthStateChange(cb) {
        log.authListeners.push(cb);
        return { data: { subscription: { unsubscribe: () => { log.unsubscribed = true; } } } };
      },
    },
    channel(name) {
      const ch = { name, handlers: [], subscribed: false };
      ch.on = (type, filter, cb) => { ch.handlers.push({ type, filter, cb }); return ch; };
      ch.subscribe = () => { ch.subscribed = true; return ch; };
      log.channels.push(ch);
      return ch;
    },
    removeChannel(ch) { log.removed.push(ch); return Promise.resolve('ok'); },
  };
  return client;
}

/** The terminal (write) operation recorded for a table: { payload, ops }. */
function write(client, table, terminal, index = 0) {
  const recs = client.log.from.filter((r) => r.table === table && r.terminal === terminal);
  const rec = recs[index];
  assert.ok(rec, `no ${terminal} on ${table}`);
  return { payload: rec.ops.find(([m]) => m === terminal)[1], ops: rec.ops };
}

const NOW = () => t('2026-11-25T10:00:00Z');
const make = (opts) => {
  const client = fakeClient(opts);
  const layer = createSupabaseDataLayer({ client, now: NOW, origin: 'https://app.example' });
  return { client, layer };
};

// ---------- hand-made rows for loadBoard ----------
const PEOPLE = [
  { id: 'u1', name: 'Mina', email: 'Mina@Redcon.com', role: 'admin', color: '#111111', board_order: 0, has_column: true, active: true, prefs: { push: false, email: true } },
  { id: 'u2', name: 'Mohamed', email: null, role: 'engineer', color: '#EE6A1F', board_order: 1, has_column: false, active: true, prefs: { push: true, email: false } },
];
const P1 = {
  id: 'p1', title: 'Water tank', client: 'Client A', ref: 'R-1', tender_type: 'private', tender_id: 'tm1', supervisor: null,
  assignee_id: 'u1', position: 0, status: 'Drafting', received_on: '2026-11-20', due_on: null, folder_url: 'https://x.example/folder',
  source: 'email', sub_open: true, archived: false, updated_at: '2026-11-25T10:00:00Z', updated_by: 'Mina',
  project_tags: [{ tag_id: 'new' }],
  subtasks: [
    { id: 's2', text: 'B', done: false, note: '', due_on: null, position: 2, created_at: '2026-11-01T00:00:00Z' },
    { id: 's1', text: 'A', done: true, note: 'n', due_on: '2026-12-01', position: 1, created_at: '2026-11-02T00:00:00Z' },
  ],
  links: [{ id: 'l1', title: 'Tender', url: 'https://t.example/1', source: 'email' }],
  comments: [
    { id: 'c2', author_name: 'System', body: 'Status: Drafting', system: true, created_at: '2026-11-22T00:00:00Z' },
    { id: 'c1', author_name: 'Mina', body: 'Hi', system: false, created_at: '2026-11-21T00:00:00Z' },
  ],
  date_changes: [
    { id: 'd1', from_date: null, to_date: '2026-12-03', changed_by: 'email', created_at: '2026-11-21T00:00:00Z' },
    { id: 'd2', from_date: '2026-12-03', to_date: '2026-12-10', changed_by: 'Mina', created_at: '2026-11-23T00:00:00Z' },
  ],
  mail_events: [
    { id: 'e1', kind: 'new_project', direction: 'received', summary: 'New tender', subject: 'Tender', links_count: 2, received_at: '2026-11-20T08:00:00Z', created_at: '2026-11-20T08:05:00Z', web_link: null },
  ],
  reminders: [
    { id: 'r2', message: 'Call', at: '2026-11-30T09:00:00Z', repeat: 'none', fired: false, recipients: ['u1'], email: true, project_id: 'p1' },
    { id: 'r1', message: 'Earlier', at: '2026-11-28T09:00:00Z', repeat: 'none', fired: false, recipients: ['all'], email: true, project_id: 'p1' },
    { id: 'r0', message: 'Done', at: '2026-11-10T09:00:00Z', repeat: 'none', fired: true, recipients: ['all'], email: true, project_id: 'p1' },
  ],
};
const P2 = {
  id: 'p2', title: 'Road', client: null, ref: '', tender_type: 'public', tender_id: null, supervisor: null, assignee_id: null,
  position: -1, status: '', received_on: null, due_on: '2026-12-05', folder_url: '', source: 'manual', sub_open: false,
  archived: false, updated_at: '2026-11-24T00:00:00Z', updated_by: '', project_tags: [{ tag_id: 'un' }],
  subtasks: [], links: [], comments: [], date_changes: [], mail_events: [], reminders: [],
};

function boardTables() {
  return {
    people: ok(PEOPLE),
    tender_team: ok([{ id: 'tm1', name: 'Eng. Mina', name_ar: 'مينا', type: 'private' }]),
    tags: ok([{ id: 'new', name: 'New', color: '#EE6A1F' }, { id: 'un', name: 'Unassigned', color: '#5B5B57' }]),
    projects: ok([P1, P2]),
    project_seen: ok([{ project_id: 'p1', seen_at: '2026-11-24T12:00:00Z' }]),
    reminders: ok([{ id: 'gr1', message: 'Team meeting', at: '2026-11-26T09:00:00Z', repeat: 'weekly', fired: false, recipients: ['all'], email: false, project_id: null }]),
    reminder_deliveries: ok([{ id: 'dl1', message: 'Call', recipient_names: ['Mina'], email_count: 1, sent_at: '2026-11-25T08:00:00Z', projects: { title: 'Water tank' } }]),
    settings: ok([
      { key: 'mail', value: { address: 'tenders@redcon.com', subjectHint: 'ورد الينا', hourlyEnabled: true } },
      { key: 'folders', value: { rootUrl: 'https://sp.example/root' } },
      { key: 'mail_state', value: { lastRunAt: '2026-11-25T07:00:00Z' } },
    ]),
    mail_runs: ok([{ id: 'run1', trigger: 'cron', started_at: '2026-11-25T07:00:00Z', summary: { fetched: 9, alreadyProcessed: 2, created: 1, updated: 3, review: 1, prefiltered: 0, ignored: 1, errors: 0 } }]),
    processed_messages: ok([
      { message_id: 'm1', subject: 'New tender', from_address: 'a@x.example', received_at: '2026-11-25T06:00:00Z', processed_at: '2026-11-25T06:01:00Z', outcome: 'applied', project_id: 'p1', projects: { title: 'Water tank' } },
      { message_id: 'm2', subject: 'Newsletter', from_address: 'n@x.example', received_at: null, processed_at: '2026-11-25T06:30:00Z', outcome: 'prefiltered', project_id: null, projects: null },
    ]),
    review_queue: ok([{
      id: 'rv1',
      message: { id: 'x', subject: 'Maybe road', from: { name: 'A', address: 'q@x.example' }, date: '2026-11-24T09:00:00Z', bodyText: 'Body text', webLink: 'https://outlook.example/1' },
      ai_form: { summary: 'S2', kind: 'update', project_name: 'Road X' },
      validated: null,
      reasons: ['unknown_project'],
      candidates: [{ projectId: 'p2', title: 'Road', score: 0.6 }],
      created_at: '2026-11-24T09:01:00Z',
      status: 'open',
    }]),
  };
}

const USER_MINA = {
  id: 'u1', name: 'Mina', email: 'Mina@Redcon.com', role: 'admin', color: '#111111', status: 'active',
  prefs: { browser: false, email: true }, hasColumn: true, order: 0,
};
const USER_MOHAMED = {
  id: 'u2', name: 'Mohamed', email: '', role: 'engineer', color: '#EE6A1F', status: 'active',
  prefs: { browser: true, email: false }, hasColumn: false, order: 1,
};

test('assertDataLayer accepts a complete layer and names missing methods', () => {
  const { layer } = make();
  assert.equal(assertDataLayer(layer), true);
  assert.throws(() => assertDataLayer({ init: () => {} }), /Data layer is missing: .*loadBoard/);
});

test('fmtDay formats ISO dates as en-GB day, short month, year', () => {
  assert.equal(fmtDay('2026-12-03'), '03 Dec 2026');
  assert.equal(fmtDay(''), '');
});

test('loadBoard maps hand-made rows to the exact BoardState', async () => {
  const { layer } = make({ session: { user: { email: 'mina@redcon.com' } }, tables: boardTables() });
  const board = await layer.loadBoard();
  const expectedP1 = {
    id: 'p1', title: 'Water tank', client: 'Client A', ref: 'R-1', type: 'private', tender: 'tm1', supervisor: '',
    columnId: 'u1', pos: 0, status: 'Drafting', received: '2026-11-20', due: '', folder: 'https://x.example/folder',
    source: 'email', subOpen: true, updatedAt: t('2026-11-25T10:00:00Z'), updatedBy: 'Mina',
    mailSeen: t('2026-11-24T12:00:00Z'), tags: ['new'],
    subtasks: [
      { id: 's1', text: 'A', done: true, note: 'n', due: '2026-12-01' },
      { id: 's2', text: 'B', done: false, note: '', due: '' },
    ],
    links: [{ id: 'l1', title: 'Tender', url: 'https://t.example/1', src: true }],
    comments: [
      { id: 'c1', who: 'Mina', text: 'Hi', at: t('2026-11-21T00:00:00Z'), sys: false },
      { id: 'c2', who: 'System', text: 'Status: Drafting', at: t('2026-11-22T00:00:00Z'), sys: true },
    ],
    dueHistory: [
      { from: '2026-12-03', to: '2026-12-10', by: 'Mina', at: t('2026-11-23T00:00:00Z') },
      { from: '', to: '2026-12-03', by: 'email', at: t('2026-11-21T00:00:00Z') },
    ],
    mailLog: [{
      id: 'e1', at: t('2026-11-20T08:05:00Z'), emailAt: t('2026-11-20T08:00:00Z'), kind: 'new_project',
      direction: 'received', summary: 'New tender', subject: 'Tender', links: 2, webLink: '',
    }],
    notifications: [
      { id: 'r1', at: t('2026-11-28T09:00:00Z'), msg: 'Earlier', repeat: 'none', fired: false, to: ['all'], email: true, projectId: 'p1' },
      { id: 'r2', at: t('2026-11-30T09:00:00Z'), msg: 'Call', repeat: 'none', fired: false, to: ['u1'], email: true, projectId: 'p1' },
    ],
  };
  const expectedP2 = {
    id: 'p2', title: 'Road', client: '', ref: '', type: 'public', tender: null, supervisor: '', columnId: null, pos: -1,
    status: '', received: '', due: '2026-12-05', folder: '', source: 'manual', subOpen: false,
    updatedAt: t('2026-11-24T00:00:00Z'), updatedBy: '', mailSeen: 0, tags: ['un'],
    subtasks: [], links: [], comments: [], dueHistory: [], mailLog: [], notifications: [],
  };
  assert.deepEqual(board, {
    mode: 'supabase',
    me: USER_MINA,
    users: [USER_MINA, USER_MOHAMED],
    tenderTeam: [{ id: 'tm1', name: 'Eng. Mina', ar: 'مينا', type: 'private' }],
    tags: [{ id: 'new', name: 'New', color: '#EE6A1F' }, { id: 'un', name: 'Unassigned', color: '#5B5B57' }],
    projects: [expectedP1, expectedP2],
    reminders: [{ id: 'gr1', at: t('2026-11-26T09:00:00Z'), msg: 'Team meeting', repeat: 'weekly', fired: false, to: ['all'], email: false, projectId: null }],
    sentLog: [{ id: 'dl1', msg: 'Call', project: 'Water tank', names: ['Mina'], email: 1, at: t('2026-11-25T08:00:00Z') }],
    mail: {
      address: 'tenders@redcon.com',
      subject: 'ورد الينا',
      hourly: true,
      lastSync: t('2026-11-25T07:00:00Z'),
      runs: [{ at: t('2026-11-25T07:00:00Z'), trigger: 'cron', fetched: 9, created: 1, updated: 3, review: 1, prefiltered: 0, ignored: 1, errors: 0 }],
      log: [
        { id: 'm1', subject: 'New tender', from: 'a@x.example', at: t('2026-11-25T06:00:00Z'), outcome: 'applied', label: OUTCOME_LABELS.applied + ' → Water tank', pid: 'p1' },
        { id: 'm2', subject: 'Newsletter', from: 'n@x.example', at: t('2026-11-25T06:30:00Z'), outcome: 'prefiltered', label: OUTCOME_LABELS.prefiltered, pid: null },
      ],
      reviews: [{
        id: 'rv1', subject: 'Maybe road', from: 'q@x.example', at: t('2026-11-24T09:00:00Z'), excerpt: 'Body text',
        summary: 'S2', kind: 'update', title: 'Road X', reasons: ['unknown_project'],
        candidates: [{ pid: 'p2', title: 'Road', score: 0.6 }], webLink: 'https://outlook.example/1',
      }],
    },
    folders: { root: 'https://sp.example/root' },
  });
});

test('loadBoard: me matches the email case-insensitively and is null for an unknown email', async () => {
  const known = make({ session: { user: { email: 'MINA@redcon.com' } }, tables: boardTables() });
  assert.equal((await known.layer.loadBoard()).me.id, 'u1');
  const unknown = make({ session: { user: { email: 'nobody@redcon.com' } }, tables: boardTables() });
  assert.equal((await unknown.layer.loadBoard()).me, null);
  const signedOut = make({ session: null, tables: boardTables() });
  assert.equal((await signedOut.layer.loadBoard()).me, null);
});

test('moveProject calls rpc_move_project with the exact parameter names', async () => {
  const { client, layer } = make();
  await layer.moveProject('p1', 'u2', ['p2', 'p1']);
  await layer.moveProject('p1', null, ['p1']);
  assert.deepEqual(client.log.rpc, [
    { fn: 'rpc_move_project', args: { p_project: 'p1', p_assignee: 'u2', p_order: ['p2', 'p1'] } },
    { fn: 'rpc_move_project', args: { p_project: 'p1', p_assignee: null, p_order: ['p1'] } },
  ]);
});

test('setDueDate sends null for an empty date and returns the RPC boolean', async () => {
  const { client, layer } = make({ rpcs: { rpc_set_due_date: ok(true) } });
  assert.equal(await layer.setDueDate('p1', ''), true);
  assert.deepEqual(client.log.rpc[0], { fn: 'rpc_set_due_date', args: { p_project: 'p1', p_due: null } });
  const dated = make({ rpcs: { rpc_set_due_date: ok(false) } });
  assert.equal(await dated.layer.setDueDate('p1', '2026-12-09'), false);
  assert.deepEqual(dated.client.log.rpc[0].args, { p_project: 'p1', p_due: '2026-12-09' });
});

test('updateProject with status writes the column and a system comment', async () => {
  const { client, layer } = make();
  await layer.updateProject('p1', { status: 'X' });
  const upd = write(client, 'projects', 'update');
  assert.deepEqual(upd.payload, { status: 'X' });
  assert.deepEqual(upd.ops.filter(([m]) => m === 'eq'), [['eq', 'id', 'p1']]);
  assert.deepEqual(write(client, 'comments', 'insert').payload, {
    project_id: 'p1', author_name: 'System', body: 'Status: X', system: true,
  });
});

test('updateProject with tender sets the member type and writes the tender comment', async () => {
  const { client, layer } = make({
    tables: { 'tender_team.select': ok({ id: 'tm1', name: 'Eng. Mina', name_ar: 'مينا', type: 'private' }) },
  });
  await layer.updateProject('p1', { tender: 'tm1' });
  assert.deepEqual(write(client, 'projects', 'update').payload, { tender_id: 'tm1', tender_type: 'private' });
  assert.deepEqual(write(client, 'comments', 'insert').payload, {
    project_id: 'p1', author_name: 'System', body: 'Tender team: Eng. Mina (private)', system: true,
  });
});

test('toggleTag inserts when on and deletes when off', async () => {
  const { client, layer } = make();
  await layer.toggleTag('p1', 'urgent', true);
  assert.deepEqual(write(client, 'project_tags', 'insert').payload, { project_id: 'p1', tag_id: 'urgent' });
  await layer.toggleTag('p1', 'urgent', false);
  const del = write(client, 'project_tags', 'delete', 0);
  assert.deepEqual(del.ops.filter(([m]) => m === 'eq'), [['eq', 'project_id', 'p1'], ['eq', 'tag_id', 'urgent']]);
});

test('createProject inserts the project, its tags and the created comment', async () => {
  const { client, layer } = make({ tables: { 'projects.insert': ok({ id: 'p9' }) } });
  const id = await layer.createProject({ title: 'New road', tender: null, type: 'public', due: '2026-12-09', client: 'Client B', columnId: 'u1' });
  assert.equal(id, 'p9');
  assert.deepEqual(write(client, 'projects', 'insert').payload, {
    title: 'New road', client: 'Client B', tender_type: 'public', tender_id: null, due_on: '2026-12-09',
    assignee_id: 'u1', received_on: '2026-11-25', source: 'manual',
  });
  assert.deepEqual(write(client, 'project_tags', 'insert').payload, [{ project_id: 'p9', tag_id: 'new' }]);
  assert.deepEqual(write(client, 'comments', 'insert').payload, {
    project_id: 'p9', author_name: 'System', body: 'Project created manually', system: true,
  });
  await layer.createProject({ title: 'Unassigned', tender: null, type: 'public', due: '', client: '', columnId: null });
  assert.deepEqual(write(client, 'project_tags', 'insert', 1).payload, [
    { project_id: 'p9', tag_id: 'new' }, { project_id: 'p9', tag_id: 'un' },
  ]);
});

test('addComment writes the signed-in person as author, loading the board first when needed', async () => {
  const { client, layer } = make({
    session: { user: { email: 'mina@redcon.com' } },
    tables: { people: ok(PEOPLE), 'comments.insert': ok({ id: 'c9' }) },
  });
  assert.equal(await layer.addComment('p1', 'Hello'), 'c9');
  assert.deepEqual(write(client, 'comments', 'insert').payload, {
    project_id: 'p1', author_id: 'u1', author_name: 'Mina', body: 'Hello', system: false,
  });
});

test('addSubtask uses the largest position plus one', async () => {
  const { client, layer } = make({
    tables: { 'subtasks.select': ok([{ position: 4 }]), 'subtasks.insert': ok({ id: 's9' }) },
  });
  assert.equal(await layer.addSubtask('p1', { text: 'Check', due: '' }), 's9');
  assert.deepEqual(write(client, 'subtasks', 'insert').payload, { project_id: 'p1', text: 'Check', due_on: null, position: 5 });
});

test('updateSettings merges into the mail and folders settings', async () => {
  const { client, layer } = make({
    session: { user: { email: 'mina@redcon.com' } },
    tables: {
      people: ok(PEOPLE),
      'settings.select': ok([
        { key: 'mail', value: { address: 'a@redcon.com', subjectHint: 'old', hourlyEnabled: true } },
        { key: 'folders', value: { rootUrl: 'https://old.example' } },
      ]),
    },
  });
  await layer.updateSettings({ subject: 'X', hourly: false, folderRoot: 'https://new.example' });
  const updates = client.log.from.filter((r) => r.table === 'settings' && r.terminal === 'update');
  const byKey = Object.fromEntries(updates.map((r) => [r.ops.find(([m]) => m === 'eq')[2], r.ops.find(([m]) => m === 'update')[1].value]));
  assert.deepEqual(byKey, {
    mail: { address: 'a@redcon.com', subjectHint: 'X', hourlyEnabled: false },
    folders: { rootUrl: 'https://new.example' },
  });
});

test('addPerson maps a duplicate email (23505) to duplicate_email', async () => {
  const { client, layer } = make({
    tables: {
      'people.select': ok([{ board_order: 0 }]),
      'people.insert': fail('duplicate key value violates unique constraint', '23505'),
    },
  });
  const res = await layer.addPerson({ name: 'Sara', email: 'Mina@Redcon.com', role: 'engineer', hasColumn: true });
  assert.deepEqual(res, { ok: false, error: 'duplicate_email' });
  assert.deepEqual(write(client, 'people', 'insert').payload.email, 'mina@redcon.com');
});

test('addPerson validates the input and derives the name from the email', async () => {
  const { client, layer } = make({
    tables: { 'people.select': ok([]), 'people.insert': ok({ id: 'u9' }) },
  });
  assert.deepEqual(await layer.addPerson({ name: '', email: '', role: 'engineer', hasColumn: true }), { ok: false, error: 'missing_name' });
  assert.deepEqual(await layer.addPerson({ name: 'X', email: 'not-an-email', role: 'engineer', hasColumn: true }), { ok: false, error: 'invalid_email' });
  assert.equal(client.log.from.filter((r) => r.table === 'people' && r.terminal === 'insert').length, 0);
  assert.deepEqual(await layer.addPerson({ name: '', email: 'mohamed.ali@redcon.com', role: 'engineer', hasColumn: true }), { ok: true, id: 'u9' });
  assert.deepEqual(write(client, 'people', 'insert').payload, {
    name: 'Mohamed Ali', email: 'mohamed.ali@redcon.com', role: 'engineer', color: '#111111', board_order: 0,
    has_column: true, prefs: { push: true, email: true },
  });
});

test('syncMailNow maps the mail-sync summary to read/created/updated/review', async () => {
  const { client, layer } = make({
    functions: { 'mail-sync': ok({ fetched: 9, alreadyProcessed: 2, created: 1, updated: 3, review: 1 }) },
  });
  assert.deepEqual(await layer.syncMailNow(), { read: 7, created: 1, updated: 3, review: 1 });
  assert.deepEqual(client.log.invoke[0], { name: 'mail-sync', opts: { body: { source: 'manual' } } });
});

test('resolveReview invokes mail-review with the resolution', async () => {
  const { client, layer } = make({ functions: { 'mail-review': ok({ projectId: 'p1' }) } });
  assert.deepEqual(await layer.resolveReview('r1', { action: 'assign', projectId: 'p1' }), { projectId: 'p1' });
  assert.deepEqual(client.log.invoke[0], {
    name: 'mail-review',
    opts: { body: { reviewId: 'r1', action: 'assign', projectId: 'p1' } },
  });
});

test('sendReminderNow invokes send-reminders in now mode and returns names and emails', async () => {
  const { client, layer } = make({
    functions: {
      'send-reminders': ok({
        reminders: 0, autoReminders: 0, pushes: 1, pushesFailed: 0, emails: 1, emailsFailed: 0,
        removedSubscriptions: 0, recipientNames: ['Mina'],
      }),
    },
  });
  const res = await layer.sendReminderNow({ projectId: 'p1', msg: 'Call', to: ['all'], email: true });
  assert.deepEqual(res, { names: ['Mina'], emails: 1 });
  assert.deepEqual(client.log.invoke[0], {
    name: 'send-reminders',
    opts: { body: { mode: 'now', reminder: { projectId: 'p1', message: 'Call', recipients: ['all'], email: true } } },
  });
});

test('mail hourly sync defaults to on when hourlyEnabled is missing, and off only when false', async () => {
  const withSetting = (value) => make({
    session: null,
    tables: { ...boardTables(), settings: ok([{ key: 'mail', value }]) },
  }).layer.loadBoard();
  assert.equal((await withSetting({ address: 'a@redcon.com' })).mail.hourly, true);
  assert.equal((await withSetting({ address: 'a@redcon.com', hourlyEnabled: false })).mail.hourly, false);
});

test('syncMailNow reports a skipped or failed run instead of "up to date"', async () => {
  const skipped = make({ functions: { 'mail-sync': ok({ skipped: 'already_running', fetched: 0, errors: 0 }) } });
  await assert.rejects(skipped.layer.syncMailNow(), { message: /already running/ });
  const failed = make({ functions: { 'mail-sync': ok({ skipped: null, fetched: 0, errors: 2 }) } });
  await assert.rejects(failed.layer.syncMailNow(), { message: /Email sync failed/ });
  const partial = make({ functions: { 'mail-sync': ok({ skipped: null, fetched: 4, alreadyProcessed: 0, created: 1, updated: 0, review: 0, errors: 1 }) } });
  assert.deepEqual(await partial.layer.syncMailNow(), { read: 4, created: 1, updated: 0, review: 0 });
});

test('edge function errors use the JSON error code from the response body', async () => {
  const errorWith = (json) => ({
    data: null,
    error: { message: 'Edge Function returned a non-2xx status code', context: { json: () => Promise.resolve(json) } },
  });
  const closed = make({ functions: { 'mail-review': errorWith({ ok: false, error: 'not_found_or_closed' }) } });
  await assert.rejects(closed.layer.resolveReview('r1', { action: 'assign' }), { message: 'Someone already handled this email' });
  const missing = make({ functions: { 'send-reminders': errorWith({ error: 'project_not_found' }) } });
  await assert.rejects(missing.layer.sendReminderNow({ projectId: 'p1', msg: 'x', to: [], email: false }), { message: 'That project no longer exists' });
  const denied = make({ functions: { 'mail-sync': errorWith({ error: 'forbidden' }) } });
  await assert.rejects(denied.layer.syncMailNow(), { message: 'Your account is not on the team' });
  const unreadable = make({ functions: { 'mail-sync': { data: null, error: { message: 'Failed to send a request', context: { json: () => Promise.reject(new Error('no body')) } } } } });
  await assert.rejects(unreadable.layer.syncMailNow(), { message: 'Failed to send a request' });
});

test('sendTestNotification invokes send-reminders in test mode', async () => {
  const { client, layer } = make({ functions: { 'send-reminders': ok(null) } });
  await layer.sendTestNotification();
  assert.deepEqual(client.log.invoke[0], { name: 'send-reminders', opts: { body: { mode: 'test' } } });
});

test('server and database errors become Error messages', async () => {
  const rpcFail = make({ rpcs: { rpc_move_project: fail('boom') } });
  await assert.rejects(rpcFail.layer.moveProject('p1', null, ['p1']), { name: 'Error', message: 'boom' });
  const fnFail = make({ functions: { 'send-reminders': fail('boom') } });
  await assert.rejects(fnFail.layer.sendTestNotification(), { message: 'boom' });
  const tableFail = make({ tables: { 'tags.insert': fail('boom') } });
  await assert.rejects(tableFail.layer.createTag('Urgent'), { message: 'boom' });
});

test('resetDemo rejects with Not available', async () => {
  const { layer } = make();
  await assert.rejects(layer.resetDemo(), { message: 'Not available' });
});

test('subscribe forwards postgres changes and removes the channel on unsubscribe', async () => {
  const { client, layer } = make();
  const events = [];
  const unsubscribe = layer.subscribe((evt) => events.push(evt));
  const [ch] = client.log.channels;
  assert.equal(ch.name, 'rendcon-board');
  assert.equal(ch.subscribed, true);
  assert.equal(ch.handlers[0].type, 'postgres_changes');
  assert.deepEqual(ch.handlers[0].filter, { event: '*', schema: 'public' });
  ch.handlers[0].cb({ table: 'projects', eventType: 'UPDATE', new: { id: 'p1' } });
  assert.deepEqual(events, [{ table: 'projects', type: 'UPDATE', record: { id: 'p1' } }]);
  unsubscribe();
  assert.deepEqual(client.log.removed, [ch]);
});

test('signUp reports needsConfirmation when there is no session', async () => {
  const { client, layer } = make();
  assert.deepEqual(await layer.signUp('new@redcon.com', 'pw-123456'), { ok: true, needsConfirmation: true });
  assert.deepEqual(client.log.auth[0].args.options, { emailRedirectTo: 'https://app.example' });
  const confirmed = make({ auth: { signUp: { data: { session: { access_token: 'x' } }, error: null } } });
  assert.deepEqual(await confirmed.layer.signUp('new@redcon.com', 'pw-123456'), { ok: true, needsConfirmation: false });
  const failed = make({ auth: { signUp: { data: null, error: { message: 'weak password' } } } });
  assert.deepEqual(await failed.layer.signUp('new@redcon.com', 'x'), { ok: false, error: 'weak password' });
});

test('signIn maps auth errors to ok:false and init reports the session state', async () => {
  const bad = make({ auth: { signInWithPassword: { data: null, error: { message: 'Invalid login credentials' } } } });
  assert.deepEqual(await bad.layer.signIn('a@b.co', 'wrong'), { ok: false, error: 'Invalid login credentials' });
  const signed = make({ session: { user: { email: 'a@b.co' } } });
  assert.deepEqual(await signed.layer.init(), { signedIn: true });
  assert.deepEqual(await signed.layer.getSession(), { email: 'a@b.co' });
  const anon = make();
  assert.deepEqual(await anon.layer.init(), { signedIn: false });
  assert.equal(await anon.layer.getSession(), null);
});
