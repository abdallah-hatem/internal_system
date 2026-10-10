import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationDto, pageSize } from '../../common/dto/pagination.dto';

import type { Prisma } from '@prisma/client';
import { notFound } from '../../common/api-error';
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
      take: limit + 1,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { createdAt: 'desc' },
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
