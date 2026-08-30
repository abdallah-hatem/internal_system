import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from './notifications.service';
import { PushService } from './push.service';

/**
 * Telling somebody that something happened to their request.
 *
 * Without this the storefront is a form that swallows things: a shop submits a
 * request and then has to keep opening the app to find out whether anyone
 * answered, and the office learns a request exists only by looking at a screen
 * nobody has a reason to open.
 *
 * Three rules hold everywhere in here.
 *
 * **The row is the record; the push is an attempt.** Every event writes a
 * `Notification` first and pushes second. A phone that is off, a stale
 * subscription, a push service having a bad afternoon — none of them lose the
 * notification, because the bell already has it.
 *
 * **It never throws at the caller.** These run after the business action has
 * committed. An approval that succeeded and then failed to notify is an
 * approval; rolling it back because a phone was unreachable would be a far
 * worse bug than a missed alert.
 *
 * **The text is a key, not a sentence.** `eventType` plus a payload, so the
 * reader's app says it in the reader's language. The English `title` stays as
 * what the logs record and what a client that has never heard the event falls
 * back to — the same bargain `api-error.ts` makes for refusals.
 */
@Injectable()
export class PortalNotifier {
  private readonly log = new Logger(PortalNotifier.name);

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    private push: PushService,
  ) {}

  /** Everyone in the office who should hear about a shop's request. */
  private async officeUserIds(): Promise<string[]> {
    const users = await this.prisma.user.findMany({
      where: { role: { in: ['CORE_PARTNER', 'ADMIN_SUPPORT'] }, status: 'ACTIVE' },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  /** The login behind a shop, if it has one. */
  private async shopUserId(customerId: string): Promise<string | null> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { shopOwnerUserId: true },
    });
    return customer?.shopOwnerUserId ?? null;
  }

  /**
   * Write the rows, then try the phones.
   *
   * Swallows everything. The only trace of a failure is a log line, which is
   * the right place for it: nobody's order should depend on it.
   */
  private async deliver(
    userIds: string[],
    event: {
      eventType: string;
      title: string;
      body: string;
      payload?: Record<string, unknown>;
      url?: string;
      tag?: string;
    },
  ) {
    if (userIds.length === 0) return;

    try {
      await this.notifications.createForMultipleUsers(userIds, {
        eventType: event.eventType,
        title: event.title,
        payload: event.payload,
      });
    } catch (err) {
      // If even the row failed there is nothing to push about, and the caller
      // still must not hear about it.
      this.log.error(`could not record ${event.eventType}: ${(err as Error).message}`);
      return;
    }

    for (const userId of userIds) {
      try {
        await this.push.sendToUser(userId, {
          title: event.title,
          body: event.body,
          url: event.url,
          // Same tag replaces rather than stacks, so three updates about one
          // request leave one notification on the phone and not three.
          tag: event.tag,
        });
      } catch (err) {
        this.log.warn(`push for ${event.eventType} failed: ${(err as Error).message}`);
      }
    }
  }

  // ── What the office hears ───────────────────────────────────────────

  async orderRequestSubmitted(args: { requestId: string; requestNo: string; shopName: string }) {
    await this.deliver(await this.officeUserIds(), {
      eventType: 'ORDER_REQUEST_SUBMITTED',
      title: `${args.shopName} asked to buy — ${args.requestNo}`,
      body: 'Stock is held for 48 hours while you answer.',
      payload: { ...args },
      url: '/order-requests',
      tag: `order-request-${args.requestId}`,
    });
  }

  async importRequestSubmitted(args: { requestId: string; productName: string; shopName: string }) {
    await this.deliver(await this.officeUserIds(), {
      eventType: 'IMPORT_REQUEST_SUBMITTED',
      title: `${args.shopName} asked for ${args.productName}`,
      body: 'A shop wants something we do not stock.',
      payload: { ...args },
      url: '/import-requests',
      tag: `import-request-${args.requestId}`,
    });
  }

  async shopSignedUp(args: { customerId: string; shopName: string }) {
    await this.deliver(await this.officeUserIds(), {
      eventType: 'SHOP_SIGNED_UP',
      title: `${args.shopName} signed up`,
      body: 'They can browse, but cannot order until you verify them.',
      payload: { ...args },
      url: '/customers?verification=UNVERIFIED',
      tag: `signup-${args.customerId}`,
    });
  }

  /**
   * A hold running out while nobody has answered.
   *
   * Raised by the sweeper six hours before the deadline, once per request —
   * the point is to prompt an answer while there is still stock behind it, not
   * to report afterwards that there no longer is.
   */
  async holdExpiringSoon(args: { requestId: string; requestNo: string; shopName: string }) {
    await this.deliver(await this.officeUserIds(), {
      eventType: 'HOLD_EXPIRING',
      title: `${args.requestNo} is still waiting`,
      body: `The stock held for ${args.shopName} goes back on the shelf in six hours.`,
      payload: { ...args },
      url: '/order-requests',
      tag: `order-request-${args.requestId}`,
    });
  }

  // ── What the shop hears ─────────────────────────────────────────────

  async orderRequestAnswered(args: {
    customerId: string;
    requestId: string;
    requestNo: string;
    approved: boolean;
    orderNo?: string;
    partial?: boolean;
  }) {
    const userId = await this.shopUserId(args.customerId);
    if (!userId) return;

    await this.deliver([userId], {
      eventType: args.approved ? 'ORDER_REQUEST_APPROVED' : 'ORDER_REQUEST_DECLINED',
      title: args.approved
        ? `${args.requestNo} approved`
        : `${args.requestNo} could not be filled`,
      body: args.approved
        ? args.partial
          ? 'Some of what you asked for is on its way — open it to see what changed.'
          : 'Your order is confirmed.'
        : 'Open it to see why.',
      payload: { ...args },
      url: `/requests/${args.requestId}`,
      tag: `order-request-${args.requestId}`,
    });
  }

  async importRequestAnswered(args: {
    customerId: string;
    requestId: string;
    productName: string;
    status: string;
  }) {
    const userId = await this.shopUserId(args.customerId);
    if (!userId) return;

    await this.deliver([userId], {
      eventType: `IMPORT_REQUEST_${args.status}`,
      title: `About ${args.productName}`,
      body:
        args.status === 'SOURCING'
          ? 'We are looking for it.'
          : args.status === 'ANSWERED'
            ? 'We have an answer for you.'
            : 'We could not source it.',
      payload: { ...args },
      url: `/imports/${args.requestId}`,
      tag: `import-request-${args.requestId}`,
    });
  }
}
