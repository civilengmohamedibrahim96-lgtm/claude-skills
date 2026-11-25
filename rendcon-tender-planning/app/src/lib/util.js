// Pure helpers shared by the UI and the tests. No DOM access at import time.

export const $ = (s, r = globalThis.document) => r.querySelector(s);
export const $$ = (s, r = globalThis.document) => [...r.querySelectorAll(s)];

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Only a plain hex colour may reach a style attribute; anything else falls back to the neutral grey. */
export const safeColor = (c) => (/^#[0-9a-fA-F]{3,8}$/.test(String(c)) ? c : '#5B5B57');
export const icon = (n, c = '') => `<svg class="i ${c}"><use href="#i-${n}"/></svg>`;

export const HOUR = 3600000;
export const COLORS = ['#111111', '#EE6A1F', '#5B5B57', '#9C4A12', '#2F7D7A', '#B8860B'];
export const TAG_PALETTE = ['#EE6A1F', '#5B5B57', '#9C4A12', '#2F7D7A', '#B8860B'];

/** 'YYYY-MM-DD' (read as a local calendar day), epoch ms, or Date → Date. */
export function toDate(v) {
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v ?? ''));
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(v);
}

export const fmtDate = (d) => (d ? toDate(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const fmtShort = (d) => (d ? toDate(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '');
export const fmtDT = (ms) => (ms ? new Date(ms).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
export const initials = (n) => (n || '?').replace(/^Eng\.?\s*/i, '').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
/** 'YYYY-MM-DD' for `days` days from `now` (local calendar). */
export function isoIn(days, now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** value for <input type="datetime-local"> in local time. */
export const localDT = (ms) => {
  const d = new Date(ms);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

export function ago(ms, now = Date.now()) {
  if (!ms) return '';
  const m = Math.round((now - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.round(h / 24);
  return d < 7 ? d + 'd ago' : fmtShort(new Date(ms));
}

/** Days from today (local) to a due date: negative = overdue. */
export function daysUntil(d, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((toDate(d) - today) / 864e5);
}

export function dueInfo(d, now = new Date()) {
  if (!d) return { cls: 'none', rel: 'Not set' };
  const diff = daysUntil(d, now);
  if (diff < 0) return { cls: 'late', rel: `${-diff} day${diff === -1 ? '' : 's'} overdue` };
  if (diff === 0) return { cls: 'late', rel: 'Today' };
  if (diff <= 3) return { cls: 'soon', rel: diff === 1 ? 'Tomorrow' : `In ${diff} days` };
  return { cls: '', rel: `In ${diff} days` };
}

export function workload(items, now = new Date()) {
  const late = items.filter((x) => x.due && daysUntil(x.due, now) < 0 && !x.tags.includes('sub')).length;
  const wk = items.filter((x) => x.due && daysUntil(x.due, now) >= 0 && daysUntil(x.due, now) <= 7).length;
  return (late ? `<span class="wl late">· ${late} overdue</span>` : '') + (wk ? `<span class="wl">· ${wk} due this week</span>` : '');
}

export function firstName(v) {
  return String(v || '').replace(/^\s*(و?المهندس[ةه]?|مهندس[ةه]?|م\s*[\/\.]|eng\.?)\s*/i, '').trim().split(/\s+/)[0] || '';
}

export const typeBadge = (t) => `<span class="ttype ${t === 'private' ? 'priv' : 'pub'}">${t === 'private' ? 'Private' : 'Public'}</span>`;

export const avatar = (u, cls = '') => (u
  ? `<span class="avatar ${cls}" style="background:${safeColor(u.color)}" title="${esc(u.name)}">${esc(initials(u.name))}</span>`
  : `<span class="avatar ghost ${cls}" title="Unassigned">${icon('user')}</span>`);

export const digits = (s) => String(s).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
/** Arabic-insensitive lower-case form used for matching (alef forms, ta marbuta, ya). */
export const norm = (s) => digits(String(s ?? '')).replace(/[إأآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').toLowerCase();

export const SORTS = {
  due: ['Submission date · earliest first', 'Submission date ↑'],
  dueDesc: ['Submission date · latest first', 'Submission date ↓'],
  updated: ['Latest update first', 'Latest update'],
  received: ['Newest received first', 'Newest received'],
  name: ['Project name · A–Z', 'Name A–Z'],
  manual: ['Manual · drag to arrange', 'Manual order'],
};

/** Returns a sorted copy of `items` by the SORTS key (unknown key → manual). */
export function sortItems(items, key) {
  const t = (x) => (x.due ? toDate(x.due).getTime() : Infinity);
  const by = {
    due: (a, b) => t(a) - t(b) || a.title.localeCompare(b.title),
    dueDesc: (a, b) => (b.due ? t(b) : -Infinity) - (a.due ? t(a) : -Infinity),
    updated: (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
    received: (a, b) => String(b.received || '').localeCompare(String(a.received || '')),
    name: (a, b) => a.title.localeCompare(b.title, ['ar', 'en']),
    manual: (a, b) => a.pos - b.pos,
  }[key] || ((a, b) => a.pos - b.pos);
  return [...items].sort(by);
}

const FOLDER_HOSTS = /sharepoint\.com|onedrive\.live\.com|1drv\.ms|onedrive\.com/i;
/** 'onedrive' for SharePoint / OneDrive links, otherwise 'link'. */
export const folderKind = (url) => (FOLDER_HOSTS.test(String(url || '')) ? 'onedrive' : 'link');

/** Short text for a folder link: host + path without the scheme. */
export const folderLabel = (url) => String(url || '').replace(/^https?:\/\//, '');
