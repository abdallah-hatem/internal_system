import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class SettlementsService {
  constructor(private prisma: PrismaService) {}

  async findAll(
    query: PaginationDto & {
      cycleId?: string;
      status?: string;
    },
  ) {
    const { cursor, limit = 20, cycleId, status } = query;

    const where: any = {};
    if (cycleId) where.cycleId = cycleId;
    if (status) where.status = status;

    const items = await this.prisma.settlement.findMany({
      where,
      take: limit + 1,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { createdAt: 'desc' },
      include: {
        cycle: { select: { id: true, code: true, status: true } },
        lines: {
          include: {
            participant: {
              include: {
                partner: {
                  select: {
                    id: true,
                    email: true,
                    partner: { select: { id: true, displayName: true } },
                  },
                },
                investor: { select: { id: true, email: true } },
              },
            },
          },
        },
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
    const settlement = await this.prisma.settlement.findUnique({
      where: { id },
      include: {
        cycle: { select: { id: true, code: true, status: true } },
        lines: {
          include: {
            participant: {
              include: {
                partner: {
                  select: {
                    id: true,
                    email: true,
                    partner: { select: { id: true, displayName: true } },
                  },
                },
                investor: { select: { id: true, email: true } },
              },
            },
          },
        },
      },
    });
    if (!settlement) throw new NotFoundException('Settlement not found');
    return { data: settlement };
  }

  async calculate(cycleId: string) {
    const cycle = await this.prisma.importCycle.findUnique({
      where: { id: cycleId },
    });
    if (!cycle) throw new NotFoundException('Cycle not found');

    // Get cycle participants
    const participants = await this.prisma.cycleParticipant.findMany({
      where: { cycleId },
    });
    if (participants.length === 0) {
      throw new BadRequestException('No participants found for this cycle');
    }

    // Get cycle financial transactions to compute totals
    const transactions = await this.prisma.financialTransaction.findMany({
      where: { cycleId },
    });

    // Aggregate totals by category
    const purchaseTotal = transactions
      .filter((t) => t.category === 'purchase' && t.direction === 'OUTFLOW')
      .reduce((sum, t) => sum.add(t.amount), new Prisma.Decimal(0));

    const shippingTotal = transactions
      .filter((t) => t.category === 'shipping' && t.direction === 'OUTFLOW')
      .reduce((sum, t) => sum.add(t.amount), new Prisma.Decimal(0));

    const feesTotal = transactions
      .filter((t) => t.category === 'fees' && t.direction === 'OUTFLOW')
      .reduce((sum, t) => sum.add(t.amount), new Prisma.Decimal(0));

    const totalCost = purchaseTotal.add(shippingTotal).add(feesTotal);

    // Compute total contribution
    const totalContribution = participants.reduce(
      (sum, p) => sum.add(p.contributionAmount),
      new Prisma.Decimal(0),
    );

    // Calculate the settlement lines per participant
    const settlementLines = participants.map((participant) => {
      const pct = totalContribution.gt(0)
        ? participant.contributionAmount.div(totalContribution)
        : new Prisma.Decimal(0);

      const purchaseShare = purchaseTotal.mul(pct);
      const shippingShare = shippingTotal.mul(pct);
      const feesShare = feesTotal.mul(pct);

      return {
        participantId: participant.id,
        purchaseShare: Number(purchaseShare),
        shippingShare: Number(shippingShare),
        feesShare: Number(feesShare),
        totalShare: Number(purchaseShare.add(shippingShare).add(feesShare)),
      };
    });

    // Create settlement with lines using a transaction
    const settlement = await this.prisma.$transaction(async (tx) => {
      const created = await tx.settlement.create({
        data: {
          cycleId,
          status: 'DRAFT',
          calculatedAt: new Date(),
        },
      });

      for (const line of settlementLines) {
        // Create one line per component
        await tx.settlementLine.create({
          data: {
            settlementId: created.id,
            participantId: line.participantId,
            component: 'purchase',
            amount: line.purchaseShare,
          },
        });
        await tx.settlementLine.create({
          data: {
            settlementId: created.id,
            participantId: line.participantId,
            component: 'shipping',
            amount: line.shippingShare,
          },
        });
        await tx.settlementLine.create({
          data: {
            settlementId: created.id,
            participantId: line.participantId,
            component: 'fees',
            amount: line.feesShare,
          },
        });
      }

      return tx.settlement.findUnique({
        where: { id: created.id },
        include: {
          cycle: { select: { id: true, code: true, status: true } },
          lines: {
            include: {
              participant: {
                include: {
                  partner: {
                    select: {
                      id: true,
                      email: true,
                      partner: { select: { id: true, displayName: true } },
                    },
                  },
                  investor: { select: { id: true, email: true } },
                },
              },
            },
          },
        },
      });
    });

    return { data: settlement };
  }

  async approve(id: string) {
    const settlement = await this.prisma.settlement.findUnique({ where: { id } });
    if (!settlement) throw new NotFoundException('Settlement not found');
    if (settlement.status !== 'DRAFT') {
      throw new BadRequestException('Only DRAFT settlements can be approved');
    }

    const updated = await this.prisma.settlement.update({
      where: { id },
      data: {
        status: 'APPROVED',
        approvedAt: new Date(),
      },
      include: {
        cycle: { select: { id: true, code: true, status: true } },
      },
    });

    return { data: updated };
  }

  async markPaid(id: string) {
    const settlement = await this.prisma.settlement.findUnique({ where: { id } });
    if (!settlement) throw new NotFoundException('Settlement not found');
    if (settlement.status !== 'APPROVED') {
      throw new BadRequestException('Only APPROVED settlements can be marked as paid');
    }

    const updated = await this.prisma.settlement.update({
      where: { id },
      data: {
        status: 'PAID',
        paidAt: new Date(),
      },
      include: {
        cycle: { select: { id: true, code: true, status: true } },
      },
    });

    return { data: updated };
  }

  async reverse(id: string, reason: string) {
    const settlement = await this.prisma.settlement.findUnique({ where: { id } });
    if (!settlement) throw new NotFoundException('Settlement not found');
    if (settlement.status === 'REVERSED') {
      throw new BadRequestException('Settlement is already reversed');
    }

    const updated = await this.prisma.settlement.update({
      where: { id },
      data: {
        status: 'REVERSED',
      },
      include: {
        cycle: { select: { id: true, code: true, status: true } },
      },
    });

    return { data: updated };
  }
}
