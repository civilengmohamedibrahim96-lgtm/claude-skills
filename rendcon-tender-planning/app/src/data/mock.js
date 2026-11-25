// Demo data layer: implements every method of DATA_LAYER_METHODS in memory,
// persisted as JSON under one localStorage key (or kept in memory without storage).
import { SYSTEM_TEXT, assertDataLayer } from './contract.js';
import { seedState } from './seed.js';
import { HOUR, TAG_PALETTE } from '../lib/util.js';
import { makeProject, newId, runMockSync, applyReview, PALETTE_USERS } from './mock-mail.js';

export const MOCK_KEY = 'rendcon-tp-real-v1';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const fmtDay = (iso) => {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
};
const deriveName = (email) => email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export function createMockDataLayer({ storage = null, now = () => Date.now(), timers = true } = {}) {
  let mem = null;
  const listeners = new Set();
  const authListeners = new Set();
  const emit = (evt) => listeners.forEach((cb) => { try { cb(evt); } catch (e) { console.error(e); } });

  // ---- persistence ----
  function load() {
    if (storage) {
      try {
        const raw = storage.getItem(MOCK_KEY);
        if (raw) {
          const st = JSON.parse(raw);
          if (st && Array.isArray(st.projects)) { mem = st; return st; }
        }
      } catch (_) { /* unreadable storage: fall back to memory */ }
    }
    if (!mem) mem = seedState(now());
    return mem;
  }
  function save(st) {
    mem = st;
    if (storage) { try { storage.setItem(MOCK_KEY, JSON.stringify(st)); } catch (_) { /* quota or private mode */ } }
  }
  function mutate(fn) {
    const st = load();
    const out = fn(st);
    save(st);
    emit({ table: 'board', type: 'UPDATE' });
    return out;
  }

  // ---- helpers ----
  const me = (st) => st.users.find((u) => u.id === st.meId) || null;
  const needMe = (st) => { const m = me(st); if (!m) throw new Error('You are not on the planning team'); return m; };
  const needAdmin = (st) => { const m = needMe(st); if (m.role !== 'admin') throw new Error('Only an admin can do that'); return m; };
  const findP = (st, id) => { const p = st.projects.find((x) => x.id === id); if (!p) throw new Error('Project not found'); return p; };
  const findReminder = (st, id) => {
    for (const p of st.projects) { const r = p.notifications.find((x) => x.id === id); if (r) return { list: p.notifications, r }; }
    const g = st.reminders.find((x) => x.id === id);
    return g ? { list: st.reminders, r: g } : null;
  };
  const sys = (text) => ({ id: newId(), who: 'System', text, at: now(), sys: true });
  const touch = (st, p) => { p.updatedAt = now(); p.updatedBy = (me(st) || {}).name || 'email'; };
  const resolveRecipients = (st, to, p) => {
    const ids = new Set();
    (to || []).forEach((t) => {
      if (t === 'all') st.users.forEach((u) => ids.add(u.id));
      else if (t === 'assignee') { if (p && p.columnId && st.users.some((u) => u.id === p.columnId)) ids.add(p.columnId); }
      else if (st.users.some((u) => u.id === t)) ids.add(t);
    });
    return [...ids].map((id) => st.users.find((u) => u.id === id)).sort((a, b) => a.order - b.order);
  };
  const reminderTitle = (p) => 'Reminder' + (p ? ' · ' + (p.title.length > 40 ? p.title.slice(0, 38) + '…' : p.title) : '');

  // ---- projection to the BoardState view model ----
  function boardOf(st) {
    const m = me(st);
    const byDate = (a, b) => (a.at || 0) - (b.at || 0);
    const projects = st.projects.map((p) => ({
      id: p.id, title: p.title, client: p.client || '', ref: p.ref || '', type: p.type || 'public', tender: p.tender ?? null,
      supervisor: p.supervisor || '', columnId: p.columnId ?? null, pos: p.pos || 0, status: p.status || '',
      received: p.received || '', due: p.due || '', folder: p.folder || '', source: p.source || 'manual',
      subOpen: p.subOpen !== false, updatedAt: p.updatedAt || 0, updatedBy: p.updatedBy || '', mailSeen: p.mailSeen || 0,
      tags: [...(p.tags || [])],
      subtasks: (p.subtasks || []).map((s) => ({ id: s.id, text: s.text || '', done: !!s.done, note: s.note || '', due: s.due || '' })),
      links: (p.links || []).map((l) => ({ id: l.id, title: l.title || '', url: l.url, src: !!l.src })),
      comments: (p.comments || []).map((c) => ({ id: c.id, who: c.who, text: c.text, at: c.at, sys: !!c.sys })).sort(byDate),
      dueHistory: (p.dueHistory || []).map((h) => ({ from: h.from || '', to: h.to || '', by: h.by, at: h.at })),
      mailLog: (p.mailLog || []).map((e) => ({ id: e.id, at: e.at, emailAt: e.emailAt ?? e.at, kind: e.kind, direction: e.direction || 'received', summary: e.summary || '', subject: e.subject || '', links: e.links || 0, webLink: e.webLink || '' })),
      notifications: (p.notifications || []).filter((n) => !n.fired).map((n) => ({ id: n.id, at: n.at, msg: n.msg, repeat: n.repeat, fired: false, to: [...(n.to || [])], email: !!n.email, projectId: p.id })).sort(byDate),
    }));
    return {
      mode: 'mock',
      me: m ? userOut(m) : null,
      users: st.users.slice().sort((a, b) => a.order - b.order).map(userOut),
      tenderTeam: st.tenderTeam.slice().sort((a, b) => (a.sort || 0) - (b.sort || 0)).map((t) => ({ id: t.id, name: t.name, ar: t.ar || '', type: t.type })),
      tags: st.tags.map((t) => ({ id: t.id, name: t.name, color: t.color })),
      projects,
      reminders: st.reminders.filter((r) => !r.fired).map((r) => ({ id: r.id, at: r.at, msg: r.msg, repeat: r.repeat, fired: false, to: [...(r.to || [])], email: !!r.email, projectId: null })).sort(byDate),
      sentLog: st.sentLog.slice(0, 10).map((l) => ({ id: l.id, msg: l.msg, project: l.project || '', names: [...l.names], email: l.email || 0, at: l.at })),
      mail: {
        address: st.mail.address || '', subject: st.mail.subject || '', hourly: !!st.mail.hourly, lastSync: st.mail.lastSync ?? null,
        runs: st.mail.runs.slice(0, 5), log: st.mail.log.slice(0, 30).map((l) => ({ ...l })),
        reviews: st.mail.reviews.slice().sort((a, b) => b.at - a.at).map((r) => ({ ...r, candidates: r.candidates.map((c) => ({ ...c })), reasons: [...r.reasons] })),
      },
      folders: { root: st.folders.root || '' },
    };
  }
  const userOut = (u) => ({
    id: u.id, name: u.name, email: u.email || '', role: u.role, color: u.color, status: 'active',
    prefs: { browser: !!u.prefs.browser, email: !!u.prefs.email }, hasColumn: !!u.hasColumn, order: u.order,
  });

  // ---- reminder engine ----
  function fireReminder(st, n, p, at) {
    const users = resolveRecipients(st, n.to, p);
    const mailTo = n.email ? users.filter((u) => u.prefs.email && u.email) : [];
    st.sentLog.unshift({ id: newId(), msg: n.msg, project: p ? p.title : '', names: users.map((u) => u.name), email: mailTo.length, at });
    st.sentLog = st.sentLog.slice(0, 40);
    const step = { hourly: HOUR, daily: 24 * HOUR, weekly: 168 * HOUR }[n.repeat];
    if (step) { while (n.at <= at) n.at += step; } else n.fired = true;
    const viewer = users.find((u) => u.id === st.meId);
    return viewer && viewer.prefs.browser ? { table: 'reminders', type: 'FIRED', record: { title: reminderTitle(p), body: n.msg, projectId: p ? p.id : null } } : null;
  }

  const layer = {
    // ---- auth ----
    async init() { return { signedIn: true }; },
    async getSession() { const m = me(load()); return m ? { email: m.email } : null; },
    async signIn() { return { ok: true }; },
    async signUp() { return { ok: true, needsConfirmation: false }; },
    async signOut() { /* demo: nothing to sign out of */ },
    async requestPasswordReset() { return { ok: true }; },
    async updatePassword() { return { ok: true }; },
    onAuthChange(cb) { authListeners.add(cb); return () => authListeners.delete(cb); },

    // ---- board ----
    async loadBoard() { return JSON.parse(JSON.stringify(boardOf(load()))); },
    subscribe(cb) {
      listeners.add(cb);
      if (storage && typeof globalThis.addEventListener === 'function') {
        globalThis.addEventListener('storage', (e) => { if (e.key === MOCK_KEY) { mem = null; emit({ table: 'board', type: 'UPDATE' }); } });
      }
      return () => listeners.delete(cb);
    },

    // ---- projects ----
    async createProject({ title, tender, type, due, client, columnId }) {
      return mutate((st) => {
        const t = String(title || '').trim();
        if (!t) throw new Error('Write a project title');
        const member = tender ? st.tenderTeam.find((x) => x.id === tender) : null;
        const col = columnId || null;
        if (col && !st.users.some((u) => u.id === col && u.hasColumn)) throw new Error('Column not found');
        const author = needMe(st);
        const p = makeProject(st, {
          title: t, client: client || '', tender: member ? member.id : null,
          type: member ? member.type : type || 'public', due: due || '', columnId: col,
          tags: col ? ['new'] : ['new', 'un'], updatedBy: author.name,
        }, now());
        p.comments.push(sys(SYSTEM_TEXT.created));
        return p.id;
      });
    },
    async updateProject(id, patch = {}) {
      mutate((st) => {
        const p = findP(st, id);
        const extra = [];
        if ('title' in patch) { const t = String(patch.title || '').trim(); if (!t) throw new Error('Write a project title'); p.title = t; }
        if ('client' in patch) p.client = patch.client || '';
        if ('ref' in patch) p.ref = patch.ref || '';
        if ('type' in patch) p.type = patch.type === 'private' ? 'private' : 'public';
        if ('tender' in patch) {
          const m = patch.tender ? st.tenderTeam.find((x) => x.id === patch.tender) : null;
          p.tender = m ? m.id : null;
          if (m) p.type = m.type;
          extra.push(SYSTEM_TEXT.tender(m || null));
        }
        if ('supervisor' in patch) p.supervisor = patch.supervisor || '';
        if ('status' in patch) { p.status = patch.status || ''; extra.push(SYSTEM_TEXT.status(p.status)); }
        if ('received' in patch) p.received = patch.received || '';
        if ('folder' in patch) { p.folder = patch.folder || ''; if (p.folder) extra.push(SYSTEM_TEXT.folder(p.folder)); }
        if ('subOpen' in patch) p.subOpen = !!patch.subOpen;
        extra.forEach((text) => p.comments.push(sys(text)));
        touch(st, p);
      });
    },
    async deleteProject(id) {
      mutate((st) => { findP(st, id); st.projects = st.projects.filter((p) => p.id !== id); st.mail.log.forEach((l) => { if (l.pid === id) l.pid = null; }); });
    },
    async moveProject(id, columnId, orderedIds = []) {
      mutate((st) => {
        const p = findP(st, id);
        const prev = p.columnId ?? null, next = columnId || null;
        if (next && !st.users.some((u) => u.id === next && u.hasColumn)) throw new Error('Column not found');
        p.columnId = next;
        const order = orderedIds.includes(id) ? orderedIds : [id, ...orderedIds];
        order.forEach((pid, i) => { const x = st.projects.find((q) => q.id === pid); if (x) x.pos = i; });
        if (prev !== next) {
          if (next) {
            p.tags = p.tags.filter((t) => t !== 'un');
            p.comments.push(sys(SYSTEM_TEXT.assigned(st.users.find((u) => u.id === next).name)));
          } else {
            if (!p.tags.includes('un')) p.tags.push('un');
            p.comments.push(sys(SYSTEM_TEXT.unassigned));
          }
          touch(st, p);
        }
      });
    },
    async setDueDate(id, due) {
      return mutate((st) => {
        const p = findP(st, id);
        const v = due || '';
        if ((p.due || '') === v) return false;
        p.dueHistory.unshift({ from: p.due || '', to: v, by: (me(st) || {}).name || 'email', at: now() });
        if (!v) p.comments.push(sys(SYSTEM_TEXT.dueCleared));
        else if (!p.due) p.comments.push(sys(SYSTEM_TEXT.dueSet(fmtDay(v))));
        else p.comments.push(sys(SYSTEM_TEXT.dueChanged(fmtDay(p.due), fmtDay(v))));
        p.due = v;
        touch(st, p);
        return true;
      });
    },
    async toggleTag(id, tagId, on) {
      mutate((st) => {
        const p = findP(st, id);
        if (!st.tags.some((t) => t.id === tagId)) throw new Error('Tag not found');
        if (on) { if (!p.tags.includes(tagId)) p.tags.push(tagId); } else p.tags = p.tags.filter((t) => t !== tagId);
        touch(st, p);
      });
    },
    async markMailSeen(id) {
      mutate((st) => { findP(st, id).mailSeen = now(); });
    },
    async createTag(name) {
      return mutate((st) => {
        const n = String(name || '').trim();
        if (!n) throw new Error('Write a tag name');
        const tag = { id: newId(), name: n, color: TAG_PALETTE[st.tags.length % TAG_PALETTE.length], sort: st.tags.length + 1 };
        st.tags.push(tag);
        return { id: tag.id, name: tag.name, color: tag.color };
      });
    },

    // ---- sub-tasks, links, comments ----
    async addSubtask(projectId, { text, due } = {}) {
      return mutate((st) => {
        const p = findP(st, projectId);
        const s = { id: newId(), text: String(text || '').trim(), done: false, note: '', due: due || '' };
        if (!s.text) throw new Error('Write the sub-task first');
        p.subtasks.push(s);
        touch(st, p);
        return s.id;
      });
    },
    async updateSubtask(id, patch = {}) {
      mutate((st) => {
        const p = st.projects.find((x) => x.subtasks.some((s) => s.id === id));
        if (!p) throw new Error('Sub-task not found');
        const s = p.subtasks.find((x) => x.id === id);
        if ('text' in patch) s.text = patch.text || '';
        if ('done' in patch) s.done = !!patch.done;
        if ('note' in patch) s.note = patch.note || '';
        if ('due' in patch) s.due = patch.due || '';
        touch(st, p);
      });
    },
    async deleteSubtask(id) {
      mutate((st) => {
        const p = st.projects.find((x) => x.subtasks.some((s) => s.id === id));
        if (!p) throw new Error('Sub-task not found');
        p.subtasks = p.subtasks.filter((s) => s.id !== id);
        touch(st, p);
      });
    },
    async addLink(projectId, { title, url } = {}) {
      return mutate((st) => {
        const p = findP(st, projectId);
        const u = String(url || '').trim();
        if (!/^https?:\/\//i.test(u)) throw new Error('Paste the full link (https://…)');
        if (p.links.some((l) => l.url === u)) throw new Error('That link is already on this project');
        const l = { id: newId(), title: String(title || '').trim(), url: u, src: false };
        p.links.push(l);
        touch(st, p);
        return l.id;
      });
    },
    async deleteLink(id) {
      mutate((st) => {
        const p = st.projects.find((x) => x.links.some((l) => l.id === id));
        if (!p) throw new Error('Link not found');
        p.links = p.links.filter((l) => l.id !== id);
        touch(st, p);
      });
    },
    async addComment(projectId, text) {
      return mutate((st) => {
        const p = findP(st, projectId);
        const t = String(text || '').trim();
        if (!t) throw new Error('Write a comment first');
        const author = needMe(st);
        const c = { id: newId(), who: author.name, text: t, at: now(), sys: false };
        p.comments.push(c);
        touch(st, p);
        return c.id;
      });
    },

    // ---- reminders ----
    async addReminder({ projectId = null, at, msg, repeat = 'none', to = [], email = true } = {}) {
      return mutate((st) => {
        const text = String(msg || '').trim();
        if (!text) throw new Error('Write a reminder message');
        const r = { id: newId(), at: Number(at), msg: text, repeat, fired: false, to: [...to], email: !!email, projectId: projectId || null };
        if (projectId) findP(st, projectId).notifications.push(r); else st.reminders.push(r);
        return r.id;
      });
    },
    async deleteReminder(id) {
      mutate((st) => {
        const found = findReminder(st, id);
        if (!found) throw new Error('Reminder not found');
        found.list.splice(found.list.indexOf(found.r), 1);
      });
    },
    async sendReminderNow({ projectId = null, msg, to = [], email = true } = {}) {
      return mutate((st) => {
        const p = projectId ? findP(st, projectId) : null;
        const users = resolveRecipients(st, to, p);
        const mailTo = email ? users.filter((u) => u.prefs.email && u.email) : [];
        const names = users.map((u) => u.name);
        st.sentLog.unshift({ id: newId(), msg: String(msg || ''), project: p ? p.title : '', names, email: mailTo.length, at: now() });
        st.sentLog = st.sentLog.slice(0, 40);
        return { names, emails: mailTo.length };
      });
    },
    async sendTestNotification() {
      emit({ table: 'reminders', type: 'FIRED', record: { title: 'Test reminder', body: 'Notifications are working for Redcon Tender Planning.', projectId: null } });
    },

    // ---- team ----
    async addPerson({ name, email, role, hasColumn } = {}) {
      const st = load();
      const em = String(email || '').trim().toLowerCase();
      if (em && !EMAIL_RE.test(em)) return { ok: false, error: 'invalid_email' };
      const nm = String(name || '').trim() || (em ? deriveName(em) : '');
      if (!nm) return { ok: false, error: 'missing_name' };
      if (em && st.users.some((u) => (u.email || '').toLowerCase() === em)) return { ok: false, error: 'duplicate_email' };
      const u = {
        id: newId(), name: nm, email: em, role: role === 'admin' ? 'admin' : 'engineer', color: PALETTE_USERS[st.users.length % PALETTE_USERS.length],
        status: 'active', prefs: { browser: true, email: !!em }, hasColumn: hasColumn !== false,
        order: Math.max(-1, ...st.users.map((x) => x.order)) + 1,
      };
      st.users.push(u);
      save(st);
      emit({ table: 'people', type: 'INSERT' });
      return { ok: true, id: u.id };
    },
    async updatePerson(id, patch = {}) {
      mutate((st) => {
        const m = needMe(st);
        const admin = m.role === 'admin';
        if (!admin && id !== m.id) throw new Error('Only an admin can change another person');
        const u = st.users.find((x) => x.id === id);
        if (!u) throw new Error('Person not found');
        if ('name' in patch) { const n = String(patch.name || '').trim(); if (!n) throw new Error('Write a name'); u.name = n; }
        if ('email' in patch) {
          if (!admin) throw new Error('Only an admin can change the email');
          const em = String(patch.email || '').trim().toLowerCase();
          if (em && !EMAIL_RE.test(em)) throw new Error('Enter a valid email address');
          if (em && st.users.some((x) => x.id !== id && (x.email || '').toLowerCase() === em)) throw new Error('That email is already on the team');
          u.email = em;
        }
        if ('role' in patch && admin) u.role = patch.role === 'admin' ? 'admin' : 'engineer';
        if ('color' in patch) u.color = patch.color;
        if ('prefs' in patch && patch.prefs) u.prefs = { browser: !!patch.prefs.browser, email: !!patch.prefs.email };
      });
    },
    async removePerson(id) {
      mutate((st) => {
        needAdmin(st);
        if (id === st.meId) throw new Error('You cannot remove yourself');
        st.projects.filter((p) => p.columnId === id).forEach((p) => { p.columnId = null; if (!p.tags.includes('un')) p.tags.push('un'); });
        st.users = st.users.filter((u) => u.id !== id);
      });
    },
    async reorderPeople(ids = []) {
      mutate((st) => {
        needAdmin(st);
        const rest = st.users.filter((u) => !ids.includes(u.id)).sort((a, b) => a.order - b.order);
        ids.forEach((id, i) => { const u = st.users.find((x) => x.id === id); if (u) u.order = i; });
        rest.forEach((u, i) => { u.order = ids.length + i; });
      });
    },
    async setColumn(userId, on) {
      mutate((st) => {
        needAdmin(st);
        const u = st.users.find((x) => x.id === userId);
        if (!u) throw new Error('Person not found');
        u.hasColumn = !!on;
        if (!on) {
          st.projects.filter((p) => p.columnId === userId).forEach((p) => { p.columnId = null; if (!p.tags.includes('un')) p.tags.push('un'); });
        }
      });
    },
    async addTenderMember({ name, ar = '', type = 'public' } = {}) {
      return mutate((st) => {
        needAdmin(st);
        const n = String(name || '').trim();
        if (!n) throw new Error('Write a name');
        if (st.tenderTeam.some((t) => t.name === n)) throw new Error('That name is already on the tender team');
        const t = { id: newId(), name: n, ar: String(ar || '').trim(), type: type === 'private' ? 'private' : 'public', sort: Math.max(0, ...st.tenderTeam.map((x) => x.sort || 0)) + 1 };
        st.tenderTeam.push(t);
        return t.id;
      });
    },
    async updateTenderMember(id, patch = {}) {
      mutate((st) => {
        needAdmin(st);
        const t = st.tenderTeam.find((x) => x.id === id);
        if (!t) throw new Error('Tender engineer not found');
        if ('name' in patch) { const n = String(patch.name || '').trim(); if (!n) throw new Error('Write a name'); t.name = n; }
        if ('ar' in patch) t.ar = String(patch.ar || '').trim();
        if ('type' in patch) {
          t.type = patch.type === 'private' ? 'private' : 'public';
          st.projects.filter((p) => p.tender === id).forEach((p) => { p.type = t.type; touch(st, p); });
        }
      });
    },
    async removeTenderMember(id) {
      mutate((st) => {
        needAdmin(st);
        st.projects.filter((p) => p.tender === id).forEach((p) => { p.tender = null; touch(st, p); });
        st.tenderTeam = st.tenderTeam.filter((t) => t.id !== id);
      });
    },
    async updateSettings(patch = {}) {
      mutate((st) => {
        needAdmin(st);
        if ('address' in patch) st.mail.address = String(patch.address || '').trim();
        if ('subject' in patch) st.mail.subject = patch.subject || '';
        if ('hourly' in patch) st.mail.hourly = !!patch.hourly;
        if ('folderRoot' in patch) {
          const r = String(patch.folderRoot || '').trim();
          if (r && !/^https:\/\//.test(r)) throw new Error('Paste the full folder link (https://…)');
          st.folders.root = r;
        }
      });
    },

    // ---- email ----
    async syncMailNow() {
      await new Promise((r) => setTimeout(r, 600));
      return mutate((st) => {
        const c = runMockSync(st, now());
        st.mail.lastSync = now();
        st.mail.runs.unshift({ at: now(), trigger: 'manual', fetched: c.read, created: c.created, updated: c.updated, review: c.review, prefiltered: c.prefiltered, ignored: 0, errors: 0 });
        st.mail.runs = st.mail.runs.slice(0, 5);
        return { read: c.read, created: c.created, updated: c.updated, review: c.review };
      });
    },
    async resolveReview(reviewId, resolution = {}) {
      return mutate((st) => applyReview(st, reviewId, resolution, now()));
    },

    // ---- push (nothing to store in the demo) ----
    async savePushSubscription(sub) { if (!sub || !sub.endpoint) throw new Error('Subscription is missing'); },
    async deletePushSubscription() {},

    // ---- demo only ----
    async resetDemo() {
      mem = seedState(now());
      save(mem);
      emit({ table: 'board', type: 'UPDATE' });
    },

    /** Test hook (not part of the contract): fires due reminders as of `at`. */
    _tick(at = now()) {
      const st = load();
      const due = [
        ...st.projects.flatMap((p) => p.notifications.map((n) => ({ n, p }))),
        ...st.reminders.map((n) => ({ n, p: null })),
      ].filter(({ n }) => !n.fired && n.at <= at);
      if (!due.length) return;
      const events = due.map(({ n, p }) => fireReminder(st, n, p, at)).filter(Boolean);
      save(st);
      emit({ table: 'board', type: 'UPDATE' });
      events.forEach((e) => emit(e));
    },
  };

  assertDataLayer(layer);
  if (timers) setInterval(() => layer._tick(), 15000);
  return layer;
}

