import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PrismaService } from '../../prisma/prisma.service';
import {
  PaginationDto,
  pageSize,
  cursorPage,
} from '../../common/dto/pagination.dto';

import { notFound } from '../../common/api-error';
import { assertUuid, isUuid } from '../../common/uuid';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import { withEntityLabels } from './audit-labels';

/**
 * Every audit row carries the full before/after of what changed — sale
 * orders, payments, settlements, users. It is a reading of the whole business,
 * so it is open to the roles that may already read that business: core
 * partners, and admin support, who list sales, payments, the ledger and
 * settlements too. A temporary investor or a shop is refused. Before this the
 * controller named no roles, and the guard's silence meant open (rule 12).
 */
/**
 * Who did it, by the name the office knows them by (owner 2026-10-18: "filter
 * by the 3 users, me, Fares & Shady"). A partner's displayName; an account with
 * no partner record (admin support) has only its email, which the client shows.
 */
const ACTOR = {
  select: {
    id: true,
    email: true,
    partner: { select: { displayName: true } },
  },
} as const;

type WithActor = {
  actor: {
    id: string;
    email: string;
    partner: { displayName: string } | null;
  } | null;
};

function flattenActor<T extends WithActor>(log: T) {
  const { actor, ...rest } = log;
  return {
    ...rest,
    actor: actor
      ? {
          id: actor.id,
          email: actor.email,
          displayName: actor.partner?.displayName ?? null,
        }
      : null,
  };
}

@ApiTags('Audit Logs')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Roles('CORE_PARTNER', 'ADMIN_SUPPORT')
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
      limit: rawLimit = 20,
      entityType,
      entityId,
      actorUserId,
      action,
      from,
      to,
    } = query;
    const limit = pageSize(rawLimit);

    const where: any = {};
    // The "Who" filter. Not an id → 400; an id that is nobody → 404. Either
    // reaching Postgres would fail the uuid cast and come back as a 500.
    if (actorUserId) {
      assertUuid(actorUserId, 'actorUserId');
      const user = await this.prisma.user.findUnique({
        where: { id: actorUserId },
        select: { id: true },
      });
      if (!user) throw notFound('user');
    }
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
      ...cursorPage(cursor, limit),
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      include: { actor: ACTOR },
    });

    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    // The record's name or number, not its UUID (owner 2026-10-18).
    const data = await withEntityLabels(this.prisma, page.map(flattenActor));
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
    if (!isUuid(id)) throw notFound('auditLog');
    const log = await this.prisma.auditLog.findUnique({
      where: { id },
      include: { actor: ACTOR },
    });
    if (!log) throw notFound('auditLog');
    const [data] = await withEntityLabels(this.prisma, [flattenActor(log)]);
    return { data };
  }
}
