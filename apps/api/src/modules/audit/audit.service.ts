import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}

  async log(
    params: {
      actorUserId?: string;
      action: string;
      entityType: string;
      entityId: string;
      beforeJson?: any;
      afterJson?: any;
      correlationId?: string;
      sourceIp?: string;
      userAgent?: string;
    },
    /**
     * The transaction the change was made in, when there is one. The entry is
     * then part of that change: kept if it commits, gone if it rolls back — and
     * written on the transaction's own connection, which a second connection
     * would deadlock against.
     */
    db: Pick<Prisma.TransactionClient, 'auditLog'> = this.prisma,
  ) {
    return db.auditLog.create({
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
