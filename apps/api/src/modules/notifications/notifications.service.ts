import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  PaginationDto,
  pageSize,
  cursorPage,
} from '../../common/dto/pagination.dto';

import type { Prisma } from '@prisma/client';
import { notFound } from '../../common/api-error';
import type { LowStockRow } from '../../common/low-stock';
import {
  renderNotification,
  type NotificationCode,
  type NotificationParams,
} from '../../common/notification-messages';

@Injectable()
export class NotificationsService {
  constructor(private prisma: PrismaService) {}

  async findAll(
    userId: string,
    pagination: PaginationDto & { unreadOnly?: boolean },
  ) {
    const { cursor, limit: rawLimit = 20, unreadOnly } = pagination;
    const limit = pageSize(rawLimit);
    const where: any = { userId };
    if (unreadOnly) where.readAt = null;

    const items = await this.prisma.notification.findMany({
      where,
      ...cursorPage(cursor, limit),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });

    const hasMore = items.length > limit;
    const data = hasMore ? items.slice(0, limit) : items;

    return {
      data,
      meta: {
        nextCursor: hasMore ? data[data.length - 1].id : null,
        limit,
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
   * Write one notification. The caller names it with a `code` and `params`;
   * the English `title` is derived here, so no service writes the sentence
   * itself (CLAUDE.md rule 9) and the two cannot disagree.
   */
  async create(data: {
    userId: string;
    eventType: string;
    code: NotificationCode;
    params: NotificationParams;
    payload?: NotificationPayload;
  }) {
    return this.prisma.notification.create({
      data: { userId: data.userId, ...rowFor(data) },
    });
  }

  async createForMultipleUsers(
    userIds: string[],
    data: {
      eventType: string;
      code: NotificationCode;
      params: NotificationParams;
      payload?: NotificationPayload;
    },
  ) {
    const row = rowFor(data);
    return this.prisma.notification.createMany({
      data: userIds.map((userId) => ({ userId, ...row })),
    });
  }
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
