// Web Push sender on an injected web-push-compatible library (`web-push` in the edge function).
import type { PushOutcome, PushPayload, PushSender, PushSubscriptionRow } from './types.ts';

export type WebPushLike = {
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string, options?: Record<string, unknown>): Promise<{ statusCode: number }>;
};

export function createWebPushSender(
  lib: WebPushLike,
  vapid: { subject: string; publicKey: string; privateKey: string },
): PushSender {
  lib.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  return {
    async send(sub: PushSubscriptionRow, payload: PushPayload): Promise<PushOutcome> {
      try {
        await lib.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload),
          { TTL: 3600, urgency: 'high' },
        );
        return 'ok';
      } catch (err) {
        const code = typeof err === 'object' && err !== null ? (err as { statusCode?: unknown }).statusCode : undefined;
        return code === 404 || code === 410 ? 'gone' : 'error';
      }
    },
  };
}
