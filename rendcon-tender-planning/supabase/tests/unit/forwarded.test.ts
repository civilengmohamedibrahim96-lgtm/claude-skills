import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSupervisor, focusBody, focusMessage, projectNameHint } from '../../functions/_shared/forwarded.ts';
import type { MailMessage } from '../../functions/_shared/types.ts';

const FORWARD = [
  'Mohamed Abdo',
  'Tendering Engineer',
  '',
  '________________________________',
  'From: Public Sector Tendering DC <public.sector@redconcon.com>',
  'Sent: Sunday, July 12, 2026 10:00 AM',
  'To: Shereen Mahmoud El-Akkad <s.akkad@redconcon.com>; Ahmed Ali <a.ali@redconcon.com>;',
  ' Hany Fawzy <h.fawzy@redconcon.com>',
  'Cc: Public Sector <public.sector@redconcon.com>',
  'Subject: New Tender Notification - Zomra East Project (Z) PK 20',
  '',
  'ورد الينا مناقصه جديده – Zomra East Project (Z) PK 20',
  'المالك : هيئة المجتمعات العمرانية',
  'والمشرف علي الدراسة',
  '',
  'م. محمد مصطفي',
  'موعد تسليم العطاء : 9– 08– 2026',
  '',
  '________________________________',
  'From: Public Sector Tendering DC <public.sector@redconcon.com>',
  'Sent: Monday, June 1, 2026 9:00 AM',
  'To: Shereen Mahmoud El-Akkad <s.akkad@redconcon.com>',
  'Subject: New Tender Notification - Sharm El Sheikh Cruise Terminal Project',
  '',
  'ورد الينا مناقصه جديده – Sharm El Sheikh Cruise Terminal Project',
  'والمشرف علي الدراسة : م/ شيرين محمود',
].join('\r\n');

function msg(over: Partial<MailMessage>): MailMessage {
  return {
    id: 'x', conversationId: null, folder: 'inbox', subject: 'FW: New Tender Notification - Zomra East Project (Z) PK 20',
    from: { name: 'Mohamed Abdo', address: 'me@gmail.com' }, to: [], cc: [], date: '2026-07-12T08:00:00Z',
    bodyText: FORWARD, bodyHtml: null, webLink: null, headers: {},
    isMeetingMessage: false, hasAttachments: false, ...over,
  };
}

test('focusBody keeps only the forwarded original, without To/Cc or older quotes', () => {
  const f = focusBody(msg({}))!;
  assert.equal(f.subject, 'New Tender Notification - Zomra East Project (Z) PK 20');
  assert.match(f.from!, /public\.sector@redconcon\.com/);
  assert.match(f.body, /Zomra East/);
  assert.doesNotMatch(f.body, /Shereen|Sharm|شيرين|Tendering Engineer/);
});

test('focusBody keeps the trailing Links block', () => {
  const f = focusBody(msg({ bodyText: `${FORWARD}\n\nLinks:\nhttps://redcon.sharepoint.com/x` }))!;
  assert.match(f.body, /Links:\nhttps:\/\/redcon\.sharepoint\.com\/x$/);
});

test('a non-forward drops the older quoted email below it', () => {
  const body = 'Please see the addendum.\n\nFrom: Client <c@client.example>\nSent: x\nSubject: Old project\n\nold text';
  const m = focusMessage(msg({ subject: 'Addendum', bodyText: body }));
  assert.equal(m.bodyText, 'Please see the addendum.');
  assert.equal(m.subject, 'Addendum');
});

test('a message without header blocks is unchanged', () => {
  const m = msg({ subject: 'Hello', bodyText: 'ورد الينا مناقصه جديده – مبنى' });
  assert.equal(focusMessage(m), m);
});

test('extractSupervisor takes the first engineer after المشرف علي الدراسة', () => {
  assert.equal(extractSupervisor(FORWARD), 'محمد');
  assert.equal(extractSupervisor('والمشرف على الدراسه : م/ كريم سامي'), 'كريم');
  assert.equal(extractSupervisor('والمشرف علي الدراسة م محمود حسن'), 'محمود');
  assert.equal(extractSupervisor('والمشرف علي الدراسة : Eng. Hany Fawzy'), 'Hany');
  assert.equal(extractSupervisor('no supervisor here'), null);
});

test('projectNameHint reads the name at the top', () => {
  assert.equal(projectNameHint({ subject: 'New Tender Notification - Zomra East Project (Z) PK 20', bodyText: '' }),
    'Zomra East Project (Z) PK 20');
  assert.equal(projectNameHint({ subject: 'New Addendum - Sharm El Sheikh Cruise Terminal', bodyText: '' }),
    'Sharm El Sheikh Cruise Terminal');
  assert.equal(projectNameHint({ subject: 'تحديث', bodyText: 'ورد إلينا Addendum خاص بمشروع .Sharm El Sheikh Cruise Terminal Project' }),
    'Sharm El Sheikh Cruise Terminal Project');
});

import { compareNames } from '../../functions/_shared/forwarded.ts';
test('compareNames', () => {
  assert.equal(compareNames('Jirian - Island B Villas Construction Package', 'Jirian – Island B Villas Construction Package'), 'same');
  assert.equal(compareNames('Jirian - Island B Villas Construction Package', 'Jirian - Island B Fully finished Villas Construction Package 2'), 'differs');
  assert.equal(compareNames('Metal Cans Plant Project', 'Metal Cans Plant'), 'same');
  assert.equal(compareNames('El Ayat 28,000 Feddans – Integrated Infrastructure Development Project', 'El Ayat Infrastructure'), 'fits');
  assert.equal(compareNames('Metal Cans Plant Project', 'مصنع العلب المعدنية'), 'unrelated');
});

test('a forward of a forward uses the first block with text', () => {
  const body = [
    'sig', '', 'From: Public Sector Tendering DC <public.sector@redconcon.com>', 'Sent: x', 'To: me',
    'Subject: Fw: New Tender Notification - Metal Cans Plant Project', '', '', 'Sent from Outlook for Android<https://aka.ms/x>',
    '________________________________', 'From: Public Sector Tendering DC <public.sector@redconcon.com>', 'Sent: y',
    'To: Shereen <s@redconcon.com>', 'Subject: New Tender Notification - Metal Cans Plant Project', '',
    'ورد الينا مناقصه جديده – Metal Cans Plant Project', 'والمشرف علي الدراسة', '', 'م. شيرين العقاد', 'موعد تسليم العطاء : 20– 12– 2026',
  ].join('\r\n');
  const f = focusBody({ subject: 'FW: New Tender Notification  - Metal Cans Plant Project', bodyText: body })!;
  assert.equal(f.subject, 'New Tender Notification - Metal Cans Plant Project');
  assert.match(f.body, /20– 12– 2026/);
  assert.equal(extractSupervisor(f.body), 'شيرين');
});
