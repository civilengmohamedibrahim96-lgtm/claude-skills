// Prototype demo data (index.html seed()), in the data-layer shape of contract.js.
// The mock layer keeps this internal state; loadBoard() projects it to a BoardState.
import { isoIn, HOUR } from '../lib/util.js';

const SHAREPOINT = 'https://redcon.sharepoint.com/sites/Tenders/Shared%20Documents/Tenders';
let seq = 0;
const uid = (p = 'x') => `${p}${++seq}`;

/** Internal mock state. `now` is epoch ms. */
export function seedState(now = Date.now()) {
  seq = 0;
  const D = (days) => isoIn(days, new Date(now));
  const u0 = 'u0', u1 = 'u1', u2 = 'u2', u3 = 'u3';
  const P = (o) => Object.assign({
    id: uid('p'), columnId: null, pos: 0, tags: [], status: '', received: D(-3), due: D(14), folder: '',
    client: '', ref: '', type: 'public', supervisor: '', tender: null, dueHistory: [], updatedAt: now,
    updatedBy: 'Mohamed Ibrahim', mailSeen: 0, subtasks: [], links: [], comments: [], notifications: [],
    mailLog: [], source: 'manual', subOpen: true, sort: 0,
  }, o);
  const sub = (text, done, note, due) => ({ id: uid('s'), text, done, note, due });
  const link = (title, url) => ({ id: uid('l'), title, url, src: false });
  const com = (who, text, at, sys = false) => ({ id: uid('c'), who, text, at, sys });
  const ml = (at, kind, summary, subject, links) => ({ id: uid('m'), at, emailAt: at, kind, direction: 'received', summary, subject, links, webLink: '' });
  const rem = (o) => Object.assign({ id: uid('r'), fired: false, email: true }, o);
  const H = (n) => now - n * HOUR;

  return {
    meId: u0,
    users: [
      { id: u0, name: 'Mohamed Ibrahim', email: 'mohamed@redcon.example', role: 'admin', color: '#EE6A1F', status: 'active', prefs: { browser: true, email: true }, hasColumn: false, order: 0 },
      { id: u1, name: 'Eng. Ahmed Hassan', email: 'ahmed@redcon.example', role: 'engineer', color: '#111111', status: 'active', prefs: { browser: true, email: true }, hasColumn: true, order: 1 },
      { id: u2, name: 'Eng. Sara Mostafa', email: 'sara@redcon.example', role: 'engineer', color: '#2F7D7A', status: 'active', prefs: { browser: true, email: true }, hasColumn: true, order: 2 },
      { id: u3, name: 'Eng. Omar Khaled', email: 'omar@redcon.example', role: 'engineer', color: '#9C4A12', status: 'active', prefs: { browser: true, email: true }, hasColumn: true, order: 3 },
    ],
    tenderTeam: [
      { id: 'tm1', name: 'Eng. Mina', ar: 'مينا', type: 'private', sort: 1 },
      { id: 'tm2', name: 'Eng. Merihan', ar: 'ميريهان', type: 'private', sort: 2 },
      { id: 'tm3', name: 'Eng. Mohamed Mustafa', ar: 'محمد مصطفى', type: 'public', sort: 3 },
      { id: 'tm4', name: 'Eng. Shreine', ar: 'شيرين', type: 'public', sort: 4 },
    ],
    tags: [
      { id: 'new', name: 'New project', color: '#EE6A1F', sort: 1 },
      { id: 'upd', name: 'New updates', color: '#B8860B', sort: 2 },
      { id: 'qa', name: 'Queries answers', color: '#2F7D7A', sort: 3 },
      { id: 'pp', name: 'Postponed', color: '#8A8A85', sort: 4 },
      { id: 'un', name: 'Unassigned', color: '#111111', sort: 5 },
      { id: 'urgent', name: 'Urgent', color: '#C8321E', sort: 6 },
      { id: 'sub', name: 'Submitted', color: '#2E7D4F', sort: 7 },
    ],
    reminders: [rem({ id: uid('r'), at: now + 26 * HOUR, msg: 'Weekly tender review meeting', repeat: 'weekly', to: ['all'], projectId: null })],
    sentLog: [],
    mail: { address: 'tenders@redcon.example', subject: 'ورد الينا', hourly: true, lastSync: now - 38 * 60000, runs: [], log: [], reviews: [], processed: [] },
    folders: { root: SHAREPOINT },
    projects: [
      P({
        id: 'p1', title: 'توريد وتركيب أعمال الكهرباء – مبنى الإدارة', client: 'Ministry of Housing', type: 'public', tender: 'tm3',
        mailSeen: H(30), mailLog: [
          ml(H(26), 'update', 'Annex 1 issued · submission date 22 Nov → 29 Nov 2026', 'ورد الينا – ملحق رقم 1: توريد وتركيب أعمال الكهرباء – مبنى الإدارة', 1),
          ml(H(4 * 24), 'new_project', 'New tender received · submission 22 Nov 2026', 'ورد الينا – مناقصة عامة: توريد وتركيب أعمال الكهرباء – مبنى الإدارة', 1),
        ],
        tags: ['upd'], columnId: u2, pos: 0, status: 'Pricing MEP BOQ – waiting on lighting supplier quote', due: D(5),
        folder: `${SHAREPOINT}/Electrical-Admin-Building`,
        dueHistory: [{ from: D(-2), to: D(5), by: 'email', at: H(26) }],
        updatedAt: H(2 / 3), updatedBy: 'email',
        subtasks: [sub('Review specs & drawings', true, '', ''), sub('Request supplier quotes', true, '3 suppliers contacted', ''), sub('Price lighting package', false, '', D(2)), sub('Final BOQ sign-off', false, '', D(4))],
        links: [link('Tender portal', 'https://tenders.example/electrical-admin')],
        comments: [com('Eng. Sara Mostafa', 'Lighting quote expected Thursday.', H(26))],
        notifications: [rem({ id: uid('r'), at: now + 20 * HOUR, msg: 'Chase lighting supplier quote', repeat: 'none', to: ['assignee', u0], projectId: 'p1' })],
      }),
      P({
        id: 'p2', title: 'إنشاء خزان مياه أرضي سعة 5000 م³', client: 'Water Authority', type: 'public', tender: 'tm4',
        mailSeen: now, mailLog: [ml(H(6 * 24), 'new_project', 'New tender received · submission 03 Dec 2026', 'ورد الينا – إنشاء خزان مياه أرضي سعة 5000 م³', 0)],
        tags: ['new'], columnId: u1, pos: 0, status: 'Site visit done – structural take-off in progress', due: D(9),
        folder: `${SHAREPOINT}/Water-Tank-5000`, updatedAt: H(3), updatedBy: 'Eng. Ahmed Hassan',
        subtasks: [sub('Site visit', true, '', ''), sub('Structural take-off', false, '', D(3)), sub('Send queries to client', true, 'Sent 12 queries', '')],
      }),
      P({
        id: 'p3', title: 'Rehabilitation of Internal Roads – Phase 2', client: 'New Cities Authority', type: 'public', tender: 'tm3',
        mailSeen: now, mailLog: [ml(H(50), 'postponed', 'Submission postponed · 28 Nov → 24 Dec 2026', 'تأجيل موعد تقديم العطاءات – إعادة تأهيل الطرق الداخلية – المرحلة الثانية', 1)],
        tags: ['pp'], columnId: u3, pos: 0, status: 'Postponed by client – new date to be announced', due: D(30),
        dueHistory: [{ from: D(4), to: D(30), by: 'email', at: H(50) }], updatedAt: H(50), updatedBy: 'email',
        links: [link('Postponement notice', 'https://tenders.example/roads-phase-2/notice')],
      }),
      P({
        id: 'p4', title: 'Fire fighting system – Logistics Hub', client: 'Port Logistics Co.', type: 'private', tender: 'tm1',
        tags: ['new', 'urgent'], columnId: u2, pos: 1, status: 'Hydraulic calc pending', due: D(2),
        updatedAt: now - 20 * 60000, updatedBy: 'Eng. Sara Mostafa',
        subtasks: [sub('Hydraulic calculation', false, '', D(1)), sub('Pump room pricing', false, '', D(2))],
      }),
      P({
        id: 'p5', title: 'صيانة شبكات الصرف الصحي – الحي الثالث', client: 'Municipality', type: 'public', tender: 'tm4',
        mailLog: [ml(H(5), 'new_project', 'New tender received · submission 06 Dec 2026', 'ورد الينا – صيانة شبكات الصرف الصحي – الحي الثالث', 0)],
        tags: ['new', 'un'], status: 'Received by email – needs an engineer', source: 'email', due: D(12), updatedAt: H(5), updatedBy: 'email',
      }),
      P({
        id: 'p6', title: 'Steel shed – Industrial Zone plot 14', client: 'Private client', type: 'private', tender: 'tm2',
        tags: ['un'], status: '', due: D(18), updatedAt: H(26), updatedBy: 'Mohamed Ibrahim',
      }),
      P({
        id: 'p7', title: 'Boundary wall & gatehouse', client: 'Education Directorate', type: 'public', tender: 'tm3',
        tags: ['sub'], columnId: u1, pos: 1, status: 'Submitted – awaiting opening', due: D(-1), updatedAt: H(30), updatedBy: 'Eng. Ahmed Hassan',
      }),
    ],
  };
}
