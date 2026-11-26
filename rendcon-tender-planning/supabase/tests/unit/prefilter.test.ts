import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { prefilter } from '../../functions/_shared/prefilter.ts';
import { normalizeGraphMessage } from '../../functions/_shared/mail_normalize.ts';
import type { Folder, MailMessage } from '../../functions/_shared/types.ts';

const NOT_SKIPPED = { skip: false, reason: null };

function msg(over: Partial<MailMessage>): MailMessage {
  return {
    id: 'x', conversationId: null, folder: 'inbox', subject: 'ورد الينا – مناقصة عامة: إنشاء مبنى',
    from: { name: 'Buyer', address: 'buyer@client.example' }, to: [], cc: [], date: '2026-11-25T08:00:00Z',
    bodyText: 'ورد الينا طلب تسعير', bodyHtml: null, webLink: null, headers: {},
    isMeetingMessage: false, hasAttachments: false, ...over,
  };
}

const fixture = (name: string): any =>
  JSON.parse(readFileSync(new URL(`../fixtures/emails/${name}.json`, import.meta.url), 'utf8'));

test('fixture 06 (newsletter with List-Unsubscribe) is skipped as bulk_header', () => {
  const f = fixture('06-newsletter');
  const m = normalizeGraphMessage(f.raw, 'inbox')!;
  assert.deepEqual(prefilter(m), { skip: true, reason: 'bulk_header' });
});

test('fixtures 01-05, 07, 08 are not skipped', () => {
  for (const name of ['01-new-tender', '02-postponed', '03-queries-answers', '04-queries-sent', '05-offer-submitted', '07-ambiguous-roads', '08-injection']) {
    const f = fixture(name);
    const m = normalizeGraphMessage(f.raw, f.folder as Folder)!;
    assert.deepEqual(prefilter(m), NOT_SKIPPED, name);
  }
});

test('auto replies by subject (English and Arabic, normalised)', () => {
  assert.deepEqual(prefilter(msg({ subject: 'Automatic reply: Out of office' })), { skip: true, reason: 'auto_reply' });
  assert.deepEqual(prefilter(msg({ subject: 'رد تلقائي: خارج المكتب' })), { skip: true, reason: 'auto_reply' });
  assert.deepEqual(prefilter(msg({ subject: 'Undeliverable: offer', folder: 'sent' })), { skip: true, reason: 'auto_reply' });
});

test('auto replies by header', () => {
  assert.deepEqual(
    prefilter(msg({ headers: { 'auto-submitted': 'auto-replied' } })),
    { skip: true, reason: 'auto_reply' },
  );
  assert.deepEqual(prefilter(msg({ headers: { 'auto-submitted': 'no' } })), NOT_SKIPPED);
  assert.deepEqual(prefilter(msg({ headers: { 'x-autoreply': 'yes' } })), { skip: true, reason: 'auto_reply' });
});

test('meeting responses', () => {
  assert.deepEqual(prefilter(msg({ subject: 'Accepted: Site visit' })), { skip: true, reason: 'meeting' });
  assert.deepEqual(prefilter(msg({ subject: 'Cancelled: kickoff' })), { skip: true, reason: 'meeting' });
  assert.deepEqual(prefilter(msg({ isMeetingMessage: true })), { skip: true, reason: 'meeting' });
});

test('system senders are skipped in the inbox only', () => {
  const from = { name: null, address: 'no-reply@portal.example' };
  assert.deepEqual(prefilter(msg({ from })), { skip: true, reason: 'system_sender' });
  assert.deepEqual(prefilter(msg({ from: { name: null, address: 'Mailer-Daemon@x.example' } })), { skip: true, reason: 'system_sender' });
  assert.deepEqual(prefilter(msg({ from, folder: 'sent' })), NOT_SKIPPED);
});

test('a newsletter-like body that mentions a tender is not skipped, in either folder', () => {
  const body = 'النشره الشهريه: اعلان عن مناقصه جديده للطرق. unsubscribe link below';
  const subject = 'Monthly newsletter';
  assert.deepEqual(prefilter(msg({ subject, bodyText: body, from: { name: null, address: 'hello@shop.example' } })), NOT_SKIPPED);
  assert.deepEqual(
    prefilter(msg({ subject, bodyText: body, folder: 'sent', from: { name: null, address: 'hello@shop.example' } })),
    NOT_SKIPPED,
  );
});

test('a plain newsletter with no tender words is skipped as newsletter', () => {
  assert.deepEqual(
    prefilter(msg({ subject: 'Our webinar on steel', bodyText: 'Join us. Unsubscribe anytime.', from: { name: null, address: 'hello@shop.example' } })),
    { skip: true, reason: 'newsletter' },
  );
});

test('bulk headers apply to the inbox only', () => {
  assert.deepEqual(prefilter(msg({ headers: { precedence: 'bulk' } })), { skip: true, reason: 'bulk_header' });
  assert.deepEqual(prefilter(msg({ headers: { 'list-id': '<x>' } })), { skip: true, reason: 'bulk_header' });
  assert.deepEqual(prefilter(msg({ folder: 'sent', headers: { precedence: 'bulk' } })), NOT_SKIPPED);
});

import { createPrefilter, isAlwaysReadSender, parseSenderList } from '../../functions/_shared/prefilter.ts';

test('always-read senders: domains, subdomains and full addresses', () => {
  const list = ['redconcon.com', 'boss@partner.example'];
  assert.equal(isAlwaysReadSender('ali@redconcon.com', list), true);
  assert.equal(isAlwaysReadSender('ali@mail.redconcon.com', list), true);
  assert.equal(isAlwaysReadSender('ali@notredconcon.com', list), false);
  assert.equal(isAlwaysReadSender('boss@partner.example', list), true);
  assert.equal(isAlwaysReadSender('other@partner.example', list), false);
  assert.equal(isAlwaysReadSender('x@moh.gov.sa', list), false);
  assert.equal(isAlwaysReadSender(null, list), false);
  assert.deepEqual(parseSenderList(undefined), ['redconcon.com']);
  assert.deepEqual(parseSenderList('  '), ['redconcon.com']);
  assert.deepEqual(parseSenderList(' @RedconCon.com, Ali@x.org;bad'), ['redconcon.com', 'ali@x.org']);
});

test('always-read inbox mail is never skipped except auto-replies', () => {
  const pf = createPrefilter();
  const team = (over: Partial<MailMessage>) => msg({ from: { name: null, address: 'no-reply@redconcon.com' }, ...over });
  assert.deepEqual(pf(team({ headers: { 'list-unsubscribe': '<x>' } })), NOT_SKIPPED);
  assert.deepEqual(pf(team({ subject: 'Newsletter', bodyText: 'unsubscribe' })), NOT_SKIPPED);
  assert.deepEqual(pf(team({ isMeetingMessage: true })), NOT_SKIPPED);
  assert.deepEqual(pf(team({ subject: 'Out of office' })), { skip: true, reason: 'auto_reply' });
  // other senders keep the normal rules
  assert.deepEqual(pf(msg({ from: { name: null, address: 'no-reply@etenders.gov.eg' } })), { skip: true, reason: 'system_sender' });
});
