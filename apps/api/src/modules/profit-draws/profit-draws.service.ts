import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; money must not become a float
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SettlementsService } from '../settlements/settlements.service';
import { CostingService } from '../costing/costing.service';
import {
  participantInputsOf,
  profitShareOf,
  distributeCycleProfit,
} from '../settlements/settlement-math';
import { badRequest, notFound } from '../../common/api-error';
import { isUuid } from '../../common/uuid';
import { lockCycle } from '../../common/shipment-load';
import { lockAccounts } from '../../common/partner-account';
import {
  assertNotFuture,
  businessDay,
  businessToday,
} from '../../common/dates';
import { formatMoney } from '../../common/money';
import {
  CLOSED_FOR_DRAWS,
  PROFIT_DRAW_CATEGORY,
  PROFIT_DRAW_RELATED,
  STANDING_DRAW,
  collectedProfit,
  cycleSalesPaid,
} from '../../common/profit-draws';
import {
  CAPITAL_BACK_CATEGORY,
  CAPITAL_BACK_REVERSAL_TYPE,
  CAPITAL_BACK_TYPE,
  capitalRoom,
  cycleCostRecovered,
  recoveredShare,
} from '../../common/capital-back-early';
import type {
  CreateCapitalBackDto,
  CreateProfitDrawDto,
  ReverseProfitDrawDto,
} from './dto/profit-draw.dto';

type Db = Prisma.TransactionClient;

const ZERO = new Prisma.Decimal(0);
const m2 = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v).toFixed(2);
const dayDate = (day: string) => new Date(`${day}T00:00:00Z`);

/** The most a single draw may be: the ledger's columns hold 18,2. */
const MAX_AMOUNT = new Prisma.Decimal('9999999999999999.99');

/** Each core partner's room to take profit from a cycle right now. */
export interface DrawRoom {
  partnerUserId: string;
  name: string;
  /** His share of the split, in percent (4dp); null when there is no basis. */
  sharePct: string | null;
  /** His share of the profit collected so far. */
  shareOfCollectedEgp: string;
  /** His standing draws on this cycle, not yet settled. */
  drawnEgp: string;
  /** What he still owes from an earlier payout (any cycle). */
  owedEgp: string;
  /** What he may take now: share − drawn − owed, never below zero. */
  availableEgp: string;
}

/** Each participant's room to take capital back from a cycle right now. */
export interface CapitalRoom {
  userId: string;
  participantType: string;
  name: string;
  /** What he put in: the figure the split reads, which this never moves. */
  contributionEgp: string;
  /** His part of what paid sales recovered: the recovered share of it. */
  recoveredEgp: string;
  /** Capital he took back early from this cycle, not yet settled. */
  takenEgp: string;
  /** What he may take now: recovered − taken, never below zero. */
  availableEgp: string;
}

/**
 * Profit taken before a cycle is settled (BUSINESS_LOGIC §8, owner
 * 2026-11-08) — and since the same day capital taken back early, by any
 * participant, out of what paid sales recovered. A core partner on the cycle takes part of his share of the
 * profit already collected, in cash; the cycle's profit is unchanged, and its
 * settlement takes the draw off his payout (`SettlementsService`).
 */
@Injectable()
export class ProfitDrawsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private settlements: SettlementsService,
    private costing: CostingService,
  ) {}

  // ─── Reading ─────────────────────────────────────────────────────────

  /** The cycle's draws, newest first, and each core partner's room to take more. */
  async forCycle(cycleId: string) {
    if (!isUuid(cycleId)) throw notFound('cycle');
    const cycle = await this.prisma.importCycle.findUnique({
      where: { id: cycleId },
      select: { id: true, code: true, status: true },
    });
    if (!cycle) throw notFound('cycle');
    const draws = await this.prisma.profitDraw.findMany({
      where: { cycleId, kind: 'DRAW' },
      orderBy: [{ drawnOn: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      include: {
        partner: {
          select: { email: true, partner: { select: { displayName: true } } },
        },
        settledBy: { select: { id: true, status: true } },
      },
    });
    const room = await this.room(this.prisma, cycleId);
    const settlements = await this.prisma.settlement.findMany({
      where: { cycleId, status: { in: ['APPROVED', 'PAID'] } },
      select: { status: true },
    });
    const locked =
      CLOSED_FOR_DRAWS.includes(cycle.status) || settlements.length > 0;
    return {
      data: {
        cycleId,
        cycleCode: cycle.code,
        /** Why nothing can be taken or undone now, or null. */
        locked: locked
          ? settlements.some((s) => s.status === 'PAID')
            ? 'SETTLEMENT_PAID'
            : settlements.length > 0
              ? 'SETTLEMENT_APPROVED'
              : cycle.status
          : null,
        profitEgp: room.profit === null ? null : m2(room.profit),
        /** This cycle's sales, and how much of them the customers have paid. */
        salesEgp: m2(room.sales.revenueEgp),
        salesPaidEgp: m2(room.sales.paidEgp),
        /** What is still owed on them. */
        uncollectedEgp: m2(room.sales.revenueEgp.sub(room.sales.paidEgp)),
        /** The share of its sales paid, in percent: the share of its profit collected. */
        sharePaidPct: room.sales.share.mul(100).toFixed(2),
        collectedProfitEgp: m2(room.collected),
        /** Why there is no split to take a share of (CYCLE_NOT_FUNDED, …), or null. */
        problem: room.problem,
        partners: room.partners,
        draws: draws.map((d) => ({
          id: d.id,
          partnerUserId: d.partnerUserId,
          name: d.partner.partner?.displayName ?? d.partner.email,
          amountEgp: m2(d.amountEgp),
          drawnOn: d.drawnOn.toISOString().slice(0, 10),
          note: d.note,
          createdAt: d.createdAt,
          reversedAt: d.reversedAt,
          reversalReason: d.reversalReason,
          /** Taken off a paid settlement's payout: undo that settlement first. */
          settled: d.settledById !== null,
        })),
      },
    };
  }

  /**
   * Each core partner's room on the cycle, read through `db` (the
   * transaction's client when writing, so the draws counted are the ones
   * the cycle and account locks protect).
   */
  private async room(db: Db | PrismaService, cycleId: string) {
    const core = await db.cycleParticipant.findMany({
      where: {
        cycleId,
        participantType: 'CORE_PARTNER',
        partnerUserId: { not: null },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: {
        partner: {
          select: { email: true, partner: { select: { displayName: true } } },
        },
      },
    });

    // The settlement's own arithmetic, never a second one (rule 11).
    let profit: Prisma.Decimal | null = null;
    let problem: string | null = null;
    const shares = new Map<string, Prisma.Decimal>();
    const pcts = new Map<string, Prisma.Decimal>();
    try {
      const projected = await this.settlements.project(cycleId, db);
      if (projected) profit = projected.pnl.grossProfit;
    } catch (e) {
      if (!(e instanceof BadRequestException)) throw e;
      problem = codeOf(e);
    }

    const sales = await cycleSalesPaid(db, cycleId);
    const collected =
      profit === null ? ZERO : collectedProfit(profit, sales.share);

    if (profit !== null) {
      const all = await db.cycleParticipant.findMany({
        where: { cycleId },
        orderBy: { createdAt: 'asc' },
      });
      const inputs = participantInputsOf(all);
      // Each participant's part of what is collected, the way the payout
      // splits the whole profit — before any investor's fee, which only an
      // investor pays and he cannot draw.
      const parts = profitShareOf(inputs, collected);
      // The split's percentages do not depend on the amount split.
      const lines = distributeCycleProfit(inputs, profit).lines;
      if (parts) {
        all.forEach((p, i) => {
          if (p.participantType !== 'CORE_PARTNER' || !p.partnerUserId) return;
          const userId = p.partnerUserId;
          shares.set(userId, (shares.get(userId) ?? ZERO).add(parts[i]));
          pcts.set(userId, (pcts.get(userId) ?? ZERO).add(lines[i].sharePct));
        });
      }
    }

    const userIds = [...new Set(core.map((c) => c.partnerUserId as string))];
    const standing = userIds.length
      ? await db.profitDraw.findMany({
          where: {
            ...STANDING_DRAW,
            settledById: null,
            partnerUserId: { in: userIds },
            OR: [{ kind: 'DRAW', cycleId }, { kind: 'CARRIED' }],
          },
          select: { partnerUserId: true, kind: true, amountEgp: true },
        })
      : [];

    const seen = new Set<string>();
    const partners: DrawRoom[] = [];
    for (const c of core) {
      const userId = c.partnerUserId as string;
      if (seen.has(userId)) continue;
      seen.add(userId);
      const mine = standing.filter((s) => s.partnerUserId === userId);
      const drawn = mine
        .filter((s) => s.kind === 'DRAW')
        .reduce((s, r) => s.add(r.amountEgp), ZERO);
      const owed = mine
        .filter((s) => s.kind === 'CARRIED')
        .reduce((s, r) => s.add(r.amountEgp), ZERO);
      const share = shares.get(userId) ?? ZERO;
      const left = share.sub(drawn).sub(owed);
      partners.push({
        partnerUserId: userId,
        name: c.partner?.partner?.displayName ?? c.partner?.email ?? userId,
        sharePct: pcts.get(userId)?.toFixed(4) ?? null,
        shareOfCollectedEgp: m2(share),
        drawnEgp: m2(drawn),
        owedEgp: m2(owed),
        availableEgp: m2(left.gt(0) ? left : ZERO),
      });
    }
    return { profit, sales, collected, problem, partners };
  }

  /**
   * The cycle's capital taken back early, newest first, and each
   * participant's room to take more (§8, 2026-11-08).
   */
  async capitalForCycle(cycleId: string) {
    if (!isUuid(cycleId)) throw notFound('cycle');
    const cycle = await this.prisma.importCycle.findUnique({
      where: { id: cycleId },
      select: { id: true, code: true, status: true },
    });
    if (!cycle) throw notFound('cycle');
    const rows = await this.prisma.profitDraw.findMany({
      where: { cycleId, kind: 'CAPITAL' },
      orderBy: [{ drawnOn: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      include: {
        partner: {
          select: { email: true, partner: { select: { displayName: true } } },
        },
      },
    });
    const room = await this.capitalRoom(this.prisma, cycleId);
    const settlements = await this.prisma.settlement.findMany({
      where: { cycleId, status: { in: ['APPROVED', 'PAID'] } },
      select: { status: true },
    });
    const locked =
      CLOSED_FOR_DRAWS.includes(cycle.status) || settlements.length > 0;
    return {
      data: {
        cycleId,
        cycleCode: cycle.code,
        locked: locked
          ? settlements.some((s) => s.status === 'PAID')
            ? 'SETTLEMENT_PAID'
            : settlements.length > 0
              ? 'SETTLEMENT_APPROVED'
              : cycle.status
          : null,
        /** What the cycle cost to fund. */
        toFundEgp: m2(room.toFund),
        /** The cost of the goods customers have paid for. */
        recoveredEgp: m2(room.recovered),
        /** The share of the cost to fund recovered, in percent. */
        recoveredPct: room.share.mul(100).toFixed(2),
        people: room.people,
        taken: rows.map((d) => ({
          id: d.id,
          userId: d.partnerUserId,
          name: d.partner.partner?.displayName ?? d.partner.email,
          amountEgp: m2(d.amountEgp),
          takenOn: d.drawnOn.toISOString().slice(0, 10),
          note: d.note,
          createdAt: d.createdAt,
          reversedAt: d.reversedAt,
          reversalReason: d.reversalReason,
          settled: d.settledById !== null,
        })),
      },
    };
  }

  /**
   * Each participant's room to take capital back, read through `db` (the
   * transaction's client when writing).
   */
  private async capitalRoom(db: Db | PrismaService, cycleId: string) {
    const participants = await db.cycleParticipant.findMany({
      where: { cycleId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: {
        partner: {
          select: { email: true, partner: { select: { displayName: true } } },
        },
        investor: {
          select: { email: true, partner: { select: { displayName: true } } },
        },
      },
    });
    const { toFund } = await this.costing.fundingFor(
      cycleId,
      db === this.prisma ? undefined : db,
    );
    const recovered = await cycleCostRecovered(db, cycleId);
    const share = recoveredShare(recovered, toFund);

    const userIds = participants
      .map((p) => p.partnerUserId ?? p.investorUserId)
      .filter((u): u is string => !!u);
    const standing = userIds.length
      ? await db.profitDraw.findMany({
          where: {
            ...STANDING_DRAW,
            settledById: null,
            kind: 'CAPITAL',
            cycleId,
            partnerUserId: { in: userIds },
          },
          select: { partnerUserId: true, amountEgp: true },
        })
      : [];

    const seen = new Set<string>();
    const people: CapitalRoom[] = [];
    for (const p of participants) {
      const userId = p.partnerUserId ?? p.investorUserId;
      if (!userId || seen.has(userId)) continue;
      seen.add(userId);
      const who = p.partner ?? p.investor;
      const taken = standing
        .filter((s) => s.partnerUserId === userId)
        .reduce((s, r) => s.add(r.amountEgp), ZERO);
      const contribution = new Prisma.Decimal(p.contributionAmount);
      const r = capitalRoom({ share, contribution, taken });
      people.push({
        userId,
        participantType: p.participantType,
        name: who?.partner?.displayName ?? who?.email ?? userId,
        contributionEgp: m2(contribution),
        recoveredEgp: m2(r.recoveredEgp),
        takenEgp: m2(taken),
        availableEgp: m2(r.availableEgp),
      });
    }
    return { toFund, recovered, share, people };
  }

  // ─── Writing ─────────────────────────────────────────────────────────

  /**
   * A participant — core partner or investor — takes part of his capital
   * back, up to his part of what paid sales recovered (§8, 2026-11-08). Any
   * core partner records it, for anyone on the cycle.
   */
  async takeCapital(
    cycleId: string,
    dto: CreateCapitalBackDto,
    actorId: string,
  ) {
    if (!isUuid(cycleId)) throw notFound('cycle');
    if (!isUuid(dto.userId)) throw notFound('participant');
    const amount = positive(dto.amountEgp);
    assertNotFuture(dto.takenOn, 'CAPITAL_TAKEN_BACK');
    const day = dto.takenOn ? businessDay(dto.takenOn) : businessToday();
    const holder = await this.prisma.user.findUnique({
      where: { id: dto.userId },
      select: {
        id: true,
        email: true,
        partner: { select: { displayName: true } },
      },
    });
    if (!holder) throw notFound('participant');
    const name = holder.partner?.displayName ?? holder.email;

    const id = randomUUID();
    const created = await this.prisma.$transaction(
      async (tx) => {
        // The cycle first, then his account: the order every writer here
        // takes them in.
        await lockCycle(tx, cycleId);
        const cycle = await tx.importCycle.findUnique({
          where: { id: cycleId },
          select: { id: true, code: true, status: true },
        });
        if (!cycle) throw notFound('cycle');
        await assertOpenForDraws(tx, cycle);
        await lockAccounts(tx, [holder.id]);

        const room = await this.capitalRoom(tx, cycleId);
        const mine = room.people.find((p) => p.userId === holder.id);
        if (!mine) {
          throw badRequest(
            'CAPITAL_BACK_NOT_ON_CYCLE',
            `${name} has no capital in ${cycle.code} to take back.`,
            { partner: name, cycle: cycle.code },
          );
        }
        const available = new Prisma.Decimal(mine.availableEgp);
        if (amount.gt(available)) {
          throw badRequest(
            'CAPITAL_BACK_OVER_AVAILABLE',
            `${name} can take back at most ${formatMoney(available)} EGP from ${cycle.code} now: ` +
              `paid sales have recovered ${room.share.mul(100).toFixed(2)}% of its cost, ` +
              `${formatMoney(mine.recoveredEgp)} of the ${formatMoney(mine.contributionEgp)} he put in, ` +
              `and he has taken back ${formatMoney(mine.takenEgp)}.`,
            {
              partner: name,
              cycle: cycle.code,
              available: formatMoney(available),
              pct: room.share.mul(100).toFixed(2),
              recovered: formatMoney(mine.recoveredEgp),
              contribution: formatMoney(mine.contributionEgp),
              taken: formatMoney(mine.takenEgp),
            },
          );
        }

        const entry = await tx.financialTransaction.create({
          data: {
            type: CAPITAL_BACK_TYPE,
            category: CAPITAL_BACK_CATEGORY,
            direction: 'OUTFLOW',
            amount,
            currency: 'EGP',
            cycleId,
            relatedType: PROFIT_DRAW_RELATED,
            relatedId: id,
            occurredOn: dayDate(day),
            reason: `${name} took part of his capital back from ${cycle.code}`,
            createdBy: actorId,
          },
        });
        return tx.profitDraw.create({
          data: {
            id,
            kind: 'CAPITAL',
            cycleId,
            partnerUserId: holder.id,
            amountEgp: amount,
            drawnOn: dayDate(day),
            note: dto.note?.trim() || null,
            ledgerEntryId: entry.id,
            createdBy: actorId,
          },
        });
      },
      { timeout: 30_000 },
    );

    await this.audit.log({
      actorUserId: actorId,
      action: 'CAPITAL_BACK_EARLY',
      entityType: 'ProfitDraw',
      entityId: created.id,
      afterJson: {
        cycleId,
        userId: holder.id,
        amountEgp: m2(created.amountEgp),
        takenOn: day,
      },
    });
    return {
      data: { id: created.id, amountEgp: m2(created.amountEgp), takenOn: day },
    };
  }

  /** A core partner takes part of his share of the profit collected so far. */
  async create(cycleId: string, dto: CreateProfitDrawDto, actorId: string) {
    if (!isUuid(cycleId)) throw notFound('cycle');
    if (!isUuid(dto.partnerUserId)) throw notFound('partner');
    const amount = positive(dto.amountEgp);
    assertNotFuture(dto.drawnOn, 'PROFIT_DRAWN');
    const day = dto.drawnOn ? businessDay(dto.drawnOn) : businessToday();
    const holder = await this.prisma.user.findUnique({
      where: { id: dto.partnerUserId },
      select: {
        id: true,
        role: true,
        email: true,
        partner: { select: { displayName: true } },
      },
    });
    if (!holder || holder.role !== 'CORE_PARTNER' || !holder.partner) {
      throw notFound('partner');
    }
    const name = holder.partner.displayName ?? holder.email;

    const id = randomUUID();
    const created = await this.prisma.$transaction(
      async (tx) => {
        // The cycle first, then his account: the order every writer here
        // takes them in. An approval waits on the cycle's lock, so none slips
        // in between the check below and the write.
        await lockCycle(tx, cycleId);
        const cycle = await tx.importCycle.findUnique({
          where: { id: cycleId },
          select: { id: true, code: true, status: true },
        });
        if (!cycle) throw notFound('cycle');
        await assertOpenForDraws(tx, cycle);
        await lockAccounts(tx, [holder.id]);

        const onCycle = await tx.cycleParticipant.findFirst({
          where: {
            cycleId,
            participantType: 'CORE_PARTNER',
            partnerUserId: holder.id,
          },
          select: { id: true },
        });
        if (!onCycle) {
          throw badRequest(
            'PROFIT_DRAW_NOT_ON_CYCLE',
            `${name} is not a core partner on ${cycle.code}, so has no share of its profit to take.`,
            { partner: name, cycle: cycle.code },
          );
        }

        const room = await this.room(tx, cycleId);
        if (room.problem) {
          throw badRequest(
            room.problem,
            `${cycle.code}'s profit has no agreed split yet, so no share of it can be taken.`,
          );
        }
        const mine = room.partners.find((p) => p.partnerUserId === holder.id)!;
        const available = new Prisma.Decimal(mine.availableEgp);
        if (amount.gt(available)) {
          throw badRequest(
            'PROFIT_DRAW_OVER_AVAILABLE',
            `${name} can take at most ${formatMoney(available)} EGP from ${cycle.code} now: ` +
              `his share of the profit collected is ${formatMoney(mine.shareOfCollectedEgp)}, ` +
              `he has taken ${formatMoney(mine.drawnEgp)} and owes ${formatMoney(mine.owedEgp)}.`,
            {
              partner: name,
              cycle: cycle.code,
              available: formatMoney(available),
              share: formatMoney(mine.shareOfCollectedEgp),
              drawn: formatMoney(mine.drawnEgp),
              owed: formatMoney(mine.owedEgp),
            },
          );
        }

        const entry = await tx.financialTransaction.create({
          data: {
            type: 'PROFIT_DRAW',
            category: PROFIT_DRAW_CATEGORY,
            direction: 'OUTFLOW',
            amount,
            currency: 'EGP',
            cycleId,
            relatedType: PROFIT_DRAW_RELATED,
            relatedId: id,
            occurredOn: dayDate(day),
            reason: `${name} took part of his profit from ${cycle.code}`,
            createdBy: actorId,
          },
        });
        return tx.profitDraw.create({
          data: {
            id,
            kind: 'DRAW',
            cycleId,
            partnerUserId: holder.id,
            amountEgp: amount,
            drawnOn: dayDate(day),
            note: dto.note?.trim() || null,
            ledgerEntryId: entry.id,
            createdBy: actorId,
          },
        });
      },
      // The projection reads every sale of the cycle; give it room.
      { timeout: 30_000 },
    );

    await this.audit.log({
      actorUserId: actorId,
      action: 'PROFIT_DRAW',
      entityType: 'ProfitDraw',
      entityId: created.id,
      afterJson: {
        cycleId,
        partnerUserId: holder.id,
        amountEgp: m2(created.amountEgp),
        drawnOn: day,
      },
    });
    return {
      data: { id: created.id, amountEgp: m2(created.amountEgp), drawnOn: day },
    };
  }

  /**
   * Undo a draw or capital taken back early, once, with a reason — while its
   * cycle is not yet being settled.
   */
  async reverse(id: string, dto: ReverseProfitDrawDto, actorId: string) {
    if (!isUuid(id)) throw notFound('profitDraw');
    const reason = dto.reason?.trim();
    if (!reason) {
      throw badRequest(
        'PROFIT_DRAW_REASON_REQUIRED',
        'A reason is required to undo profit taken.',
      );
    }
    const found = await this.prisma.profitDraw.findUnique({
      where: { id },
      select: { cycleId: true, kind: true },
    });
    if (!found) throw notFound('profitDraw');
    if (found.kind === 'CARRIED' || !found.cycleId) {
      throw badRequest(
        'PROFIT_DRAW_CARRIED_NOT_REVERSIBLE',
        'What a partner still owes from a payout is undone with that settlement, not on its own.',
      );
    }
    const cycleId = found.cycleId;

    const done = await this.prisma.$transaction(async (tx) => {
      await lockCycle(tx, cycleId);
      const draw = await tx.profitDraw.findUnique({ where: { id } });
      if (!draw) throw notFound('profitDraw');
      if (draw.reversedAt) {
        throw badRequest(
          'PROFIT_DRAW_ALREADY_REVERSED',
          'This profit taken was already undone.',
        );
      }
      if (draw.settledById) {
        throw badRequest(
          'PROFIT_DRAW_SETTLED',
          'This was taken off a paid settlement. Reverse that settlement first.',
        );
      }
      const cycle = await tx.importCycle.findUnique({
        where: { id: cycleId },
        select: { id: true, code: true, status: true },
      });
      await assertOpenForDraws(tx, cycle!);
      await lockAccounts(tx, [draw.partnerUserId]);

      const original = draw.ledgerEntryId
        ? await tx.financialTransaction.findUnique({
            where: { id: draw.ledgerEntryId },
          })
        : null;
      if (original) {
        await tx.financialTransaction.create({
          data: {
            type:
              draw.kind === 'CAPITAL'
                ? CAPITAL_BACK_REVERSAL_TYPE
                : 'PROFIT_DRAW_REVERSAL',
            category: original.category,
            direction: 'INFLOW',
            amount: original.amount,
            currency: original.currency,
            cycleId: original.cycleId,
            relatedType: PROFIT_DRAW_RELATED,
            relatedId: draw.id,
            reversalOfId: original.id,
            occurredOn: dayDate(businessToday()),
            reason:
              draw.kind === 'CAPITAL'
                ? `Capital taken back undone: ${reason}`
                : `Profit taken undone: ${reason}`,
            createdBy: actorId,
          },
        });
      }
      return tx.profitDraw.update({
        where: { id },
        data: {
          reversedAt: new Date(),
          reversedBy: actorId,
          reversalReason: reason,
        },
      });
    });

    await this.audit.log({
      actorUserId: actorId,
      action:
        done.kind === 'CAPITAL'
          ? 'CAPITAL_BACK_REVERSE'
          : 'PROFIT_DRAW_REVERSE',
      entityType: 'ProfitDraw',
      entityId: id,
      beforeJson: { amountEgp: m2(done.amountEgp) },
      afterJson: { reversed: true, reason },
    });
    return { data: { id, reversedAt: done.reversedAt } };
  }
}

/** Refuse once the cycle is being settled, is settled, or never ordered anything. */
async function assertOpenForDraws(
  tx: Db,
  cycle: { id: string; code: string; status: string },
) {
  const settled = await tx.settlement.findFirst({
    where: { cycleId: cycle.id, status: { in: ['APPROVED', 'PAID'] } },
    select: { status: true },
  });
  if (settled || CLOSED_FOR_DRAWS.includes(cycle.status)) {
    throw badRequest(
      'PROFIT_DRAW_CYCLE_LOCKED',
      `${cycle.code} is being settled or is closed; profit taken from it can no longer change. ` +
        'Reverse its settlement first.',
      { cycle: cycle.code, status: settled?.status ?? cycle.status },
    );
  }
}

/** Money above zero, at most two decimals, within the column. */
function positive(value: unknown): Prisma.Decimal {
  let d: Prisma.Decimal;
  try {
    d = new Prisma.Decimal(
      typeof value === 'number' || typeof value === 'string' ? value : NaN,
    );
  } catch {
    throw amountNotPositive();
  }
  if (!d.isFinite() || d.lte(0)) throw amountNotPositive();
  if (d.decimalPlaces() > 2) {
    throw badRequest(
      'PROFIT_DRAW_AMOUNT_PRECISION',
      'The amount can have at most two decimals.',
    );
  }
  if (d.gt(MAX_AMOUNT)) throw amountNotPositive();
  return d;
}

function amountNotPositive() {
  return badRequest(
    'PROFIT_DRAW_AMOUNT_NOT_POSITIVE',
    'The amount must be greater than zero.',
  );
}

function codeOf(e: BadRequestException): string {
  const body = e.getResponse() as { code?: string } | string;
  return typeof body === 'object' && body.code ? body.code : 'CYCLE_NOT_FUNDED';
}
