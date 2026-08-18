import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PaginationDto } from '../../common/dto/pagination.dto';

@Injectable()
export class ShippingService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private notifications: NotificationsService,
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
      trackingRef?: string;
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

    // Check sequence uniqueness within cycle
    const existingLeg = await this.prisma.shippingLeg.findUnique({
      where: { cycleId_sequence: { cycleId, sequence: data.sequence } },
    });
    if (existingLeg) {
      throw new BadRequestException(
        `Shipping leg with sequence ${data.sequence} already exists for this cycle`,
      );
    }

    const leg = await this.prisma.shippingLeg.create({
      data: {
        cycleId,
        sequence: data.sequence,
        origin: data.origin,
        destination: data.destination,
        provider: data.provider,
        trackingRef: data.trackingRef,
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
      trackingRef?: string;
    },
    actorId: string,
  ) {
    const existing = await this.prisma.shippingLeg.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Shipping leg not found');

    const updated = await this.prisma.shippingLeg.update({
      where: { id },
      data: {
        status: data.status,
        departedOn: data.departedOn ? new Date(data.departedOn) : undefined,
        arrivedOn: data.arrivedOn ? new Date(data.arrivedOn) : undefined,
        amount: data.amount,
        provider: data.provider,
        trackingRef: data.trackingRef,
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
}
