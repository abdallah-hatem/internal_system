import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as webpush from 'web-push';

import { PrismaService } from '../../prisma/prisma.service';
import { badRequest } from '../../common/api-error';

/**
 * What a service worker is handed: the office's (`apps/web/public/sw.js`) or
 * the storefront's. `url` is what a tap opens. `locale` is the language the
 * words are in; the office worker puts a `url` with no language in front of
 * it under that one.
 */
export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  locale?: string;
}

const errText = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/**
 * Delivering a notification to a device that is not looking at the app.
 *
 * Push is a delivery attempt, never the record. Every notification is written
 * to the `notifications` table first and pushed second, so a push that fails —
 * because the phone is off, the subscription is stale, or the service is down —
 * loses nothing. The bell is what the shop comes back to.
 *
 * A subscription that answers 404 or 410 is gone for good: the browser has
 * revoked it, and retrying it forever is how a table fills with endpoints for
 * every phone that ever uninstalled the app, each one a failed request on every
 * send.
 */
@Injectable()
export class PushService {
  private readonly log = new Logger(PushService.name);
  private readonly vapidPublicKey: string | null;

  constructor(
    private prisma: PrismaService,
    config: ConfigService,
  ) {
    const publicKey = config.get<string>('VAPID_PUBLIC_KEY');
    const privateKey = config.get<string>('VAPID_PRIVATE_KEY');
    const subject =
      config.get<string>('VAPID_SUBJECT') ?? 'mailto:admin@motoparts.local';

    if (publicKey && privateKey) {
      webpush.setVapidDetails(subject, publicKey, privateKey);
      this.vapidPublicKey = publicKey;
    } else {
      this.vapidPublicKey = null;
      // Not fatal. The app must run without push configured — otherwise a
      // missing key stops the whole API, and the notifications people actually
      // read are the ones in the bell.
      this.log.warn(
        'VAPID keys are not set; web push is disabled and the bell still works.',
      );
    }
  }

  /** The key a browser needs to subscribe. Null when push is not configured. */
  publicKey(): string | null {
    return this.vapidPublicKey;
  }

  /**
   * Remember a browser that agreed to be notified.
   *
   * Keyed on the endpoint, which is unique per browser per site. Re-subscribing
   * the same browser updates the keys rather than adding a row — otherwise
   * every permission prompt a shop accepts leaves another dead endpoint behind.
   */
  async subscribe(
    userId: string,
    sub: { endpoint: string; keys: { p256dh: string; auth: string } },
    userAgent?: string,
  ) {
    const saved = await this.prisma.pushSubscription.upsert({
      where: { endpoint: sub.endpoint },
      update: {
        userId,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        userAgent,
        failureCount: 0,
      },
      create: {
        userId,
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        userAgent,
      },
    });

    return { data: { id: saved.id, subscribed: true } };
  }

  async unsubscribe(userId: string, endpoint: string) {
    // Scoped to the caller: an endpoint is a long opaque string, but it is not
    // a secret, and nobody should be able to silence someone else's phone.
    await this.prisma.pushSubscription.deleteMany({
      where: { userId, endpoint },
    });
    return { data: { subscribed: false } };
  }

  /**
   * Send to every device one person has registered: `sendToUsers` for one.
   *
   * Never throws at the caller. This runs after the notification row is already
   * written, and a failure to reach a phone must not roll back the thing that
   * happened — a settlement approved and then un-approved because a push failed
   * would be a far worse bug than a missed alert.
   */
  sendToUser(
    userId: string,
    payload: PushPayload,
  ): Promise<{ sent: number; removed: number }> {
    return this.sendToUsers([userId], () => payload);
  }

  /** Each push service gets this long to accept one message. */
  static readonly SEND_TIMEOUT_MS = 2500;
  /** And one delivery this long in all, however many people and devices. */
  static readonly DEADLINE_MS = 3000;

  /**
   * Send to every device of every one of these people, each in their own words.
   *
   * One query for all of their subscriptions, however many people — telling
   * three partners must not ask the database three times — and none at all
   * when push is not configured. Nobody with no subscription is sent anything.
   *
   * Bounded in time. The request that raised the notification awaits this (on
   * Vercel, work left running after the response is sent may simply be cut
   * off), so every device is tried at once, each send gives up after
   * `SEND_TIMEOUT_MS`, and the whole thing returns by `DEADLINE_MS` whatever the
   * push services are doing. A device that has not answered by then is left
   * alone: counted neither delivered nor failed.
   *
   * Never throws, and must not run inside a transaction: it uses the client's
   * own connection (LEARNINGS: Deployment). Call it after the commit.
   */
  async sendToUsers(
    userIds: readonly string[],
    payloadFor: (userId: string) => PushPayload,
  ): Promise<{ sent: number; removed: number }> {
    const none = { sent: 0, removed: 0 };
    if (!this.vapidPublicKey) return none;
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return none;

    let subs: {
      id: string;
      userId: string;
      endpoint: string;
      p256dh: string;
      auth: string;
    }[];
    try {
      subs = await this.prisma.pushSubscription.findMany({
        where: { userId: { in: ids } },
        select: {
          id: true,
          userId: true,
          endpoint: true,
          p256dh: true,
          auth: true,
        },
      });
    } catch (err) {
      this.log.warn(`could not read push subscriptions: ${errText(err)}`);
      return none;
    }
    if (subs.length === 0) return none;

    type Outcome = 'sent' | 'gone' | 'failed' | 'late';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<Outcome>((resolve) => {
      timer = setTimeout(() => resolve('late'), PushService.DEADLINE_MS);
    });

    const attempt = async (sub: (typeof subs)[number]): Promise<Outcome> => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          JSON.stringify(payloadFor(sub.userId)),
          { timeout: PushService.SEND_TIMEOUT_MS },
        );
        return 'sent';
      } catch (err: any) {
        const status = err?.statusCode;
        // Gone for good, not a bad moment. Deleting is the only way this
        // table does not grow forever.
        if (status === 404 || status === 410) return 'gone';
        this.log.warn(
          `push to ${sub.id} failed with ${status ?? errText(err)}`,
        );
        return 'failed';
      }
    };

    const outcomes = await Promise.all(
      subs.map((sub) => Promise.race([attempt(sub), deadline])),
    );
    clearTimeout(timer);

    const idsWith = (o: Outcome) =>
      subs.filter((_, i) => outcomes[i] === o).map((s) => s.id);
    const sentIds = idsWith('sent');
    const goneIds = idsWith('gone');
    const failedIds = idsWith('failed');
    const late = outcomes.filter((o) => o === 'late').length;
    if (late > 0) {
      this.log.warn(`${late} push(es) had not answered after the deadline`);
    }

    // At most three writes, whatever the number of devices.
    if (sentIds.length > 0) {
      await this.quietly(
        this.prisma.pushSubscription.updateMany({
          where: { id: { in: sentIds } },
          data: { lastSuccessAt: new Date(), failureCount: 0 },
        }),
      );
    }
    if (goneIds.length > 0) {
      await this.quietly(
        this.prisma.pushSubscription.deleteMany({
          where: { id: { in: goneIds } },
        }),
      );
    }
    if (failedIds.length > 0) {
      await this.quietly(
        this.prisma.pushSubscription.updateMany({
          where: { id: { in: failedIds } },
          data: { failureCount: { increment: 1 } },
        }),
      );
    }

    return { sent: sentIds.length, removed: goneIds.length };
  }

  /** Bookkeeping about devices: a failure here is a log line, never an error. */
  private async quietly(write: PromiseLike<unknown>) {
    try {
      await write;
    } catch (err) {
      this.log.warn(`push bookkeeping failed: ${errText(err)}`);
    }
  }

  /**
   * One alert to the signed-in person's own devices, so they can see alerts
   * work (owner, 2026-10-16: "I need to test it"). The words come from the
   * client, translated into the reader's language; only their own devices are
   * reached, so there is nobody else to spam. Each way it cannot arrive is a
   * coded refusal, never a quiet success.
   */
  async sendTest(
    userId: string,
    text: { title?: unknown; body?: unknown },
  ): Promise<{ sent: number; removed: number; devices: number }> {
    const title = typeof text.title === 'string' ? text.title.trim() : '';
    const body = typeof text.body === 'string' ? text.body.trim() : '';
    if (!title || !body || title.length > 120 || body.length > 300) {
      throw badRequest(
        'VALIDATION_FAILED',
        'A test alert needs a title (up to 120) and a body (up to 300).',
        {
          fields: 'title, body',
        },
      );
    }
    if (!this.vapidPublicKey) {
      throw badRequest(
        'PUSH_NOT_CONFIGURED',
        'Alerts are not set up on the server.',
      );
    }
    const devices = await this.prisma.pushSubscription.count({
      where: { userId },
    });
    if (devices === 0) {
      throw badRequest(
        'NO_PUSH_DEVICE',
        'No device of yours has alerts turned on.',
      );
    }
    const { sent, removed } = await this.sendToUser(userId, {
      title,
      body,
      url: '/settings',
      tag: 'test-alert',
    });
    if (sent === 0) {
      throw badRequest(
        'PUSH_TEST_NOT_DELIVERED',
        'The test alert could not be delivered to any of your devices.',
        {
          devices,
          removed,
        },
      );
    }
    return { sent, removed, devices };
  }
}
