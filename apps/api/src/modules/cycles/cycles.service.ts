import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { nextReferenceNumber, pad } from '../../common/references';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PaginationDto, pageSize } from '../../common/dto/pagination.dto';
import { Prisma, ParticipantType } from '@prisma/client';

import { badRequest, notFound } from '../../common/api-error';
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


/** Accept only the two participant kinds the business recognises. */
function assertParticipantType(value: string): ParticipantType {
  if (value === 'CORE_PARTNER' || value === 'TEMP_INVESTOR') return value;
  throw badRequest(
    'BAD_PARTICIPANT_TYPE',
    `participantType must be CORE_PARTNER or TEMP_INVESTOR (received "${value}")`,
    { value: String(value) },
  );
}

@Injectable()
export class CyclesService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private notifications: NotificationsService,
  ) {}

  async findAll(pagination: PaginationDto & { status?: string }) {
    const { cursor, limit: rawLimit = 20, status } = pagination;
    const limit = pageSize(rawLimit);
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
        // Named fields, not `include: true`: those relations are User records,
        // and including them whole sent every participant's bcrypt password
        // hash to the browser with the cycle.
        participants: {
          include: {
            partner: {
              select: { id: true, email: true, role: true, partner: { select: { displayName: true } } },
            },
            investor: {
              select: { id: true, email: true, role: true, partner: { select: { displayName: true } } },
            },
          },
        },
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
    if (!cycle) throw notFound('cycle');
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
        participantType: ParticipantType;
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
      throw badRequest('ORIGIN_TYPE_REQUIRED', 'originType (or origin) is required');
    }

    // Generate cycle code: CYC-YYYY-XXXX (or use provided code)
    let code = data.code;
    if (!code) {
      const year = new Date().getFullYear();
      const last = await this.prisma.importCycle.findFirst({
        where: { code: { startsWith: `CYC-${year}` } },
        orderBy: { code: 'desc' },
        select: { code: true },
      });
      code = `CYC-${year}-${pad(nextReferenceNumber(last?.code, 4), 4)}`;
    }

    const cycle = await this.prisma.importCycle.create({
      data: {
        code,
        originType: originType as any,
        currency: data.currency || 'EGP',
        status: 'PLANNING',
        // A cycle starts when it is set up, so the wizard does not ask. The
        // field stays accepted for a back-dated import, which is the only case
        // where the two differ — and the only way to set it, since a cycle has
        // no update endpoint.
        startedOn: data.startedOn ? new Date(data.startedOn) : new Date(),
      },
    });

    // The three partners fund a cycle equally unless someone says otherwise,
    // so a new cycle starts with them on it. Before this, every cycle began
    // with nobody on it and settling reported "No participants found" — the
    // common case took the most work and the default was to get it wrong.
    //
    // Contributions start at zero because the capital is not known yet: a
    // cycle costs what its goods and shipping come to, which is decided over
    // the next few steps. "Split equally" on the cycle fills them in once it
    // is. Equal contributions give an equal split by construction, which is
    // why the profit percentage is left alone — three explicit 33.33s add up
    // to 99.99 and are rejected, and picking which partner absorbs the extra
    // 0.01 is not a decision worth encoding.
    if (!data.participants || data.participants.length === 0) {
      const partners = await this.prisma.user.findMany({
        where: { role: 'CORE_PARTNER', status: 'ACTIVE' },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
      for (const partner of partners) {
        await this.prisma.cycleParticipant.create({
          data: {
            cycleId: cycle.id,
            participantType: 'CORE_PARTNER',
            partnerUserId: partner.id,
            contributionAmount: 0,
          },
        });
      }
    }

    // Create inline participants if provided
    if (data.participants && data.participants.length > 0) {
      for (const p of data.participants) {
        const type = assertParticipantType(p.participantType);
        // The participant row and the money arriving are one fact, so they are
        // written together — a contribution recorded without its ledger entry
        // is the gap this whole thing exists to close.
        const participant = await this.prisma.$transaction(async (tx) => {
          const created = await tx.cycleParticipant.create({
            data: {
              cycleId: cycle.id,
              participantType: type,
              partnerUserId: p.partnerUserId,
              investorUserId: p.investorUserId,
              contributionAmount: p.contributionAmount,
              customProfitPct: p.customProfitPct,
              investorFeePct: p.investorFeePct,
            },
          });
          await this.recordContributionChange(tx, {
            cycleId: cycle.id,
            cycleCode: cycle.code,
            participantId: created.id,
            before: 0,
            after: p.contributionAmount,
            isInvestor: type === 'TEMP_INVESTOR',
            actorId,
          });
          return created;
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

  /**
   * Refuse a cycle step the shipping has not actually reached.
   *
   * Completing the wizard used to walk a cycle from PLANNING to VERIFICATION in
   * one click and receive the stock, so goods "departed", "arrived" and landed
   * in inventory in the same instant, with no departure or arrival date ever
   * recorded. A cycle that had been approved a moment ago had sellable stock.
   *
   * Now the shipment's own dates decide. A leg is in transit once it has a
   * departure date and arrived once it has an arrival date, and the cycle
   * cannot pass a point its goods have not reached.
   *
   *   China cycle:  leg 1 is China→UAE, leg 2 is UAE→Egypt
   *   UAE direct:   leg 1 is UAE→Egypt
   */
  private async assertShippingReached(
    cycleId: string,
    originType: string,
    targetStatus: string,
  ) {
    const legs = await this.prisma.shippingLeg.findMany({
      where: { cycleId },
      orderBy: { sequence: 'asc' },
      select: { sequence: true, status: true, origin: true, destination: true },
    });

    // Nothing to check before the legs are recorded — they are added part-way
    // through the wizard, and the early steps happen before that.
    if (legs.length === 0) return;

    const lastSequence = originType === 'UAE_DIRECT' ? 1 : 2;
    const leg = (sequence: number) => legs.find((l) => l.sequence === sequence);
    const where = (l: { origin: string; destination: string }) =>
      `${l.origin} → ${l.destination}`;

    const needs = (
      sequence: number,
      minimum: 'IN_TRANSIT' | 'ARRIVED',
      what: string,
    ) => {
      const l = leg(sequence);
      if (!l) return;
      const rank: Record<string, number> = { PENDING: 0, IN_TRANSIT: 1, ARRIVED: 2 };
      if ((rank[l.status] ?? 0) >= rank[minimum]) return;
      throw badRequest(
        minimum === 'ARRIVED' ? 'LEG_NOT_ARRIVED' : 'LEG_NOT_DEPARTED',
        `${where(l)} has not ${what}. Record the ${
          minimum === 'ARRIVED' ? 'arrival' : 'departure'
        } date on that leg first.`,
        { leg: where(l) },
      );
    };

    switch (targetStatus) {
      case 'IN_TRANSIT':
        needs(1, 'IN_TRANSIT', 'departed');
        break;
      case 'ARRIVED_UAE':
        // Only a China cycle has a leg that lands in the UAE. A UAE-direct
        // cycle's goods are sitting at its origin and nothing has moved.
        if (originType !== 'UAE_DIRECT') needs(1, 'ARRIVED', 'arrived');
        break;
      case 'IN_TRANSIT_TO_EGYPT':
        needs(lastSequence, 'IN_TRANSIT', 'departed');
        break;
      case 'ARRIVED_EGYPT':
        for (const l of legs) needs(l.sequence, 'ARRIVED', 'arrived');
        break;
      default:
        break;
    }
  }

  async transition(id: string, targetStatus: string, actorId: string) {
    const cycle = await this.prisma.importCycle.findUnique({ where: { id } });
    if (!cycle) throw notFound('cycle');

    const allowed = VALID_TRANSITIONS[cycle.status];
    if (!allowed || !allowed.includes(targetStatus)) {
      throw badRequest(
        'BAD_STATUS_TRANSITION',
        `Cannot transition from ${cycle.status} to ${targetStatus}. Allowed: ${(allowed || []).join(', ')}`,
        { from: cycle.status, to: targetStatus, allowed: (allowed || []).join(', ') },
      );
    }

    // Validate UAE-direct cannot add China leg
    if (
      targetStatus === 'IN_TRANSIT' &&
      cycle.originType === 'UAE_DIRECT'
    ) {
      throw badRequest(
        'UAE_DIRECT_NO_CHINA_LEG',
        'UAE_DIRECT cycles cannot have a China-to-UAE leg',
      );
    }

    await this.assertShippingReached(id, cycle.originType, targetStatus);

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
      participantType: ParticipantType;
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
    if (!cycle) throw notFound('cycle');

    // Validate: cannot add participants in closed cycles
    if (cycle.status === 'CLOSED') {
      throw badRequest(
        'CYCLE_CLOSED_NO_PARTICIPANTS',
        'Cannot add participants to a closed cycle',
      );
    }

    const type = assertParticipantType(data.participantType);
    const userId =
      type === 'TEMP_INVESTOR' ? data.investorUserId : data.partnerUserId;
    if (!userId) {
      throw type === 'TEMP_INVESTOR'
        ? badRequest('INVESTOR_ID_REQUIRED', 'investorUserId is required for a temporary investor')
        : badRequest('PARTNER_ID_REQUIRED', 'partnerUserId is required for a core partner');
    }

    // Adding the same person twice would dilute everyone else's profit share.
    const already = await this.prisma.cycleParticipant.findFirst({
      where:
        type === 'TEMP_INVESTOR'
          ? { cycleId, investorUserId: userId }
          : { cycleId, partnerUserId: userId },
    });
    if (already) {
      throw badRequest(
        'ALREADY_A_PARTICIPANT',
        'This person is already a participant in this cycle',
      );
    }

    const participant = await this.prisma.$transaction(async (tx) => {
      const created = await tx.cycleParticipant.create({
        data: {
          cycleId,
          participantType: type,
          partnerUserId: type === 'TEMP_INVESTOR' ? undefined : userId,
          investorUserId: type === 'TEMP_INVESTOR' ? userId : undefined,
          contributionAmount: data.contributionAmount,
          customProfitPct: data.customProfitPct,
          investorFeePct: data.investorFeePct,
        },
      });
      await this.recordContributionChange(tx, {
        cycleId,
        cycleCode: cycle.code,
        participantId: created.id,
        before: 0,
        after: data.contributionAmount,
        isInvestor: type === 'TEMP_INVESTOR',
        actorId,
      });
      return created;
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

  /**
   * Post the money a participant put in, or took back out.
   *
   * The ledger recorded the cycle spending its capital but never recorded that
   * capital arriving: the purchase went out as an OUTFLOW and the partners'
   * money that funded it appeared nowhere. Netting the table gave −62,325 on a
   * cycle that had been settled in full and owed nobody anything — the business
   * looked to have spent money it never received, understated by exactly what
   * the partners had contributed.
   *
   * A contribution is a standing figure that can be edited, but money moving is
   * an event. So this posts the DIFFERENCE rather than the new total: raise a
   * contribution and the increase comes in, lower it and the excess goes back.
   * The entries then always sum to the current figure without any of them being
   * rewritten, which is what keeps the ledger an audit trail rather than a
   * mirror of a mutable column.
   */
  private async recordContributionChange(
    tx: Prisma.TransactionClient,
    args: {
      cycleId: string;
      cycleCode: string;
      participantId: string;
      before: Prisma.Decimal | number;
      after: Prisma.Decimal | number;
      isInvestor: boolean;
      actorId: string;
    },
  ) {
    const before = new Prisma.Decimal(args.before ?? 0);
    const after = new Prisma.Decimal(args.after ?? 0);
    const delta = after.sub(before);
    if (delta.isZero()) return;

    const who = args.isInvestor ? 'investor' : 'partner';
    await tx.financialTransaction.create({
      data: {
        type: 'CAPITAL_CONTRIBUTION',
        category: 'contribution',
        // A reduction is capital handed back, so the money leaves.
        direction: delta.gt(0) ? 'INFLOW' : 'OUTFLOW',
        amount: delta.abs().toDecimalPlaces(2),
        currency: 'EGP',
        cycleId: args.cycleId,
        relatedType: 'CYCLE_PARTICIPANT',
        relatedId: args.participantId,
        reason: delta.gt(0)
          ? `Capital put into ${args.cycleCode} by ${who}`
          : `Capital returned from ${args.cycleCode} to ${who}`,
        createdBy: args.actorId,
      },
    });
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
    if (!existing) throw notFound('participant');

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.cycleParticipant.update({
        where: { id },
        data: {
          contributionAmount: data.contributionAmount,
          customProfitPct: data.customProfitPct,
          investorFeePct: data.investorFeePct,
        },
        include: { cycle: { select: { code: true } } },
      });
      // This is the path "Split equally" takes, and where a contribution
      // usually gets its real value: a cycle is created with zeros because the
      // capital is not known until the goods and shipping are costed.
      await this.recordContributionChange(tx, {
        cycleId: next.cycleId,
        cycleCode: next.cycle.code,
        participantId: next.id,
        before: existing.contributionAmount,
        after: next.contributionAmount,
        isInvestor: next.participantType === 'TEMP_INVESTOR',
        actorId,
      });
      return next;
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
