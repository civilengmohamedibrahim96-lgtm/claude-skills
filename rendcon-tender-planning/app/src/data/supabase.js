// Redcon Tender Planning – Supabase data layer (implements the §2.7 contract in contract.js).
// The supabase-js client is injected by data/index.js. No keys, no service role, no direct fetch.

import { SYSTEM_TEXT, OUTCOME_LABELS } from './contract.js';

const TAG_COLORS = ['#EE6A1F', '#5B5B57', '#9C4A12', '#2F7D7A', '#B8860B'];
const PERSON_COLORS = ['#111111', '#EE6A1F', '#5B5B57', '#9C4A12', '#2F7D7A', '#B8860B'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AUTH_EVENTS = ['SIGNED_IN', 'SIGNED_OUT', 'PASSWORD_RECOVERY'];

/** '2026-12-03' → '03 Dec 2026' (en-GB, UTC). Empty input → ''. */
export function fmtDay(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(iso));
}

const ms = (t) => (t ? new Date(t).getTime() : 0);
const byNumber = (get, dir = 1) => (a, b) => dir * (get(a) - get(b));

/** Unwraps a supabase-js { data, error } result; errors become Error(message). */
function unwrap(res, fallback = 'Request failed') {
  if (res.error) throw new Error(res.error.message || fallback);
  return res.data;
}

function mapProject(r, seenMap) {
  const subtasks = (r.subtasks ?? []).slice().sort((a, b) => a.position - b.position || ms(a.created_at) - ms(b.created_at));
  const comments = (r.comments ?? []).slice().sort(byNumber((c) => ms(c.created_at)));
  const dueHistory = (r.date_changes ?? []).slice().sort(byNumber((c) => ms(c.created_at), -1));
  const mailLog = (r.mail_events ?? []).slice().sort(byNumber((e) => ms(e.created_at), -1));
  const notifications = (r.reminders ?? []).filter((x) => !x.fired).slice().sort(byNumber((x) => ms(x.at)));
  return {
    id: r.id,
    title: r.title,
    client: r.client ?? '',
    ref: r.ref ?? '',
    type: r.tender_type,
    tender: r.tender_id ?? null,
    supervisor: r.supervisor ?? '',
    columnId: r.assignee_id ?? null,
    pos: r.position ?? 0,
    status: r.status ?? '',
    received: r.received_on ?? '',
    due: r.due_on ?? '',
    folder: r.folder_url ?? '',
    source: r.source,
    subOpen: r.sub_open,
    updatedAt: ms(r.updated_at),
    updatedBy: r.updated_by ?? '',
    mailSeen: seenMap.get(r.id) ?? 0,
    tags: (r.project_tags ?? []).map((t) => t.tag_id),
    subtasks: subtasks.map((s) => ({ id: s.id, text: s.text, done: s.done, note: s.note ?? '', due: s.due_on ?? '' })),
    links: (r.links ?? []).map((l) => ({ id: l.id, title: l.title, url: l.url, src: l.source === 'email' })),
    comments: comments.map((c) => ({ id: c.id, who: c.author_name, text: c.body, at: ms(c.created_at), sys: c.system })),
    dueHistory: dueHistory.map((d) => ({ from: d.from_date ?? '', to: d.to_date ?? '', by: d.changed_by, at: ms(d.created_at) })),
    mailLog: mailLog.map((e) => ({
      id: e.id,
      at: ms(e.created_at),
      emailAt: ms(e.received_at),
      kind: e.kind,
      direction: e.direction,
      summary: e.summary ?? '',
      subject: e.subject ?? '',
      links: e.links_count ?? 0,
      webLink: e.web_link ?? '',
    })),
    notifications: notifications.map((x) => ({
      id: x.id,
      at: ms(x.at),
      msg: x.message,
      repeat: x.repeat,
      fired: x.fired,
      to: x.recipients ?? [],
      email: x.email,
      projectId: x.project_id ?? null,
    })),
  };
}

function mapReminder(x) {
  return {
    id: x.id,
    at: ms(x.at),
    msg: x.message,
    repeat: x.repeat,
    fired: x.fired,
    to: x.recipients ?? [],
    email: x.email,
    projectId: x.project_id ?? null,
  };
}

function mapMailRun(r) {
  const s = r.summary ?? {};
  return {
    at: ms(r.started_at),
    trigger: r.trigger,
    fetched: s.fetched ?? 0,
    created: s.created ?? 0,
    updated: s.updated ?? 0,
    review: s.review ?? 0,
    prefiltered: s.prefiltered ?? 0,
    ignored: s.ignored ?? 0,
    errors: s.errors ?? 0,
  };
}

function mapMailLog(p) {
  let label = OUTCOME_LABELS[p.outcome] ?? p.outcome;
  if (p.outcome === 'applied' && p.projects?.title) label += ' → ' + p.projects.title;
  return {
    id: p.message_id,
    subject: p.subject ?? '',
    from: p.from_address ?? '',
    at: ms(p.received_at ?? p.processed_at),
    outcome: p.outcome,
    label,
    pid: p.project_id ?? null,
  };
}

function mapReview(r) {
  const m = r.message ?? {};
  const ai = r.ai_form ?? null;
  const v = r.validated ?? null;
  return {
    id: r.id,
    subject: m.subject ?? '',
    from: m.from?.address ?? '',
    at: ms(m.date ?? r.created_at),
    excerpt: (m.bodyText ?? '').slice(0, 300),
    summary: ai?.summary ?? v?.summary ?? '',
    kind: ai?.kind ?? v?.kind ?? '',
    title: v?.projectName ?? ai?.project_name ?? '',
    reasons: r.reasons ?? [],
    candidates: (r.candidates ?? []).map((c) => ({ pid: c.projectId, title: c.title, score: c.score })),
    webLink: m.webLink ?? '',
  };
}

function userAgent() {
  return typeof navigator !== 'undefined' && navigator.userAgent ? navigator.userAgent : '';
}

export function createSupabaseDataLayer({
  client,
  now = () => Date.now(),
  origin = (typeof location !== 'undefined' ? location.origin : ''),
}) {
  // The signed-in people row ({id, name}) from the last loadBoard(); null when not on the team.
  let meRow = null;
  const isoNow = () => new Date(now()).toISOString();

  async function currentMe() {
    if (!meRow) await loadBoard();
    if (!meRow) throw new Error('Your account is not on the team');
    return meRow;
  }

  async function systemComment(projectId, body) {
    unwrap(await client.from('comments').insert({ project_id: projectId, author_name: 'System', body, system: true }));
  }

  async function loadBoard() {
    const [session, people, team, tags, projects, seen, reminders, deliveries, settings, runs, processed, reviews, requests] = await Promise.all([
      client.auth.getSession(),
      client.from('people').select('*').eq('active', true).order('board_order'),
      client.from('tender_team').select('*').order('sort').order('name'),
      client.from('tags').select('*').order('sort').order('created_at'),
      client.from('projects').select('*, project_tags(tag_id), subtasks(*), links(*), comments(*), date_changes(*), mail_events(id,kind,direction,summary,subject,links_count,received_at,created_at,web_link), reminders(*)').eq('archived', false),
      client.from('project_seen').select('project_id, seen_at'),
      client.from('reminders').select('*').is('project_id', null).eq('fired', false).order('at'),
      client.from('reminder_deliveries').select('*, projects(title)').order('sent_at', { ascending: false }).limit(10),
      client.from('settings').select('*'),
      client.from('mail_runs').select('*').order('started_at', { ascending: false }).limit(5),
      client.from('processed_messages').select('*, projects(title)').order('processed_at', { ascending: false }).limit(30),
      client.from('review_queue').select('*').eq('status', 'open').order('created_at', { ascending: false }),
      client.from('access_requests').select('*').order('created_at', { ascending: false }),
    ]);

    const email = session?.data?.session?.user?.email ?? '';
    const peopleRows = unwrap(people) ?? [];
    const lower = email.toLowerCase();
    const meDb = lower ? peopleRows.find((p) => (p.email ?? '').toLowerCase() === lower) ?? null : null;
    meRow = meDb ? { id: meDb.id, name: meDb.name } : null;

    const users = peopleRows.map((p) => ({
      id: p.id,
      name: p.name,
      email: p.email ?? '',
      role: p.role,
      color: p.color,
      status: 'active',
      prefs: { browser: p.prefs?.push ?? true, email: p.prefs?.email ?? true },
      hasColumn: p.has_column,
      order: p.board_order,
    }));

    const seenMap = new Map((unwrap(seen) ?? []).map((s) => [s.project_id, ms(s.seen_at)]));
    const settingsMap = Object.fromEntries((unwrap(settings) ?? []).map((s) => [s.key, s.value ?? {}]));
    const mailSetting = settingsMap.mail ?? {};
    const mailState = settingsMap.mail_state ?? {};

    return {
      mode: 'supabase',
      me: meDb ? users.find((u) => u.id === meDb.id) ?? null : null,
      users,
      tenderTeam: (unwrap(team) ?? []).map((t) => ({ id: t.id, name: t.name, ar: t.name_ar ?? '', type: t.type })),
      tags: (unwrap(tags) ?? []).map((t) => ({ id: t.id, name: t.name, color: t.color })),
      projects: (unwrap(projects) ?? []).map((p) => mapProject(p, seenMap)),
      reminders: (unwrap(reminders) ?? []).map(mapReminder),
      sentLog: (unwrap(deliveries) ?? []).map((d) => ({
        id: d.id,
        msg: d.message,
        project: d.projects?.title ?? '',
        names: d.recipient_names ?? [],
        email: d.email_count ?? 0,
        at: ms(d.sent_at),
      })),
      mail: {
        address: mailSetting.address ?? '',
        subject: mailSetting.subjectHint ?? '',
        hourly: mailSetting.hourlyEnabled !== false,
        lastSync: mailState.lastRunAt ? ms(mailState.lastRunAt) : null,
        runs: (unwrap(runs) ?? []).map(mapMailRun),
        log: (unwrap(processed) ?? []).map(mapMailLog),
        reviews: (unwrap(reviews) ?? []).map(mapReview),
      },
      folders: { root: (settingsMap.folders ?? {}).rootUrl ?? '' },
      // only admins can read these (RLS); before this table exists the error is ignored
      accessRequests: (requests?.error ? [] : requests?.data ?? []).map((r) => ({ id: r.id, email: r.email, at: ms(r.created_at) })),
    };
  }

  /** Invokes an edge function. Errors carry the function's JSON `error` code when it has one, mapped to a readable message. */
  async function invoke(name, body) {
    const res = await client.functions.invoke(name, { body });
    if (res.error) {
      let j = null;
      try { j = await res.error.context?.json?.(); } catch { j = null; }
      const code = j?.error;
      const message = code === 'not_found_or_closed' ? 'Someone already handled this email'
        : code === 'project_not_found' ? 'That project no longer exists'
          : code === 'forbidden' ? 'Your account is not on the team'
            : (code || res.error.message || 'Server function failed');
      throw new Error(message);
    }
    return res.data;
  }

  return {
    // ---- auth ----
    async init() {
      const res = await client.auth.getSession();
      return { signedIn: !!res.data?.session };
    },

    async getSession() {
      const res = await client.auth.getSession();
      const email = res.data?.session?.user?.email;
      return email ? { email } : null;
    },

    async signIn(email, password) {
      const { error } = await client.auth.signInWithPassword({ email, password });
      return error ? { ok: false, error: error.message } : { ok: true };
    },

    async signUp(email, password) {
      const { data, error } = await client.auth.signUp({ email, password, options: { emailRedirectTo: origin } });
      if (error) return { ok: false, error: error.message };
      return { ok: true, needsConfirmation: !data?.session };
    },

    async signOut() {
      unwrap(await client.auth.signOut(), 'Sign out failed');
      meRow = null;
    },

    async requestPasswordReset(email) {
      const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: origin });
      return error ? { ok: false, error: error.message } : { ok: true };
    },

    async updatePassword(password) {
      const { error } = await client.auth.updateUser({ password });
      return error ? { ok: false, error: error.message } : { ok: true };
    },

    onAuthChange(cb) {
      const { data } = client.auth.onAuthStateChange((event) => {
        if (event === 'SIGNED_OUT') meRow = null;
        cb(AUTH_EVENTS.includes(event) ? event : 'OTHER');
      });
      return () => data.subscription.unsubscribe();
    },

    // ---- board ----
    loadBoard,

    subscribe(cb) {
      const channel = client
        .channel('rendcon-board')
        .on('postgres_changes', { event: '*', schema: 'public' }, (payload) =>
          cb({ table: payload.table, type: payload.eventType, record: payload.new }))
        .subscribe();
      return () => client.removeChannel(channel);
    },

    // ---- projects ----
    async createProject({ title, tender, type, due, client: company, columnId }) {
      const project = unwrap(await client.from('projects').insert({
        title,
        client: company ?? '',
        tender_type: type,
        tender_id: tender ?? null,
        due_on: due || null,
        assignee_id: columnId ?? null,
        received_on: isoNow().slice(0, 10),
        source: 'manual',
      }).select('id').single());
      const tagIds = columnId ? ['new'] : ['new', 'un'];
      unwrap(await client.from('project_tags').insert(tagIds.map((tag_id) => ({ project_id: project.id, tag_id }))));
      await systemComment(project.id, SYSTEM_TEXT.created);
      return project.id;
    },

    async updateProject(id, patch) {
      const row = {};
      const map = { title: 'title', client: 'client', ref: 'ref', type: 'tender_type', supervisor: 'supervisor', status: 'status', folder: 'folder_url', subOpen: 'sub_open' };
      for (const [key, column] of Object.entries(map)) if (key in patch) row[column] = patch[key];
      if ('received' in patch) row.received_on = patch.received || null;

      const comments = [];
      if ('tender' in patch) {
        let member = null;
        if (patch.tender) {
          const t = unwrap(await client.from('tender_team').select('*').eq('id', patch.tender).single());
          member = { id: t.id, name: t.name, ar: t.name_ar ?? '', type: t.type };
        }
        row.tender_id = member ? member.id : null;
        if (member) row.tender_type = member.type;
        comments.push(SYSTEM_TEXT.tender(member));
      }
      if ('status' in patch) comments.unshift(SYSTEM_TEXT.status(patch.status));
      if (patch.folder) comments.push(SYSTEM_TEXT.folder(patch.folder));

      if (Object.keys(row).length) unwrap(await client.from('projects').update(row).eq('id', id));
      for (const text of comments) await systemComment(id, text);
    },

    async deleteProject(id) {
      unwrap(await client.from('projects').delete().eq('id', id));
    },

    async moveProject(id, columnId, orderedIds) {
      unwrap(await client.rpc('rpc_move_project', { p_project: id, p_assignee: columnId ?? null, p_order: orderedIds }));
    },

    async setDueDate(id, due) {
      return unwrap(await client.rpc('rpc_set_due_date', { p_project: id, p_due: due || null })) === true;
    },

    async toggleTag(id, tagId, on) {
      if (on) unwrap(await client.from('project_tags').insert({ project_id: id, tag_id: tagId }));
      else unwrap(await client.from('project_tags').delete().eq('project_id', id).eq('tag_id', tagId));
    },

    async markMailSeen(id) {
      const who = await currentMe();
      unwrap(await client.from('project_seen').upsert(
        { person_id: who.id, project_id: id, seen_at: isoNow() },
        { onConflict: 'person_id,project_id' },
      ));
    },

    async createTag(name) {
      const existing = unwrap(await client.from('tags').select('id')) ?? [];
      const color = TAG_COLORS[existing.length % TAG_COLORS.length];
      const tag = unwrap(await client.from('tags').insert({ name: name.trim(), color }).select('*').single());
      return { id: tag.id, name: tag.name, color: tag.color };
    },

    // ---- sub-tasks, links, comments ----
    async addSubtask(projectId, { text, due }) {
      const last = unwrap(await client.from('subtasks').select('position').eq('project_id', projectId)
        .order('position', { ascending: false }).limit(1)) ?? [];
      const position = (last[0]?.position ?? -1) + 1;
      const row = unwrap(await client.from('subtasks').insert({ project_id: projectId, text, due_on: due || null, position }).select('id').single());
      return row.id;
    },

    async updateSubtask(id, patch) {
      const row = {};
      for (const key of ['text', 'done', 'note']) if (key in patch) row[key] = patch[key];
      if ('due' in patch) row.due_on = patch.due || null;
      if (Object.keys(row).length) unwrap(await client.from('subtasks').update(row).eq('id', id));
    },

    async deleteSubtask(id) {
      unwrap(await client.from('subtasks').delete().eq('id', id));
    },

    async addLink(projectId, { title, url }) {
      const row = unwrap(await client.from('links').insert({ project_id: projectId, title: title ?? '', url }).select('id').single());
      return row.id;
    },

    async deleteLink(id) {
      unwrap(await client.from('links').delete().eq('id', id));
    },

    async addComment(projectId, text) {
      const who = await currentMe();
      const row = unwrap(await client.from('comments').insert({
        project_id: projectId,
        author_id: who.id,
        author_name: who.name,
        body: text,
        system: false,
      }).select('id').single());
      return row.id;
    },

    // ---- reminders ----
    async addReminder({ projectId, at, msg, repeat, to, email }) {
      const who = await currentMe();
      const row = unwrap(await client.from('reminders').insert({
        project_id: projectId ?? null,
        message: msg,
        at: new Date(at).toISOString(),
        repeat,
        recipients: to,
        email,
        created_by: who.id,
      }).select('id').single());
      return row.id;
    },

    async deleteReminder(id) {
      unwrap(await client.from('reminders').delete().eq('id', id));
    },

    async sendReminderNow({ projectId, msg, to, email }) {
      const data = await invoke('send-reminders', {
        mode: 'now', reminder: { projectId: projectId ?? null, message: msg, recipients: to, email },
      });
      return { names: data?.recipientNames ?? [], emails: data?.emails ?? 0 };
    },

    async sendTestNotification() {
      await invoke('send-reminders', { mode: 'test' });
    },

    // ---- team ----
    async addPerson({ name, email, role, hasColumn }) {
      const cleanEmail = (email ?? '').trim().toLowerCase();
      let displayName = (name ?? '').trim();
      if (!displayName && cleanEmail) {
        displayName = cleanEmail.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      }
      if (!displayName) return { ok: false, error: 'missing_name' };
      if (cleanEmail && !EMAIL_RE.test(cleanEmail)) return { ok: false, error: 'invalid_email' };

      const active = unwrap(await client.from('people').select('board_order').eq('active', true)) ?? [];
      const color = PERSON_COLORS[active.length % PERSON_COLORS.length];
      const order = active.reduce((max, p) => Math.max(max, p.board_order), -1) + 1;
      const res = await client.from('people').insert({
        name: displayName,
        email: cleanEmail || null,
        role: role ?? 'engineer',
        color,
        board_order: order,
        has_column: hasColumn ?? true,
        prefs: { push: true, email: !!cleanEmail },
      }).select('id').single();
      if (res.error) {
        if (res.error.code === '23505') return { ok: false, error: 'duplicate_email' };
        throw new Error(res.error.message || 'Request failed');
      }
      return { ok: true, id: res.data.id };
    },

    async updatePerson(id, patch) {
      const row = {};
      if ('name' in patch) row.name = patch.name;
      if ('email' in patch) row.email = patch.email ? patch.email.trim().toLowerCase() : null;
      if ('role' in patch) row.role = patch.role;
      if ('color' in patch) row.color = patch.color;
      if (patch.prefs) {
        const current = unwrap(await client.from('people').select('prefs').eq('id', id).single());
        const prefs = { ...(current.prefs ?? {}) };
        if ('browser' in patch.prefs) prefs.push = patch.prefs.browser;
        if ('email' in patch.prefs) prefs.email = patch.prefs.email;
        row.prefs = prefs;
      }
      if (Object.keys(row).length) unwrap(await client.from('people').update(row).eq('id', id));
    },

    async dismissAccessRequest(id) {
      unwrap(await client.from('access_requests').delete().eq('id', id));
    },

    async removePerson(id) {
      unwrap(await client.rpc('rpc_remove_person', { p_person: id }));
    },

    async reorderPeople(ids) {
      unwrap(await client.rpc('rpc_reorder_people', { p_ids: ids }));
    },

    async setColumn(userId, on) {
      unwrap(await client.rpc('rpc_set_column', { p_person: userId, p_on: !!on }));
    },

    async addTenderMember({ name, ar, type }) {
      const row = unwrap(await client.from('tender_team').insert({ name, name_ar: ar ?? '', type }).select('id').single());
      return row.id;
    },

    async updateTenderMember(id, patch) {
      const row = {};
      if ('name' in patch) row.name = patch.name;
      if ('ar' in patch) row.name_ar = patch.ar ?? '';
      if ('type' in patch) row.type = patch.type;
      if (Object.keys(row).length) unwrap(await client.from('tender_team').update(row).eq('id', id));
      // Every project of this tender takes the member's type.
      if ('type' in patch) unwrap(await client.from('projects').update({ tender_type: patch.type }).eq('tender_id', id));
    },

    async removeTenderMember(id) {
      // Projects keep their row: the foreign key is ON DELETE SET NULL, so their tender becomes null.
      unwrap(await client.from('tender_team').delete().eq('id', id));
    },

    async updateSettings(patch) {
      const who = await currentMe();
      const touchesMail = ['address', 'subject', 'hourly'].some((k) => k in patch);
      const touchesFolders = 'folderRoot' in patch;
      if (!touchesMail && !touchesFolders) return;

      const rows = unwrap(await client.from('settings').select('*').in('key', ['mail', 'folders'])) ?? [];
      const byKey = Object.fromEntries(rows.map((r) => [r.key, { ...(r.value ?? {}) }]));
      const writes = [];
      if (touchesMail) {
        const mail = byKey.mail ?? {};
        if ('address' in patch) mail.address = patch.address;
        if ('subject' in patch) mail.subjectHint = patch.subject;
        if ('hourly' in patch) mail.hourlyEnabled = !!patch.hourly;
        writes.push(['mail', mail]);
      }
      if (touchesFolders) {
        const folders = byKey.folders ?? {};
        folders.rootUrl = patch.folderRoot;
        writes.push(['folders', folders]);
      }
      for (const [key, value] of writes) {
        unwrap(await client.from('settings').update({ value, updated_by: who.name, updated_at: isoNow() }).eq('key', key));
      }
    },

    // ---- email ----
    async syncMailNow() {
      const d = await invoke('mail-sync', { source: 'manual' });
      if (d?.skipped === 'already_running') throw new Error('An email sync is already running – try again in a few minutes');
      if ((d?.errors ?? 0) > 0 && !d?.fetched) throw new Error('Email sync failed – check the mailbox connection (Email intake → recent runs)');
      return {
        read: (d?.fetched ?? 0) - (d?.alreadyProcessed ?? 0),
        created: d?.created ?? 0,
        updated: d?.updated ?? 0,
        review: d?.review ?? 0,
      };
    },

    async resolveReview(reviewId, resolution) {
      const d = await invoke('mail-review', { reviewId, ...resolution });
      return { projectId: d?.projectId ?? null };
    },

    // ---- push ----
    async savePushSubscription(sub) {
      const who = await currentMe();
      unwrap(await client.from('push_subscriptions').upsert({
        person_id: who.id,
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        user_agent: userAgent(),
      }, { onConflict: 'endpoint' }));
    },

    async deletePushSubscription(endpoint) {
      unwrap(await client.from('push_subscriptions').delete().eq('endpoint', endpoint));
    },

    // ---- demo only ----
    async resetDemo() {
      throw new Error('Not available');
    },
  };
}
