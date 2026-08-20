import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { CostingService } from '../costing/costing.service';
import { Prisma, ShippingCostBasis } from '@prisma/client';

@Injectable()
export class ShippingService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private notifications: NotificationsService,
    private costing: CostingService,
  ) {}

  async findAll(pagination: PaginationDto & { cycleId?: string }) {
    const { cursor, limit = 20, cycleId } = pagination;
    const where: any = {};
    if (cycleId) where.cycleId = cycleId;

    const items = await this.prisma.shippingLeg.findMany({
      where,
      take: limit + 1,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: [{ cycleId: 'asc' }, { sequence: 'asc' }],
      include: { cycle: true },
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

  async findByCycle(cycleId: string) {
    const legs = await this.prisma.shippingLeg.findMany({
      where: { cycleId },
      orderBy: { sequence: 'asc' },
    });
    return { data: legs };
  }

  async createLeg(
    cycleId: string,
    data: {
      sequence: number;
      origin: string;
      destination: string;
      provider?: string;
      providerId?: string;
      trackingRef?: string;
      costBasis?: ShippingCostBasis;
      ratePerUnit?: number;
      chargeablePieces?: number;
      chargeableWeightKg?: number;
      currency?: string;
      fxRateToEgp?: number;
      amount?: number;
    },
    actorId: string,
  ) {
    const cycle = await this.prisma.importCycle.findUnique({
      where: { id: cycleId },
    });
    if (!cycle) throw new NotFoundException('Cycle not found');

    // Validate: UAE_DIRECT cycles only allow sequence 1 (UAE→Egypt)
    if (cycle.originType === 'UAE_DIRECT' && data.sequence !== 1) {
      throw new BadRequestException(
        'UAE_DIRECT cycles only allow a single shipping leg (sequence 1: UAE to Egypt)',
      );
    }

    // Validate destination for UAE_DIRECT
    if (cycle.originType === 'UAE_DIRECT' && data.sequence === 1) {
      if (
        !data.origin.toUpperCase().includes('UAE') ||
        !data.destination.toUpperCase().includes('EGYPT')
      ) {
        throw new BadRequestException(
          'UAE_DIRECT cycle shipping leg must go from UAE to Egypt',
        );
      }
    }

    // China cycles ship in two legs: 1 = China->UAE (merchant), 2 = UAE->Egypt
    // (shipping company). Anything beyond sequence 2 is not a real route.
    if (cycle.originType === 'CHINA' && ![1, 2].includes(data.sequence)) {
      throw new BadRequestException(
        'CHINA cycles have at most two shipping legs (sequence 1: China to UAE, sequence 2: UAE to Egypt)',
      );
    }

    // Check sequence uniqueness within cycle
    const existingLeg = await this.prisma.shippingLeg.findUnique({
      where: { cycleId_sequence: { cycleId, sequence: data.sequence } },
    });
    if (existingLeg) {
      throw new BadRequestException(
        `Shipping leg with sequence ${data.sequence} already exists for this cycle`,
      );
    }

    const costFields = this.buildCostFields(data);

    const leg = await this.prisma.shippingLeg.create({
      data: {
        cycleId,
        sequence: data.sequence,
        origin: data.origin,
        destination: data.destination,
        provider: data.provider,
        providerId: data.providerId,
        trackingRef: data.trackingRef,
        ...costFields,
      },
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'CREATE',
      entityType: 'ShippingLeg',
      entityId: leg.id,
      afterJson: leg,
    });

    return { data: leg };
  }

  async updateLeg(
    id: string,
    data: {
      status?: string;
      departedOn?: string;
      arrivedOn?: string;
      amount?: number;
      provider?: string;
      providerId?: string;
      trackingRef?: string;
      costBasis?: ShippingCostBasis;
      ratePerUnit?: number;
      chargeablePieces?: number;
      chargeableWeightKg?: number;
      currency?: string;
      fxRateToEgp?: number;
    },
    actorId: string,
  ) {
    const existing = await this.prisma.shippingLeg.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Shipping leg not found');

    // Recompute the EGP amount from the merged (existing + incoming) state so a
    // partial update of just the rate or the piece count stays consistent.
    const merged = {
      costBasis: data.costBasis ?? existing.costBasis,
      ratePerUnit: data.ratePerUnit ?? existing.ratePerUnit,
      chargeablePieces: data.chargeablePieces ?? existing.chargeablePieces,
      chargeableWeightKg: data.chargeableWeightKg ?? existing.chargeableWeightKg,
      amount: data.amount ?? existing.amount,
      fxRateToEgp: data.fxRateToEgp ?? existing.fxRateToEgp,
    };
    const costFields = this.buildCostFields({ ...merged, currency: data.currency });

    const updated = await this.prisma.shippingLeg.update({
      where: { id },
      data: {
        status: data.status,
        departedOn: data.departedOn ? new Date(data.departedOn) : undefined,
        arrivedOn: data.arrivedOn ? new Date(data.arrivedOn) : undefined,
        provider: data.provider,
        providerId: data.providerId,
        trackingRef: data.trackingRef,
        ...costFields,
      },
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'UPDATE',
      entityType: 'ShippingLeg',
      entityId: id,
      beforeJson: existing,
      afterJson: updated,
    });

    // Notify cycle participants if leg arrived
    if (data.arrivedOn && !existing.arrivedOn) {
      const participants = await this.prisma.cycleParticipant.findMany({
        where: { cycleId: existing.cycleId },
      });
      const userIds = participants
        .map((p) => [p.partnerUserId, p.investorUserId])
        .flat()
        .filter(Boolean) as string[];
      if (userIds.length > 0) {
        const cycle = await this.prisma.importCycle.findUnique({
          where: { id: existing.cycleId },
        });
        await this.notifications.createForMultipleUsers(userIds, {
          eventType: 'SHIPPING_LEG_ARRIVED',
          title: `Shipping leg ${existing.sequence} (${existing.origin} → ${existing.destination}) has arrived`,
          payload: {
            legId: id,
            cycleId: existing.cycleId,
            cycleCode: cycle?.code,
            sequence: existing.sequence,
          },
        });
      }
    }

    return { data: updated };
  }

  /**
   * Normalise the costing inputs for a leg and derive its EGP amount.
   *
   * Shipping is quoted per piece most of the time, occasionally by weight, and
   * sometimes as a single agreed figure (the UAE->Egypt combined payment that
   * covers service, customs and handling).
   */
  private buildCostFields(data: {
    costBasis?: ShippingCostBasis;
    ratePerUnit?: number | Prisma.Decimal | null;
    chargeablePieces?: number | Prisma.Decimal | null;
    chargeableWeightKg?: number | Prisma.Decimal | null;
    currency?: string;
    fxRateToEgp?: number | Prisma.Decimal | null;
    amount?: number | Prisma.Decimal | null;
  }) {
    const basis = data.costBasis ?? 'FLAT';
    const dec = (v: number | Prisma.Decimal | null | undefined) =>
      v === null || v === undefined ? null : new Prisma.Decimal(v);

    const ratePerUnit = dec(data.ratePerUnit);
    const chargeablePieces = dec(data.chargeablePieces);
    const chargeableWeightKg = dec(data.chargeableWeightKg);
    const fxRateToEgp = dec(data.fxRateToEgp) ?? new Prisma.Decimal(1);

    if (basis === 'PER_PIECE' && (!ratePerUnit || !chargeablePieces)) {
      throw new BadRequestException(
        'PER_PIECE shipping requires both ratePerUnit and chargeablePieces',
      );
    }
    if (basis === 'PER_WEIGHT' && (!ratePerUnit || !chargeableWeightKg)) {
      throw new BadRequestException(
        'PER_WEIGHT shipping requires both ratePerUnit and chargeableWeightKg',
      );
    }

    // For rate-based legs the native amount is derived, not typed in.
    let amount = dec(data.amount);
    if (basis === 'PER_PIECE') {
      amount = ratePerUnit!.mul(chargeablePieces!);
    } else if (basis === 'PER_WEIGHT') {
      amount = ratePerUnit!.mul(chargeableWeightKg!);
    }

    const amountEgp = this.costing.computeLegAmountEgp({
      costBasis: basis,
      ratePerUnit,
      chargeablePieces,
      chargeableWeightKg,
      amount,
      fxRateToEgp,
    });

    return {
      costBasis: basis,
      ratePerUnit,
      chargeablePieces,
      chargeableWeightKg,
      currency: data.currency ?? 'EGP',
      fxRateToEgp,
      amount: amount ? amount.toDecimalPlaces(2) : null,
      amountEgp,
    };
  }
}
