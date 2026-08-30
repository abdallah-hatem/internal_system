import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as webpush from 'web-push';

import { PrismaService } from '../../prisma/prisma.service';

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
    const subject = config.get<string>('VAPID_SUBJECT') ?? 'mailto:admin@motoparts.local';

    if (publicKey && privateKey) {
      webpush.setVapidDetails(subject, publicKey, privateKey);
      this.vapidPublicKey = publicKey;
    } else {
      this.vapidPublicKey = null;
      // Not fatal. The app must run without push configured — otherwise a
      // missing key stops the whole API, and the notifications people actually
      // read are the ones in the bell.
      this.log.warn('VAPID keys are not set; web push is disabled and the bell still works.');
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
    await this.prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });
    return { data: { subscribed: false } };
  }

  /**
   * Send to every device one person has registered.
   *
   * Never throws at the caller. This runs after the notification row is already
   * written, and a failure to reach a phone must not roll back the thing that
   * happened — a settlement approved and then un-approved because a push failed
   * would be a far worse bug than a missed alert.
   */
  async sendToUser(
    userId: string,
    payload: { title: string; body: string; url?: string; tag?: string },
  ): Promise<{ sent: number; removed: number }> {
    if (!this.vapidPublicKey) return { sent: 0, removed: 0 };

    const subs = await this.prisma.pushSubscription.findMany({ where: { userId } });
    let sent = 0;
    let removed = 0;

    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload),
        );
        sent += 1;
        await this.prisma.pushSubscription.update({
          where: { id: sub.id },
          data: { lastSuccessAt: new Date(), failureCount: 0 },
        });
      } catch (err: any) {
        const status = err?.statusCode;
        if (status === 404 || status === 410) {
          // Gone for good, not a bad moment. Deleting is the only way this
          // table does not grow forever.
          await this.prisma.pushSubscription.delete({ where: { id: sub.id } });
          removed += 1;
        } else {
          await this.prisma.pushSubscription.update({
            where: { id: sub.id },
            data: { failureCount: { increment: 1 } },
          });
          this.log.warn(`push to ${sub.id} failed with ${status ?? 'no status'}`);
        }
      }
    }

    return { sent, removed };
  }
}
