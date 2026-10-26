import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  listRows,
  type ListQuery,
  searchOf,
  sortOf,
} from '../../common/list-query';
import { searchIds } from '../../common/repositories/list-search';

import type { Prisma } from '@prisma/client';
import { notFound } from '../../common/api-error';
import type { LowStockRow } from '../../common/low-stock';
import {
  bellLink,
  pushLocaleFor,
  renderNotification,
  type NotificationCode,
  type NotificationParams,
} from '../../common/notification-messages';
import { PushService } from './push.service';

export { bellLink };

/** What a push needs besides the row: where it opens, what it replaces. */
interface PushOptions {
  /** Where a tap opens. Default: the bell's own link (`bellLink`). */
  url?: string;
  /** Same tag replaces rather than stacks. Default: the link. */
  tag?: string;
}

@Injectable()
export class NotificationsService {
  private readonly log = new Logger(NotificationsService.name);

  constructor(
    private prisma: PrismaService,
    private push: PushService,
  ) {}

  async findAll(
    userId: string,
    query: ListQuery & { unreadOnly?: boolean | string },
  ) {
    const { unreadOnly } = query;
    const search = searchOf(query);
    const { orderBy } = sortOf(query, {
      newest: [{ createdAt: 'desc' }, { id: 'desc' }],
    } satisfies Record<string, Prisma.NotificationOrderByWithRelationInput[]>);
    const where: Prisma.NotificationWhereInput = { userId };
    if (unreadOnly === true || unreadOnly === 'true') where.readAt = null;
    if (search) {
      where.id = {
        in: await searchIds(
          this.prisma,
          `notifications t`,
          [`t.title`, `t.params::text`],
          search,
        ),
      };
    }

    // The bell walks cursors; the Notifications page asks for a page
    // (server-side lists, owner 2026-10-25).
    const { rows: data, meta } = await listRows(query, {
      rows: (window) =>
        this.prisma.notification.findMany({ where, orderBy, ...window }),
      count: () => this.prisma.notification.count({ where }),
    });

    return {
      data,
      meta: {
        ...meta,
        unreadCount: await this.prisma.notification.count({
          where: { userId, readAt: null },
        }),
      },
    };
  }

  async markAsRead(id: string, userId: string) {
    const notification = await this.prisma.notification.findFirst({
      where: { id, userId },
    });
    if (!notification) throw notFound('notification');

    return this.prisma.notification.update({
      where: { id },
      data: { readAt: new Date() },
    });
  }

  async markAllAsRead(userId: string) {
    await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { data: { success: true } };
  }

  /**
   * Write one notification, then push it to that person's devices.
   *
   * The caller names it with a `code` and `params`; the English `title` is
   * derived here, so no service writes the sentence itself (CLAUDE.md rule 9)
   * and the two cannot disagree.
   *
   * The row is the record; the push is an attempt (`deliverPush`). Call it
   * after the commit, never inside a transaction.
   */
  async create(data: NotificationEvent & { userId: string }) {
    const row = await this.prisma.notification.create({
      data: { userId: data.userId, ...rowFor(data) },
    });
    await this.deliverPush([data.userId], data);
    return row;
  }

  /** The same, for several people at once: one insert, one push lookup. */
  async createForMultipleUsers(userIds: string[], data: NotificationEvent) {
    const row = rowFor(data);
    const written = await this.prisma.notification.createMany({
      data: userIds.map((userId) => ({ userId, ...row })),
    });
    await this.deliverPush(userIds, data);
    return written;
  }

  /**
   * Put the notification on these people's phones, in the words the bell uses.
   *
   * Until 2026-10-18 nothing in the office was ever pushed: these two methods
   * only wrote rows, and only the storefront's requests reached a phone. A
   * sale that took a product below its minimum rang the bell and left the
   * phone silent, alerts turned on and all.
   *
   * The words are `renderNotification` for the code, in the language
   * `pushLocaleFor` picks — the same text the bell shows, never a new
   * sentence. Bounded and never throwing (`PushService.sendToUsers`): the row
   * is already written, and the request that raised it must neither fail nor
   * wait on a phone.
   */
  private async deliverPush(userIds: string[], event: NotificationEvent) {
    if (userIds.length === 0) return;
    try {
      const url = event.push?.url ?? bellLink(event.eventType, event.payload);
      const tag = event.push?.tag ?? url;
      await this.push.sendToUsers(userIds, () => {
        // Per reader, so a stored language is a change here and nowhere else.
        const locale = pushLocaleFor({});
        const words = renderNotification(event.code, event.params, locale);
        return {
          title: words.title,
          body: words.body ?? '',
          url,
          tag,
          locale,
        };
      });
    } catch (err) {
      this.log.warn(
        `push for ${event.eventType} failed: ${(err as Error).message}`,
      );
    }
  }
}

/** What happened, as the row stores it, and how its push should behave. */
export interface NotificationEvent {
  eventType: string;
  code: NotificationCode;
  params: NotificationParams;
  payload?: NotificationPayload;
  push?: PushOptions;
}

/** What saying stock is low needs from this service. */
export type LowStockNotifier = Pick<
  NotificationsService,
  'createForMultipleUsers'
>;

/**
 * Tell every active core partner that these products are low
 * (BUSINESS_LOGIC §3). One sentence for all of them, as the receipt or sale
 * that found them would say it. Raised after receiving stock and, since
 * 2026-10-11, after a sale takes a product into low stock. The one place the
 * alert is written, so the two cannot word it or address it differently.
 *
 * Call it after the commit, never inside a transaction: it reaches for the
 * client's own connection (LEARNINGS: Deployment).
 */
export async function notifyLowStock(
  db: Pick<Prisma.TransactionClient, 'user'>,
  notifications: LowStockNotifier,
  products: readonly LowStockRow[],
): Promise<void> {
  if (products.length === 0) return;
  const partners = await db.user.findMany({
    where: { role: 'CORE_PARTNER', status: 'ACTIVE' },
    select: { id: true },
  });
  const userIds = partners.map((u) => u.id);
  if (userIds.length === 0) return;
  await notifications.createForMultipleUsers(userIds, {
    eventType: 'LOW_STOCK_DETECTED',
    code: 'LOW_STOCK_DETECTED',
    params: { products: products.map((p) => p.productName).join(', ') },
    payload: { products: [...products] },
  });
}

/** Ids the event carries, for the link the reader's app builds. */
type NotificationPayload = Record<string, unknown>;

/** The stored shape of a notification: code, params, and the English text. */
export function rowFor(data: {
  eventType: string;
  code: NotificationCode;
  params: NotificationParams;
  payload?: NotificationPayload;
}) {
  return {
    eventType: data.eventType,
    code: data.code,
    params: data.params,
    title: renderNotification(data.code, data.params, 'en').title,
    // The payload is whatever ids the event carries; Prisma stores it as JSON.
    payloadJson: data.payload as Prisma.InputJsonValue | undefined,
  };
}
