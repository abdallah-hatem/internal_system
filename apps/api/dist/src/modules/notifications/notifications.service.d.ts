import { PrismaService } from '../../prisma/prisma.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
export declare class NotificationsService {
    private prisma;
    constructor(prisma: PrismaService);
    findAll(userId: string, pagination: PaginationDto & {
        unreadOnly?: boolean;
    }): Promise<{
        data: {
            id: string;
            createdAt: Date;
            userId: string;
            eventType: string;
            title: string;
            payloadJson: import("@prisma/client/runtime/library").JsonValue | null;
            readAt: Date | null;
        }[];
        meta: {
            nextCursor: string | null;
            limit: number;
            unreadCount: number;
        };
    }>;
    markAsRead(id: string, userId: string): Promise<{
        id: string;
        createdAt: Date;
        userId: string;
        eventType: string;
        title: string;
        payloadJson: import("@prisma/client/runtime/library").JsonValue | null;
        readAt: Date | null;
    }>;
    markAllAsRead(userId: string): Promise<{
        data: {
            success: boolean;
        };
    }>;
    create(data: {
        userId: string;
        eventType: string;
        title: string;
        payload?: any;
    }): Promise<{
        id: string;
        createdAt: Date;
        userId: string;
        eventType: string;
        title: string;
        payloadJson: import("@prisma/client/runtime/library").JsonValue | null;
        readAt: Date | null;
    }>;
    createForMultipleUsers(userIds: string[], data: {
        eventType: string;
        title: string;
        payload?: any;
    }): Promise<import(".prisma/client").Prisma.BatchPayload>;
}
