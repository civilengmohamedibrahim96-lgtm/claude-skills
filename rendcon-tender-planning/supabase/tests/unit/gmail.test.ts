import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { composioConfigFromEnv, createComposioMailClient } from '../../functions/_shared/composio.ts';
import {
  decodeBase64Url,
  normalizeGmailMessage,
  normalizerFor,
  normalizeGraphMessage,
  parseAddress,
  parseAddressList,
} from '../../functions/_shared/mail_normalize.ts';
import type { HttpRequest, HttpResponse, HttpTransport } from '../../functions/_shared/types.ts';

const ENV = { COMPOSIO_API_KEY: 'k', COMPOSIO_CONNECTED_ACCOUNT_ID: 'ca_1', COMPOSIO_PROVIDER: 'gmail' };

const b64url = (s: string) => Buffer.from(s, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function transportOf(responses: HttpResponse[]) {
  const requests: HttpRequest[] = [];
  let i = 0;
  const transport: HttpTransport = async (req) => {
    requests.push(req);
    return responses[Math.min(i++, responses.length - 1)];
  };
  return { transport, requests };
}

const msg = (id: string, ts: string) => ({ messageId: id, messageTimestamp: ts });
const page = (messages: unknown[], nextPageToken = '') => ({ status: 200, json: { successful: true, data: { messages, nextPageToken, resultSizeEstimate: 0 } } });

describe('gmail config', () => {
  test('provider gmail switches default slugs', () => {
    const cfg = composioConfigFromEnv(ENV);
    assert.equal(cfg.provider, 'gmail');
    assert.deepEqual(cfg.slugs, {
      listInbox: 'GMAIL_FETCH_EMAILS',
      listSent: 'GMAIL_FETCH_EMAILS',
      getMessage: 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID',
      sendMail: 'GMAIL_SEND_EMAIL',
    });
  });
  test('default provider stays outlook', () => {
    assert.equal(composioConfigFromEnv({ COMPOSIO_API_KEY: 'k', COMPOSIO_CONNECTED_ACCOUNT_ID: 'c' }).provider, 'outlook');
  });
  test('unknown provider throws', () => {
    assert.throws(() => composioConfigFromEnv({ ...ENV, COMPOSIO_PROVIDER: 'yahoo' }), /COMPOSIO_PROVIDER/);
  });
});

describe('gmail client', () => {
  test('list builds a Gmail query, follows page tokens and returns oldest first', async () => {
    const { transport, requests } = transportOf([
      page([msg('c', '2026-11-26T08:00:00Z'), msg('b', '2026-11-26T07:00:00Z')], 'tok2'),
      page([msg('a', '2026-11-26T06:00:00Z')]),
    ]);
    const items = await createComposioMailClient(composioConfigFromEnv(ENV), transport)
      .listMessages('inbox', '2026-11-26T05:00:00Z', 60) as any[];
    assert.deepEqual(items.map((m) => m.messageId), ['a', 'b', 'c']);
    assert.equal(requests.length, 2);
    const first = JSON.parse(requests[0].body ?? '').arguments;
    assert.equal(first.query, `in:inbox after:${Date.parse('2026-11-26T05:00:00Z') / 1000}`);
    assert.equal(first.include_payload, true);
    assert.equal(first.page_token, undefined);
    assert.equal(JSON.parse(requests[1].body ?? '').arguments.page_token, 'tok2');
    assert.ok(requests[0].url.endsWith('/GMAIL_FETCH_EMAILS'));
  });

  test('sent folder uses in:sent, drops older-than-since, caps to the oldest max', async () => {
    const { transport, requests } = transportOf([
      page([msg('n', '2026-11-26T09:00:00Z'), msg('m', '2026-11-26T08:00:00Z'), msg('old', '2026-11-25T00:00:00Z')]),
    ]);
    const items = await createComposioMailClient(composioConfigFromEnv(ENV), transport)
      .listMessages('sent', '2026-11-26T05:00:00Z', 1) as any[];
    assert.deepEqual(items.map((m) => m.messageId), ['m']);
    assert.ok(JSON.parse(requests[0].body ?? '').arguments.query.startsWith('in:sent after:'));
  });

  test('getMessage and sendMail use Gmail arguments', async () => {
    const { transport, requests } = transportOf([
      { status: 200, json: { successful: true, data: { messageId: 'x1', subject: 's' } } },
      { status: 200, json: { successful: true, data: { id: 'sent' } } },
    ]);
    const client = createComposioMailClient(composioConfigFromEnv(ENV), transport);
    assert.deepEqual(await client.getMessage('x1'), { messageId: 'x1', subject: 's' });
    assert.deepEqual(JSON.parse(requests[0].body ?? '').arguments, { message_id: 'x1', format: 'full' });
    await client.sendMail({ to: 'a@b.c', subject: 'Hi', html: '<p>x</p>' });
    assert.ok(requests[1].url.endsWith('/GMAIL_SEND_EMAIL'));
    assert.deepEqual(JSON.parse(requests[1].body ?? '').arguments, { recipient_email: 'a@b.c', subject: 'Hi', body: '<p>x</p>', is_html: true });
  });
});

describe('gmail addresses', () => {
  test('parseAddress', () => {
    assert.deepEqual(parseAddress('Ahmed Ali <Ahmed@Example.com>'), { name: 'Ahmed Ali', address: 'ahmed@example.com' });
    assert.deepEqual(parseAddress('"Ali, Ahmed" <a@b.c>'), { name: 'Ali, Ahmed', address: 'a@b.c' });
    assert.deepEqual(parseAddress('x@y.z'), { name: null, address: 'x@y.z' });
    assert.equal(parseAddress(''), null);
  });
  test('parseAddressList splits outside quotes', () => {
    assert.deepEqual(parseAddressList('"Ali, Ahmed" <a@b.c>, D@E.f; g@h.i'), ['a@b.c', 'd@e.f', 'g@h.i']);
    assert.deepEqual(parseAddressList(undefined), []);
  });
  test('decodeBase64Url handles UTF-8 Arabic', () => {
    assert.equal(decodeBase64Url(b64url('مناقصة <b>x</b>')), 'مناقصة <b>x</b>');
  });
});

describe('normalizeGmailMessage', () => {
  const raw = {
    messageId: '19b1',
    threadId: 't1',
    subject: 'Tender 42',
    sender: 'Client <client@x.com>',
    to: 'tenders@redcon.com, Bob <bob@redcon.com>',
    messageTimestamp: '2026-11-26T08:31:36Z',
    messageText: 'Hello\r\nworld',
    display_url: 'https://mail.google.com/mail/u/0/#inbox/19b1',
    attachmentList: [{ filename: 'boq.pdf' }],
    labelIds: ['INBOX'],
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'Cc', value: 'eve@x.com' },
        { name: 'Auto-Submitted', value: 'no' },
        { name: 'Received', value: 'first' },
        { name: 'Received', value: 'second' },
      ],
      parts: [
        { mimeType: 'text/plain', filename: '', body: { data: b64url('Hello\nworld') } },
        { mimeType: 'text/html', filename: '', body: { data: b64url('<p>Hello <a href="https://t.example/doc">doc</a></p>') } },
      ],
    },
  };

  test('maps the Composio Gmail shape', () => {
    const m = normalizeGmailMessage(raw, 'inbox');
    assert.ok(m);
    assert.equal(m.id, '19b1');
    assert.equal(m.conversationId, 't1');
    assert.equal(m.subject, 'Tender 42');
    assert.deepEqual(m.from, { name: 'Client', address: 'client@x.com' });
    assert.deepEqual(m.to, ['tenders@redcon.com', 'bob@redcon.com']);
    assert.deepEqual(m.cc, ['eve@x.com']);
    assert.equal(m.date, '2026-11-26T08:31:36Z');
    assert.equal(m.bodyText, 'Hello\nworld');
    assert.ok(m.bodyHtml?.includes('https://t.example/doc'));
    assert.equal(m.webLink, 'https://mail.google.com/mail/u/0/#inbox/19b1');
    assert.equal(m.headers['auto-submitted'], 'no');
    assert.equal(m.headers.received, 'first');
    assert.equal(m.hasAttachments, true);
    assert.equal(m.isMeetingMessage, false);
  });

  test('falls back to HTML text, header dates and calendar parts', () => {
    const m = normalizeGmailMessage({
      id: 'z',
      payload: {
        headers: [{ name: 'From', value: 'a@b.c' }, { name: 'Date', value: 'Wed, 25 Nov 2026 10:00:00 +0000' }, { name: 'Subject', value: 'S' }],
        parts: [
          { mimeType: 'text/html', filename: '', body: { data: b64url('<div>Hi&amp;bye</div>') } },
          { mimeType: 'text/calendar', filename: '', body: { size: 1 } },
        ],
      },
    }, 'sent');
    assert.ok(m);
    assert.equal(m.bodyText, 'Hi&bye');
    assert.equal(m.date, '2026-11-25T10:00:00.000Z');
    assert.equal(m.subject, 'S');
    assert.equal(m.from?.address, 'a@b.c');
    assert.equal(m.isMeetingMessage, true);
    assert.equal(m.hasAttachments, false);
  });

  test('rejects non-objects and missing ids; normalizerFor picks by provider', () => {
    assert.equal(normalizeGmailMessage(null, 'inbox'), null);
    assert.equal(normalizeGmailMessage({ subject: 'x' }, 'inbox'), null);
    assert.equal(normalizerFor('gmail'), normalizeGmailMessage);
    assert.equal(normalizerFor('outlook'), normalizeGraphMessage);
  });
});
