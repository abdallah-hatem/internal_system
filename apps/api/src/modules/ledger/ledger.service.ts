import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  PaginationDto,
  pageSize,
  cursorPage,
} from '../../common/dto/pagination.dto';
import { AuditService } from '../audit/audit.service';

import { badRequest, notFound } from '../../common/api-error';
import { isUuid } from '../../common/uuid';
import { businessToday } from '../../common/dates';
import { CLOSED_CYCLE_STATUSES } from '../../common/manual-ledger-categories';
import { CreateLedgerEntryDto } from './dto/ledger.dto';
import { checkManualEntry } from './manual-entry';
import { fixRunningCostShares } from '../../common/running-costs';

@Injectable()
export class LedgerService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async findAll(
    query: PaginationDto & {
      cycleId?: string;
      accountId?: string;
      type?: string;
      category?: string;
      direction?: string;
      from?: string;
      to?: string;
    },
  ) {
    const {
      cursor,
      limit: rawLimit = 20,
      cycleId,
      accountId,
      type,
      category,
      direction,
      from,
      to,
    } = query;
    const limit = pageSize(rawLimit);

    const where: any = {};
    if (cycleId) where.cycleId = cycleId;
    if (accountId) where.accountId = accountId;
    if (type) where.type = type;
    if (category) where.category = category;
    if (direction) where.direction = direction;
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to);
    }

    const items = await this.prisma.financialTransaction.findMany({
      where,
      ...cursorPage(cursor, limit),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        cycle: { select: { id: true, code: true } },
        account: { select: { id: true, name: true } },
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

  async findOne(id: string) {
    const transaction = await this.prisma.financialTransaction.findUnique({
      where: { id },
      include: {
        cycle: { select: { id: true, code: true } },
        account: { select: { id: true, name: true } },
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
        account: { select: { id: true, name: true } },
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

  /** Active money accounts, for the pickers that move money (§18). */
  async accounts() {
    const data = await this.prisma.moneyAccount.findMany({
      where: { active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, accountType: true, currency: true },
    });
    return { data };
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
        accountId: original.accountId,
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
        account: { select: { id: true, name: true } },
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
