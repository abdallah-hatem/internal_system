import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  PaginationDto,
  pageSize,
  cursorPage,
} from '../../common/dto/pagination.dto';
import { AuditService } from '../audit/audit.service';

import { badRequest, notFound } from '../../common/api-error';
import { TRANSFER_CATEGORY } from '../../common/ledger-categories';
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

  async create(
    data: {
      type: string;
      category: string;
      direction: 'INFLOW' | 'OUTFLOW';
      amount: number;
      currency: string;
      fxRateToEgp?: number;
      accountId?: string;
      cycleId?: string;
      relatedType?: string;
      relatedId?: string;
      reason?: string;
    },
    userId: string,
  ) {
    // A transfer of leftovers between cycles (§8, L5) is written only by the
    // transfer, in pairs, with its record behind it. Typed by hand it would
    // move a cycle's cost with no stock behind it.
    if (data.category === TRANSFER_CATEGORY) {
      throw badRequest(
        'LEDGER_CATEGORY_RESERVED',
        'Moving leftover stock between cycles is recorded from the cycle page, not as a ledger entry.',
        { category: data.category },
      );
    }
    const transaction = await this.prisma.financialTransaction.create({
      data: {
        type: data.type,
        category: data.category,
        direction: data.direction,
        amount: data.amount,
        currency: data.currency,
        fxRateToEgp: data.fxRateToEgp,
        accountId: data.accountId,
        cycleId: data.cycleId,
        relatedType: data.relatedType,
        relatedId: data.relatedId,
        reason: data.reason,
        createdBy: userId,
      },
      include: {
        cycle: { select: { id: true, code: true } },
        account: { select: { id: true, name: true } },
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
