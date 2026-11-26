import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'migrations');
const shim = readFileSync(join(here, 'shim.sql'), 'utf8');

const ENGINEER = 'eng@redcon.example';
const ADMIN = 'admin@redcon.example';
const OUTSIDER = 'x@evil.example';
const PROJECT_TITLE = 'إنشاء خزان مياه أرضي سعة 5000 م³';

const TABLES = [
  'people', 'tender_team', 'tags', 'projects', 'project_tags', 'subtasks',
  'mail_events', 'links', 'comments', 'date_changes', 'project_seen',
  'review_queue', 'processed_messages', 'match_examples', 'mail_runs',
  'reminders', 'reminder_deliveries', 'push_subscriptions', 'settings',
  'access_requests',
];

// Shared-database state built in before(); tests run in declaration order.
let db: PGlite;
let adminId: string;
let engineerId: string;
let minaId: string;
let projectId: string;

// Run fn as a Postgres role with a Supabase-style JWT (email) in auth.jwt().
async function as<T>(email: string | null, role: string, fn: () => Promise<T>): Promise<T> {
  const claims = email ? JSON.stringify({ email, role }) : '';
  await db.query("select set_config('request.jwt.claims', $1, false)", [claims]);
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claims', '', false)");
  }
}

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await db.query<T>(sql, params);
  return r.rows[0] as T;
}

before(async () => {
  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(shim);
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = readFileSync(join(migrationsDir, f), 'utf8')
      .replace(/-- @supabase-only begin[\s\S]*?-- @supabase-only end/g, '');
    await db.exec(sql);
  }
  await db.exec(`
    insert into public.people (name, email, role) values
      ('Admin', 'admin@redcon.example', 'admin'),
      ('Eng One', 'eng@redcon.example', 'engineer');
  `);
  adminId = (await one<{ id: string }>("select id from public.people where email = 'admin@redcon.example'")).id;
  engineerId = (await one<{ id: string }>("select id from public.people where email = 'eng@redcon.example'")).id;
  minaId = (await one<{ id: string }>("select id from public.tender_team where name = 'Eng. Mina'")).id;
  const p = await db.query<{ id: string }>(
    `insert into public.projects (title, due_on, tender_id, tender_type)
     values ($1, '2026-12-03', $2, 'private') returning id`,
    [PROJECT_TITLE, minaId],
  );
  projectId = p.rows[0].id;
  await db.query(`insert into public.project_tags (project_id, tag_id) values ($1, 'un')`, [projectId]);
});

after(async () => {
  await db?.close();
});

test('1. all 20 tables exist in public', async () => {
  const r = await db.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = 'public' order by tablename",
  );
  const names = r.rows.map((x) => x.tablename);
  assert.equal(names.length, TABLES.length);
  assert.deepEqual([...names].sort(), [...TABLES].sort());
});

test('2. seed: tags, tender team and settings', async () => {
  const tags = await db.query<{ id: string }>('select id from public.tags order by sort');
  assert.deepEqual(tags.rows.map((x) => x.id), ['new', 'upd', 'qa', 'pp', 'un', 'urgent', 'sub']);

  const team = await db.query<{ name: string; name_ar: string; type: string }>(
    'select name, name_ar, type from public.tender_team order by sort',
  );
  assert.equal(team.rows.length, 4);
  const byAr = Object.fromEntries(team.rows.map((x) => [x.name_ar, x.type]));
  assert.equal(byAr['مينا'], 'private');
  assert.equal(byAr['ميريهان'], 'private');
  assert.equal(byAr['محمد مصطفى'], 'public');
  assert.equal(byAr['شيرين'], 'public');

  const keys = await db.query<{ key: string }>('select key from public.settings order by key');
  assert.deepEqual(keys.rows.map((x) => x.key), ['folders', 'mail', 'mail_state']);
});

test('3. ar_norm matches the section 2.8 test vectors', async () => {
  const vectors: [string, string][] = [
    ['إنشاء خزانُ مياه أرضي سعة ٥٠٠٠ م³ – (المرحلة) ـــ', 'انشاء خزان مياه ارضي سعه 5000 م3 المرحله'],
    ['ورد إلينا – مناقصة عامة: إنشاء مبنى إداري', 'ورد الينا مناقصه عامه انشاء مبني اداري'],
    ['Boundary Wall & Gatehouse', 'boundary wall gatehouse'],
    ['والمشرف علي الدراسه : م/ شيرين محمود', 'والمشرف علي الدراسه م شيرين محمود'],
    ['آخر موعد للتقديم: ٢٠/١٢/٢٠٢٦', 'اخر موعد للتقديم 20 12 2026'],
    ['مؤسسة الأهرام — ١٠٠٪', 'موسسه الاهرام 100'],
  ];
  for (const [input, expected] of vectors) {
    const row = await one<{ v: string }>('select public.ar_norm($1) as v', [input]);
    assert.equal(row.v, expected, `ar_norm(${input})`);
  }
});

test('4. projects.search_norm is filled and trigram search finds the project', async () => {
  const row = await one<{ search_norm: string; hits: number }>(
    `select search_norm,
            (select count(*)::int from public.projects
              where extensions.similarity(search_norm, 'خزان مياه') > 0.2) as hits
       from public.projects where id = $1`,
    [projectId],
  );
  assert.ok(row.search_norm && row.search_norm.length > 0);
  assert.equal(row.hits, 1);
});

test('5. RLS: members see team data, outsiders see nothing, anon is denied', async () => {
  const engProjects = await as(ENGINEER, 'authenticated', () =>
    one<{ n: number }>('select count(*)::int as n from public.projects'));
  assert.equal(engProjects.n, 1);
  const engPeople = await as(ENGINEER, 'authenticated', () =>
    one<{ n: number }>('select count(*)::int as n from public.people'));
  assert.equal(engPeople.n, 2);

  const outProjects = await as(OUTSIDER, 'authenticated', () =>
    one<{ n: number }>('select count(*)::int as n from public.projects'));
  assert.equal(outProjects.n, 0);
  const outPeople = await as(OUTSIDER, 'authenticated', () =>
    one<{ n: number }>('select count(*)::int as n from public.people'));
  assert.equal(outPeople.n, 0);

  await assert.rejects(
    as(null, 'anon', () => db.query('select * from public.projects')),
    /permission denied/,
  );
});

test('6. RLS: only admins write tender_team; engineers cannot write mail_events', async () => {
  await assert.rejects(
    as(ENGINEER, 'authenticated', () =>
      db.query(`insert into public.tender_team (name) values ('Eng. Intruder')`)),
  );
  const inserted = await as(ADMIN, 'authenticated', () =>
    db.query(`insert into public.tender_team (name) values ('Eng. Test Admin') returning id`));
  assert.equal(inserted.rows.length, 1);
  await db.exec(`delete from public.tender_team where name = 'Eng. Test Admin'`);

  await assert.rejects(
    as(ENGINEER, 'authenticated', () =>
      db.query(
        `insert into public.mail_events (project_id, message_id, folder, direction, kind, received_at)
         values ($1, 'msg-eng-forged', 'inbox', 'received', 'update', now())`,
        [projectId],
      )),
  );
});

test('7. people: own colour yes; own role no; other person name is a 0-row update', async () => {
  const updated = await as(ENGINEER, 'authenticated', () =>
    db.query(`update public.people set color = '#123456' where id = $1`, [engineerId]));
  assert.equal(updated.affectedRows, 1);
  const color = await one<{ color: string }>('select color from public.people where id = $1', [engineerId]);
  assert.equal(color.color, '#123456');

  await assert.rejects(
    as(ENGINEER, 'authenticated', () =>
      db.query(`update public.people set role = 'admin' where id = $1`, [engineerId])),
    /Only an admin/,
  );

  const other = await as(ENGINEER, 'authenticated', () =>
    db.query(`update public.people set name = 'Hacked' where id = $1`, [adminId]));
  assert.equal(other.affectedRows, 0);
  const adminName = await one<{ name: string }>('select name from public.people where id = $1', [adminId]);
  assert.equal(adminName.name, 'Admin');
});

test('8. rpc_move_project assigns and moves back, with system comments', async () => {
  await as(ENGINEER, 'authenticated', () =>
    db.query('select public.rpc_move_project($1, $2, $3::uuid[])',
      [projectId, engineerId, `{${projectId}}`]));

  const assigned = await one<{ assignee_id: string }>(
    'select assignee_id from public.projects where id = $1', [projectId]);
  assert.equal(assigned.assignee_id, engineerId);
  const untagged = await one<{ n: number }>(
    `select count(*)::int as n from public.project_tags where project_id = $1 and tag_id = 'un'`, [projectId]);
  assert.equal(untagged.n, 0);
  const lastA = await one<{ body: string }>(
    'select body from public.comments where project_id = $1 order by created_at desc, id desc limit 1', [projectId]);
  assert.equal(lastA.body, 'Assigned to Eng One');

  await as(ENGINEER, 'authenticated', () =>
    db.query('select public.rpc_move_project($1, null, $2::uuid[])',
      [projectId, `{${projectId}}`]));

  const tagged = await one<{ n: number }>(
    `select count(*)::int as n from public.project_tags where project_id = $1 and tag_id = 'un'`, [projectId]);
  assert.equal(tagged.n, 1);
  const lastB = await one<{ body: string }>(
    'select body from public.comments where project_id = $1 order by created_at desc, id desc limit 1', [projectId]);
  assert.equal(lastB.body, 'Moved back to unassigned');
});

test('9. rpc_set_due_date records one change and a system comment; unchanged date returns false', async () => {
  const first = await as(ENGINEER, 'authenticated', () =>
    one<{ r: boolean }>(`select public.rpc_set_due_date($1, '2027-01-10') as r`, [projectId]));
  assert.equal(first.r, true);

  const changes = await db.query<{ from_date: string; to_date: string; changed_by: string }>(
    `select from_date::text, to_date::text, changed_by from public.date_changes`);
  assert.equal(changes.rows.length, 1);
  assert.deepEqual(changes.rows[0], {
    from_date: '2026-12-03', to_date: '2027-01-10', changed_by: 'Eng One',
  });

  const comment = await one<{ body: string }>(
    `select body from public.comments where project_id = $1 and body like 'Submission date%'
      order by created_at desc, id desc limit 1`, [projectId]);
  assert.equal(comment.body, 'Submission date changed from 03 Dec 2026 to 10 Jan 2027');

  const second = await as(ENGINEER, 'authenticated', () =>
    one<{ r: boolean }>(`select public.rpc_set_due_date($1, '2027-01-10') as r`, [projectId]));
  assert.equal(second.r, false);
});

test('10. a subtask touches its project: updated_at moves and updated_by is the person', async () => {
  const before = await one<{ t: string }>('select updated_at::text as t from public.projects where id = $1', [projectId]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await as(ENGINEER, 'authenticated', () =>
    db.query(`insert into public.subtasks (project_id, text) values ($1, 'Prepare drawings')`, [projectId]));
  const after = await one<{ moved: boolean; updated_by: string }>(
    `select updated_at > $2::timestamptz as moved, updated_by from public.projects where id = $1`,
    [projectId, before.t]);
  assert.equal(after.moved, true);
  assert.equal(after.updated_by, 'Eng One');
});

test('11. rpc_start_mail_run: service role gets a run id once; engineer is refused', async () => {
  const first = await as(null, 'service_role', () =>
    one<{ id: string | null }>(`select public.rpc_start_mail_run('cron') as id`));
  assert.match(first.id ?? '', /^[0-9a-f-]{36}$/);
  const second = await as(null, 'service_role', () =>
    one<{ id: string | null }>(`select public.rpc_start_mail_run('cron') as id`));
  assert.equal(second.id, null);

  await assert.rejects(
    as(ENGINEER, 'authenticated', () => db.query(`select public.rpc_start_mail_run('manual')`)),
    /permission denied/,
  );
});

test('12. hook_before_user_created: anyone may sign up; outsiders wait for an admin', async () => {
  const ok = await one<{ r: unknown }>(
    `select public.hook_before_user_created($1::jsonb) as r`,
    [JSON.stringify({ user: { email: 'ENG@redcon.example' } })]);
  assert.deepEqual(ok.r, {});
  const none = await one<{ n: number }>(`select count(*)::int as n from public.access_requests`);
  assert.equal(none.n, 0);

  const outsider = await one<{ r: unknown }>(
    `select public.hook_before_user_created($1::jsonb) as r`,
    [JSON.stringify({ user: { email: 'X@Evil.example' } })]);
  assert.deepEqual(outsider.r, {});
  await db.query(`select public.hook_before_user_created($1::jsonb)`, [JSON.stringify({ user: { email: OUTSIDER } })]);
  const queued = await one<{ n: number; e: string }>(`select count(*)::int as n, max(email) as e from public.access_requests`);
  assert.equal(queued.n, 1);
  assert.equal(queued.e, OUTSIDER);

  // the outsider (and an engineer) cannot see requests or any board data; the admin can see requests
  const seenByOutsider = await as(OUTSIDER, 'authenticated', () => db.query('select * from public.access_requests'));
  assert.equal(seenByOutsider.rows.length, 0);
  const projectsByOutsider = await as(OUTSIDER, 'authenticated', () => db.query('select * from public.projects'));
  assert.equal(projectsByOutsider.rows.length, 0);
  const seenByEngineer = await as(ENGINEER, 'authenticated', () => db.query('select * from public.access_requests'));
  assert.equal(seenByEngineer.rows.length, 0);
  const seenByAdmin = await as(ADMIN, 'authenticated', () => db.query('select * from public.access_requests'));
  assert.equal(seenByAdmin.rows.length, 1);

  // approving = adding them to people, which clears the request
  await as(ADMIN, 'authenticated', () =>
    db.query(`insert into public.people (name, email, has_column) values ('X', $1, false)`, [OUTSIDER]));
  const cleared = await one<{ n: number }>(`select count(*)::int as n from public.access_requests`);
  assert.equal(cleared.n, 0);
  const nowMember = await as(OUTSIDER, 'authenticated', () => db.query('select * from public.projects'));
  assert.equal(nowMember.rows.length, 1);
  await db.query(`delete from public.people where email = $1`, [OUTSIDER]);
});

test('13. changing a tender engineer type updates their projects', async () => {
  const before = await one<{ t: string }>('select tender_type as t from public.projects where id = $1', [projectId]);
  assert.equal(before.t, 'private');
  await db.exec(`update public.tender_team set type = 'public' where id = '${minaId}'`);
  const after = await one<{ t: string }>('select tender_type as t from public.projects where id = $1', [projectId]);
  assert.equal(after.t, 'public');
});

test('14. colours are 6-digit hex: an injected colour is refused, a valid one is accepted', async () => {
  await assert.rejects(
    as(ENGINEER, 'authenticated', () =>
      db.query(`update public.people set color = 'red"><x' where id = $1`, [engineerId])),
    /people_color_hex/,
  );
  const ok = await as(ENGINEER, 'authenticated', () =>
    db.query(`update public.people set color = '#123ABC' where id = $1`, [engineerId]));
  assert.equal(ok.affectedRows, 1);
  const color = await one<{ color: string }>('select color from public.people where id = $1', [engineerId]);
  assert.equal(color.color, '#123ABC');
});
