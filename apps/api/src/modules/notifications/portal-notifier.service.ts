import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from './notifications.service';
import { PushService } from './push.service';
import {
  isNotificationCode,
  pushLocaleFor,
  renderNotification,
  type NotificationCode,
  type NotificationParams,
} from '../../common/notification-messages';

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
 * **The text is a key, not a sentence.** A `code` plus its `params`
 * (`common/notification-messages.ts`), so the reader's app says it in the
 * reader's language. The English `title` stays as what the logs record and what
 * a client that has never heard the code falls back to — the same bargain
 * `api-error.ts` makes for refusals. Only the push is worded here, because it
 * is sent while no app is open to word it.
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
      where: {
        role: { in: ['CORE_PARTNER', 'ADMIN_SUPPORT'] },
        status: 'ACTIVE',
      },
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
   * The row stores the code and its params; the push is put into words here,
   * in the language `pushLocaleFor` picks for each reader, because nobody's
   * app is open to translate it.
   *
   * Swallows everything. The only trace of a failure is a log line, which is
   * the right place for it: nobody's order should depend on it.
   */
  private async deliver(
    userIds: string[],
    event: {
      eventType: string;
      code: NotificationCode;
      params: NotificationParams;
      payload?: Record<string, unknown>;
      url?: string;
      tag?: string;
    },
  ) {
    if (userIds.length === 0) return;

    try {
      await this.notifications.createForMultipleUsers(userIds, {
        eventType: event.eventType,
        code: event.code,
        params: event.params,
        payload: event.payload,
      });
    } catch (err) {
      // If even the row failed there is nothing to push about, and the caller
      // still must not hear about it.
      this.log.error(
        `could not record ${event.eventType}: ${(err as Error).message}`,
      );
      return;
    }

    let readers: { id: string; role: string | null }[] = [];
    try {
      readers = await this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, role: true },
      });
    } catch (err) {
      this.log.warn(
        `could not read who to push ${event.eventType} to: ${(err as Error).message}`,
      );
    }
    const roleOf = new Map(readers.map((r) => [r.id, r.role]));

    for (const userId of userIds) {
      try {
        const words = renderNotification(
          event.code,
          event.params,
          pushLocaleFor({ role: roleOf.get(userId) }),
        );
        await this.push.sendToUser(userId, {
          title: words.title,
          body: words.body ?? '',
          url: event.url,
          // Same tag replaces rather than stacks, so three updates about one
          // request leave one notification on the phone and not three.
          tag: event.tag,
        });
      } catch (err) {
        this.log.warn(
          `push for ${event.eventType} failed: ${(err as Error).message}`,
        );
      }
    }
  }

  // ── What the office hears ───────────────────────────────────────────

  async orderRequestSubmitted(args: {
    requestId: string;
    requestNo: string;
    shopName: string;
  }) {
    await this.deliver(await this.officeUserIds(), {
      eventType: 'ORDER_REQUEST_SUBMITTED',
      code: 'ORDER_REQUEST_SUBMITTED',
      params: { shopName: args.shopName, requestNo: args.requestNo },
      payload: { ...args },
      url: '/requests',
      tag: `order-request-${args.requestId}`,
    });
  }

  async importRequestSubmitted(args: {
    requestId: string;
    productName: string;
    shopName: string;
  }) {
    await this.deliver(await this.officeUserIds(), {
      eventType: 'IMPORT_REQUEST_SUBMITTED',
      code: 'IMPORT_REQUEST_SUBMITTED',
      params: { shopName: args.shopName, productName: args.productName },
      payload: { ...args },
      url: '/requests?view=imports',
      tag: `import-request-${args.requestId}`,
    });
  }

  async shopSignedUp(args: { customerId: string; shopName: string }) {
    await this.deliver(await this.officeUserIds(), {
      eventType: 'SHOP_SIGNED_UP',
      code: 'SHOP_SIGNED_UP',
      params: { shopName: args.shopName },
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
  async holdExpiringSoon(args: {
    requestId: string;
    requestNo: string;
    shopName: string;
  }) {
    await this.deliver(await this.officeUserIds(), {
      eventType: 'HOLD_EXPIRING',
      code: 'HOLD_EXPIRING',
      params: { requestNo: args.requestNo, shopName: args.shopName },
      payload: { ...args },
      url: '/requests',
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
      eventType: args.approved
        ? 'ORDER_REQUEST_APPROVED'
        : 'ORDER_REQUEST_DECLINED',
      code: !args.approved
        ? 'ORDER_REQUEST_DECLINED'
        : args.partial
          ? 'ORDER_REQUEST_APPROVED_PARTIAL'
          : 'ORDER_REQUEST_APPROVED',
      params: { requestNo: args.requestNo },
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

    const code = `IMPORT_REQUEST_${args.status}`;
    if (!isNotificationCode(code)) {
      this.log.warn(`no notification for import request status ${args.status}`);
      return;
    }

    await this.deliver([userId], {
      eventType: code,
      code,
      params: { productName: args.productName },
      payload: { ...args },
      url: `/imports/${args.requestId}`,
      tag: `import-request-${args.requestId}`,
    });
  }
}
