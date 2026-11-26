// The prototype UI (index.html), ported to the data layer (src/data/contract.js).
// Reads come from S (the last BoardState); every write goes through act(() => dl.method(...)).
import {
  $, $$, esc, icon, HOUR, fmtDate, fmtShort, fmtDT, ago, dueInfo, workload, firstName, typeBadge, avatar,
  norm, SORTS, sortItems, COLORS, safeColor, folderKind, folderLabel, localDT, isoIn, toDate, daysUntil, initials,
} from './lib/util.js';
import { KIND_LABELS, REVIEW_REASON_LABELS, OUTCOME_LABELS } from './data/contract.js';
import { enablePush, pushSupported } from './push.js';

let dl = null;
let S = null;                       // BoardState
let bound = false;
let cur = null;                     // open project id
let curTab = 'files';
let filterTags = new Set();
let query = '';
let qSel = 0;
let drag = null;
let openLogs = new Set();
let openSubs = new Set();
let syncing = false;
let pendingRepaint = false;
let refreshTimer = null;
const SORT_KEY = 'rendcon-sort-v1';
const FOLD_KEY = 'rendcon-subfold-v1';
let openFolds = new Set();
try { openFolds = new Set(JSON.parse(localStorage.getItem(FOLD_KEY) || '[]')); } catch (_) { openFolds = new Set(); }
const saveFolds = () => { try { localStorage.setItem(FOLD_KEY, JSON.stringify([...openFolds])); } catch (_) { /* storage unavailable */ } };
let sortPrefs = {};
try { sortPrefs = JSON.parse(localStorage.getItem(SORT_KEY) || '{}') || {}; } catch (_) { sortPrefs = {}; }

const $board = () => $('#board');

/* ---------------- state helpers ---------------- */
function derive() {
  S.columns = S.users.filter((u) => u.hasColumn).map((u) => ({ id: u.id, userId: u.id }));
}
const me = () => S.me;
const isAdmin = () => !!S.me && S.me.role === 'admin';
const userById = (id) => S.users.find((u) => u.id === id);
const colById = (id) => S.columns.find((c) => c.id === id);
const colUser = (c) => c && userById(c.userId);
const colName = (id) => { const u = colUser(colById(id)); return u ? u.name : 'Engineer'; };
const colOfUser = (uid) => S.columns.find((c) => c.userId === uid);
const proj = (id) => S.projects.find((p) => p.id === id);
const tagById = (id) => S.tags.find((t) => t.id === id);
const tenderById = (id) => (S.tenderTeam || []).find((t) => t.id === id);
const projType = (p) => { const t = tenderById(p.tender); return t ? t.type : (p.type || 'public'); };
const sortKey = (k) => sortPrefs[k] || 'due';
const tenderLabel = (p) => p.supervisor || firstName(((tenderById(p.tender) || {}).name || '').replace(/^Eng\.?\s*/i, ''));
const isSubmitted = (p) => p.tags.includes('sub');
const upcomingCount = () => S.projects.reduce((a, p) => a + p.notifications.length, 0) + S.reminders.length;

/* ---------------- write helper ---------------- */
/** Runs one data-layer write, then repaints. Errors become a toast. Returns {ok, value}. */
async function act(fn) {
  try {
    const value = await fn();
    await refresh(true);
    return { ok: true, value };
  } catch (err) {
    toast(esc(err && err.message ? err.message : 'Something went wrong'), 'x', 5000);
    await refresh(true).catch(() => {});
    return { ok: false, value: undefined };
  }
}

/* ---------------- toasts & notifications ---------------- */
function toast(html, ico = 'check', ms = 3200) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `<span class="ti">${icon(ico)}</span><span>${html}</span>`;
  $('#toasts').appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}
function notify(title, body) {
  toast(`<b>${esc(title)}</b><br><span dir="auto">${esc(body)}</span>`, 'bell', 7000);
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(title, { body, tag: title + body });
      n.onclick = () => window.focus();
    }
  } catch (_) { /* notifications unavailable */ }
}

/* ---------------- repaint ---------------- */
const isEditing = (root) => {
  const a = document.activeElement;
  return !!(root && a && root.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
};
const openSheetEl = () => document.querySelector('.sheet.show');

function repaintOverlays() {
  if (cur && !proj(cur)) { closePage(); return; }
  if (cur) renderPage();
  if ($('#mailSheet').classList.contains('show')) renderMailSheet();
  if ($('#remSheet').classList.contains('show')) renderRemSheet();
  if ($('#teamSheet').classList.contains('show')) renderTeamSheet();
}

/** Reloads S and repaints. Unforced (other people's changes) waits while a field is being typed in. */
async function refresh(force = false) {
  S = await dl.loadBoard();
  derive();
  renderBoard();
  if (!force && (isEditing($('#page')) || isEditing(openSheetEl()))) { pendingRepaint = true; return; }
  pendingRepaint = false;
  repaintOverlays();
}
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { refresh(false).catch((e) => console.error(e)); }, 250);
}

/* ---------------- board ---------------- */
/* Submission-date ranges. "This week" = the next 7 days (same as the column's "due this week"), "Next week" = the 7 days after. */
const DUE_RANGES = [['overdue', 'Overdue'], ['today', 'Today'], ['week', 'This week'], ['next', 'Next week'], ['month', 'This month'], ['later', 'Later'], ['none', 'No date']];
function dueRange(k, now = new Date()) {
  const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()), add = (n) => { const d = new Date(t0); d.setDate(d.getDate() + n); return d; };
  if (k === 'week') return [t0, add(7)];
  if (k === 'next') return [add(8), add(14)];
  if (k === 'month') return [new Date(now.getFullYear(), now.getMonth(), 1), new Date(now.getFullYear(), now.getMonth() + 1, 0)];
  return null;
}
function dueMatch(p, k, now = new Date()) {
  if (k === 'none') return !p.due;
  if (!p.due) return false;
  const dd = daysUntil(p.due, now);
  if (k === 'overdue') return dd < 0 && !isSubmitted(p);
  if (k === 'today') return dd === 0;
  if (k === 'later') return toDate(p.due) > new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const r = dueRange(k, now), t = toDate(p.due);
  return t >= r[0] && t <= r[1];
}
const rangeHint = (k) => { const r = dueRange(k); return r ? `${fmtShort(r[0])} – ${fmtShort(r[1])}` : ''; };
const statusKey = (v) => String(v || '').trim().toLowerCase();
function statusOptions() {
  const seen = new Map();
  S.projects.forEach((p) => { const k = statusKey(p.status); if (k && !seen.has(k)) seen.set(k, { label: p.status.trim(), n: 0 }); if (k) seen.get(k).n++; });
  return [...seen.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 12);
}
/** Filters: AND across groups, OR inside a group (e.g. two engineers = either one). */
function matches(p) {
  if (filterTags.size) {
    const groups = {};
    filterTags.forEach((t) => { const g = /^(type|tm|eng|due|st):/.test(t) ? t.split(':')[0] : 'tag:' + t; (groups[g] = groups[g] || []).push(t); });
    const hit = (t) => {
      if (t.startsWith('type:')) return projType(p) === t.slice(5);
      if (t.startsWith('tm:')) return p.tender === t.slice(3);
      if (t.startsWith('eng:')) return (p.columnId || 'un') === t.slice(4);
      if (t.startsWith('due:')) return dueMatch(p, t.slice(4));
      if (t.startsWith('st:')) return statusKey(p.status) === t.slice(3);
      return p.tags.includes(t);
    };
    if (!Object.values(groups).every((ts) => ts.some(hit))) return false;
  }
  if (query && !norm(p.title).includes(norm(query))) return false;
  return true;
}
const engFilters = () => [...filterTags].filter((t) => t.startsWith('eng:')).map((t) => t.slice(4));

function cardHTML(p) {
  const done = p.subtasks.filter((s) => s.done).length, tot = p.subtasks.length;
  const rem = p.notifications.length;
  const com = p.comments.filter((c) => !c.sys).length;
  const du = p.tags.includes('sub') && p.due ? { cls: 'done', rel: 'Submitted' } : dueInfo(p.due);
  const eng = colUser(colById(p.columnId));
  const tnd = tenderById(p.tender);
  const tl = tenderLabel(p);
  const ml = p.mailLog || [];
  const unread = ml.filter((e) => e.at > (p.mailSeen || 0)).length;
  const open = openLogs.has(p.id);
  const last = (p.dueHistory || [])[0];
  const fresh = p.updatedAt && Date.now() - p.updatedAt < 24 * HOUR;
  const footer = tot || p.links.length || com || p.folder || rem || eng;
  return `<article class="card ${du.cls === 'late' ? 'is-late' : ''}" data-id="${esc(p.id)}" tabindex="0" aria-label="${esc(p.title)}">
    <div class="c-top">${typeBadge(projType(p))}${tl ? `<span class="c-tender" dir="auto" title="Study supervisor (المشرف على الدراسة)${tnd ? ' · ' + esc(tnd.name) : ''}">${esc(tl)}</span>` : ''}
      ${ml.length ? `<button class="c-upd-btn ${unread ? 'new' : ''} ${open ? 'open' : ''}" data-nodrag data-log="${esc(p.id)}" aria-expanded="${open}" title="Updates from email · last change ${p.updatedAt ? fmtDT(p.updatedAt) : ''}">${unread ? `<i></i><b>${unread} new</b>` : icon('mail') + ml.length} · ${ago(p.updatedAt)}${icon('chev', 'chev')}</button>`
      : `<span class="c-upd ${fresh ? 'fresh' : ''}" title="Last updated ${p.updatedAt ? fmtDT(p.updatedAt) : ''}${p.updatedBy ? ' by ' + esc(p.updatedBy) : ''}"><i></i>Updated ${ago(p.updatedAt)}</span>`}</div>
    ${ml.length ? `<div class="c-log ${open ? 'open' : ''}" data-logbox="${esc(p.id)}"><div><div class="c-log-in"><div class="c-log-h">${icon('mail')}Updates from email</div>${ml.slice(0, 6).map((e) => {
      const [label, cls] = KIND_LABELS[e.kind] || ['Update', 'k-upd'];
      return `<div class="c-log-it"><div class="r"><span class="dir">${e.direction === 'sent' ? '↑' : '↓'}</span><span class="k ${cls}">${esc(label)}</span>${e.at > (p.mailSeen || 0) ? '<span class="nw">new</span>' : ''}<time title="${fmtDT(e.at)}">${ago(e.at)}</time></div><p>${esc(e.summary)}${e.links ? ` <span class="ln">${icon('link')}${e.links}</span>` : ''}</p><small dir="rtl" title="${esc(e.subject)}">${esc(e.subject)}</small>${e.webLink ? ` <a href="${esc(e.webLink)}" target="_blank" rel="noopener" data-nodrag>Open email</a>` : ''}</div>`;
    }).join('')}${ml.length > 6 ? `<div class="c-log-more">+ ${ml.length - 6} older in the project</div>` : ''}</div></div></div>` : ''}
    <h3 dir="auto">${esc(p.title)}</h3>
    ${p.client ? `<div class="c-client" dir="auto">${esc(p.client)}</div>` : ''}
    <div class="c-due ${du.cls}" title="Submission date">
      ${icon('cal')}<b>${p.due ? fmtDate(p.due) : 'No submission date'}</b>
      ${p.due ? `<span class="c-rel">${du.rel}</span>` : ''}
      ${last && Date.now() - last.at < 7 * 24 * HOUR ? `<span class="c-due-src ${last.by === 'email' ? 'em' : ''}" title="${last.by === 'email' ? 'Date updated from email' : 'Date changed by ' + esc(last.by)} · ${ago(last.at)}${last.from ? ' (was ' + fmtDate(last.from) + ')' : ''}">${icon(last.by === 'email' ? 'mail' : 'user')}</span>` : ''}
      <button class="c-due-edit c-sub-btn ${isSubmitted(p) ? 'on' : ''}" data-nodrag data-submit="${esc(p.id)}" aria-label="${isSubmitted(p) ? 'Move back to active' : 'Mark as submitted'}" title="${isSubmitted(p) ? 'Submitted · click to move back to active' : 'Mark as submitted'}">${icon('check')}</button>
      <button class="c-due-edit" data-nodrag data-due="${esc(p.id)}" aria-label="Change submission date" title="Change submission date">${icon('edit')}</button>
      <input type="date" class="due-in" data-duein="${esc(p.id)}" value="${p.due || ''}" tabindex="-1" aria-hidden="true">
    </div>
    ${p.status ? `<div class="c-status" dir="auto">${esc(p.status)}</div>` : ''}
    ${p.tags.length ? `<div class="card-tags">${p.tags.map((id) => { const t = tagById(id); return t ? `<span class="tag"><i class="tdot" style="background:${safeColor(t.color)}"></i>${esc(t.name)}</span>` : ''; }).join('')}</div>` : ''}
    ${footer ? `<div class="c-foot">
      ${tot ? `<span class="c-tasks" title="${done} of ${tot} sub-tasks done"><span class="c-bar"><i style="width:${done / tot * 100}%"></i></span>${done}/${tot}</span>` : ''}
      ${p.links.length ? `<span title="Links">${icon('link')}${p.links.length}</span>` : ''}
      ${com ? `<span title="Comments">${icon('msg')}${com}</span>` : ''}
      ${p.folder ? `<span title="Project folder">${icon('folder')}</span>` : ''}
      ${rem ? `<span class="bell" title="Reminders set">${icon('bell')}${rem}</span>` : ''}
      <span class="grow"></span>
      ${eng ? `<span class="c-eng" title="Planning engineer: ${esc(eng.name)}">${avatar(eng, 'sm')}<span>${esc(eng.name.replace(/^Eng\.\s*/, '').split(' ')[0])}</span></span>` : ''}
    </div>` : ''}
  </article>`;
}

function colHTML(col, unassigned) {
  const sk = col ? col.id : 'un', skey = sortKey(sk);
  const all = sortItems(S.projects.filter((p) => (p.columnId || null) === (col ? col.id : null)), skey);
  const items = all.filter((p) => !isSubmitted(p));
  const shown = items.filter(matches);
  const subs = all.filter(isSubmitted).sort((a, b2) => (b2.due || '').localeCompare(a.due || ''));
  const subShown = subs.filter(matches);
  const filtering = !!(query || filterTags.size);
  const foldOpen = openFolds.has(sk) || (filtering && subShown.length > 0);
  const u = colUser(col);
  const canEdit = !unassigned && (isAdmin() || u.id === S.me.id);
  return `<section class="col ${unassigned ? 'unassigned' : ''}" data-col="${esc(col ? col.id : '')}">
    <div class="col-head">
      ${unassigned ? `<div class="col-who"><div class="avatar">${icon('mail')}</div><div class="col-title"><span>Unassigned projects</span><small>New jobs land here${workload(items)}</small></div></div>`
        : `<${canEdit ? 'button' : 'div'} class="col-who" ${canEdit ? `data-profile="${esc(u.id)}" title="Edit ${esc(u.name)}'s profile"` : ''}>${avatar(u)}<div class="col-title"><span dir="auto">${esc(u.name)}</span><small>${items.length} project${items.length === 1 ? '' : 's'}${workload(items)}${canEdit ? `<span class="edit-hint">${icon('edit')}</span>` : ''}</small></div></${canEdit ? 'button' : 'div'}>`}
      <span class="col-count">${shown.length}</span>
      ${unassigned || !isAdmin() ? '' : `<button class="btn ghost icon sm" data-colmenu="${esc(col.id)}" aria-label="Column options">${icon('dots')}</button>`}
    </div>
    <div class="col-sort"><button class="sort-btn" data-sort="${esc(sk)}" title="Sort this column">${icon('sort')}<span>${SORTS[skey][1]}</span>${icon('chev', 'chev')}</button></div>
    <div class="col-list" data-list="${esc(col ? col.id : '')}">${shown.map(cardHTML).join('') || `<div class="empty-col">${unassigned ? 'No unassigned projects' : 'Drag a project here to assign it'}</div>`}</div>
    ${subs.length ? `<div class="sub-fold ${foldOpen ? 'open' : ''}">
      <button class="sub-fold-h" data-fold="${esc(sk)}" aria-expanded="${foldOpen}">${icon('check', 'ok')}<span>Submitted</span><span class="col-count">${filtering ? `${subShown.length}/${subs.length}` : subs.length}</span><span class="grow"></span>${icon('chev', 'chev')}</button>
      <div class="collapse ${foldOpen ? '' : 'closed'}"><div><div class="sub-fold-list">${subShown.map(cardHTML).join('') || '<div class="empty-col">No submitted projects match</div>'}</div></div></div>
    </div>` : ''}
    <div class="col-foot"><button class="btn sm add-card" data-add="${esc(col ? col.id : '')}">${icon('plus')}Add project</button></div>
  </section>`;
}

function renderBoard() {
  const b = $board(), sl = b.scrollLeft;
  const cols = S.columns.filter((c) => colUser(c)).sort((a, b2) => S.users.indexOf(colUser(a)) - S.users.indexOf(colUser(b2)));
  const ef = engFilters(), showCol = (id) => !ef.length || ef.includes(id);
  b.innerHTML = (showCol('un') ? colHTML(null, true) : '') + cols.filter((c) => showCol(c.id)).map((c) => colHTML(c, false)).join('') + (isAdmin() && !ef.length ? `<button class="add-col" id="addCol">${icon('plus')}Add engineer</button>` : '');
  b.scrollLeft = sl;
  renderFilters();
  renderHeader();
}

function filterLabel(id) {
  if (id.startsWith('type:')) return { txt: id === 'type:public' ? 'Public' : 'Private', dot: '' };
  if (id.startsWith('tm:')) { const t = tenderById(id.slice(3)); return { txt: t ? firstName(t.name.replace(/^Eng\.?\s*/i, '')) : '—', dot: '' }; }
  if (id.startsWith('eng:')) return { txt: id === 'eng:un' ? 'Unassigned' : firstName(colName(id.slice(4)).replace(/^Eng\.?\s*/i, '')), dot: '' };
  if (id.startsWith('due:')) return { txt: 'Due: ' + ((DUE_RANGES.find((r) => r[0] === id.slice(4)) || [])[1] || ''), dot: '' };
  if (id.startsWith('st:')) { const o = statusOptions().find((x) => x[0] === id.slice(3)); return { txt: o ? o[1].label : id.slice(3), dot: '' }; }
  const t = tagById(id);
  return { txt: t ? t.name : id, dot: t ? t.color : '' };
}
function renderFilters() {
  const act_ = [...filterTags].filter((id) => (!id.startsWith('tm:') || tenderById(id.slice(3))) && (!id.startsWith('eng:') || id === 'eng:un' || colById(id.slice(4))));
  $('#qChips').innerHTML = act_.map((id) => { const l = filterLabel(id); return `<span class="qchip">${l.dot ? `<i class="tdot" style="background:${safeColor(l.dot)}"></i>` : ''}${esc(l.txt)}<button type="button" data-unfilter="${esc(id)}" aria-label="Remove filter ${esc(l.txt)}">${icon('x')}</button></span>`; }).join('');
  $('#fCount').hidden = !act_.length;
  $('#fCount').textContent = act_.length;
  $('#q').placeholder = act_.length ? 'Search within filters…' : 'Search project names…';
  const opt = (id, html) => `<button type="button" class="fopt ${filterTags.has(id) ? 'on' : ''}" data-filter="${esc(id)}">${html}</button>`;
  const engCols = S.columns.filter((c) => colUser(c)).sort((a, b2) => S.users.indexOf(colUser(a)) - S.users.indexOf(colUser(b2)));
  $('#fPanel').innerHTML = `
    <div class="fgrp"><span>Submission date</span><div>${DUE_RANGES.map(([k, l]) => opt('due:' + k, `${esc(l)}${rangeHint(k) ? `<small class="fhint">${esc(rangeHint(k))}</small>` : ''}`)).join('')}</div></div>
    <div class="fgrp"><span>Engineer</span><div>${opt('eng:un', 'Unassigned')}${engCols.map((c) => { const u = colUser(c); return opt('eng:' + c.id, `${avatar(u, 'xs')}<bdi>${esc(firstName(u.name.replace(/^Eng\.?\s*/i, '')))}</bdi>`); }).join('')}</div></div>
    <div class="fgrp"><span>Status</span><div>${statusOptions().map(([k, o]) => opt('st:' + k, `<bdi>${esc(o.label)}</bdi><small class="fhint">${o.n}</small>`)).join('') || '<em class="fnone">No statuses written yet</em>'}</div></div>
    <div class="fgrp"><span>Tender type</span><div>${opt('type:public', 'Public')}${opt('type:private', 'Private')}</div></div>
    <div class="fgrp"><span>Tender team</span><div>${(S.tenderTeam || []).map((t) => opt('tm:' + t.id, `<em class="tt ${t.type}">${t.type === 'private' ? 'Pr' : 'Pu'}</em><bdi>${esc(firstName(t.name.replace(/^Eng\.?\s*/i, '')))}</bdi>`)).join('')}</div></div>
    <div class="fgrp"><span>Tags</span><div>${S.tags.map((t) => opt(t.id, `<i class="tdot" style="background:${safeColor(t.color)}"></i>${esc(t.name)}`)).join('')}</div></div>
    <div class="ffoot"><button type="button" class="btn sm ghost" id="fClear" ${act_.length ? '' : 'disabled'}>Clear all</button><button type="button" class="btn sm dark" id="fDone">Done</button></div>`;
}

function renderHeader() {
  if (!S) return;
  $('#driveDot').parentElement.classList.toggle('on', !!S.folders.root);
  $('#driveBtn').title = S.folders.root ? 'Tenders folder – linked' : 'Tenders folder – not set';
  $('#mailDot').parentElement.classList.toggle('on', !!S.mail.address);
  $('#remCount').textContent = upcomingCount();
  $('#teamBtn').hidden = !isAdmin();
  $('#meBtn').innerHTML = avatar(S.me);
  $('#resetBtn').hidden = S.mode !== 'mock';
  const vb = $('#viewBanner');
  if (S.mode === 'mock') {
    vb.hidden = false;
    vb.className = 'view-banner demo';
    vb.textContent = 'Demo mode – no server connected. Changes are saved only in this browser.';
  } else vb.hidden = true;
  updateSyncMeta();
}
function updateSyncMeta() {
  const el = $('#syncMeta');
  if (!S || !S.mail.hourly) { el.textContent = S && S.mail.address ? 'auto-sync off' : ''; return; }
  if (!S.mail.lastSync) { el.textContent = 'not synced yet'; return; }
  const next = Math.max(0, S.mail.lastSync + HOUR - Date.now());
  const agoMin = Math.max(0, Math.round((Date.now() - S.mail.lastSync) / 60000));
  el.textContent = `synced ${agoMin}m ago · next in ${Math.ceil(next / 60000)}m`;
}

/* ---------------- drag & drop (mouse + touch, pointer events) ---------------- */
function bindBoardDrag() {
  $board().addEventListener('pointerdown', (e) => {
    if (e.target.closest('[data-nodrag]')) return;
    const card = e.target.closest('.card');
    if (!card || e.button > 0) return;
    const fromList = card.closest('.col-list');
    drag = { card, id: card.dataset.id, x: e.clientX, y: e.clientY, started: false, fixed: !fromList, from: fromList ? fromList.dataset.list : null };
  });
  document.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.started) { if (drag.fixed || Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return; startDrag(e); }
    const g = drag.ghost;
    g.style.left = (e.clientX - drag.ox) + 'px';
    g.style.top = (e.clientY - drag.oy) + 'px';
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const col = el && el.closest('.col');
    $$('.col-list.over').forEach((l) => l.classList.remove('over'));
    if (col) {
      const list = $('.col-list', col);
      list.classList.add('over');
      const emp = $('.empty-col', list);
      if (emp) emp.style.display = 'none';
      const cards = $$('.card', list).filter((c) => c !== drag.card);
      const before = cards.find((c) => { const r = c.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
      if (before) list.insertBefore(drag.ph, before); else list.appendChild(drag.ph);
    }
    const b = $board(), br = b.getBoundingClientRect();
    if (e.clientX > br.right - 60) b.scrollLeft += 14; else if (e.clientX < br.left + 60) b.scrollLeft -= 14;
  });
  document.addEventListener('pointerup', () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (!d.started) { openProject(d.id); return; }
    document.body.style.cursor = '';
    $board().style.scrollBehavior = '';
    const list = d.ph.parentElement;
    const target = list.dataset.list || null;
    const ids = [...list.children].map((n) => (n === d.ph ? d.id : n.dataset.id)).filter(Boolean);
    const p = proj(d.id);
    const prev = p.columnId || null;
    p.columnId = target;
    ids.forEach((id, i) => { const x = proj(id); if (x) x.pos = i; });
    d.ghost.remove();
    renderBoard();
    const nc = $(`.card[data-id="${d.id}"]`);
    if (nc) { nc.style.animation = 'none'; nc.offsetHeight; nc.style.animation = ''; nc.classList.add('dropped'); }
    if (prev !== target) {
      if (target) toast(`<b dir="auto">${esc(p.title)}</b> assigned to <b>${esc(colName(target))}</b>`, 'user');
      else toast('Moved to <b>Unassigned</b>', 'user');
    } else if (sortKey(target || 'un') !== 'manual') {
      toast('This column is sorted automatically. Choose <b>Sort → Manual order</b> to arrange it by hand.', 'sort', 4500);
    }
    act(() => dl.moveProject(d.id, target, ids));
  });
  document.addEventListener('pointercancel', () => {
    if (drag && drag.started) { drag.ghost.remove(); drag = null; renderBoard(); } else drag = null;
  });
}
function startDrag(e) {
  drag.started = true;
  const r = drag.card.getBoundingClientRect();
  drag.ox = e.clientX - r.left;
  drag.oy = e.clientY - r.top;
  const g = drag.card.cloneNode(true);
  g.classList.add('ghost');
  g.style.width = r.width + 'px';
  g.style.left = r.left + 'px';
  g.style.top = r.top + 'px';
  document.body.appendChild(g);
  drag.ghost = g;
  const ph = document.createElement('div');
  ph.className = 'placeholder';
  ph.style.height = r.height + 'px';
  drag.ph = ph;
  drag.card.replaceWith(ph);
  document.body.style.cursor = 'grabbing';
  $board().style.scrollBehavior = 'auto';
}

/* ---------------- board clicks, filters, search ---------------- */
function bindBoardClicks() {
  $board().addEventListener('click', (e) => {
    const a = e.target.closest('[data-add]'); if (a) { newProject(a.dataset.add || null); return; }
    if (e.target.closest('#addCol')) { addColumn(); return; }
    const m = e.target.closest('[data-colmenu]'); if (m) { colMenu(m, m.dataset.colmenu); return; }
    const pr = e.target.closest('[data-profile]'); if (pr) { editProfile(pr.dataset.profile); return; }
    const so = e.target.closest('[data-sort]'); if (so) { sortMenu(so, so.dataset.sort); return; }
    const lg = e.target.closest('[data-log]'); if (lg) { toggleLog(lg.dataset.log); return; }
    const sb = e.target.closest('[data-submit]'); if (sb) { setSubmitted(sb.dataset.submit); return; }
    const fd = e.target.closest('[data-fold]'); if (fd) { toggleFold(fd); return; }
    const dd = e.target.closest('[data-due]');
    if (dd) {
      const i = $(`[data-duein="${dd.dataset.due}"]`);
      try { i.showPicker(); } catch (_) { editDue(dd.dataset.due); }
      return;
    }
  });
  $board().addEventListener('keydown', (e) => {
    const c = e.target.closest('.card');
    if (c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openProject(c.dataset.id); }
  });
  $board().addEventListener('change', async (e) => {
    const i = e.target.closest('[data-duein]');
    if (!i) return;
    const p = proj(i.dataset.duein);
    const r = await act(() => dl.setDueDate(p.id, i.value));
    if (r.ok && r.value) { flash(p.id); toast(`Submission date set to <b>${fmtDate(i.value)}</b>`, 'cal'); }
  });
}

/** Marks a project submitted (the system 'sub' tag) or moves it back to active. */
async function setSubmitted(id, on) {
  const p = proj(id);
  if (!p) return;
  const want = on === undefined ? !isSubmitted(p) : on;
  const r = await act(() => dl.toggleTag(p.id, 'sub', want));
  if (!r.ok) return;
  toast(want ? `<b dir="auto">${esc(p.title)}</b> marked as submitted` : `<b dir="auto">${esc(p.title)}</b> moved back to active`, want ? 'check' : 'left');
  if (!want) flash(p.id);
}
function toggleFold(btn) {
  const k = btn.dataset.fold, fold = btn.closest('.sub-fold'), open = !fold.classList.contains('open');
  if (open) openFolds.add(k); else openFolds.delete(k);
  saveFolds();
  fold.classList.toggle('open', open);
  btn.setAttribute('aria-expanded', open);
  $('.collapse', fold).classList.toggle('closed', !open);
}

function toggleLog(id) {
  const p = proj(id), card = $(`.card[data-id="${id}"]`);
  if (!p || !card) return;
  const open = !openLogs.has(id);
  open ? openLogs.add(id) : openLogs.delete(id);
  const box = $('.c-log', card); if (box) box.classList.toggle('open', open);
  const btn = $('.c-upd-btn', card);
  if (!btn) return;
  btn.classList.toggle('open', open);
  btn.setAttribute('aria-expanded', open);
  if (open && btn.classList.contains('new')) {
    p.mailSeen = Date.now();
    btn.classList.remove('new');
    btn.innerHTML = `${icon('mail')}${p.mailLog.length} · ${ago(p.updatedAt)}${icon('chev', 'chev')}`;
    dl.markMailSeen(id).catch((err) => toast(esc(err.message), 'x'));
  }
}

function editDue(id) {
  const p = proj(id);
  modal(`<h3>Submission date</h3><div class="row"><label for="eD">Latest submission date</label><input class="in" type="date" id="eD" value="${p.due || ''}"></div><div class="acts"><button class="btn" data-close>Cancel</button><button class="btn primary" id="eOk">Save date</button></div>`, () => {
    $('#eOk').onclick = async () => {
      closeModal();
      const r = await act(() => dl.setDueDate(p.id, $('#eD').value));
      if (r.ok && r.value) toast(`Submission date set to <b>${fmtDate($('#eD').value)}</b>`, 'cal');
    };
  });
}

function setPanel(open) {
  $('#fPanel').classList.toggle('show', open);
  $('#fBtn').classList.toggle('on', open);
  $('#fBtn').setAttribute('aria-expanded', open);
  if (open) $('#qList').classList.remove('show');
}
function bindSearch() {
  $('#fBtn').addEventListener('click', (e) => { e.stopPropagation(); setPanel(!$('#fPanel').classList.contains('show')); });
  $('#fPanel').addEventListener('click', (e) => {
    e.stopPropagation();
    const b = e.target.closest('[data-filter]');
    if (b) { const id = b.dataset.filter; filterTags.has(id) ? filterTags.delete(id) : filterTags.add(id); renderBoard(); return; }
    if (e.target.closest('#fClear')) { filterTags.clear(); renderBoard(); return; }
    if (e.target.closest('#fDone')) setPanel(false);
  });
  $('#qChips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-unfilter]');
    if (!b) return;
    e.stopPropagation();
    filterTags.delete(b.dataset.unfilter);
    renderBoard();
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.searchwrap')) setPanel(false); });
  $('.sbar').addEventListener('click', (e) => { if (!e.target.closest('button')) $('#q').focus(); });
  $('#q').addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !e.target.value && filterTags.size) { const last = [...filterTags].pop(); filterTags.delete(last); renderBoard(); }
  });
  $('#q').addEventListener('input', (e) => { query = e.target.value.trim().toLowerCase(); qSel = 0; renderBoard(); renderQList(); });
  $('#q').addEventListener('focus', renderQList);
  $('#q').addEventListener('blur', () => setTimeout(() => $('#qList').classList.remove('show'), 150));
  $('#q').addEventListener('keydown', (e) => {
    const ms = $$('#qList .qi');
    if (!ms.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); qSel = (qSel + (e.key === 'ArrowDown' ? 1 : -1) + ms.length) % ms.length; renderQList(); }
    if (e.key === 'Enter') { e.preventDefault(); $('#qList').classList.remove('show'); openProject(ms[qSel].dataset.qo); }
    if (e.key === 'Escape') $('#qList').classList.remove('show');
  });
  $('#qList').addEventListener('mousedown', (e) => {
    const sf = e.target.closest('[data-sfilter]');
    if (sf) { e.preventDefault(); const id = sf.dataset.sfilter; filterTags.has(id) ? filterTags.delete(id) : filterTags.add(id); renderBoard(); renderSuggest(); return; }
    if (e.target.closest('[data-sall]')) { e.preventDefault(); $('#qList').classList.remove('show'); setPanel(true); return; }
    const b = e.target.closest('[data-qo]');
    if (!b) return;
    e.preventDefault();
    $('#qList').classList.remove('show');
    openProject(b.dataset.qo);
  });
}
function renderQList() {
  const v = $('#q').value.trim(), L = $('#qList');
  if (!v) { renderSuggest(); return; }
  const n = norm(v);
  const ms = S.projects.filter((p) => norm(p.title).includes(n)).slice(0, 8);
  qSel = Math.min(qSel, Math.max(ms.length - 1, 0));
  L.innerHTML = ms.length ? ms.map((p, i) => `<button class="qi ${i === qSel ? 'on' : ''}" role="option" data-qo="${esc(p.id)}"><b dir="auto">${esc(p.title)}</b></button>`).join('') : '<div class="qe">No project with that name</div>';
  L.classList.add('show');
  $('#q').setAttribute('aria-expanded', 'true');
}

/** Quick filter suggestions shown when the empty search box is focused. */
function renderSuggest() {
  const L = $('#qList');
  const chip = (id, html) => `<button type="button" class="fopt ${filterTags.has(id) ? 'on' : ''}" data-sfilter="${esc(id)}">${html}</button>`;
  const cnt = (fn) => S.projects.filter((p) => !isSubmitted(p) && fn(p)).length;
  const dueChips = ['overdue', 'today', 'week', 'next', 'month'].map((k) => [k, cnt((p) => dueMatch(p, k))]).filter(([k, n]) => n || filterTags.has('due:' + k));
  const engCols = S.columns.filter((c) => colUser(c));
  const sts = statusOptions().slice(0, 6);
  L.innerHTML = `<div class="sugg">
    <div class="sugg-h">Submission date</div><div class="sugg-r">${dueChips.map(([k, n]) => chip('due:' + k, `${esc(DUE_RANGES.find((r) => r[0] === k)[1])}<small class="fhint">${n}</small>`)).join('') || '<em class="fnone">Nothing due soon</em>'}</div>
    <div class="sugg-h">Engineer</div><div class="sugg-r">${engCols.map((c) => { const u = colUser(c); return chip('eng:' + c.id, `${avatar(u, 'xs')}<bdi>${esc(firstName(u.name.replace(/^Eng\.?\s*/i, '')))}</bdi>`); }).join('')}</div>
    ${sts.length ? `<div class="sugg-h">Status</div><div class="sugg-r">${sts.map(([k, o]) => chip('st:' + k, `<bdi>${esc(o.label)}</bdi>`)).join('')}</div>` : ''}
    <div class="sugg-f">Or type to search project names · <button type="button" data-sall>All filters</button></div>
  </div>`;
  L.classList.add('show');
  $('#q').setAttribute('aria-expanded', 'true');
}

/* ---------------- sorting & menus ---------------- */
function sortMenu(btn, k) {
  const r = btn.getBoundingClientRect(), cur_ = sortKey(k);
  menu(r.left, r.bottom + 4, Object.entries(SORTS).map(([id, [label]]) => [label, id === cur_ ? 'check' : 'sort', () => {
    sortPrefs[k] = id;
    try { localStorage.setItem(SORT_KEY, JSON.stringify(sortPrefs)); } catch (_) { /* storage unavailable */ }
    renderBoard();
    toast(`Sorted by <b>${label.toLowerCase()}</b>`, 'sort');
  }, id === cur_ ? 'cur' : '']));
  $('#menu').style.minWidth = '250px';
}
function colMenu(btn, id) {
  const r = btn.getBoundingClientRect(), u = colUser(colById(id));
  menu(r.right - 200, r.bottom + 4, [
    ['Edit profile', 'edit', () => editProfile(u.id)],
    ['Add project here', 'plus', () => newProject(id)],
    ['Remove column', 'trash', async () => {
      if (!confirm(`Remove ${u.name}'s column? Their projects move to Unassigned. They stay on the team.`)) return;
      const r2 = await act(() => dl.setColumn(u.id, false));
      if (r2.ok) toast('Column removed – projects moved to Unassigned');
    }, 'danger'],
  ]);
}
function menu(x, y, items) {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'menu';
  m.id = 'menu';
  m.style.left = Math.max(8, x) + 'px';
  m.style.top = y + 'px';
  m.innerHTML = items.map((it, i) => `<button data-i="${esc(i)}" class="${it[3] || ''}">${icon(it[1])}${it[0]}</button>`).join('');
  document.body.appendChild(m);
  m.onclick = (e) => { const b = e.target.closest('[data-i]'); if (b) { closeMenu(); items[b.dataset.i][2](); } };
  setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0);
}
function closeMenu() { const m = $('#menu'); if (m) m.remove(); }

/* ---------------- modal ---------------- */
function modal(html, after) {
  const m = $('#modal');
  $('.box', m).className = 'box';
  $('.box', m).innerHTML = html;
  m.classList.add('show');
  $('#scrim').classList.add('show');
  $$('[data-close]', m).forEach((b) => { b.onclick = closeModal; });
  if (after) after();
  const f = $('input,textarea,select', m);
  if (f) f.focus();
}
function closeModal() {
  $('#modal').classList.remove('show');
  if (!$('#page').classList.contains('show') && !$('.sheet.show')) $('#scrim').classList.remove('show');
}

function tenderOptions(sel) {
  const g = (t) => (S.tenderTeam || []).filter((x) => x.type === t).map((x) => `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  return `<option value="">— Not set —</option><optgroup label="Private">${g('private')}</optgroup><optgroup label="Public">${g('public')}</optgroup>`;
}

function newProject(colId) {
  modal(`<h3>New project</h3>
    <div class="row"><label for="nT">Project title</label><input class="in" id="nT" dir="auto" placeholder="Project name (Arabic or English)"></div>
    <div class="formgrid"><div class="row"><label for="nTm">Tender team</label><select class="in" id="nTm">${tenderOptions('')}</select></div>
    <div class="row"><label for="nD">Submission date</label><input class="in" type="date" id="nD" value="${isoIn(14)}"></div>
    <div class="row full"><label for="nC">Client</label><input class="in" id="nC" dir="auto"></div></div>
    <div class="acts"><button class="btn" data-close>Cancel</button><button class="btn primary" id="nOk">Create project</button></div>`, () => {
    $('#nOk').onclick = async () => {
      const t = $('#nT').value.trim();
      if (!t) return $('#nT').focus();
      const tm = tenderById($('#nTm').value);
      closeModal();
      const r = await act(() => dl.createProject({
        title: t, tender: tm ? tm.id : null, type: tm ? tm.type : 'public', due: $('#nD').value,
        client: $('#nC').value.trim(), columnId: colId || null,
      }));
      if (r.ok) { flash(r.value); toast('Project created'); }
    };
  });
}
function flash(id) {
  requestAnimationFrame(() => {
    const c = $(`.card[data-id="${id}"]`);
    if (c) { c.classList.add('fresh'); c.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }); }
  });
}

/* ---------------- project page ---------------- */
function openProject(id) { location.hash = '#p/' + id; }
function route() {
  const m = location.hash.match(/^#p\/([\w-]+)/);
  if (m && proj(m[1])) {
    cur = m[1];
    renderPage();
    $('#page').classList.add('show');
    $('#scrim').classList.add('show');
  } else {
    cur = null;
    $('#page').classList.remove('show');
    if (!$('.sheet.show')) $('#scrim').classList.remove('show');
  }
}
function closePage() {
  if (location.hash) history.pushState('', document.title, location.pathname + location.search);
  route();
}
function folderIconHTML(url) {
  return folderKind(url) === 'onedrive'
    ? '<svg class="i gd" viewBox="0 0 32 20"><use href="#i-onedrive"/></svg>'
    : icon('link');
}
function columnIdsExcept(colId, exceptId) {
  return S.projects.filter((x) => (x.columnId || null) === (colId || null) && x.id !== exceptId)
    .sort((a, b) => a.pos - b.pos).map((x) => x.id);
}

function renderPage() {
  const p = proj(cur);
  if (!p) return;
  const done = p.subtasks.filter((s) => s.done).length;
  const dinfo = isSubmitted(p) && p.due ? { cls: 'done', rel: 'Submitted' } : dueInfo(p.due);
  const dueStyle = dinfo.cls === 'done' ? 'background:var(--ok);color:#fff;border-color:var(--ok)' : dinfo.cls === 'late' ? 'background:var(--danger);color:#fff;border-color:var(--danger)' : dinfo.cls === 'soon' ? 'background:var(--accent);color:#fff;border-color:var(--accent)' : '';
  const nonSys = p.comments.filter((c) => !c.sys).length;
  $('#page').innerHTML = `
  <div class="page-head">
    <button class="btn icon" id="back" aria-label="Back to board">${icon('left')}</button>
    <div class="t">
      <div class="crumb">${typeBadge(projType(p))}${tenderById(p.tender) ? ' ' + esc(tenderById(p.tender).name) + ' ·' : ''} received ${fmtDate(p.received)} · updated ${ago(p.updatedAt)}${p.updatedBy ? ' by ' + esc(p.updatedBy) : ''}${p.source === 'email' ? ' <span class="src">from email</span>' : ''}</div>
      <input class="title-in" id="pTitle" value="${esc(p.title)}" dir="auto" aria-label="Project title">
    </div>
    <button class="btn ${isSubmitted(p) ? 'sub-on' : ''}" id="pSubmit" title="${isSubmitted(p) ? 'Click to move it back to active' : 'Move this tender to the Submitted list'}">${icon('check')}${isSubmitted(p) ? 'Submitted' : 'Mark as submitted'}</button>
    <button class="btn icon" id="pMore" aria-label="More">${icon('dots')}</button>
    <button class="btn icon p-close" id="pClose" aria-label="Close project" title="Close (Esc)">${icon('x')}</button>
  </div>
  <div class="page-body">
    <div>
      <div class="panel">
        <h4>Details</h4>
        <div class="field"><label for="pCol">Assigned to</label><select class="in" id="pCol"><option value="">— Unassigned —</option>${S.columns.filter((c) => colUser(c)).map((c) => `<option value="${c.id}" ${c.id === p.columnId ? 'selected' : ''}>${esc(colName(c.id))}</option>`).join('')}</select></div>
        <div class="field"><label for="pStatus">Status</label><input class="in" id="pStatus" value="${esc(p.status)}" dir="auto" placeholder="Write the current status…" list="statusList"></div>
        <datalist id="statusList"><option>Reviewing documents</option><option>Site visit scheduled</option><option>Queries sent to client</option><option>Pricing in progress</option><option>Waiting supplier quotes</option><option>Ready for submission</option><option>Submitted</option></datalist>
        <div class="field due-field"><label for="pDue">Submission date</label><div style="display:flex;gap:8px;align-items:center"><input class="in" type="date" id="pDue" value="${p.due || ''}"><span class="c-rel" style="${dueStyle}">${dinfo.rel}</span></div>
          ${(p.dueHistory || []).length ? `<div class="due-hist">${p.dueHistory.slice(0, 3).map((h) => `<div>${icon(h.by === 'email' ? 'mail' : 'user')}${h.from ? fmtDate(h.from) + ' → ' : ''}<b style="color:var(--ink-2)">${fmtDate(h.to)}</b> · ${h.by === 'email' ? 'from email' : esc(h.by)} · ${ago(h.at)}</div>`).join('')}</div>` : '<div class="due-hist">Updates automatically when an email gives a new date. You can change it here at any time.</div>'}</div>
        <div class="field"><label for="pTender">Tender team</label><div style="display:flex;gap:8px;align-items:center"><select class="in" id="pTender">${tenderOptions(p.tender)}</select>${typeBadge(projType(p))}</div></div>
        ${tenderById(p.tender) ? '' : `<div class="field"><label>Tender type</label><div class="seg" id="pType"><button type="button" data-v="public" class="${p.type !== 'private' ? 'on' : ''}">Public</button><button type="button" data-v="private" class="${p.type === 'private' ? 'on' : ''}">Private</button></div></div>`}
        <div class="field"><label for="pClient">Client</label><input class="in" id="pClient" value="${esc(p.client)}" dir="auto"></div>
        <div class="field"><label for="pRec">Received</label><input class="in" type="date" id="pRec" value="${p.received || ''}"></div>
      </div>
      <div class="panel">
        <h4>Tags</h4>
        <div class="tagpick" id="tagpick">${S.tags.map((t) => `<button data-tag="${esc(t.id)}" class="${p.tags.includes(t.id) ? 'on' : ''}"><i class="tdot" style="background:${safeColor(t.color)}"></i>${esc(t.name)}</button>`).join('')}<input class="newtag" id="newTag" placeholder="+ New tag" dir="auto" aria-label="New tag"></div>
      </div>
      <div class="panel">
        <h4>Project folder</h4>
        ${p.folder ? `<div class="folder">${folderIconHTML(p.folder)}<a href="${esc(p.folder)}" target="_blank" rel="noopener">${esc(folderLabel(p.folder))}</a><button class="btn sm ghost" id="unlink">Unlink</button></div>`
          : `<div class="addrow"><input class="in" id="folderIn" placeholder="Paste the SharePoint / OneDrive folder link"><button class="btn sm" id="folderLink">Link</button>${S.folders.root ? `<a class="btn sm dark" href="${esc(S.folders.root)}" target="_blank" rel="noopener">${icon('folder')}Open main tenders folder</a>` : ''}</div>`}
      </div>
      <div class="panel">
        <h4 class="sub-head ${p.subOpen ? '' : 'closed'}" id="subHead">${icon('chev', 'chev')}Sub-tasks <span class="pill">${done}/${p.subtasks.length}</span><span class="grow"></span></h4>
        <div class="collapse ${p.subOpen ? '' : 'closed'}" id="subWrap"><div>
          <div class="prog" style="margin:0 0 12px"><i style="width:${p.subtasks.length ? done / p.subtasks.length * 100 : 0}%"></i></div>
          <div id="subs">${p.subtasks.map(subHTML).join('')}</div>
          <form class="addrow" id="subAdd"><input class="in" id="subIn" placeholder="Add a sub-task…" dir="auto"><input class="in" type="date" id="subDue" style="width:150px" aria-label="Sub-task date"><button class="btn primary sm" style="height:34px">${icon('plus')}Add</button></form>
        </div></div>
      </div>
    </div>
    <div>
      <div class="panel" style="animation-delay:.06s">
        <div class="tabs" id="tabs">
          ${[['files', 'folder', 'Files', 0], ['links', 'link', 'Links', p.links.length], ['comments', 'msg', 'Comments', nonSys], ['notifications', 'bell', 'Notifications', p.notifications.length], ['uploads', 'up', 'Uploads', 0]]
            .map(([k, ic, l, n]) => `<button class="tab ${curTab === k ? 'on' : ''}" data-tab="${esc(k)}">${icon(ic)}${l}${n ? `<span class="n">${n}</span>` : ''}</button>`).join('')}
          <span class="tab-ink" id="tabInk"></span>
        </div>
        <div id="pane"></div>
      </div>
    </div>
  </div>`;
  bindPage(p);
  renderPane();
  moveInk();
}

function subHTML(s) {
  const open = openSubs.has(s.id);
  return `<div class="sub ${s.done ? 'done' : ''} ${open ? 'open' : ''}" data-sub="${esc(s.id)}">
    <div class="sub-row">
      <button class="chk" data-act="toggle" aria-label="Done"><svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10" fill="none"/></svg></button>
      <input class="sub-text" value="${esc(s.text)}" dir="auto" data-act="text" aria-label="Sub-task">
      ${s.due ? `<span class="sub-due">${fmtShort(s.due)}</span>` : ''}
      ${s.note ? `<span title="Has notes" style="color:var(--muted)">${icon('msg')}</span>` : ''}
      <button class="btn ghost icon sm sub-tog" data-act="open" aria-label="Expand">${icon('chev')}</button>
      <button class="btn ghost icon sm sub-x" data-act="del" aria-label="Delete">${icon('x')}</button>
    </div>
    <div class="collapse ${open ? '' : 'closed'}"><div><div class="sub-more">
      <textarea class="in" data-act="note" placeholder="Notes, details…" dir="auto">${esc(s.note || '')}</textarea>
      <input class="in" type="date" data-act="due" value="${s.due || ''}" aria-label="Due date">
    </div></div></div>
  </div>`;
}

function bindPage(p) {
  $('#back').onclick = closePage;
  $('#pClose').onclick = closePage;
  $('#pSubmit').onclick = () => setSubmitted(p.id);
  $('#pMore').onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    menu(r.right - 190, r.bottom + 4, [['Delete project', 'trash', async () => {
      if (!confirm('Delete this project?')) return;
      closePage();
      const r2 = await act(() => dl.deleteProject(p.id));
      if (r2.ok) toast('Project deleted');
    }, 'danger']]);
  };
  const field = (id, patch, msg) => {
    $(id).onchange = async (e) => {
      const r = await act(() => dl.updateProject(p.id, typeof patch === 'function' ? patch(e.target.value) : { [patch]: e.target.value }));
      if (r.ok && msg) toast(msg);
    };
  };
  $('#pTitle').onchange = async (e) => {
    const v = e.target.value.trim();
    if (!v) { e.target.value = p.title; return toast('Write a project title', 'x'); }
    await act(() => dl.updateProject(p.id, { title: v }));
  };
  field('#pStatus', 'status', 'Status updated');
  field('#pClient', 'client');
  field('#pRec', 'received');
  $('#pDue').onchange = async (e) => {
    const r = await act(() => dl.setDueDate(p.id, e.target.value));
    if (r.ok && r.value) toast(`Submission date set to <b>${fmtDate(e.target.value)}</b>`, 'cal');
  };
  const pt = $('#pType');
  if (pt) pt.onclick = (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    $$('#pType button').forEach((x) => x.classList.toggle('on', x === b));
    act(() => dl.updateProject(p.id, { type: b.dataset.v }));
  };
  $('#pTender').onchange = (e) => act(() => dl.updateProject(p.id, { tender: e.target.value || null, supervisor: '' }));
  $('#pCol').onchange = async (e) => {
    const v = e.target.value || null;
    const r = await act(() => dl.moveProject(p.id, v, [p.id, ...columnIdsExcept(v, p.id)]));
    if (r.ok && v) toast(`Assigned to <b>${esc(colName(v))}</b>`, 'user');
  };
  $('#tagpick').onclick = (e) => {
    const b = e.target.closest('[data-tag]');
    if (!b) return;
    const id = b.dataset.tag;
    act(() => dl.toggleTag(p.id, id, !p.tags.includes(id)));
  };
  $('#newTag').onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    const n = e.target.value.trim();
    if (!n) return;
    act(async () => {
      const tag = await dl.createTag(n);
      await dl.toggleTag(p.id, tag.id, true);
    }).then((r) => { if (r.ok) toast(`Tag <b>${esc(n)}</b> created`); });
  };
  if (p.folder) {
    $('#unlink').onclick = () => act(() => dl.updateProject(p.id, { folder: '' }));
  } else {
    $('#folderLink').onclick = async () => {
      const v = $('#folderIn').value.trim();
      if (!/^https?:\/\//.test(v)) return toast('Paste the full folder link (https://…)', 'x');
      const r = await act(() => dl.updateProject(p.id, { folder: v }));
      if (r.ok) toast('Folder linked', 'folder');
    };
  }
  $('#subHead').onclick = () => {
    const open = !p.subOpen;
    p.subOpen = open;
    $('#subHead').classList.toggle('closed', !open);
    $('#subWrap').classList.toggle('closed', !open);
    dl.updateProject(p.id, { subOpen: open }).catch((err) => toast(esc(err.message), 'x'));
  };
  $('#subAdd').onsubmit = async (e) => {
    e.preventDefault();
    const t = $('#subIn').value.trim();
    if (!t) return;
    const r = await act(() => dl.addSubtask(p.id, { text: t, due: $('#subDue').value }));
    if (r.ok) { const i = $('#subIn'); if (i) i.focus(); }
  };
  $('#subs').addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]');
    if (!a) return;
    const el = a.closest('.sub');
    const s = p.subtasks.find((x) => x.id === el.dataset.sub);
    if (!s) return;
    if (a.dataset.act === 'toggle') {
      const done = !s.done;
      act(() => dl.updateSubtask(s.id, { done }));
      if (done) toast('Sub-task completed');
    }
    if (a.dataset.act === 'open') {
      const open = !openSubs.has(s.id);
      open ? openSubs.add(s.id) : openSubs.delete(s.id);
      el.classList.toggle('open', open);
      $('.collapse', el).classList.toggle('closed', !open);
    }
    if (a.dataset.act === 'del') {
      el.style.transition = 'opacity .2s,transform .2s';
      el.style.opacity = 0;
      el.style.transform = 'translateX(10px)';
      setTimeout(() => act(() => dl.deleteSubtask(s.id)), 200);
    }
  });
  $('#subs').addEventListener('change', (e) => {
    const a = e.target.closest('[data-act]');
    if (!a) return;
    const s = p.subtasks.find((x) => x.id === a.closest('.sub').dataset.sub);
    if (!s) return;
    const patch = a.dataset.act === 'text' ? { text: a.value } : a.dataset.act === 'note' ? { note: a.value } : a.dataset.act === 'due' ? { due: a.value } : null;
    if (patch) act(() => dl.updateSubtask(s.id, patch));
  });
  $('#tabs').onclick = (e) => {
    const t = e.target.closest('[data-tab]');
    if (!t) return;
    curTab = t.dataset.tab;
    $$('.tab').forEach((x) => x.classList.toggle('on', x === t));
    moveInk();
    renderPane();
  };
}
function moveInk() {
  const t = $('.tab.on'), ink = $('#tabInk');
  if (!t || !ink) return;
  ink.style.left = t.offsetLeft + 'px';
  ink.style.width = t.offsetWidth + 'px';
}

function renderPane() {
  const p = proj(cur), pane = $('#pane');
  if (!p || !pane) return;
  pane.className = 'tabpane';
  void pane.offsetWidth;
  if (curTab === 'files') {
    pane.innerHTML = p.folder
      ? `<div class="folder">${folderIconHTML(p.folder)}<span style="flex:1;font-size:13px">Files are kept in the project's SharePoint / OneDrive folder.</span><a class="btn sm" href="${esc(p.folder)}" target="_blank" rel="noopener">${icon('ext')}Open folder</a></div>`
      : '<div class="empty">No folder linked yet. Paste the project\'s SharePoint / OneDrive folder link under Project folder.</div>';
  }
  if (curTab === 'links') {
    pane.innerHTML = `<form class="addrow" id="lf" style="margin-bottom:10px"><input class="in" id="lt" placeholder="Title" style="max-width:160px" dir="auto"><input class="in" id="lu" placeholder="https://…" type="url" required><button class="btn primary sm" style="height:34px">${icon('plus')}Add</button></form>
      ${p.links.length ? p.links.map((l) => `<div class="list-item"><span class="ico">${icon('link')}</span><div class="body"><b><a href="${esc(l.url)}" target="_blank" rel="noopener" dir="auto">${esc(l.title || l.url)}</a></b><small>${esc(l.url)}${l.src ? ' · from email' : ''}</small></div><button class="btn ghost icon sm" data-dell="${esc(l.id)}" aria-label="Remove">${icon('x')}</button></div>`).join('')
        : '<div class="empty">No links yet. Links found in emails are added here automatically.</div>'}`;
    $('#lf').onsubmit = (e) => {
      e.preventDefault();
      const title = $('#lt').value.trim(), url = $('#lu').value.trim();
      act(() => dl.addLink(p.id, { title, url })).then((r) => { if (r.ok) toast('Link added', 'link'); });
    };
    pane.onclick = (e) => {
      const b = e.target.closest('[data-dell]');
      if (b) act(() => dl.deleteLink(b.dataset.dell));
    };
  }
  if (curTab === 'comments') {
    const list = [...p.comments].sort((a, b) => b.at - a.at);
    pane.innerHTML = `<form id="cf"><textarea class="in" id="ct" placeholder="Write a comment…" dir="auto"></textarea><div style="display:flex;justify-content:space-between;align-items:center;margin:8px 0 6px"><small style="color:var(--muted)">Posting as ${esc(me().name)}</small><button class="btn primary sm">Post comment</button></div></form>
      ${list.map((c) => `<div class="comment ${c.sys ? 'sys' : ''}"><div class="avatar">${c.sys ? icon('clock') : esc(initials(c.who))}</div><div class="b"><div class="who">${esc(c.who)}<time>${fmtDT(c.at)}</time></div><p dir="auto">${esc(c.text)}</p></div></div>`).join('') || '<div class="empty">No comments yet.</div>'}`;
    $('#cf').onsubmit = (e) => {
      e.preventDefault();
      const t = $('#ct').value.trim();
      if (!t) return;
      act(() => dl.addComment(p.id, t));
    };
  }
  if (curTab === 'notifications') {
    const perm = ('Notification' in window) ? Notification.permission : 'unsupported';
    const list = [...p.notifications].sort((a, b) => a.at - b.at);
    const canPush = S.mode === 'supabase' && pushSupported();
    pane.innerHTML = `${perm !== 'granted' ? `<div class="folder" style="margin-bottom:12px"><span style="color:var(--accent)">${icon('bell')}</span><span style="flex:1;font-size:13px">${perm === 'denied' ? 'Desktop notifications are blocked in this browser. Reminders will still show inside the app.' : perm === 'unsupported' ? 'This browser has no desktop notifications; reminders show inside the app.' : 'Allow notifications to get reminders even when this tab is in the background.'}</span>${perm === 'default' || canPush ? `<button class="btn sm primary" id="perm">${canPush ? 'Enable on this device' : 'Allow'}</button>` : ''}</div>` : ''}
      <div class="presets">
        <button class="btn sm" data-pre="1m">In 1 min (test)</button>
        <button class="btn sm" data-pre="1h">In 1 hour</button>
        <button class="btn sm" data-pre="tom9">Tomorrow 09:00</button>
        ${p.due ? '<button class="btn sm" data-pre="due1">1 day before submission</button><button class="btn sm" data-pre="due3">3 days before</button>' : ''}
      </div>
      <form class="formgrid" id="nf">
        <input class="in full" id="nm" placeholder="Reminder message" dir="auto" value="${esc(p.title.slice(0, 60))}">
        <input class="in" type="datetime-local" id="nat" value="${localDT(Date.now() + HOUR)}" required aria-label="Date and time">
        <select class="in" id="nrep" aria-label="Repeat"><option value="none">Once</option><option value="hourly">Every hour</option><option value="daily">Every day</option><option value="weekly">Every week</option></select>
        <div class="full"><span class="lbl-sm">Send to</span>${recipPicker('nto', ['assignee'], true)}</div>
        <label class="chk-row full"><input type="checkbox" id="nemail" checked>Also send by email</label>
        <button class="btn primary full">${icon('bell')}Set reminder</button>
      </form>
      ${list.length ? list.map((n) => remRow(n, p, `data-deln="${esc(n.id)}"`, true)).join('') : '<div class="empty">No reminders for this project.</div>'}`;
    const pb = $('#perm');
    if (pb) pb.onclick = () => (canPush ? enablePushUI() : Notification.requestPermission().then(() => renderPane()));
    $('.presets', pane).onclick = (e) => {
      const b = e.target.closest('[data-pre]');
      if (!b) return;
      const k = b.dataset.pre;
      let t;
      if (k === '1m') t = Date.now() + 60000;
      if (k === '1h') t = Date.now() + HOUR;
      if (k === 'tom9') { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); t = +d; }
      if (k.startsWith('due')) {
        const d = toDate(p.due);
        d.setDate(d.getDate() - (k === 'due1' ? 1 : 3));
        d.setHours(9, 0, 0, 0);
        t = +d;
        $('#nm').value = `Submission ${k === 'due1' ? 'tomorrow' : 'in 3 days'}: ${p.title}`;
      }
      $('#nat').value = localDT(t);
    };
    const npick = bindPicker('nto');
    $('#nf').onsubmit = (e) => {
      e.preventDefault();
      const at = new Date($('#nat').value).getTime();
      const to = npick();
      if (!to.length) return toast('Choose who gets the reminder', 'x');
      act(() => dl.addReminder({ projectId: p.id, at, msg: $('#nm').value.trim() || p.title, repeat: $('#nrep').value, to, email: $('#nemail').checked }))
        .then((r) => { if (r.ok) toast(`Reminder set for <b>${fmtDT(at)}</b>`, 'bell'); });
    };
    pane.onclick = (e) => {
      const b = e.target.closest('[data-deln]');
      if (b) act(() => dl.deleteReminder(b.dataset.deln));
    };
  }
  if (curTab === 'uploads') {
    pane.innerHTML = `<div class="drop"><div style="margin-bottom:6px;color:var(--accent)">${icon('up')}</div><b>Upload files in SharePoint / OneDrive</b><br>
      <small>${S.folders.root || p.folder ? 'Open the project folder and drag your files there (large drawings included).' : 'Set the main tenders folder first (Folder button at the top).'}</small>
      ${p.folder ? `<div style="margin-top:10px"><a class="btn sm" href="${esc(p.folder)}" target="_blank" rel="noopener">${icon('ext')}Open folder</a></div>` : ''}</div>`;
  }
}

/* ---------------- reminders: recipients ---------------- */
function recipPicker(id, selected, withAssignee) {
  const opt = (v, html, cls = '') => `<button type="button" class="${cls} ${selected.includes(v) ? 'on' : ''}" data-r="${esc(v)}">${html}</button>`;
  return `<div class="recips" id="${id}">${opt('all', 'Everyone', 'txt')}${withAssignee ? opt('assignee', 'Assigned engineer', 'txt') : ''}${S.users.map((u) => opt(u.id, avatar(u, 'sm') + esc(u.name.replace(/^Eng\.\s*/, '')))).join('')}</div>`;
}
function bindPicker(id) {
  const el = $('#' + id);
  el.onclick = (e) => {
    const b = e.target.closest('[data-r]');
    if (!b) return;
    if (b.dataset.r === 'all') { $$('[data-r]', el).forEach((x) => x.classList.toggle('on', x === b && !b.classList.contains('on'))); }
    else { b.classList.toggle('on'); $('[data-r="all"]', el).classList.remove('on'); }
  };
  return () => $$('[data-r].on', el).map((b) => b.dataset.r);
}
function resolveTo(n, p) {
  const ids = new Set();
  (n.to || []).forEach((t) => {
    if (t === 'all') S.users.forEach((u) => ids.add(u.id));
    else if (t === 'assignee') { const u = p && colUser(colById(p.columnId)); if (u) ids.add(u.id); }
    else if (userById(t)) ids.add(t);
  });
  return [...ids].map(userById);
}
function toLabel(n, p) {
  if (!n.to || !n.to.length) return 'Just me';
  if (n.to.includes('all')) return 'Everyone';
  return n.to.map((t) => (t === 'assignee' ? (p && colUser(colById(p.columnId)) ? colName(p.columnId) : 'Assigned engineer') : (userById(t) || {}).name)).filter(Boolean).join(', ');
}
function remRow(n, p, del, inProject = false) {
  const who = resolveTo(n, p);
  return `<div class="rem ${n.fired ? 'fired' : ''}"><span class="ico" style="background:var(--accent-soft);color:var(--accent-2)">${icon('bell')}</span>
    <div style="flex:1;min-width:0"><div dir="auto" style="font-weight:500">${esc(n.msg)}</div>
      ${p && !inProject ? `<small dir="auto" style="color:var(--muted);display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.title)}</small>` : ''}
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:4px"><span class="when">${fmtDT(n.at)}</span>${n.repeat !== 'none' ? `<span class="pill o">${n.repeat}</span>` : ''}${n.email ? '<span class="pill">+ email</span>' : ''}<span style="color:var(--muted);font-size:12px">→ ${esc(toLabel(n, p))}</span></div></div>
    <span style="display:flex">${who.slice(0, 3).map((u) => avatar(u, 'sm')).join('')}</span>
    ${p && !inProject ? `<button class="btn sm ghost" data-open="${esc(p.id)}">Open</button>` : ''}
    <button class="btn ghost icon sm" ${del} aria-label="Delete reminder">${icon('x')}</button></div>`;
}

/* ---------------- sheets ---------------- */
function sheet(id) {
  $$('.sheet').forEach((s) => s.classList.toggle('show', s.id === id));
  if (id === 'mailSheet') renderMailSheet();
  if (id === 'remSheet') renderRemSheet();
  if (id === 'teamSheet') renderTeamSheet();
  $('#scrim').classList.toggle('show', !!id || !!cur);
}

/* ---- email intake ---- */
const pillFor = (outcome) => (outcome === 'applied' || outcome === 'review' ? 'pill o' : 'pill');
function reviewHTML(r) {
  const cands = r.candidates.map((c) => `<button class="btn sm" data-assign="${esc(r.id)}" data-pid="${esc(c.pid)}">This is: ${esc(c.title)}</button>`).join('');
  return `<div class="review-item">
    <div class="subj ar" dir="rtl">${esc(r.subject)}</div>
    <div class="from">${esc(r.from)} · ${ago(r.at)}</div>
    <div>${esc(r.summary)}</div>
    <div>${r.reasons.map((x) => `<span class="pill">${esc(REVIEW_REASON_LABELS[x] || x)}</span>`).join(' ')}</div>
    ${r.excerpt ? `<div class="snip ar" dir="rtl">${esc(r.excerpt)}</div>` : ''}
    <div class="review-acts">${cands}<button class="btn sm" data-newp="${esc(r.id)}">New project</button><button class="btn sm ghost" data-dismiss="${esc(r.id)}">Not a tender</button>${r.webLink ? `<a class="btn sm ghost" href="${esc(r.webLink)}" target="_blank" rel="noopener">Open email</a>` : ''}</div>
  </div>`;
}
function renderMailSheet() {
  const sh = $('#mailSheet');
  const m = S.mail, admin = isAdmin();
  sh.innerHTML = `<div class="sheet-head"><span style="color:var(--accent)">${icon('mail')}</span><h2>Email intake</h2><button class="btn icon" data-x aria-label="Close">${icon('x')}</button></div>
  <div class="sheet-body">
    <div class="kv">
      <label for="mAddr">Mailbox</label><input class="in" id="mAddr" value="${esc(m.address)}" ${admin ? '' : 'readonly'}>
      <label for="mSubj">Subject contains</label><input class="in ar" id="mSubj" value="${esc(m.subject)}" dir="rtl" ${admin ? '' : 'readonly'}>
      <label>Hourly auto-sync</label><div><button class="switch ${m.hourly ? 'on' : ''}" id="mHourly" aria-label="Hourly auto-sync" aria-pressed="${m.hourly}" ${admin ? '' : 'disabled'}></button></div>
      <label>Last sync</label><span style="font:500 12.5px var(--mono)">${m.lastSync ? fmtDT(m.lastSync) : 'never'}</span>
    </div>
    <button class="btn primary" id="mSync" style="width:100%;justify-content:center">${icon('sync')}Read inbox now</button>
    <div class="scan ${syncing ? 'on' : ''}" id="scanBar"><i></i></div>
    <div class="section-label">Needs review · ${m.reviews.length}</div>
    ${m.reviews.length ? m.reviews.map(reviewHTML).join('') : '<div class="empty">Nothing waiting for review.</div>'}
    <div class="section-label">How emails are read</div>
    <div style="font-size:13px;color:var(--ink-2);display:grid;gap:6px;margin-bottom:8px">
      <div>Every hour the tenders mailbox (Inbox and Sent) is read.</div>
      <div>Newsletters and automatic replies are skipped.</div>
      <div>Claude reads each remaining email and fills in a form; the app checks it and updates the board.</div>
      <div>Anything uncertain waits here in Needs review.</div>
    </div>
    <div class="section-label">Recent emails</div>
    ${m.log.length ? m.log.map((l) => `<div class="mail ${l.outcome === 'review' ? 'pending' : ''}"><div class="subj ar" dir="rtl">${esc(l.subject)}</div><div class="from">${esc(l.from || '')}</div>
      <div class="res"><span class="${pillFor(l.outcome)}">${esc(OUTCOME_LABELS[l.outcome] || l.outcome)}</span><span>${esc(l.label || '')}</span>${l.pid ? `<button class="btn sm ghost" data-open="${esc(l.pid)}" style="margin-left:auto">Open ${icon('ext')}</button>` : ''}</div></div>`).join('') : '<div class="empty">No emails read yet.</div>'}
    <div class="section-label">Recent runs</div>
    ${m.runs.length ? m.runs.map((r) => `<div style="font-size:12.5px;color:var(--muted);margin-bottom:4px">${fmtDT(r.at)} · ${esc(r.trigger)} · ${r.fetched} read · ${r.created} new · ${r.updated} updated${r.review ? ` · ${r.review} for review` : ''}</div>`).join('') : '<div class="empty">No runs yet.</div>'}
  </div>`;
  $('[data-x]', sh).onclick = () => sheet(null);
  $('#mSync').onclick = () => syncMail();
  if (admin) {
    $('#mAddr').onchange = (e) => act(() => dl.updateSettings({ address: e.target.value.trim() }));
    $('#mSubj').onchange = (e) => act(() => dl.updateSettings({ subject: e.target.value.trim() }));
    $('#mHourly').onclick = () => act(() => dl.updateSettings({ hourly: !m.hourly }));
  }
  sh.onclick = async (e) => {
    const o = e.target.closest('[data-open]');
    if (o) { sheet(null); openProject(o.dataset.open); return; }
    const a = e.target.closest('[data-assign]');
    if (a) { const r = await act(() => dl.resolveReview(a.dataset.assign, { action: 'assign', projectId: a.dataset.pid })); if (r.ok) { toast('Email added to the project'); flash(a.dataset.pid); } return; }
    const n = e.target.closest('[data-newp]');
    if (n) { const r = await act(() => dl.resolveReview(n.dataset.newp, { action: 'new' })); if (r.ok) { toast('New project created from the email'); if (r.value && r.value.projectId) flash(r.value.projectId); } return; }
    const d = e.target.closest('[data-dismiss]');
    if (d) { const r = await act(() => dl.resolveReview(d.dataset.dismiss, { action: 'dismiss' })); if (r.ok) toast('Marked as not a tender', 'mail'); }
  };
}
async function syncMail() {
  if (syncing) return;
  syncing = true;
  $('#syncBtn').classList.add('spin');
  repaintScan();
  try {
    const r = await dl.syncMailNow();
    toast(r.read
      ? `Email sync: <b>${r.read}</b> read · ${r.created} new · ${r.updated} updated${r.review ? ` · ${r.review} need review` : ''}`
      : 'Inbox up to date – no new emails', 'mail', 4200);
    if (r.created && 'Notification' in window && Notification.permission === 'granted') {
      new Notification('Rendcon – new tender' + (r.created > 1 ? 's' : ''), { body: `${r.created} new project${r.created > 1 ? 's' : ''} added to Unassigned` });
    }
  } catch (err) {
    toast(esc(err.message || 'Email sync failed'), 'x', 5000);
  } finally {
    syncing = false;
    $('#syncBtn').classList.remove('spin');
  }
  await refresh(true);
}
function repaintScan() { const sc = $('#scanBar'); if (sc) sc.classList.toggle('on', syncing); }

/* ---- reminders sheet ---- */
function renderRemSheet() {
  const sh = $('#remSheet');
  const perm = ('Notification' in window) ? Notification.permission : 'unsupported';
  const up = [...S.projects.flatMap((p) => p.notifications.map((n) => ({ n, p }))), ...S.reminders.map((n) => ({ n, p: null }))].sort((a, b) => a.n.at - b.n.at);
  sh.innerHTML = `<div class="sheet-head"><span style="color:var(--accent)">${icon('bell')}</span><h2>Reminders</h2><button class="btn icon" data-x aria-label="Close">${icon('x')}</button></div>
  <div class="sheet-body">
    <div class="folder" style="margin-bottom:16px"><span style="flex:1;font-size:13px">Notifications on this computer: <b>${perm === 'granted' ? 'allowed' : perm === 'denied' ? 'blocked in browser settings' : perm === 'default' ? 'not allowed yet' : 'not supported'}</b></span>${perm === 'default' || (S.mode === 'supabase' && pushSupported()) ? '<button class="btn sm primary" id="rPerm">Allow</button>' : ''}<button class="btn sm" id="rTest">Test</button></div>
    <div class="invite-box">
      <div style="font-weight:600;margin-bottom:12px">New reminder</div>
      <div class="formgrid">
        <div class="full"><label class="lbl-sm" for="rMsg">Message</label><input class="in" id="rMsg" placeholder="e.g. Submit pricing for 2026/104" dir="auto"></div>
        <div class="full"><label class="lbl-sm" for="rProj">Project</label><select class="in" id="rProj"><option value="">General (no project)</option>${S.projects.map((p) => `<option value="${p.id}">${esc(p.title)}</option>`).join('')}</select></div>
        <div><label class="lbl-sm" for="rAt">When</label><input class="in" type="datetime-local" id="rAt" value="${localDT(Date.now() + HOUR)}"></div>
        <div><label class="lbl-sm" for="rRep">Repeat</label><select class="in" id="rRep"><option value="none">Once</option><option value="hourly">Every hour</option><option value="daily">Every day</option><option value="weekly">Every week</option></select></div>
        <div class="full"><span class="lbl-sm">Send to</span>${recipPicker('rTo', ['all'], true)}</div>
        <label class="chk-row full"><input type="checkbox" id="rEmail" checked>Also send by email</label>
      </div>
      <div style="display:flex;gap:8px"><button class="btn" id="rNow" style="flex:1;justify-content:center">${icon('send')}Send now</button><button class="btn primary" id="rAdd" style="flex:1;justify-content:center">${icon('bell')}Schedule reminder</button></div>
    </div>
    <div class="section-label">Upcoming · ${up.length}</div>
    ${up.length ? up.map(({ n, p }) => remRow(n, p, p ? `data-delp="${esc(p.id)}" data-n="${esc(n.id)}"` : `data-delg="${esc(n.id)}"`)).join('') : '<div class="empty">Nothing scheduled.</div>'}
    <div class="section-label">Recently sent</div>
    ${S.sentLog.length ? S.sentLog.slice(0, 10).map((l) => `<div class="sent"><span style="color:var(--accent)">${icon('check')}</span><div class="b"><b style="font-weight:500" dir="auto">${esc(l.msg)}</b><small>to ${esc(l.names.join(', '))}${l.email ? ' · ' + l.email + ' email' + (l.email > 1 ? 's' : '') : ''} · ${fmtDT(l.at)}</small></div></div>`).join('') : '<div class="empty">No reminders sent yet.</div>'}
  </div>`;
  $('[data-x]', sh).onclick = () => sheet(null);
  const rp = $('#rPerm');
  if (rp) rp.onclick = () => (S.mode === 'supabase' && pushSupported() ? enablePushUI() : Notification.requestPermission().then(() => renderRemSheet()));
  $('#rTest').onclick = async () => {
    await dl.sendTestNotification().catch((err) => toast(esc(err.message), 'x'));
    if (S.mode === 'supabase') notify('Test reminder', 'Notifications are working for Redcon Tender Planning.');
  };
  const picks = bindPicker('rTo');
  $('#rProj').onchange = (e) => { const p = proj(e.target.value); if (p && !$('#rMsg').value) $('#rMsg').value = p.title.slice(0, 70); };
  const build = () => {
    const msg = $('#rMsg').value.trim();
    if (!msg) { toast('Write a reminder message', 'x'); $('#rMsg').focus(); return null; }
    const to = picks();
    if (!to.length) { toast('Choose who gets the reminder', 'x'); return null; }
    return { msg, to, email: $('#rEmail').checked, projectId: $('#rProj').value || null, at: new Date($('#rAt').value).getTime(), repeat: $('#rRep').value };
  };
  $('#rNow').onclick = async () => {
    const b = build(); if (!b) return;
    const r = await act(() => dl.sendReminderNow({ projectId: b.projectId, msg: b.msg, to: b.to, email: b.email }));
    if (r.ok) toast(`Reminder sent to <b>${esc(r.value.names.join(', ') || 'nobody')}</b>${r.value.emails ? ' · email' : ''}`, 'bell', 5000);
  };
  $('#rAdd').onclick = async () => {
    const b = build(); if (!b) return;
    const r = await act(() => dl.addReminder(b));
    if (r.ok) toast(`Reminder scheduled for <b>${fmtDT(b.at)}</b>`, 'bell');
  };
  sh.onclick = (e) => {
    const o = e.target.closest('[data-open]');
    if (o) { sheet(null); curTab = 'notifications'; openProject(o.dataset.open); return; }
    const d = e.target.closest('[data-delp],[data-delg]');
    if (!d) return;
    act(() => dl.deleteReminder(d.dataset.delg || d.dataset.n));
  };
}

/* ---- team sheet ---- */
function personFormHTML(pre) {
  return `<div class="formgrid">
    <div class="full"><label class="lbl-sm" for="${pre}Name">Name</label><input class="in" id="${pre}Name" placeholder="Eng. Name Surname" dir="auto" autocomplete="off"></div>
    <div class="full"><label class="lbl-sm" for="${pre}Email">Email <span style="font-weight:400">(needed to sign in)</span></label><input class="in" id="${pre}Email" type="email" placeholder="name@redcon.example" autocomplete="off"></div>
    <div><label class="lbl-sm" for="${pre}Role">Access</label><select class="in" id="${pre}Role"><option value="engineer">Planning engineer</option><option value="admin">Admin</option></select></div>
    <label class="chk-row" style="align-self:end"><input type="checkbox" id="${pre}Col" checked>Give them a board column</label>
  </div>`;
}
const PERSON_ERRORS = {
  missing_name: "Write the engineer's name",
  invalid_email: 'That email address does not look right',
  duplicate_email: 'That email is already on the team',
};
async function submitPerson(pre) {
  const name = $('#' + pre + 'Name').value.trim(), email = $('#' + pre + 'Email').value.trim();
  let res;
  try {
    res = await dl.addPerson({ name, email, role: $('#' + pre + 'Role').value, hasColumn: $('#' + pre + 'Col').checked });
  } catch (err) {
    toast(esc(err.message), 'x', 5000);
    return false;
  }
  if (!res.ok) {
    toast(PERSON_ERRORS[res.error] || 'Could not add the engineer', 'x');
    const field = res.error === 'missing_name' ? 'Name' : 'Email';
    $('#' + pre + field).focus();
    return false;
  }
  await refresh(true);
  const u = userById(res.id);
  const nm = u ? u.name : name;
  toast(email
    ? `<b>${esc(nm)}</b> added – they can sign in with ${esc(email.toLowerCase())} ("First time here? Create your password")`
    : `<b>${esc(nm)}</b> added to the planning team`, 'user');
  return true;
}
function memberStats(u) {
  const c = colOfUser(u.id);
  const ps = c ? S.projects.filter((p) => p.columnId === c.id) : [];
  return {
    active: ps.length,
    week: ps.filter((p) => p.due && daysUntil(p.due) >= 0 && daysUntil(p.due) <= 7).length,
    late: ps.filter((p) => p.due && daysUntil(p.due) < 0 && !p.tags.includes('sub')).length,
  };
}
function renderTeamSheet() {
  const sh = $('#teamSheet');
  if (!sh.classList.contains('show')) return;
  const order = S.users;
  sh.innerHTML = `<div class="sheet-head"><span style="color:var(--accent)">${icon('users')}</span><h2>Team</h2><button class="btn icon" data-x aria-label="Close">${icon('x')}</button></div>
  <div class="sheet-body">
    <div class="team-sec">
      <div class="sec-h"><div><h3>Planning team</h3><small>${S.users.length} engineer${S.users.length !== 1 ? 's' : ''} · drag or use the arrows to reorder – the board columns follow this order</small></div></div>
      <div class="invite-box">
        <div style="font-weight:600;margin-bottom:12px">Add a planning engineer</div>
        ${personFormHTML('t')}
        <button class="btn primary" id="tSend" style="width:100%;justify-content:center">${icon('plus')}Add engineer</button>
      </div>
      <div class="members">
    ${order.map((u, ix) => { const st = memberStats(u); return `<div class="member" draggable="true" data-mid="${esc(u.id)}"><span class="grip" title="Drag to reorder" aria-hidden="true">${icon('grip')}</span><span class="mv"><button class="btn ghost icon sm" data-up="${esc(u.id)}" ${ix === 0 ? 'disabled' : ''} aria-label="Move ${esc(u.name)} up" title="Move up">${icon('up1')}</button><button class="btn ghost icon sm" data-down="${esc(u.id)}" ${ix === order.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(u.name)} down" title="Move down">${icon('chev')}</button></span>${avatar(u)}
      <div class="b"><b dir="auto">${esc(u.name)} ${u.role === 'admin' ? '<span class="pill o">admin</span>' : ''}${me().id === u.id ? '<span class="pill">you</span>' : ''}</b>
        <small>${u.email ? esc(u.email) : 'No email – not signed in'}</small>
        <small>${st.active} project${st.active !== 1 ? 's' : ''}${st.late ? ` · <span style="color:var(--danger)">${st.late} overdue</span>` : ''}${colOfUser(u.id) ? '' : ' · no board column'}</small></div>
      <div class="acts">
        <button class="btn ghost icon sm" data-edit="${esc(u.id)}" aria-label="Edit profile" title="Edit profile">${icon('edit')}</button>
        ${u.id !== me().id ? `<button class="btn ghost icon sm" data-rm="${esc(u.id)}" aria-label="Remove" title="Remove from team">${icon('trash')}</button>` : ''}
      </div></div>`; }).join('')}
      </div>
    </div>
    <div class="team-sec second">
      <div class="sec-h"><div><h3>Tender team</h3><small>Private and public tender engineers we work with</small></div></div>
    <div id="ttList">${(S.tenderTeam || []).map((t) => `<div class="tt-row">
      <input class="in" data-tt="${esc(t.id)}" data-f="name" value="${esc(t.name)}" aria-label="Name">
      <input class="in ar" dir="rtl" data-tt="${esc(t.id)}" data-f="ar" value="${esc(t.ar || '')}" placeholder="الاسم بالعربي" aria-label="Name in Arabic, used to read emails">
      <select class="in" data-tt="${esc(t.id)}" data-f="type" aria-label="Public or private"><option value="private" ${t.type === 'private' ? 'selected' : ''}>Private</option><option value="public" ${t.type === 'public' ? 'selected' : ''}>Public</option></select>
      <button class="btn ghost icon sm" data-ttrm="${esc(t.id)}" aria-label="Remove ${esc(t.name)}">${icon('trash')}</button></div>`).join('')}</div>
    <button class="btn sm" id="ttAdd" style="margin-top:8px">${icon('plus')}Add tender engineer</button>
    <p style="font-size:12px;color:var(--muted);margin:8px 0 0">The Arabic name is how emails are matched to a tender engineer.</p>
    </div>
  </div>`;
  $('[data-x]', sh).onclick = () => sheet(null);
  $('#tSend').onclick = () => submitPerson('t');
  $('#ttList').onchange = (e) => {
    const el = e.target.closest('[data-tt]');
    if (!el) return;
    const patch = { [el.dataset.f]: el.value.trim() };
    if (el.dataset.f === 'type') patch.type = el.value;
    act(() => dl.updateTenderMember(el.dataset.tt, patch));
  };
  $('#ttAdd').onclick = async () => {
    const r = await act(() => dl.addTenderMember({ name: 'Eng. ', ar: '', type: 'public' }));
    if (r.ok) { const ins = $$('#ttList [data-f="name"]'); if (ins.length) ins[ins.length - 1].focus(); }
  };
  // drag rows to reorder, arrows, edit and remove
  let dragId = null;
  const reorder = (ids) => act(() => dl.reorderPeople(ids));
  $$('.member[data-mid]', sh).forEach((row) => {
    row.addEventListener('dragstart', (e) => { dragId = row.dataset.mid; row.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
    row.addEventListener('dragend', () => { row.classList.remove('dragging'); $$('.member.drop-a,.member.drop-b', sh).forEach((x) => x.classList.remove('drop-a', 'drop-b')); });
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      const r = row.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
      $$('.member.drop-a,.member.drop-b', sh).forEach((x) => x.classList.remove('drop-a', 'drop-b'));
      row.classList.add(after ? 'drop-b' : 'drop-a');
    });
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!dragId || dragId === row.dataset.mid) return;
      const r = row.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
      const ids = S.users.map((u) => u.id).filter((x) => x !== dragId);
      let i = ids.indexOf(row.dataset.mid);
      ids.splice(after ? i + 1 : i, 0, dragId);
      reorder(ids);
    });
  });
  sh.onclick = (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const d = t.dataset;
    if (d.up || d.down) {
      const id = d.up || d.down, i = S.users.findIndex((x) => x.id === id), j = i + (d.up ? -1 : 1);
      if (j < 0 || j >= S.users.length) return;
      const ids = S.users.map((u) => u.id);
      [ids[i], ids[j]] = [ids[j], ids[i]];
      reorder(ids);
      return;
    }
    if (d.edit) editProfile(d.edit);
    if (d.rm) removeMember(d.rm);
    if (d.ttrm) removeTender(d.ttrm);
  };
}
async function removeMember(id) {
  const u = userById(id);
  if (!u || id === me().id) return;
  if (!confirm(`Remove ${u.name} from the team? Their projects move to Unassigned.`)) return;
  const r = await act(() => dl.removePerson(id));
  if (r.ok) toast(`${esc(u.name)} removed`);
}
async function removeTender(id) {
  const t = tenderById(id);
  if (!t || !confirm(`Remove ${t.name} from the tender team?`)) return;
  const r = await act(() => dl.removeTenderMember(id));
  if (r.ok) toast(`${esc(t.name)} removed from the tender team`);
}

/* ---- profile ---- */
function editProfile(id) {
  const u = userById(id);
  if (!u) return;
  const admin = isAdmin();
  if (!(admin || id === me().id)) return;
  const st = memberStats(u), self = id === me().id;
  let color = u.color;
  modal(`<div class="prof-head"><span id="pfAv">${avatar(u, 'lg')}</span><div><h3 dir="auto">${esc(u.name)}</h3><small>${esc(u.email)} · ${u.role === 'admin' ? 'Admin' : 'Engineer'}</small></div></div>
    <div class="stats"><div><b>${st.active}</b><small>Projects</small></div><div><b>${st.week}</b><small>Due this week</small></div><div><b style="${st.late ? 'color:var(--danger)' : ''}">${st.late}</b><small>Overdue</small></div></div>
    <div class="formgrid">
      <div class="full"><label class="lbl-sm" for="pfName">Full name</label><input class="in" id="pfName" value="${esc(u.name)}" dir="auto"></div>
      <div><label class="lbl-sm" for="pfEmail">Email</label><input class="in" id="pfEmail" type="email" value="${esc(u.email)}" ${admin ? '' : 'disabled'}></div>
      ${admin && !self ? `<div><label class="lbl-sm" for="pfRole">Access</label><select class="in" id="pfRole"><option value="engineer" ${u.role === 'engineer' ? 'selected' : ''}>Engineer</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option></select></div>` : ''}
      <div class="full"><span class="lbl-sm">Avatar colour</span><div class="swatches" id="pfSw">${COLORS.map((c) => `<button type="button" data-c="${esc(c)}" class="${c === u.color ? 'on' : ''}" style="background:${safeColor(c)}" aria-label="Colour ${c}"></button>`).join('')}</div></div>
    </div>
    <span class="lbl-sm">Notifications</span>
    <label class="chk-row"><input type="checkbox" id="pfBr" ${u.prefs.browser ? 'checked' : ''}>Desktop / browser notifications</label>
    <label class="chk-row"><input type="checkbox" id="pfEm" ${u.prefs.email ? 'checked' : ''}>Reminders by email</label>
    <div class="acts" style="margin-top:14px"><button class="btn" data-close>Cancel</button><button class="btn primary" id="pfSave">Save profile</button></div>`, () => {
    $('#pfSw').onclick = (e) => {
      const b = e.target.closest('[data-c]');
      if (!b) return;
      color = b.dataset.c;
      $$('#pfSw button').forEach((x) => x.classList.toggle('on', x === b));
      $('#pfAv .avatar').style.background = color;
    };
    $('#pfSave').onclick = async () => {
      const n = $('#pfName').value.trim();
      if (!n) return $('#pfName').focus();
      const em = $('#pfEmail').value.trim();
      if (admin && em && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return toast('Enter a valid email address', 'x');
      const patch = { name: n, color, prefs: { browser: $('#pfBr').checked, email: $('#pfEm').checked } };
      if (admin) { patch.email = em; if ($('#pfRole')) patch.role = $('#pfRole').value; }
      closeModal();
      const r = await act(() => dl.updatePerson(id, patch));
      if (r.ok) toast('Profile saved');
    };
  });
}

/* ---- tenders folder (main link) ---- */
function folderSettings() {
  const admin = isAdmin();
  const root = S.folders.root || '';
  modal(`<h3>Tenders folder</h3>
    <p style="margin:-6px 0 14px;color:var(--muted);font-size:13px">Each project's folder link is kept under this main SharePoint or OneDrive folder.</p>
    <div class="row"><label for="dRoot">Main tenders folder link (SharePoint or OneDrive)</label><input class="in" id="dRoot" value="${esc(root)}" placeholder="https://company.sharepoint.com/…" ${admin ? '' : 'readonly'}></div>
    <div class="acts">${root ? `<a class="btn" href="${esc(root)}" target="_blank" rel="noopener" style="margin-right:auto">${icon('ext')}Open folder</a>` : ''}<button class="btn" data-close>Cancel</button>${admin ? '<button class="btn primary" id="dOk">Save</button>' : ''}</div>`, () => {
    const ok = $('#dOk');
    if (ok) ok.onclick = async () => {
      const v = $('#dRoot').value.trim();
      if (v && !/^https:\/\//.test(v)) return toast('Paste the full folder link (https://…)', 'x');
      closeModal();
      const r = await act(() => dl.updateSettings({ folderRoot: v }));
      if (r.ok) toast('Tenders folder saved', 'folder');
    };
  });
}

/* ---- notifications on this device ---- */
async function enablePushUI() {
  try {
    const r = await enablePush(dl);
    if (r === 'enabled') toast('Notifications are on for this device', 'bell');
    else if (r === 'denied') toast('Notifications are blocked in this browser', 'x');
    else toast('This browser cannot send notifications', 'x');
  } catch (err) {
    toast(esc(err.message || 'Could not turn on notifications'), 'x', 5000);
  }
  renderHeader();
}

/* ---- add engineer / add person ---- */
function addColumn() {
  const free = S.users.filter((u) => u.role === 'engineer' && !colOfUser(u.id));
  modal(`<h3>Add engineer</h3>
    ${free.length ? `<span class="lbl-sm">Team members without a column</span><div class="recips" style="margin-bottom:16px">${free.map((u) => `<button data-existing="${esc(u.id)}">${avatar(u, 'sm')}${esc(u.name)}</button>`).join('')}</div><span class="lbl-sm">Or add someone new</span>` : ''}
    ${personFormHTML('m')}
    <div class="acts"><button class="btn" data-close>Cancel</button><button class="btn primary" id="mOk">${icon('plus')}Add engineer</button></div>`, () => {
    $$('[data-existing]').forEach((b) => {
      b.onclick = async () => {
        closeModal();
        const r = await act(() => dl.setColumn(b.dataset.existing, true));
        if (r.ok) { $board().scrollLeft = $board().scrollWidth; toast(`Column added for <b>${esc(userById(b.dataset.existing).name)}</b>`); }
      };
    });
    $('#mOk').onclick = async () => {
      if (await submitPerson('m')) { closeModal(); $board().scrollLeft = $board().scrollWidth; }
    };
  });
}

/* ---- "Me" menu ---- */
function bindMeMenu() {
  $('#meBtn').onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const items = [['My profile', 'user', () => editProfile(me().id)]];
    if (isAdmin()) items.push(['Team', 'users', () => sheet('teamSheet')]);
    if (S.mode === 'supabase' && pushSupported()) items.push(['Turn on notifications on this device', 'bell', () => enablePushUI()]);
    if (S.mode === 'supabase') items.push(['Sign out', 'left', async () => { await dl.signOut(); location.reload(); }]);
    menu(r.right - 240, r.bottom + 8, items);
    $('#menu').style.minWidth = '240px';
  };
}

/* ---------------- static bindings & boot ---------------- */
function bindStatic() {
  bindBoardDrag();
  bindBoardClicks();
  bindSearch();
  bindMeMenu();
  $('#mailBtn').onclick = () => sheet('mailSheet');
  $('#remBtn').onclick = () => sheet('remSheet');
  $('#teamBtn').onclick = () => sheet('teamSheet');
  $('#driveBtn').onclick = folderSettings;
  $('#syncBtn').onclick = () => syncMail();
  $('#newBtn').onclick = () => newProject(null);
  $('#resetBtn').onclick = async () => {
    if (!confirm('Reset the board to the demo data?')) return;
    const r = await act(() => dl.resetDemo());
    if (r.ok) toast('Demo data restored');
  };
  $('#scrim').onclick = () => {
    if ($('#modal').classList.contains('show')) return closeModal();
    if ($('.sheet.show')) return sheet(null);
    closePage();
  };
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if ($('#modal').classList.contains('show')) return closeModal();
    if ($('.sheet.show')) return sheet(null);
    if (cur) closePage();
  });
  document.addEventListener('focusout', () => {
    setTimeout(() => { if (pendingRepaint && !isEditing($('#page')) && !isEditing(openSheetEl())) { pendingRepaint = false; repaintOverlays(); } }, 0);
  }, true);
  window.addEventListener('hashchange', route);
  window.addEventListener('resize', moveInk);
}

/** Loads the board and starts the UI. Resolves false when the signed-in email is not on the team. */
export async function startApp(layer) {
  dl = layer;
  S = await dl.loadBoard();
  derive();
  if (!S.me) return false;
  if (!bound) {
    bound = true;
    bindStatic();
    dl.subscribe((evt) => {
      if (evt.type === 'FIRED' && evt.record) notify(evt.record.title, evt.record.body);
      scheduleRefresh();
    });
    setInterval(() => { if (S) updateSyncMeta(); }, 30000);
    setInterval(() => {
      // Demo mode has no cron: read the demo mailbox hourly while the page is open.
      if (S && S.mode === 'mock' && S.mail.hourly && S.mail.address && (!S.mail.lastSync || Date.now() - S.mail.lastSync >= HOUR)) syncMail();
    }, 60000);
  }
  renderBoard();
  route();
  return true;
}
