import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationDto, pageSize } from '../../common/dto/pagination.dto';

@Injectable()
export class NotificationsService {
  constructor(private prisma: PrismaService) {}

  async findAll(userId: string, pagination: PaginationDto & { unreadOnly?: boolean }) {
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
        unreadCount: await this.prisma.notification.count({ where: { userId, readAt: null } }),
      },
    };
  }

  async markAsRead(id: string, userId: string) {
    const notification = await this.prisma.notification.findFirst({
      where: { id, userId },
    });
    if (!notification) throw new NotFoundException('Notification not found');

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

  async create(data: { userId: string; eventType: string; title: string; payload?: any }) {
    return this.prisma.notification.create({
      data: {
        userId: data.userId,
        eventType: data.eventType,
        title: data.title,
        payloadJson: data.payload ?? undefined,
      },
    });
  }

  async createForMultipleUsers(userIds: string[], data: { eventType: string; title: string; payload?: any }) {
    const notifications = userIds.map(userId => ({
      userId,
      eventType: data.eventType,
      title: data.title,
      payloadJson: data.payload ?? undefined,
    }));
    return this.prisma.notification.createMany({ data: notifications });
  }
}
