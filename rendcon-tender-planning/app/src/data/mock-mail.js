// Demo mailbox + the prototype's email rules, applied to the mock state.
// Same rules as the real integration: "ورد الينا" = new tender (or update when the
// project already exists), تأجيل = postponed, استفسار = queries answers.
import { HOUR, norm, digits, firstName } from '../lib/util.js';
import { OUTCOME_LABELS } from './contract.js';

export const MOCK_MAILBOX = [
  { id: 'm1', from: 'procurement@nca.example', subject: 'ورد الينا – مناقصة عامة: إنشاء مبنى إداري بالمنطقة الصناعية', received: -50,
    body: 'السادة / إدارة المناقصات\nورد الينا طلب تسعير للمشروع التالي:\nاسم المشروع: إنشاء مبنى إداري بالمنطقة الصناعية\nنوع المناقصة: عامة\nوالمشرف علي الدراسه : م/ شيرين محمود\nالجهة المالكة: هيئة المجتمعات العمرانية\nآخر موعد للتقديم: ٢٠٢٦-١٢-٢٠\nرابط كراسة الشروط: https://tenders.example/admin-building/specs.pdf\nوتفضلوا بقبول فائق الاحترام' },
  { id: 'm2', from: 'tenders@moh.example', subject: 'تأجيل موعد تقديم العطاءات – توريد وتركيب أعمال الكهرباء – مبنى الإدارة', received: -44,
    body: 'نحيطكم علماً بأنه تم تأجيل موعد تقديم العطاءات لمشروع: توريد وتركيب أعمال الكهرباء – مبنى الإدارة ليصبح 2027-01-10 بدلاً من الموعد السابق.\nالإخطار الرسمي: https://tenders.example/electrical-admin/postponement' },
  { id: 'm3', from: 'wa-procurement@water.example', subject: 'الرد على الاستفسارات – إنشاء خزان مياه أرضي سعة 5000 م³', received: -31,
    body: 'مرفق لسيادتكم الرد على استفسارات السادة المتقدمين لمشروع إنشاء خزان مياه أرضي سعة 5000 م³.\nملف الردود: https://tenders.example/water-tank/answers.pdf\nملحق رقم 1: https://tenders.example/water-tank/addendum-1.pdf' },
  { id: 'm4', from: 'newsletter@supplier.example', subject: 'النشرة الشهرية – عروض نوفمبر', received: -20,
    body: 'تعرف على أحدث عروضنا لمواد البناء لهذا الشهر.' },
  { id: 'm5', from: 'procurement@city.example', subject: 'ورد إلينا – ممارسة محدودة: تطوير شبكة الطرق الداخلية', received: -12,
    body: 'ورد إلينا من الجهة التالية دعوة لتقديم عطاء:\nاسم المشروع: تطوير شبكة الطرق الداخلية – المرحلة الثالثة\nنوع المناقصة: محدودة\nوالمشرف علي الدراسه : م/ مينا عادل\nالجهة المالكة: محافظة المدينة\nآخر موعد للتقديم: 28/12/2026\nالمستندات: https://tenders.example/roads-phase-3/docs' },
  { id: 'm6', from: 'procurement@nca.example', subject: 'ورد الينا – ملحق: إنشاء مبنى إداري بالمنطقة الصناعية', received: -5,
    body: 'ورد الينا ملحق جديد لمشروع إنشاء مبنى إداري بالمنطقة الصناعية يتضمن جداول كميات معدلة، وتم تعديل آخر موعد للتقديم ليصبح 2026-12-27.\nالملحق: https://tenders.example/admin-building/boq-rev1.xlsx' },
  { id: 'm7', from: 'municipality@city.example', subject: 'تأجيل موعد تقديم العطاءات – تطوير ميدان المحطة', received: -2,
    body: 'نحيطكم علماً بأنه تم تأجيل موعد تقديم العطاءات لمشروع تطوير ميدان المحطة ليصبح 2027-01-20.' },
];

export const newId = () => (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
  ? globalThis.crypto.randomUUID()
  : 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));

/** 'YYYY-MM-DD' of a timestamp in UTC (mock dates are day-based). */
export const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

export const PALETTE_USERS = ['#111111', '#EE6A1F', '#5B5B57', '#9C4A12', '#2F7D7A', '#B8860B'];

/** Adds a project at the top of its column (contract: new projects go on top). */
export function makeProject(state, o, now) {
  const col = o.columnId ?? null;
  state.projects.forEach((x) => { if ((x.columnId ?? null) === col) x.pos += 1; });
  const p = {
    id: newId(), title: o.title, client: o.client || '', ref: '', type: o.type || 'public', tender: o.tender ?? null,
    supervisor: '', columnId: col, pos: 0, status: o.status || '', received: isoDay(now), due: o.due || '',
    folder: '', source: o.source || 'manual', subOpen: true, updatedAt: now, updatedBy: o.updatedBy || 'email',
    mailSeen: 0, tags: o.tags || [], subtasks: [], links: [], comments: [], dueHistory: [], mailLog: [], notifications: [],
  };
  state.projects.push(p);
  return p;
}

export const field = (b, labels) => {
  for (const l of labels) {
    const m = b.match(new RegExp(l + '\\s*[:：]\\s*(.+)'));
    if (m) return m[1].trim();
  }
  return '';
};

export function findDate(s) {
  let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return '';
}

const words = (s) => norm(s).split(/[\s–\-:،,.()]+/).filter((w) => w.length > 2);

/** Exact project-name phrase first, then 75% of the name's words (as the prototype). */
export function findProject(state, txt) {
  let best = null, score = 0;
  for (const p of state.projects) {
    const t = norm(p.title);
    if (t.length > 6 && txt.includes(t)) { if (score < 2) { best = p; score = 2; } continue; }
    const w = words(p.title);
    if (!w.length) continue;
    const hit = w.filter((x) => txt.includes(x)).length / w.length;
    if (hit >= 0.75 && hit > score && score < 2) { best = p; score = hit; }
  }
  return best;
}

export function candidatesFor(state, txt) {
  return state.projects
    .map((p) => { const w = words(p.title); const hits = w.filter((x) => txt.includes(x)).length; return { pid: p.id, title: p.title, score: w.length ? hits / w.length : 0 }; })
    .filter((c) => c.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
}

export function parseMail(m) {
  const body = digits(m.body);
  const txt = norm(m.subject + '\n' + m.body);
  const urls = m.body.match(/https?:\/\/[^\s)،]+/g) || [];
  let kind = 'ignore';
  if (/تاجيل|مؤجل|موجل/.test(txt)) kind = 'postpone';
  else if (/استفسار/.test(txt)) kind = 'queries';
  else if (/ورد\s*الينا/.test(txt)) kind = 'new';
  const typeTxt = norm(field(body, ['نوع المناقصة', 'نوع الطرح']) || m.subject);
  const type = /محدود|خاص|ممارس/.test(typeTxt) ? 'private' : /عام/.test(typeTxt) ? 'public' : '';
  const dueField = field(body, ['[اأإآ]خر موعد للتقديم', 'موعد التقديم']);
  return {
    kind, urls, txt, type,
    supervisor: firstName(field(body, ['و?المشرف\\s+عل[يى]\\s+الدراس[ةه]'])),
    title: field(body, ['اسم المشروع']),
    client: field(body, ['الجهة المالكة', 'الجهة']),
    due: findDate(dueField || digits(m.subject + '\n' + m.body)),
  };
}

const MAIL_KIND = { new: 'new_project', upd: 'update', pp: 'postponed', qa: 'queries_answers' };
const SUMMARY = {
  new_project: (p) => `New tender received${p.due ? ' · submission ' + p.due : ''}`,
  update: () => 'Update / annex received',
  postponed: () => 'Submission postponed',
  queries_answers: () => 'Answers to queries received',
};

/** Sets the due date from an email and records it in the history (as the real rules do). */
export function setDueFromMail(state, p, due, now) {
  if (!due || due === p.due) return false;
  p.dueHistory.unshift({ from: p.due, to: due, by: 'email', at: now });
  p.due = due;
  p.updatedAt = now;
  p.updatedBy = 'email';
  return true;
}

function addMailLog(p, { kind, summary, subject, links, at }) {
  p.mailLog.unshift({ id: newId(), at, emailAt: at, kind, direction: 'received', summary, subject, links, webLink: '' });
}

function logRow(state, m, outcome, pid, label, at) {
  state.mail.log.unshift({ id: m.id, subject: m.subject, from: m.from, at, outcome, label: label || OUTCOME_LABELS[outcome], pid: pid || null });
  state.mail.processed.push(m.id);
}

/**
 * Reads every not-yet-processed mailbox message into the mock state.
 * Returns the contract counts {read, created, updated, review}.
 */
export function runMockSync(state, now) {
  const pending = MOCK_MAILBOX.filter((m) => !state.mail.processed.includes(m.id));
  const counts = { read: pending.length, created: 0, updated: 0, review: 0 };
  for (const m of pending) {
    const at = now + m.received * HOUR;
    const r = parseMail(m);
    const existing = findProject(state, r.txt);
    const short = (p) => (p.title.length > 38 ? p.title.slice(0, 36) + '…' : p.title);

    if (r.kind === 'new') {
      if (existing) {
        if (!existing.tags.includes('upd')) existing.tags.push('upd');
        existing.status = 'New update received by email';
        r.urls.forEach((u) => { if (!existing.links.some((l) => l.url === u)) existing.links.push({ id: newId(), title: u.split('/').pop() || 'Link', url: u, src: true }); });
        setDueFromMail(state, existing, r.due, at);
        existing.updatedAt = now; existing.updatedBy = 'email';
        existing.comments.push({ id: newId(), who: 'System', text: 'Email: ' + m.subject, at: now, sys: true });
        addMailLog(existing, { kind: 'update', summary: SUMMARY.update(), subject: m.subject, links: r.urls.length, at });
        applyTender(state, existing, r);
        counts.updated++;
        logRow(state, m, 'applied', existing.id, `${OUTCOME_LABELS.applied} → ${short(existing)}`, at);
      } else {
        const p = makeProject(state, {
          title: r.title || m.subject.replace(/ورد\s*[اإ]لينا\s*[–-]?\s*/, ''), client: r.client, type: r.type || 'public',
          due: r.due, tags: ['new', 'un'], status: 'Received by email – needs an engineer', source: 'email', updatedBy: 'email',
        }, now);
        r.urls.forEach((u) => p.links.push({ id: newId(), title: u.split('/').pop() || 'Link', url: u, src: true }));
        p.comments.push({ id: newId(), who: 'System', text: 'Created from email: ' + m.subject, at: now, sys: true });
        addMailLog(p, { kind: 'new_project', summary: SUMMARY.new_project(p), subject: m.subject, links: r.urls.length, at });
        counts.created++;
        logRow(state, m, 'applied', p.id, `${OUTCOME_LABELS.applied} → ${short(p)}`, at);
        applyTender(state, p, r);
        continue;
      }
    } else if (r.kind === 'postpone' || r.kind === 'queries') {
      if (existing) {
        const kind = r.kind === 'postpone' ? 'postponed' : 'queries_answers';
        if (kind === 'postponed') {
          if (!existing.tags.includes('pp')) existing.tags.push('pp');
          const nd = findDate(digits(m.body));
          setDueFromMail(state, existing, nd, at);
          existing.status = 'Postponed' + (nd ? ' to ' + nd : '');
        } else {
          if (!existing.tags.includes('qa')) existing.tags.push('qa');
          existing.status = 'Answers to queries received – review';
          setDueFromMail(state, existing, r.due, at);
        }
        r.urls.forEach((u) => { if (!existing.links.some((l) => l.url === u)) existing.links.push({ id: newId(), title: u.split('/').pop() || 'Link', url: u, src: true }); });
        existing.updatedAt = now; existing.updatedBy = 'email';
        existing.comments.push({ id: newId(), who: 'System', text: 'Email: ' + m.subject, at: now, sys: true });
        addMailLog(existing, { kind, summary: SUMMARY[kind === 'postponed' ? 'postponed' : 'queries_answers'](), subject: m.subject, links: r.urls.length, at });
        applyTender(state, existing, r);
        counts.updated++;
        const label = kind === 'postponed' ? `Postponed → ${short(existing)}` : `${OUTCOME_LABELS.applied} → ${short(existing)}`;
        logRow(state, m, 'applied', existing.id, label, at);
        continue;
      }
      counts.review++;
      const kind = r.kind === 'postpone' ? 'postponed' : 'queries_answers';
      state.mail.reviews.unshift({
        id: m.id, subject: m.subject, from: m.from, at, excerpt: m.body.slice(0, 300), summary: SUMMARY[kind](),
        kind, title: r.title || m.subject, reasons: ['update_without_project'], candidates: candidatesFor(state, r.txt), webLink: '',
      });
      logRow(state, m, 'review', null, undefined, at);
    } else {
      logRow(state, m, 'prefiltered', null, undefined, at);
    }
  }
  state.mail.log = state.mail.log.slice(0, 60);
  return counts;
}

/** Supervisor / tender-team rule from the prototype (applyMail). */
function applyTender(state, p, r) {
  if (r.supervisor) {
    p.supervisor = r.supervisor;
    let te = state.tenderTeam.find((t) => firstName(t.ar) === r.supervisor || norm(firstName(t.ar)) === norm(r.supervisor));
    if (!te) {
      te = { id: newId(), name: r.supervisor, ar: r.supervisor, type: r.type || p.type, sort: state.tenderTeam.length + 1 };
      state.tenderTeam.push(te);
    }
    p.tender = te.id; p.type = te.type;
  } else {
    const te = state.tenderTeam.find((t) => (t.ar && r.txt.includes(norm(t.ar))) || r.txt.includes(norm(t.name.replace(/^Eng\.?\s*/i, ''))));
    if (te && !p.tender) { p.tender = te.id; p.type = te.type; }
  }
}

/** Resolves a review item (assign / new / dismiss) in the mock state. */
export function applyReview(state, reviewId, res, now) {
  const item = state.mail.reviews.find((x) => x.id === reviewId);
  if (!item) throw new Error('That email is no longer waiting for review');
  const remove = () => { state.mail.reviews = state.mail.reviews.filter((x) => x.id !== reviewId); };
  if (res.action === 'dismiss') {
    remove();
    const row = state.mail.log.find((l) => l.id === reviewId);
    if (row) { row.outcome = 'ignored'; row.label = OUTCOME_LABELS.ignored; }
    return { projectId: null };
  }
  let p;
  if (res.action === 'assign') {
    p = state.projects.find((x) => x.id === res.projectId);
    if (!p) throw new Error('Project not found');
    const tag = item.kind === 'postponed' ? 'pp' : item.kind === 'queries_answers' ? 'qa' : 'upd';
    if (!p.tags.includes(tag)) p.tags.push(tag);
    const due = findDate(digits(item.excerpt));
    if (due) setDueFromMail(state, p, due, now);
    p.status = item.kind === 'postponed' ? 'Postponed' : 'Answers to queries received – review';
    addMailLog(p, { kind: item.kind, summary: item.summary, subject: item.subject, links: 0, at: item.at });
    p.updatedAt = now; p.updatedBy = 'email';
  } else if (res.action === 'new') {
    p = makeProject(state, { title: item.title, tags: ['new', 'un'], status: 'Received by email – needs an engineer', source: 'email', updatedBy: 'email' }, now);
    p.comments.push({ id: newId(), who: 'System', text: 'Created from email: ' + item.subject, at: now, sys: true });
    addMailLog(p, { kind: 'new_project', summary: 'New tender received', subject: item.subject, links: 0, at: item.at });
  } else {
    throw new Error('Unknown review action');
  }
  remove();
  const row = state.mail.log.find((l) => l.id === reviewId);
  if (row) { row.outcome = 'applied'; row.pid = p.id; row.label = `${OUTCOME_LABELS.applied} → ${p.title.length > 38 ? p.title.slice(0, 36) + '…' : p.title}`; }
  return { projectId: p.id };
}

