import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebPushSender } from '../../functions/_shared/push.ts';
import type { WebPushLike } from '../../functions/_shared/push.ts';
import type { PushSubscriptionRow } from '../../functions/_shared/types.ts';

const sub: PushSubscriptionRow = { id: 's1', personId: 'a', endpoint: 'https://push.example/1', p256dh: 'P', auth: 'A' };
const payload = { title: 'Reminder', body: 'Call the client', url: 'https://app.example/', tag: 'rem-1' };
const vapid = { subject: 'mailto:tenders@example.com', publicKey: 'PUB', privateKey: 'PRIV' };

function fakeLib(behaviour: () => Promise<{ statusCode: number }>) {
  const vapidCalls: unknown[][] = [];
  const sends: { sub: unknown; payload: string; options: unknown }[] = [];
  const lib: WebPushLike = {
    setVapidDetails(...args) {
      vapidCalls.push(args);
    },
    async sendNotification(s, p, o) {
      sends.push({ sub: s, payload: p, options: o });
      return behaviour();
    },
  };
  return { lib, vapidCalls, sends };
}

test('setVapidDetails is called once with the keys', () => {
  const { lib, vapidCalls } = fakeLib(async () => ({ statusCode: 201 }));
  createWebPushSender(lib, vapid);
  assert.deepEqual(vapidCalls, [['mailto:tenders@example.com', 'PUB', 'PRIV']]);
});

test('send passes keys, JSON payload and TTL; success is ok', async () => {
  const { lib, sends } = fakeLib(async () => ({ statusCode: 201 }));
  const sender = createWebPushSender(lib, vapid);
  assert.equal(await sender.send(sub, payload), 'ok');
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].sub, { endpoint: 'https://push.example/1', keys: { p256dh: 'P', auth: 'A' } });
  assert.equal(sends[0].payload, JSON.stringify(payload));
  assert.equal((sends[0].options as { TTL: number }).TTL, 3600);
});

test('404 and 410 are gone', async () => {
  for (const statusCode of [404, 410]) {
    const { lib } = fakeLib(async () => {
      throw Object.assign(new Error('gone'), { statusCode });
    });
    assert.equal(await createWebPushSender(lib, vapid).send(sub, payload), 'gone');
  }
});

test('other errors are error', async () => {
  const { lib } = fakeLib(async () => {
    throw Object.assign(new Error('boom'), { statusCode: 500 });
  });
  assert.equal(await createWebPushSender(lib, vapid).send(sub, payload), 'error');
  const { lib: lib2 } = fakeLib(async () => {
    throw new Error('network down');
  });
  assert.equal(await createWebPushSender(lib2, vapid).send(sub, payload), 'error');
});
