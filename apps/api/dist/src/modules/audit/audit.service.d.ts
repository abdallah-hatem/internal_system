import { PrismaService } from '../../prisma/prisma.service';
export declare class AuditService {
    private prisma;
    constructor(prisma: PrismaService);
    log(params: {
        actorUserId?: string;
        action: string;
        entityType: string;
        entityId: string;
        beforeJson?: any;
        afterJson?: any;
        correlationId?: string;
        sourceIp?: string;
        userAgent?: string;
    }): Promise<{
        id: string;
        action: string;
        entityType: string;
        entityId: string;
        beforeJson: import("@prisma/client/runtime/library").JsonValue | null;
        afterJson: import("@prisma/client/runtime/library").JsonValue | null;
        correlationId: string | null;
        sourceIp: string | null;
        userAgent: string | null;
        occurredAt: Date;
        actorUserId: string | null;
    }>;
}
