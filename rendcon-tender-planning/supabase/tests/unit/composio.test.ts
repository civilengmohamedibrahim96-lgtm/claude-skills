import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ComposioError,
  composioConfigFromEnv,
  createComposioMailClient,
  extractList,
  extractObject,
  renameArgs,
} from '../../functions/_shared/composio.ts';
import type { HttpRequest, HttpResponse, HttpTransport } from '../../functions/_shared/types.ts';

const ENV = {
  COMPOSIO_API_KEY: 'test-key',
  COMPOSIO_CONNECTED_ACCOUNT_ID: 'ca_123',
};

function recordingTransport(responses: HttpResponse[] | ((req: HttpRequest) => HttpResponse)) {
  const requests: HttpRequest[] = [];
  let i = 0;
  const transport: HttpTransport = async (req) => {
    requests.push(req);
    if (typeof responses === 'function') return responses(req);
    const r = responses[i] ?? responses[responses.length - 1];
    i += 1;
    return r;
  };
  return { transport, requests };
}

function pageOf(n: number, prefix = 'm'): HttpResponse {
  const value = Array.from({ length: n }, (_, k) => ({ id: `${prefix}${k}` }));
  return { status: 200, json: { successful: true, data: { value } } };
}

describe('composioConfigFromEnv', () => {
  test('defaults', () => {
    const cfg = composioConfigFromEnv(ENV);
    assert.equal(cfg.baseUrl, 'https://backend.composio.dev/api/v3.1');
    assert.equal(cfg.executePath, '/tools/execute/{slug}');
    assert.equal(cfg.apiKey, 'test-key');
    assert.equal(cfg.connectedAccountId, 'ca_123');
    assert.equal(cfg.userId, null);
    assert.equal(cfg.toolkitVersion, null);
    assert.deepEqual(cfg.slugs, {
      listInbox: 'OUTLOOK_LIST_MESSAGES',
      listSent: 'OUTLOOK_LIST_SENT_ITEMS_MESSAGES',
      getMessage: 'OUTLOOK_GET_MESSAGE',
      sendMail: 'OUTLOOK_SEND_EMAIL',
    });
    assert.deepEqual(cfg.argMap, {});
    assert.equal(cfg.pageSize, 25);
  });

  test('missing API key names the variable', () => {
    assert.throws(() => composioConfigFromEnv({}), /COMPOSIO_API_KEY/);
  });

  test('missing connected account names the variable', () => {
    assert.throws(() => composioConfigFromEnv({ COMPOSIO_API_KEY: 'k' }), /COMPOSIO_CONNECTED_ACCOUNT_ID/);
  });

  test('invalid COMPOSIO_ARG_MAP JSON throws', () => {
    assert.throws(
      () => composioConfigFromEnv({ ...ENV, COMPOSIO_ARG_MAP: '{nope' }),
      /COMPOSIO_ARG_MAP is not valid JSON/,
    );
  });

  test('overrides are read', () => {
    const cfg = composioConfigFromEnv({
      ...ENV,
      COMPOSIO_USER_ID: ' u-1 ',
      COMPOSIO_TOOLKIT_VERSION: '20260101_00',
      COMPOSIO_PAGE_SIZE: '10',
      COMPOSIO_SLUG_SEND: 'CUSTOM_SEND',
    });
    assert.equal(cfg.userId, 'u-1');
    assert.equal(cfg.toolkitVersion, '20260101_00');
    assert.equal(cfg.pageSize, 10);
    assert.equal(cfg.slugs.sendMail, 'CUSTOM_SEND');
  });
});

describe('renameArgs', () => {
  test('renames only mapped arguments of the mapped slug', () => {
    const map = { OUTLOOK_GET_MESSAGE: { message_id: 'messageId' } };
    assert.deepEqual(renameArgs('OUTLOOK_GET_MESSAGE', { message_id: 'x' }, map), { messageId: 'x' });
    assert.deepEqual(renameArgs('OUTLOOK_LIST_MESSAGES', { message_id: 'x' }, map), { message_id: 'x' });
  });
});

describe('extractList / extractObject', () => {
  test('finds the array in the known places', () => {
    assert.deepEqual(extractList({ value: [1] }), [1]);
    assert.deepEqual(extractList({ response_data: { value: [2] } }), [2]);
    assert.deepEqual(extractList({ data: { value: [3] } }), [3]);
    assert.deepEqual(extractList({ messages: [4] }), [4]);
    assert.deepEqual(extractList({ response_data: { messages: [5] } }), [5]);
    assert.deepEqual(extractList([6]), [6]);
  });

  test('unexpected list shape throws', () => {
    assert.throws(() => extractList({ foo: 1 }), (e: unknown) => e instanceof ComposioError && /unexpected list shape/.test((e as Error).message));
    assert.throws(() => extractList('x'), ComposioError);
  });

  test('extractObject prefers response_data, then data, then the object itself', () => {
    assert.deepEqual(extractObject({ response_data: { id: 'a' } }), { id: 'a' });
    assert.deepEqual(extractObject({ data: { id: 'b' } }), { id: 'b' });
    assert.deepEqual(extractObject({ id: 'c' }), { id: 'c' });
    assert.throws(() => extractObject({ nope: true }), ComposioError);
  });
});

describe('ComposioError', () => {
  test('retryable for 429 and 5xx only', () => {
    assert.equal(new ComposioError('x', 429).retryable, true);
    assert.equal(new ComposioError('x', 503).retryable, true);
    assert.equal(new ComposioError('x', 400).retryable, false);
    assert.equal(new ComposioError('x', 200).retryable, false);
    assert.equal(new ComposioError('x', 503).status, 503);
  });
});

describe('createComposioMailClient', () => {
  test('request shape: URL, headers, body with connected account and renamed args', async () => {
    const { transport, requests } = recordingTransport([pageOf(0)]);
    const cfg = composioConfigFromEnv({ ...ENV, COMPOSIO_ARG_MAP: '{"OUTLOOK_LIST_MESSAGES":{"top":"limit"}}' });
    const client = createComposioMailClient(cfg, transport);
    await client.listMessages('inbox', '2026-11-24T10:00:00Z', 60);

    assert.equal(requests.length, 1);
    const r = requests[0];
    assert.equal(r.url, 'https://backend.composio.dev/api/v3.1/tools/execute/OUTLOOK_LIST_MESSAGES');
    assert.equal(r.method, 'POST');
    assert.equal(r.headers['x-api-key'], 'test-key');
    assert.equal(r.headers['content-type'], 'application/json');
    const body = JSON.parse(r.body ?? '');
    assert.equal(body.connected_account_id, 'ca_123');
    assert.equal(body.user_id, undefined);
    assert.equal(body.version, undefined);
    assert.equal(body.arguments.folder, 'inbox');
    assert.equal(body.arguments.limit, 25);
    assert.equal(body.arguments.top, undefined);
    assert.ok(body.arguments.filter.includes('2026-11-24T10:00:00Z'));
  });

  test('user_id and version only when configured', async () => {
    const { transport, requests } = recordingTransport([pageOf(0)]);
    const cfg = composioConfigFromEnv({ ...ENV, COMPOSIO_USER_ID: 'u-9', COMPOSIO_TOOLKIT_VERSION: 'v2' });
    await createComposioMailClient(cfg, transport).listMessages('sent', '2026-11-24T10:00:00Z', 10);
    const body = JSON.parse(requests[0].body ?? '');
    assert.equal(body.user_id, 'u-9');
    assert.equal(body.version, 'v2');
    assert.ok(body.arguments.filter.startsWith('sentDateTime ge '));
  });

  test('pagination 25, 25, 3 → 53 items with skip 0/25/50', async () => {
    const { transport, requests } = recordingTransport([pageOf(25, 'a'), pageOf(25, 'b'), pageOf(3, 'c')]);
    const items = await createComposioMailClient(composioConfigFromEnv(ENV), transport)
      .listMessages('inbox', '2026-11-24T10:00:00Z', 100);
    assert.equal(items.length, 53);
    assert.deepEqual(requests.map((r) => JSON.parse(r.body ?? '').arguments.skip), [0, 25, 50]);
  });

  test('max 30 → 30 items', async () => {
    const { transport, requests } = recordingTransport([pageOf(25, 'a'), pageOf(25, 'b')]);
    const items = await createComposioMailClient(composioConfigFromEnv(ENV), transport)
      .listMessages('inbox', '2026-11-24T10:00:00Z', 30);
    assert.equal(items.length, 30);
    assert.equal(requests.length, 2);
  });

  test('custom execute path and base URL', async () => {
    const { transport, requests } = recordingTransport([pageOf(0)]);
    const cfg = composioConfigFromEnv({
      ...ENV,
      COMPOSIO_BASE_URL: 'https://proxy.example/api/',
      COMPOSIO_EXECUTE_PATH: '/v2/actions/{slug}/execute',
    });
    await createComposioMailClient(cfg, transport).listMessages('inbox', '2026-11-24T10:00:00Z', 5);
    assert.equal(requests[0].url, 'https://proxy.example/api/v2/actions/OUTLOOK_LIST_MESSAGES/execute');
  });

  test('getMessage sends message_id and returns the object', async () => {
    const { transport, requests } = recordingTransport([
      { status: 200, json: { successful: true, data: { response_data: { id: 'AAMk-1', subject: 's' } } } },
    ]);
    const msg = await createComposioMailClient(composioConfigFromEnv(ENV), transport).getMessage('AAMk-1');
    assert.deepEqual(msg, { id: 'AAMk-1', subject: 's' });
    const body = JSON.parse(requests[0].body ?? '');
    assert.equal(requests[0].url.endsWith('/OUTLOOK_GET_MESSAGE'), true);
    assert.deepEqual(body.arguments, { message_id: 'AAMk-1' });
  });

  test('getMessage honours COMPOSIO_ARG_MAP rename', async () => {
    const { transport, requests } = recordingTransport([
      { status: 200, json: { data: { id: 'x' } } },
    ]);
    const cfg = composioConfigFromEnv({ ...ENV, COMPOSIO_ARG_MAP: '{"OUTLOOK_GET_MESSAGE":{"message_id":"messageId"}}' });
    await createComposioMailClient(cfg, transport).getMessage('x');
    assert.deepEqual(JSON.parse(requests[0].body ?? '').arguments, { messageId: 'x' });
  });

  test('sendMail body arguments', async () => {
    const { transport, requests } = recordingTransport([{ status: 200, json: { successful: true, data: {} } }]);
    await createComposioMailClient(composioConfigFromEnv(ENV), transport)
      .sendMail({ to: 'a@b.example', subject: 'Hi', html: '<p>x</p>' });
    assert.equal(requests[0].url.endsWith('/OUTLOOK_SEND_EMAIL'), true);
    assert.deepEqual(JSON.parse(requests[0].body ?? '').arguments, {
      to_email: 'a@b.example',
      subject: 'Hi',
      body: '<p>x</p>',
      is_html: true,
    });
  });

  test('HTTP 503 → retryable ComposioError', async () => {
    const { transport } = recordingTransport([{ status: 503, json: null }]);
    await assert.rejects(
      () => createComposioMailClient(composioConfigFromEnv(ENV), transport).listMessages('inbox', '2026-11-24T10:00:00Z', 5),
      (e: unknown) => e instanceof ComposioError && e.status === 503 && e.retryable === true,
    );
  });

  test('HTTP 401 → not retryable', async () => {
    const { transport } = recordingTransport([{ status: 401, json: { error: 'bad key' } }]);
    await assert.rejects(
      () => createComposioMailClient(composioConfigFromEnv(ENV), transport).getMessage('x'),
      (e: unknown) => e instanceof ComposioError && e.status === 401 && e.retryable === false,
    );
  });

  test('successful:false body → ComposioError with the message, not retryable', async () => {
    const { transport } = recordingTransport([{ status: 200, json: { successful: false, error: 'bad token', data: null } }]);
    await assert.rejects(
      () => createComposioMailClient(composioConfigFromEnv(ENV), transport).listMessages('inbox', '2026-11-24T10:00:00Z', 5),
      (e: unknown) => e instanceof ComposioError && e.message === 'bad token' && e.retryable === false,
    );
  });

  test('unexpected list shape from the tool surfaces as ComposioError', async () => {
    const { transport } = recordingTransport([{ status: 200, json: { successful: true, data: { other: 1 } } }]);
    await assert.rejects(
      () => createComposioMailClient(composioConfigFromEnv(ENV), transport).listMessages('inbox', '2026-11-24T10:00:00Z', 5),
      /unexpected list shape/,
    );
  });
});
