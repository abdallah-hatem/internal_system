import { NotificationsService } from './notifications.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
export declare class NotificationsController {
    private notificationsService;
    constructor(notificationsService: NotificationsService);
    findAll(user: any, query: PaginationDto & {
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
    markAsRead(id: string, user: any): Promise<{
        id: string;
        createdAt: Date;
        userId: string;
        eventType: string;
        title: string;
        payloadJson: import("@prisma/client/runtime/library").JsonValue | null;
        readAt: Date | null;
    }>;
    markAllAsRead(user: any): Promise<{
        data: {
            success: boolean;
        };
    }>;
}
