import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PrismaService } from '../../prisma/prisma.service';
import {
  listRows,
  type ListQuery,
  shown,
  searchOf,
  sortOf,
} from '../../common/list-query';
import { searchIds } from '../../common/repositories/list-search';

import { badRequest, notFound } from '../../common/api-error';
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

/** A filter and an order of audit rows, in the shapes the client takes (a controller names no Prisma types). */
type AuditFind = NonNullable<
  Parameters<PrismaService['auditLog']['findMany']>[0]
>;
type AuditWhere = NonNullable<AuditFind['where']>;
type AuditOrder = Extract<AuditFind['orderBy'], unknown[]>;

/** The Audit log's orders; the first is the default. Each ends on `id`. */
const AUDIT_SORTS = {
  newest: [{ occurredAt: 'desc' }, { id: 'desc' }],
} satisfies Record<string, AuditOrder>;

/** An action or record type is a code: capitals, digits and underscores. */
const CODE = /^[A-Za-z0-9_]{1,60}$/;

/**
 * `labels`: the action and record-type codes whose names, in the reader's
 * language, contain the search — the office knows the words, the API the
 * codes, so "إنشاء" still finds every CREATE. Comma-separated codes only.
 */
function labelCodes(value: unknown): string[] {
  if (value === undefined || value === null || value === '') return [];
  const codes = typeof value === 'string' ? value.split(',') : [];
  if (
    codes.length === 0 ||
    codes.length > 200 ||
    !codes.every((c) => CODE.test(c))
  ) {
    throw badRequest(
      'LIST_FILTER_INVALID',
      `labels cannot be "${shown(value)}" (it is codes, comma-separated).`,
      { field: 'labels', value: shown(value) },
    );
  }
  return codes;
}

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
    query: ListQuery & {
      entityType?: string;
      entityId?: string;
      actorUserId?: string;
      action?: string;
      from?: string;
      to?: string;
      labels?: string;
    },
  ) {
    const { entityType, entityId, actorUserId, action, from, to } = query;
    const search = searchOf(query);
    const labels = labelCodes(query.labels);
    const { orderBy } = sortOf(query, AUDIT_SORTS);

    const where: AuditWhere = {};
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
    if (typeof entityType === 'string' && entityType)
      where.entityType = entityType;
    if (entityId) {
      assertUuid(entityId, 'entityId');
      where.entityId = entityId;
    }
    if (actorUserId) where.actorUserId = actorUserId;
    if (typeof action === 'string' && action) where.action = action;
    if (from || to) {
      where.occurredAt = {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lte: new Date(to) } : {}),
      };
    }
    // The search (server-side lists, owner 2026-10-25): who did it, by name
    // or email; the record as it was written, before and after — its name,
    // number, amount; the codes; and the codes whose names in the reader's
    // language matched (`labels`).
    if (search) {
      const ids = await searchIds(
        this.prisma,
        `audit_logs t
          LEFT JOIN users u ON u.id = t.actor_user_id
          LEFT JOIN partners p ON p.user_id = u.id`,
        [
          `t.action`,
          `t.entity_type`,
          `t.before_json::text`,
          `t.after_json::text`,
          `u.email`,
          `p.display_name`,
        ],
        search,
      );
      where.OR = [
        { id: { in: ids } },
        ...(labels.length
          ? [{ action: { in: labels } }, { entityType: { in: labels } }]
          : []),
      ];
    }

    const { rows, meta } = await listRows(query, {
      rows: (window) =>
        this.prisma.auditLog.findMany({
          where,
          orderBy,
          include: { actor: ACTOR },
          ...window,
        }),
      count: () => this.prisma.auditLog.count({ where }),
    });
    // The record's name or number, not its UUID (owner 2026-10-18).
    const data = await withEntityLabels(this.prisma, rows.map(flattenActor));
    return { data, meta };
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
