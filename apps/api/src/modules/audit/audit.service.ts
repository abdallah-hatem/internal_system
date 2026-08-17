import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}

  async log(params: {
    actorUserId?: string;
    action: string;
    entityType: string;
    entityId: string;
    beforeJson?: any;
    afterJson?: any;
    correlationId?: string;
    sourceIp?: string;
    userAgent?: string;
  }) {
    return this.prisma.auditLog.create({
      data: {
        actorUserId: params.actorUserId,
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId,
        beforeJson: params.beforeJson ?? undefined,
        afterJson: params.afterJson ?? undefined,
        correlationId: params.correlationId ?? undefined,
        sourceIp: params.sourceIp ?? undefined,
        userAgent: params.userAgent ?? undefined,
      },
    });
  }
}
