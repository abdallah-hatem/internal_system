import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
  NotFoundException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationDto } from '../../common/dto/pagination.dto';

@ApiTags('Audit Logs')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('audit-logs')
export class AuditController {
  constructor(private prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: 'List audit logs with filtering and pagination' })
  async findAll(
    @Query()
    query: PaginationDto & {
      entityType?: string;
      entityId?: string;
      actorUserId?: string;
      action?: string;
      from?: string;
      to?: string;
    },
  ) {
    const {
      cursor,
      limit = 20,
      entityType,
      entityId,
      actorUserId,
      action,
      from,
      to,
    } = query;

    const where: any = {};
    if (entityType) where.entityType = entityType;
    if (entityId) where.entityId = entityId;
    if (actorUserId) where.actorUserId = actorUserId;
    if (action) where.action = action;
    if (from || to) {
      where.occurredAt = {};
      if (from) where.occurredAt.gte = new Date(from);
      if (to) where.occurredAt.lte = new Date(to);
    }

    const items = await this.prisma.auditLog.findMany({
      where,
      take: limit + 1,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { occurredAt: 'desc' },
      include: {
        actor: { select: { id: true, email: true } },
      },
    });

    const hasMore = items.length > limit;
    const data = hasMore ? items.slice(0, limit) : items;
    return {
      data,
      meta: {
        nextCursor: hasMore ? data[data.length - 1].id : null,
        limit,
      },
    };
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single audit log by ID' })
  async findOne(@Param('id') id: string) {
    const log = await this.prisma.auditLog.findUnique({
      where: { id },
      include: {
        actor: { select: { id: true, email: true } },
      },
    });
    if (!log) throw new NotFoundException('Audit log not found');
    return { data: log };
  }
}
