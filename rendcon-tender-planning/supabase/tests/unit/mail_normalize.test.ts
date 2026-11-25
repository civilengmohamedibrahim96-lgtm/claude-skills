import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { htmlToText, extractUrls, normalizeGraphMessage } from '../../functions/_shared/mail_normalize.ts';

const fixture = (name: string): any =>
  JSON.parse(readFileSync(new URL(`../fixtures/emails/${name}.json`, import.meta.url), 'utf8'));

test('htmlToText keeps the deadline on its own line and strips tags', () => {
  const f = fixture('01-new-tender');
  const text = htmlToText(f.raw.body.content);
  assert.ok(text.split('\n').includes('آخر موعد للتقديم: ٢٠/١٢/٢٠٢٦'), text);
  assert.ok(!text.includes('<'), text);
  assert.ok(text.includes('إدارة المشتريات') === false); // from-name is not in the body
  assert.ok(text.includes('السادة / إدارة المناقصات'));
});

test('htmlToText converts anchors: TEXT (URL) unless TEXT already is the URL', () => {
  assert.equal(
    htmlToText("<p>ملف: <a href='https://a.example/x.pdf'>ملف الردود</a></p>"),
    'ملف: ملف الردود (https://a.example/x.pdf)',
  );
  assert.equal(
    htmlToText("<a href='https://a.example/y'>https://a.example/y</a>"),
    'https://a.example/y',
  );
});

test('htmlToText removes script, style and head, decodes entities once', () => {
  const text = htmlToText('<head><title>t</title></head><style>p{}</style><script>alert(1)</script><p>A &amp;lt; B&nbsp;&#39;C&#x41;</p>');
  assert.equal(text, "A &lt; B 'CA");
});

test('htmlToText collapses blank lines and spaces', () => {
  assert.equal(htmlToText('<p>a</p><p></p><p></p><p></p><p>b   c</p>'), 'a\n\nb c');
});

test('extractUrls finds both links of fixture 03 (one only in href) without trailing punctuation', () => {
  const f = fixture('03-queries-answers');
  const text = htmlToText(f.raw.body.content);
  const urls = extractUrls(text, f.raw.body.content);
  assert.deepEqual(urls, [
    'https://tenders.example/electrical-admin/answers.pdf',
    'https://tenders.example/electrical-admin/addendum-2.xlsx',
  ]);
});

test('extractUrls strips trailing punctuation and de-duplicates', () => {
  assert.deepEqual(
    extractUrls('see https://a.example/x.pdf. and https://a.example/x.pdf, (https://b.example/y)', null),
    ['https://a.example/x.pdf', 'https://b.example/y'],
  );
});

test('extractUrls reads href attributes from html', () => {
  assert.deepEqual(
    extractUrls('no links here', `<a href="https://c.example/z?a=1&amp;b=2">z</a>`),
    ['https://c.example/z?a=1&b=2'],
  );
});

test('normalizeGraphMessage on fixture 01 (html inbox)', () => {
  const f = fixture('01-new-tender');
  const m = normalizeGraphMessage(f.raw, 'inbox')!;
  assert.equal(m.id, 'AAMk-01-new-tender');
  assert.equal(m.folder, 'inbox');
  assert.equal(m.date, '2026-11-25T07:12:00Z');
  assert.equal(m.from?.address, 'procurement@nuca.example');
  assert.equal(m.from?.name, 'إدارة المشتريات');
  assert.deepEqual(m.to, ['tenders@redcon.example']);
  assert.ok(m.bodyHtml?.includes('<p>'));
  assert.ok(m.bodyText.includes('آخر موعد للتقديم: ٢٠/١٢/٢٠٢٦'));
  assert.equal(m.hasAttachments, false);
  assert.equal(m.isMeetingMessage, false);
});

test('normalizeGraphMessage on fixture 02 (plain text with cc)', () => {
  const f = fixture('02-postponed');
  const m = normalizeGraphMessage(f.raw, 'inbox')!;
  assert.equal(m.bodyHtml, null);
  assert.deepEqual(m.cc, ['planning@redcon.example']);
  assert.ok(m.bodyText.startsWith('السادة / شركة ريدكون للمقاولات'));
  assert.equal(m.hasAttachments, true);
});

test('normalizeGraphMessage on fixture 04 (sent) takes sentDateTime', () => {
  const f = fixture('04-queries-sent');
  const m = normalizeGraphMessage(f.raw, 'sent')!;
  assert.equal(m.folder, 'sent');
  assert.equal(m.date, '2026-11-24T13:40:00Z');
  assert.equal(m.from?.address, 'tenders@redcon.example');
});

test('normalizeGraphMessage on fixture 06 lower-cases header names', () => {
  const f = fixture('06-newsletter');
  const m = normalizeGraphMessage(f.raw, 'inbox')!;
  assert.equal(m.headers['list-unsubscribe'], '<https://supplier.example/unsubscribe>');
  assert.equal(m.headers.precedence, 'bulk');
  assert.equal(Object.keys(m.headers).every((k) => k === k.toLowerCase()), true);
});

test('normalizeGraphMessage returns null for non-messages', () => {
  assert.equal(normalizeGraphMessage({}, 'inbox'), null);
  assert.equal(normalizeGraphMessage('x', 'inbox'), null);
  assert.equal(normalizeGraphMessage(null, 'inbox'), null);
});

test('normalizeGraphMessage detects meeting messages', () => {
  const m = normalizeGraphMessage({ id: 'm1', '@odata.type': '#microsoft.graph.eventMessageRequest' }, 'inbox')!;
  assert.equal(m.isMeetingMessage, true);
  const none = normalizeGraphMessage({ id: 'm2', meetingMessageType: 'none' }, 'inbox')!;
  assert.equal(none.isMeetingMessage, false);
});

test('normalizeGraphMessage falls back to bodyPreview and sender', () => {
  const m = normalizeGraphMessage({
    id: 'm3', sender: { emailAddress: { address: 'Boss@Example.COM' } },
    receivedDateTime: '2026-11-25T01:00:00Z', body: { contentType: 'text', content: '' }, bodyPreview: 'preview text',
  }, 'inbox')!;
  assert.equal(m.bodyText, 'preview text');
  assert.equal(m.from?.address, 'boss@example.com');
  assert.equal(m.bodyHtml, null);
});
