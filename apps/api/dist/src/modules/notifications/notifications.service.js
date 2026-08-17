"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotificationsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
let NotificationsService = class NotificationsService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async findAll(userId, pagination) {
        const { cursor, limit = 20, unreadOnly } = pagination;
        const where = { userId };
        if (unreadOnly)
            where.readAt = null;
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
    async markAsRead(id, userId) {
        const notification = await this.prisma.notification.findFirst({
            where: { id, userId },
        });
        if (!notification)
            throw new common_1.NotFoundException('Notification not found');
        return this.prisma.notification.update({
            where: { id },
            data: { readAt: new Date() },
        });
    }
    async markAllAsRead(userId) {
        await this.prisma.notification.updateMany({
            where: { userId, readAt: null },
            data: { readAt: new Date() },
        });
        return { data: { success: true } };
    }
    async create(data) {
        return this.prisma.notification.create({
            data: {
                userId: data.userId,
                eventType: data.eventType,
                title: data.title,
                payloadJson: data.payload ?? undefined,
            },
        });
    }
    async createForMultipleUsers(userIds, data) {
        const notifications = userIds.map(userId => ({
            userId,
            eventType: data.eventType,
            title: data.title,
            payloadJson: data.payload ?? undefined,
        }));
        return this.prisma.notification.createMany({ data: notifications });
    }
};
exports.NotificationsService = NotificationsService;
exports.NotificationsService = NotificationsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], NotificationsService);
//# sourceMappingURL=notifications.service.js.map