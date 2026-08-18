import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { Prisma } from '@prisma/client';

// Valid state transitions per the spec
const VALID_TRANSITIONS: Record<string, string[]> = {
  PLANNING: ['FUNDING', 'CANCELLED'],
  FUNDING: ['PURCHASING', 'PLANNING', 'CANCELLED'],
  PURCHASING: ['IN_TRANSIT', 'ARRIVED_UAE', 'CANCELLED'],
  IN_TRANSIT: ['ARRIVED_UAE', 'ARRIVED_EGYPT'],
  ARRIVED_UAE: ['IN_TRANSIT_TO_EGYPT'],
  IN_TRANSIT_TO_EGYPT: ['ARRIVED_EGYPT'],
  ARRIVED_EGYPT: ['VERIFICATION'],
  VERIFICATION: ['SELLING', 'ARRIVED_EGYPT'],
  SELLING: ['SETTLEMENT'],
  SETTLEMENT: ['CLOSED', 'SELLING'],
  CLOSED: [],
};

@Injectable()
export class CyclesService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private notifications: NotificationsService,
  ) {}

  async findAll(pagination: PaginationDto & { status?: string }) {
    const { cursor, limit = 20, status } = pagination;
    const where: any = {};
    if (status) where.status = status;

    const items = await this.prisma.importCycle.findMany({
      where,
      take: limit + 1,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { createdAt: 'desc' },
      include: {
        participants: true,
        purchaseOrders: true,
        shippingLegs: true,
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

  async findById(id: string) {
    const cycle = await this.prisma.importCycle.findUnique({
      where: { id },
      include: {
        participants: { include: { partner: true, investor: true } },
        purchaseOrders: {
          include: {
            items: { include: { product: true } },
            supplier: true,
          },
        },
        shippingLegs: true,
        inventoryBatches: { include: { product: true } },
        settlements: true,
      },
    });
    if (!cycle) throw new NotFoundException('Cycle not found');
    return { data: cycle };
  }

  async create(
    data: {
      code?: string;
      originType?: string;
      origin?: string;
      currency?: string;
      startedOn?: string;
      participants?: Array<{
        participantType: string;
        partnerUserId?: string;
        investorUserId?: string;
        contributionAmount: number;
        customProfitPct?: number;
        investorFeePct?: number;
      }>;
    },
    actorId: string,
  ) {
    // Support both 'origin' and 'originType' field names
    const originType = data.originType || data.origin;
    if (!originType) {
      throw new BadRequestException('originType (or origin) is required');
    }

    // Generate cycle code: CYC-YYYY-XXXX (or use provided code)
    let code = data.code;
    if (!code) {
      const year = new Date().getFullYear();
      const count = await this.prisma.importCycle.count({
        where: { code: { startsWith: `CYC-${year}` } },
      });
      code = `CYC-${year}-${String(count + 1).padStart(4, '0')}`;
    }

    const cycle = await this.prisma.importCycle.create({
      data: {
        code,
        originType: originType as any,
        currency: data.currency || 'EGP',
        status: 'PLANNING',
        startedOn: data.startedOn
          ? new Date(data.startedOn)
          : new Date(),
      },
    });

    // Create inline participants if provided
    if (data.participants && data.participants.length > 0) {
      for (const p of data.participants) {
        const participant = await this.prisma.cycleParticipant.create({
          data: {
            cycleId: cycle.id,
            participantType: p.participantType,
            partnerUserId: p.partnerUserId,
            investorUserId: p.investorUserId,
            contributionAmount: p.contributionAmount,
            customProfitPct: p.customProfitPct,
            investorFeePct: p.investorFeePct,
          },
        });

        // Notify each participant
        const notifyUserId = p.partnerUserId || p.investorUserId;
        if (notifyUserId) {
          await this.notifications.create({
            userId: notifyUserId,
            eventType: 'ADDED_TO_CYCLE',
            title: `You have been added to cycle ${cycle.code}`,
            payload: {
              cycleId: cycle.id,
              cycleCode: cycle.code,
              contribution: p.contributionAmount,
            },
          });
        }
      }
    }

    await this.audit.log({
      actorUserId: actorId,
      action: 'CREATE',
      entityType: 'ImportCycle',
      entityId: cycle.id,
      afterJson: cycle,
    });

    // Notify all core partners
    const corePartners = await this.prisma.user.findMany({
      where: { role: 'CORE_PARTNER', status: 'ACTIVE' },
    });
    if (corePartners.length > 0) {
      await this.notifications.createForMultipleUsers(
        corePartners.map((u) => u.id),
        {
          eventType: 'CYCLE_CREATED',
          title: `New import cycle ${cycle.code} created`,
          payload: { cycleId: cycle.id, cycleCode: cycle.code },
        },
      );
    }

    return { data: cycle };
  }

  async transition(id: string, targetStatus: string, actorId: string) {
    const cycle = await this.prisma.importCycle.findUnique({ where: { id } });
    if (!cycle) throw new NotFoundException('Cycle not found');

    const allowed = VALID_TRANSITIONS[cycle.status];
    if (!allowed || !allowed.includes(targetStatus)) {
      throw new BadRequestException(
        `Cannot transition from ${cycle.status} to ${targetStatus}. Allowed: ${(allowed || []).join(', ')}`,
      );
    }

    // Validate UAE-direct cannot add China leg
    if (
      targetStatus === 'IN_TRANSIT' &&
      cycle.originType === 'UAE_DIRECT'
    ) {
      throw new BadRequestException(
        'UAE_DIRECT cycles cannot have a China-to-UAE leg',
      );
    }

    const updated = await this.prisma.importCycle.update({
      where: { id },
      data: {
        status: targetStatus as any,
        closedOn: targetStatus === 'CLOSED' ? new Date() : undefined,
      },
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'TRANSITION',
      entityType: 'ImportCycle',
      entityId: id,
      beforeJson: { status: cycle.status },
      afterJson: { status: targetStatus },
    });

    // Notify participants of status change
    const participants = await this.prisma.cycleParticipant.findMany({
      where: { cycleId: id },
    });
    const userIds = participants
      .map((p) => [p.partnerUserId, p.investorUserId])
      .flat()
      .filter(Boolean) as string[];

    if (userIds.length > 0) {
      await this.notifications.createForMultipleUsers(userIds, {
        eventType: 'CYCLE_STATUS_CHANGED',
        title: `Cycle ${cycle.code} moved to ${targetStatus}`,
        payload: {
          cycleId: cycle.id,
          cycleCode: cycle.code,
          fromStatus: cycle.status,
          toStatus: targetStatus,
        },
      });
    }

    return { data: updated };
  }

  // ─── Participants ─────────────────────────────────────────────

  async addParticipant(
    cycleId: string,
    data: {
      participantType: string;
      partnerUserId?: string;
      investorUserId?: string;
      contributionAmount: number;
      customProfitPct?: number;
      investorFeePct?: number;
    },
    actorId: string,
  ) {
    const cycle = await this.prisma.importCycle.findUnique({
      where: { id: cycleId },
    });
    if (!cycle) throw new NotFoundException('Cycle not found');

    // Validate: cannot add participants in closed cycles
    if (cycle.status === 'CLOSED') {
      throw new BadRequestException(
        'Cannot add participants to a closed cycle',
      );
    }

    const participant = await this.prisma.cycleParticipant.create({
      data: {
        cycleId,
        participantType: data.participantType,
        partnerUserId: data.partnerUserId,
        investorUserId: data.investorUserId,
        contributionAmount: data.contributionAmount,
        customProfitPct: data.customProfitPct,
        investorFeePct: data.investorFeePct,
      },
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'ADD_PARTICIPANT',
      entityType: 'CycleParticipant',
      entityId: participant.id,
      afterJson: participant,
    });

    // Notify the added participant
    const notifyUserId = data.partnerUserId || data.investorUserId;
    if (notifyUserId) {
      await this.notifications.create({
        userId: notifyUserId,
        eventType: 'ADDED_TO_CYCLE',
        title: `You have been added to cycle ${cycle.code}`,
        payload: {
          cycleId: cycle.id,
          cycleCode: cycle.code,
          contribution: data.contributionAmount,
        },
      });
    }

    return { data: participant };
  }

  async updateParticipant(
    id: string,
    data: {
      contributionAmount?: number;
      customProfitPct?: number;
      investorFeePct?: number;
    },
    actorId: string,
  ) {
    const existing = await this.prisma.cycleParticipant.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Participant not found');

    const updated = await this.prisma.cycleParticipant.update({
      where: { id },
      data: {
        contributionAmount: data.contributionAmount,
        customProfitPct: data.customProfitPct,
        investorFeePct: data.investorFeePct,
      },
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'UPDATE_PARTICIPANT',
      entityType: 'CycleParticipant',
      entityId: id,
      beforeJson: existing,
      afterJson: updated,
    });

    return { data: updated };
  }

  async getParticipants(cycleId: string) {
    const participants = await this.prisma.cycleParticipant.findMany({
      where: { cycleId },
      include: { partner: true, investor: true },
    });
    return { data: participants };
  }
}
