import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { Prisma } from '@prisma/client';
import {
  filterOf,
  listRows,
  type ListQuery,
  shown,
  searchOf,
  sortOf,
} from '../../common/list-query';
import { searchIds } from '../../common/repositories/list-search';
import { AuditService } from '../audit/audit.service';

import { badRequest, notFound } from '../../common/api-error';
import { assertUuid, isUuid } from '../../common/uuid';
import { businessToday } from '../../common/dates';
import { CLOSED_CYCLE_STATUSES } from '../../common/manual-ledger-categories';
import { CreateLedgerEntryDto } from './dto/ledger.dto';
import { checkManualEntry } from './manual-entry';
import { fixRunningCostShares } from '../../common/running-costs';

/** The Ledger list's orders; the first is the default. Each ends on `id`. */
const LEDGER_SORTS = {
  newest: [{ createdAt: 'desc' }, { id: 'desc' }],
} satisfies Record<
  string,
  Prisma.FinancialTransactionOrderByWithRelationInput[]
>;

/** A ledger type is a code: capitals and underscores. */
const LEDGER_TYPE = /^[A-Z_]{1,60}$/;

/**
 * `type` as the list sends it: one code, or several joined by commas (the
 * office shows some types under one name — "Purchase" is PURCHASE and
 * PURCHASE_PAYMENT). Anything that is not a code is refused.
 */
function ledgerTypes(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const types = typeof value === 'string' ? value.split(',') : [];
  if (types.length === 0 || !types.every((t) => LEDGER_TYPE.test(t))) {
    throw badRequest(
      'LIST_FILTER_INVALID',
      `type cannot be "${shown(value)}" (it is one or more codes, comma-separated).`,
      { field: 'type', value: shown(value) },
    );
  }
  return types;
}

@Injectable()
export class LedgerService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  /**
   * The Ledger list (server-side lists, owner 2026-10-25): searched,
   * filtered, counted and paged here (`common/list-query.ts`).
   *
   *   direction  INFLOW | OUTFLOW
   *   type       one type code, or several comma-separated
   *   category   one category, exactly as stored
   *   cycleId    one cycle's rows
   *   search     type, category, reason or amount
   */
  async findAll(
    query: ListQuery & {
      cycleId?: string;
      type?: string;
      category?: string;
      direction?: string;
      from?: string;
      to?: string;
    },
  ) {
    const { cycleId, category, from, to } = query;
    if (cycleId) assertUuid(cycleId, 'cycleId');
    const types = ledgerTypes(query.type);
    const direction = filterOf(query.direction, 'direction', [
      'INFLOW',
      'OUTFLOW',
    ] as const);
    const search = searchOf(query);
    const { orderBy } = sortOf(query, LEDGER_SORTS);

    const where: Prisma.FinancialTransactionWhereInput = {};
    if (cycleId) where.cycleId = cycleId;
    if (types) where.type = { in: types };
    if (typeof category === 'string' && category) where.category = category;
    if (direction) where.direction = direction;
    if (from || to) {
      where.createdAt = {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lte: new Date(to) } : {}),
      };
    }
    if (search) {
      where.id = {
        in: await searchIds(
          this.prisma,
          `financial_transactions t`,
          [`t.type`, `t.category`, `t.reason`, `t.amount::text`],
          search,
        ),
      };
    }

    const { rows, meta } = await listRows(query, {
      rows: (window) =>
        this.prisma.financialTransaction.findMany({
          where,
          orderBy,
          include: {
            cycle: { select: { id: true, code: true } },
            // Who recorded it (owner 2026-10-22: a column for the user).
            actor: {
              select: {
                id: true,
                email: true,
                partner: { select: { displayName: true } },
              },
            },
          },
          ...window,
        }),
      count: () => this.prisma.financialTransaction.count({ where }),
    });
    return { data: rows, meta };
  }

  /**
   * Every category the ledger holds, for the list's category filter — which
   * used to offer only the categories of the rows the browser had loaded.
   */
  async categories() {
    const rows = await this.prisma.financialTransaction.findMany({
      distinct: ['category'],
      select: { category: true },
      orderBy: { category: 'asc' },
    });
    return { data: rows.map((r) => r.category).filter(Boolean) };
  }

  async findOne(id: string) {
    // Not an id at all — `GET /ledger/accounts`, removed 2026-10-14, lands
    // here now: a 404, never Prisma's malformed-uuid 500.
    if (!isUuid(id)) throw notFound('financialTransaction');
    const transaction = await this.prisma.financialTransaction.findUnique({
      where: { id },
      include: {
        cycle: { select: { id: true, code: true } },
      },
    });
    if (!transaction) throw notFound('financialTransaction');
    return { data: transaction };
  }

  /**
   * Record money in or out by hand (BUSINESS_LOGIC §9, L6).
   *
   * This used to save whatever it was sent, so a partner could write category
   * `purchase`, `contribution` or `settlement` in either direction and move
   * cash, profit or a settlement with no flow knowing. A manual entry is now
   * an expense or other income from the one list, the kind fixes the
   * direction, and every other rule a person could slip on is checked here,
   * whoever calls (rule 3).
   */
  async create(dto: CreateLedgerEntryDto, userId: string) {
    const entry = checkManualEntry(dto);

    let cycleId: string | null = null;
    if (dto.cycleId) {
      // A cycle code or anything else that is not an id reads as missing,
      // never as Postgres failing the cast (rule 1).
      if (!isUuid(dto.cycleId)) throw notFound('cycle');
      const cycle = await this.prisma.importCycle.findUnique({
        where: { id: dto.cycleId },
        select: { id: true, code: true, status: true },
      });
      if (!cycle) throw notFound('cycle');
      if (CLOSED_CYCLE_STATUSES.includes(cycle.status)) {
        throw badRequest(
          'LEDGER_CYCLE_NOT_OPEN',
          `Cycle ${cycle.code} is ${cycle.status.toLowerCase()}, so nothing more can be charged to it.`,
          { cycle: cycle.code, status: cycle.status },
        );
      }
      cycleId = cycle.id;
    }

    const transaction = await this.prisma.financialTransaction.create({
      data: {
        type: entry.type,
        category: entry.category,
        direction: entry.direction,
        // Pounds: the settlement and the dashboard sum `amount` as EGP.
        amount: entry.amountEgp,
        currency: 'EGP',
        fxRateToEgp: entry.rate,
        originalAmount: entry.original?.amount ?? null,
        originalCurrency: entry.original?.currency ?? null,
        occurredOn: new Date(`${entry.occurredOn}T00:00:00Z`),
        cycleId,
        reason: entry.note,
        createdBy: userId,
      },
      include: {
        cycle: { select: { id: true, code: true } },
      },
    });

    // A running cost (an expense with no cycle, §8 L7): its shares are fixed
    // now, over the core partners of its own day — whoever joins or leaves
    // later, they never move.
    if (!cycleId && entry.direction === 'OUTFLOW') {
      await fixRunningCostShares(this.prisma);
    }

    // After the write, never inside a transaction (LEARNINGS: deployment).
    await this.audit.log({
      actorUserId: userId,
      action: 'CREATE',
      entityType: 'FinancialTransaction',
      entityId: transaction.id,
      afterJson: {
        kind: entry.kind,
        category: entry.category,
        direction: entry.direction,
        amountEgp: entry.amountEgp.toFixed(2),
        occurredOn: entry.occurredOn,
        cycleId,
      },
    });

    return { data: transaction };
  }

  /**
   * Reverse a financial entry.
   *
   * History is never rewritten (BRD 10), so this writes a balancing entry
   * pointing back at the original rather than editing or deleting it.
   *
   * Only manual entries can be reversed here. An entry raised by a flow — a
   * settlement payout, a sale's revenue, a return, a received payment — is
   * owned by that record, and reversing the line on its own would leave the
   * ledger and the thing it describes disagreeing. Those have their own
   * reversal paths.
   */
  async reverse(id: string, reason: string, userId: string) {
    if (!reason?.trim()) {
      throw badRequest(
        'REVERSAL_REASON_REQUIRED',
        'A reason is required to reverse an entry',
      );
    }

    // An id that cannot be one is not an entry (CLAUDE.md §1): asked of
    // Postgres it failed the uuid cast and answered 500.
    if (!isUuid(id)) throw notFound('financialTransaction');
    const original = await this.prisma.financialTransaction.findUnique({
      where: { id },
    });
    if (!original) throw notFound('financialTransaction');

    if (original.reversalOfId) {
      throw badRequest(
        'ENTRY_IS_A_REVERSAL',
        'This entry is itself a reversal. Reversing it would start a chain that ' +
          'nets to nothing but obscures what happened; raise a new entry instead.',
      );
    }

    const existingReversal = await this.prisma.financialTransaction.findFirst({
      where: { reversalOfId: id },
      select: { id: true, createdAt: true },
    });
    if (existingReversal) {
      throw badRequest(
        'ENTRY_ALREADY_REVERSED',
        `This entry was already reversed on ${existingReversal.createdAt
          .toISOString()
          .slice(0, 10)}. Reversing again would double-count the correction.`,
        { date: existingReversal.createdAt.toISOString().slice(0, 10) },
      );
    }

    if (original.relatedType) {
      throw badRequest(
        'ENTRY_OWNED_ELSEWHERE',
        `This entry belongs to a ${original.relatedType
          .toLowerCase()
          .replace(
            /_/g,
            ' ',
          )} and cannot be reversed on its own — the ledger and ` +
          'that record would stop agreeing. Reverse it from there instead.',
        // The code (SALE_RETURN), not the English words: the web says it as
        // `codes.referenceType.<CODE>` in the reader's language (rule 9).
        { owner: original.relatedType },
      );
    }

    // A closed cycle's profit is settled and paid out; taking a cost back off
    // it now would change a figure the partners were already paid on (L6).
    if (original.cycleId) {
      const cycle = await this.prisma.importCycle.findUnique({
        where: { id: original.cycleId },
        select: { code: true, status: true },
      });
      if (cycle && CLOSED_CYCLE_STATUSES.includes(cycle.status)) {
        throw badRequest(
          'LEDGER_CYCLE_NOT_OPEN',
          `Cycle ${cycle.code} is ${cycle.status.toLowerCase()}, so nothing more can be charged to it.`,
          { cycle: cycle.code, status: cycle.status },
        );
      }
    }

    // A running cost already taken from a partner's payout (§8, L7): he was
    // paid less for it. Undoing it now would leave that money taken for a
    // cost that no longer exists. Reverse the settlement first; that puts the
    // charge back to waiting, and then the cost can go.
    if (!original.cycleId) {
      const taken = await this.prisma.runningCostCharge.findMany({
        where: { costEntryId: id, releasedAt: null },
        select: {
          settlement: { select: { cycle: { select: { code: true } } } },
        },
      });
      if (taken.length > 0) {
        const cycles = [
          ...new Set(taken.map((t) => t.settlement.cycle.code)),
        ].join(', ');
        throw badRequest(
          'RUNNING_COST_CHARGED',
          `This running cost was already taken from a payout (${cycles}). ` +
            'Reverse that settlement first, then this entry.',
          { cycles },
        );
      }
    }

    const reversal = await this.prisma.financialTransaction.create({
      data: {
        type: original.type,
        category: original.category,
        // Mirror the original so the pair nets to zero.
        direction: original.direction === 'INFLOW' ? 'OUTFLOW' : 'INFLOW',
        amount: original.amount,
        currency: original.currency,
        fxRateToEgp: original.fxRateToEgp,
        cycleId: original.cycleId,
        relatedType: original.relatedType,
        relatedId: original.relatedId,
        reversalOfId: id,
        // Undone today, in Cairo; what was paid travels with it (L6).
        occurredOn: new Date(`${businessToday()}T00:00:00Z`),
        originalAmount: original.originalAmount,
        originalCurrency: original.originalCurrency,
        reason,
        createdBy: userId,
      },
      include: {
        cycle: { select: { id: true, code: true } },
      },
    });

    await this.audit.log({
      actorUserId: userId,
      action: 'REVERSE',
      entityType: 'FinancialTransaction',
      entityId: id,
      beforeJson: {
        direction: original.direction,
        amount: original.amount.toFixed(2),
        category: original.category,
      },
      afterJson: { reversalId: reversal.id, reason },
    });

    return { data: reversal };
  }
}
