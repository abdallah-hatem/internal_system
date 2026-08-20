import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationDto, pageSize } from '../../common/dto/pagination.dto';

@Injectable()
export class LedgerService {
  constructor(private prisma: PrismaService) {}

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
    const { cursor, limit: rawLimit = 20, cycleId, accountId, type, category, direction, from, to } = query;
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
      take: limit + 1,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { createdAt: 'desc' },
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
    if (!transaction) throw new NotFoundException('Financial transaction not found');
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

  async reverse(id: string, reason: string, userId: string) {
    const original = await this.prisma.financialTransaction.findUnique({
      where: { id },
    });
    if (!original) throw new NotFoundException('Financial transaction not found');

    const reversalDirection = original.direction === 'INFLOW' ? 'OUTFLOW' : 'INFLOW';

    const reversal = await this.prisma.financialTransaction.create({
      data: {
        type: original.type,
        category: original.category,
        direction: reversalDirection,
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

    return { data: reversal };
  }
}
