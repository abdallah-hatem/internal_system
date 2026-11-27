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
  profitTakeOf,
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
import { splitTake } from '../../common/take-money';
import {
  exitPayout,
  remainingRecoveredShare,
} from '../../common/investor-exit';
import { deductionsFor } from '../../common/profit-draws';
import { cycleFreightIsEstimate } from '../../common/leg-handovers';
import type {
  CreateCapitalBackDto,
  CreateProfitDrawDto,
  ExitInvestorDto,
  ReverseProfitDrawDto,
  TakeMoneyDto,
} from './dto/profit-draw.dto';

type Db = Prisma.TransactionClient;

/** Who is taking: his user id and his name. */
interface Holder {
  id: string;
  name: string;
}

/** Everything one part of a take needs to be checked and written. */
interface Write<R> {
  id: string;
  cycle: { id: string; code: string; status: string };
  holder: Holder;
  room: R;
  amount: Prisma.Decimal;
  day: string;
  note?: string;
  actorId: string;
}

type DrawRoomRead = Awaited<ReturnType<ProfitDrawsService['room']>>;
type CapitalRoomRead = Awaited<ReturnType<ProfitDrawsService['capitalRoom']>>;
type Written = {
  id: string;
  cycleId: string | null;
  partnerUserId: string;
  amountEgp: Prisma.Decimal;
};

const ZERO = new Prisma.Decimal(0);
const m2 = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v).toFixed(2);
const dayDate = (day: string) => new Date(`${day}T00:00:00Z`);

/** The most a single draw may be: the ledger's columns hold 18,2. */
const MAX_AMOUNT = new Prisma.Decimal('9999999999999999.99');

/** One person's part of the profit collected, summed over his rows on the cycle. */
interface TakePart {
  takeable: Prisma.Decimal;
  fee: Prisma.Decimal;
  feeReceived: Prisma.Decimal;
  pct: Prisma.Decimal;
}

/**
 * Each participant's room to take profit from a cycle right now — a core
 * partner's, or a temporary investor's (owner 2026-11-16).
 */
export interface DrawRoom {
  /** His user, a partner's or an investor's (the draw row's `partnerUserId`). */
  partnerUserId: string;
  participantType: string;
  name: string;
  /** His share of the split, in percent (4dp); null when there is no basis. */
  sharePct: string | null;
  /**
   * His part of the profit collected so far, as his payout would pay it: an
   * investor's net of his fee, a partner's with his part of those fees.
   */
  shareOfCollectedEgp: string;
  /** The investor's fee off his part of what is collected (zero for a partner). */
  investorFeeEgp: string;
  /** A partner's part of the investors' fees on what is collected (zero for an investor). */
  feeReceivedEgp: string;
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
  /** His participant row on the cycle (the exit endpoint's id). */
  participantId: string;
  /** Paid out and off the cycle (§8, 2026-11-27), his figures frozen; null while on it. */
  exit: ExitView | null;
}

/** An investor's exit as the cards show it (§8, 2026-11-27). */
export interface ExitView {
  exitedOn: string;
  capitalEgp: string;
  /** His profit share, net of any fee. */
  profitEgp: string;
  feeEgp: string;
  sharePct: string;
  /** Cash handed over at exit: capital + profit − what he had taken early. */
  paidEgp: string;
}

/** The exit columns of a participant row, for the cards; null while he is on the cycle. */
export function exitViewOf(p: {
  exitedOn: Date | null;
  exitCapitalEgp: Prisma.Decimal | null;
  exitProfitEgp: Prisma.Decimal | null;
  exitFeeEgp: Prisma.Decimal | null;
  exitSharePct: Prisma.Decimal | null;
  exitPaidEgp: Prisma.Decimal | null;
}): ExitView | null {
  if (!p.exitedOn) return null;
  return {
    exitedOn: p.exitedOn.toISOString().slice(0, 10),
    capitalEgp: m2(p.exitCapitalEgp ?? 0),
    profitEgp: m2(p.exitProfitEgp ?? 0),
    feeEgp: m2(p.exitFeeEgp ?? 0),
    sharePct: new Prisma.Decimal(p.exitSharePct ?? 0).toFixed(4),
    paidEgp: m2(p.exitPaidEgp ?? 0),
  };
}

/**
 * Profit taken before a cycle is settled (BUSINESS_LOGIC §8, owner
 * 2026-11-08) — and since the same day capital taken back early, by any
 * participant, out of what paid sales recovered. Anyone on the cycle — a core
 * partner, or since 2026-11-16 an investor, net of his fee — takes part of his
 * share of the profit already collected, in cash; the cycle's profit is
 * unchanged, and its settlement takes the draw off his payout
 * (`SettlementsService`).
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

  /** The cycle's draws, newest first, and each participant's room to take more. */
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
          /** Paid out at an investor's exit (§8, 2026-11-27): final, never undone on its own. */
          exit: d.exitParticipantId !== null,
        })),
      },
    };
  }

  /**
   * Each participant's room to take profit on the cycle — core partners and,
   * since the owner's 2026-11-16 decision, temporary investors — read through
   * `db` (the transaction's client when writing, so the draws counted are the
   * ones the cycle and account locks protect).
   */
  private async room(db: Db | PrismaService, cycleId: string) {
    // In the split's order, as settling reads them (createdAt), so the
    // rounding residual lands on the same line it will at settlement.
    const all = await db.cycleParticipant.findMany({
      where: { cycleId },
      orderBy: { createdAt: 'asc' },
      include: {
        partner: {
          select: { email: true, partner: { select: { displayName: true } } },
        },
        investor: {
          select: { email: true, partner: { select: { displayName: true } } },
        },
      },
    });

    // The settlement's own arithmetic, never a second one (rule 11).
    let profit: Prisma.Decimal | null = null;
    let problem: string | null = null;
    const parts = new Map<string, TakePart>();
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
      const inputs = participantInputsOf(all);
      // Each participant's part of what is collected, the way the payout
      // splits the whole profit: an investor's net of his fee, a partner's
      // with his part of the investors' fees (§8, 2026-11-16).
      const lines = profitTakeOf(inputs, collected);
      // The split's percentages do not depend on the amount split.
      const pcts = lines ? distributeCycleProfit(inputs, profit).lines : [];
      if (lines) {
        all.forEach((p, i) => {
          const userId = p.partnerUserId ?? p.investorUserId;
          if (!userId) return;
          const was = parts.get(userId);
          parts.set(userId, {
            takeable: (was?.takeable ?? ZERO).add(lines[i].takeable),
            fee: (was?.fee ?? ZERO).add(lines[i].investorFee),
            feeReceived: (was?.feeReceived ?? ZERO).add(lines[i].feeReceived),
            pct: (was?.pct ?? ZERO).add(pcts[i].sharePct),
          });
        });
      }
    }

    const userIds = [
      ...new Set(
        all
          .map((p) => p.partnerUserId ?? p.investorUserId)
          .filter((u): u is string => !!u),
      ),
    ];
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
    for (const c of all) {
      const userId = c.partnerUserId ?? c.investorUserId;
      if (!userId || seen.has(userId)) continue;
      seen.add(userId);
      const who = c.partner ?? c.investor;
      const mine = standing.filter((s) => s.partnerUserId === userId);
      const drawn = mine
        .filter((s) => s.kind === 'DRAW')
        .reduce((s, r) => s.add(r.amountEgp), ZERO);
      const owed = mine
        .filter((s) => s.kind === 'CARRIED')
        .reduce((s, r) => s.add(r.amountEgp), ZERO);
      const part = parts.get(userId);
      const share = part?.takeable ?? ZERO;
      // Paid out and off the cycle (§8, 2026-11-27): nothing more to take.
      const left = c.exitedOn ? ZERO : share.sub(drawn).sub(owed);
      partners.push({
        partnerUserId: userId,
        participantType: c.participantType,
        name: who?.partner?.displayName ?? who?.email ?? userId,
        sharePct: part?.pct.toFixed(4) ?? null,
        shareOfCollectedEgp: m2(share),
        investorFeeEgp: m2(part?.fee ?? ZERO),
        feeReceivedEgp: m2(part?.feeReceived ?? ZERO),
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
        /** After exits took their capital: the share of the remaining participants' capital still covered. */
        remainingRecoveredPct: room.liveShare.mul(100).toFixed(2),
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
          /** Paid out at an investor's exit (§8, 2026-11-27): final, never undone on its own. */
          exit: d.exitParticipantId !== null,
        })),
      },
    };
  }

  /**
   * Both rooms per participant, and everything taken, in one read — the
   * cycle page's "Take money from this cycle" card (§8, owner 2026-11-10).
   * Made of the two reads above, never a third reckoning of either room
   * (rule 11): profit and capital, everyone's — an investor's profit net of
   * his fee (owner 2026-11-16).
   */
  async takeForCycle(cycleId: string) {
    const { data: profit } = await this.forCycle(cycleId);
    const { data: capital } = await this.capitalForCycle(cycleId);
    const profitOf = new Map(profit.partners.map((p) => [p.partnerUserId, p]));
    const people = capital.people.map((c) => {
      const p = profitOf.get(c.userId);
      // No split to take a share of: his profit room is nothing for now.
      const profitAvailable = p && !profit.problem ? p.availableEgp : '0.00';
      return {
        userId: c.userId,
        participantId: c.participantId,
        name: c.name,
        participantType: c.participantType,
        /** Paid out and off the cycle, figures frozen (§8, 2026-11-27); null while on it. */
        exit: c.exit,
        /** Null only for someone not in the profit split at all. */
        profit: p
          ? {
              sharePct: p.sharePct,
              shareOfCollectedEgp: p.shareOfCollectedEgp,
              investorFeeEgp: p.investorFeeEgp,
              feeReceivedEgp: p.feeReceivedEgp,
              takenEgp: p.drawnEgp,
              owedEgp: p.owedEgp,
              availableEgp: profitAvailable,
            }
          : null,
        capital: {
          contributionEgp: c.contributionEgp,
          recoveredEgp: c.recoveredEgp,
          takenEgp: c.takenEgp,
          availableEgp: c.availableEgp,
        },
        /** What he may take now in all: profit first, then capital. */
        availableEgp: m2(
          new Prisma.Decimal(profitAvailable).add(c.availableEgp),
        ),
      };
    });
    const taken = [
      ...profit.draws.map((d) => ({
        id: d.id,
        kind: 'PROFIT' as const,
        userId: d.partnerUserId,
        name: d.name,
        amountEgp: d.amountEgp,
        takenOn: d.drawnOn,
        note: d.note,
        createdAt: d.createdAt,
        reversedAt: d.reversedAt,
        reversalReason: d.reversalReason,
        settled: d.settled,
        exit: d.exit,
      })),
      ...capital.taken.map((d) => ({ ...d, kind: 'CAPITAL' as const })),
    ].sort(
      (a, b) =>
        b.takenOn.localeCompare(a.takenOn) ||
        b.createdAt.getTime() - a.createdAt.getTime() ||
        b.id.localeCompare(a.id),
    );
    return {
      data: {
        cycleId,
        cycleCode: profit.cycleCode,
        locked: profit.locked,
        /** Why no profit can be taken (no agreed split), or null; capital still can. */
        problem: profit.problem,
        profitEgp: profit.profitEgp,
        /** A leg's freight is still an estimate (§2, 2026-11-20): so is this profit. */
        freightEstimate: await cycleFreightIsEstimate(this.prisma, cycleId),
        sharePaidPct: profit.sharePaidPct,
        collectedProfitEgp: profit.collectedProfitEgp,
        toFundEgp: capital.toFundEgp,
        recoveredEgp: capital.recoveredEgp,
        recoveredPct: capital.recoveredPct,
        remainingRecoveredPct: capital.remainingRecoveredPct,
        people,
        taken,
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

    // What exits paid as capital came out of the cash recovered: the rest is
    // the remaining participants' (§8, 2026-11-27), so the partners who
    // advanced an exit cannot take that same money again.
    const takenBy = (userId: string | null) =>
      standing
        .filter((s) => s.partnerUserId === userId)
        .reduce((s, r) => s.add(r.amountEgp), ZERO);
    const sumOf = (rows: typeof participants) =>
      rows.reduce((s, p) => s.add(p.contributionAmount), ZERO);
    const exited = participants.filter((p) => p.exitedOn);
    const liveShare = remainingRecoveredShare({
      share,
      allContributions: sumOf(participants),
      liveContributions: sumOf(participants.filter((p) => !p.exitedOn)),
      exitedCapitalTaken: exited.reduce(
        (s, p) => s.add(takenBy(p.investorUserId)),
        ZERO,
      ),
      anyExited: exited.length > 0,
    });

    const seen = new Set<string>();
    const people: CapitalRoom[] = [];
    for (const p of participants) {
      const userId = p.partnerUserId ?? p.investorUserId;
      if (!userId || seen.has(userId)) continue;
      seen.add(userId);
      const who = p.partner ?? p.investor;
      const taken = takenBy(userId);
      const contribution = new Prisma.Decimal(p.contributionAmount);
      const r = p.exitedOn
        ? { recoveredEgp: contribution, availableEgp: ZERO }
        : capitalRoom({ share: liveShare, contribution, taken });
      people.push({
        userId,
        participantType: p.participantType,
        name: who?.partner?.displayName ?? who?.email ?? userId,
        contributionEgp: m2(contribution),
        recoveredEgp: m2(r.recoveredEgp),
        takenEgp: m2(taken),
        availableEgp: m2(r.availableEgp),
        participantId: p.id,
        exit: exitViewOf(p),
      });
    }
    return { toFund, recovered, share, liveShare, people };
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
    const holder = await this.holderOf(dto.userId);
    if (!holder) throw notFound('participant');

    const created = await this.prisma.$transaction(
      async (tx) => {
        const cycle = await this.openForTaking(tx, cycleId, holder.id);
        const room = await this.capitalRoom(tx, cycleId);
        return this.writeCapital(tx, {
          id: randomUUID(),
          cycle,
          holder,
          room,
          amount,
          day,
          note: dto.note,
          actorId,
        });
      },
      { timeout: 30_000 },
    );

    await this.auditCapital(actorId, created, day);
    return {
      data: { id: created.id, amountEgp: m2(created.amountEgp), takenOn: day },
    };
  }

  /**
   * Someone on the cycle — a core partner, or an investor since 2026-11-16 —
   * takes part of his share of the profit collected so far.
   */
  async create(cycleId: string, dto: CreateProfitDrawDto, actorId: string) {
    if (!isUuid(cycleId)) throw notFound('cycle');
    if (!isUuid(dto.partnerUserId)) throw notFound('partner');
    const amount = positive(dto.amountEgp);
    assertNotFuture(dto.drawnOn, 'PROFIT_DRAWN');
    const day = dto.drawnOn ? businessDay(dto.drawnOn) : businessToday();
    const holder = await this.holderOf(dto.partnerUserId);
    if (!holder) throw notFound('partner');

    const created = await this.prisma.$transaction(
      async (tx) => {
        const cycle = await this.openForTaking(tx, cycleId, holder.id);
        const room = await this.room(tx, cycleId);
        return this.writeProfit(tx, {
          id: randomUUID(),
          cycle,
          holder,
          room,
          amount,
          day,
          note: dto.note,
          actorId,
        });
      },
      // The projection reads every sale of the cycle; give it room.
      { timeout: 30_000 },
    );

    await this.auditProfit(actorId, created, day);
    return {
      data: { id: created.id, amountEgp: m2(created.amountEgp), drawnOn: day },
    };
  }

  /**
   * One take from the cycle — profit first, then capital (§8, owner
   * 2026-11-10: one card; the order a GUESS, `splitTake`). Both parts are
   * recorded in one transaction, under the same locks and through the same
   * writers and checks as taking either on its own, so a person never gets
   * half a take: both rows and their cash rows are written, or nothing is.
   */
  async take(cycleId: string, dto: TakeMoneyDto, actorId: string) {
    if (!isUuid(cycleId)) throw notFound('cycle');
    if (!isUuid(dto.userId)) throw notFound('participant');
    const amount = positive(dto.amountEgp);
    assertNotFuture(dto.takenOn, 'MONEY_TAKEN');
    const day = dto.takenOn ? businessDay(dto.takenOn) : businessToday();
    const holder = await this.holderOf(dto.userId);
    if (!holder) throw notFound('participant');

    const done = await this.prisma.$transaction(
      async (tx) => {
        const cycle = await this.openForTaking(tx, cycleId, holder.id);
        // Both rooms before anything is written: the take is cut from what he
        // could take at this moment.
        const capital = await this.capitalRoom(tx, cycleId);
        const capMine = capital.people.find((p) => p.userId === holder.id);
        if (!capMine) {
          throw badRequest(
            'CAPITAL_BACK_NOT_ON_CYCLE',
            `${holder.name} has no capital in ${cycle.code} to take back.`,
            { partner: holder.name, cycle: cycle.code },
          );
        }
        // Profit is anyone's on the cycle — a partner's or an investor's, net
        // of his fee (owner 2026-11-16) — while the split has a basis;
        // otherwise his profit room is nothing.
        const profit = await this.room(tx, cycleId);
        const profitMine = !profit.problem
          ? profit.partners.find((p) => p.partnerUserId === holder.id)
          : undefined;
        const profitRoom = new Prisma.Decimal(profitMine?.availableEgp ?? 0);
        const capitalRoomNow = new Prisma.Decimal(capMine.availableEgp);

        const split = splitTake(amount, profitRoom, capitalRoomNow);
        if (!split) {
          const most = profitRoom.add(capitalRoomNow);
          throw badRequest(
            'TAKE_OVER_AVAILABLE',
            `${holder.name} can take at most ${formatMoney(most)} EGP from ${cycle.code} now: ` +
              `${formatMoney(profitRoom)} of profit and ${formatMoney(capitalRoomNow)} of capital.`,
            {
              partner: holder.name,
              cycle: cycle.code,
              available: formatMoney(most),
              profit: formatMoney(profitRoom),
              capital: formatMoney(capitalRoomNow),
            },
          );
        }

        const drawn = split.profit.gt(0)
          ? await this.writeProfit(tx, {
              id: randomUUID(),
              cycle,
              holder,
              room: profit,
              amount: split.profit,
              day,
              note: dto.note,
              actorId,
            })
          : null;
        const takenBack = split.capital.gt(0)
          ? await this.writeCapital(tx, {
              id: randomUUID(),
              cycle,
              holder,
              room: capital,
              amount: split.capital,
              day,
              note: dto.note,
              actorId,
            })
          : null;
        return { drawn, takenBack };
      },
      { timeout: 30_000 },
    );

    // After the commit, never inside it (one connection in production).
    if (done.drawn) await this.auditProfit(actorId, done.drawn, day);
    if (done.takenBack) await this.auditCapital(actorId, done.takenBack, day);
    return {
      data: {
        takenOn: day,
        amountEgp: m2(amount),
        profit: done.drawn
          ? { id: done.drawn.id, amountEgp: m2(done.drawn.amountEgp) }
          : null,
        capital: done.takenBack
          ? { id: done.takenBack.id, amountEgp: m2(done.takenBack.amountEgp) }
          : null,
      },
    };
  }

  // ─── An investor's exit (§8, owner 2026-11-27) ──────────────────────

  /**
   * What paying this investor out and taking him off the cycle would hand
   * over today — the dialog's figures, from the very reckoning `exit`
   * records. Nothing is written.
   */
  async exitPreview(cycleId: string, participantId: string) {
    if (!isUuid(cycleId)) throw notFound('cycle');
    if (!isUuid(participantId)) throw notFound('participant');
    const f = await this.prisma.$transaction(
      (tx) => this.exitFigures(tx, cycleId, participantId),
      { timeout: 30_000 },
    );
    return { data: exitFiguresView(f) };
  }

  /**
   * Pay a temporary investor out and take him off the cycle (§8, owner
   * 2026-11-27: "kick them both out by giving them their money", with his
   * profit "until today with all expenses"). Capital + his share of the
   * profit as the settlement projects it now, less what he already took
   * early, in cash from the business today — even beyond what customers have
   * paid so far: the partners advance the rest. Written in one transaction
   * under the cycle's lock and his account's: his frozen figures on his
   * participant row, and the payout as a profit draw and a capital taken back
   * (their own ledger categories), so the cycle's profit does not move and
   * his settlement payout comes to exactly nothing.
   */
  async exit(
    cycleId: string,
    participantId: string,
    dto: ExitInvestorDto,
    actorId: string,
  ) {
    if (!isUuid(cycleId)) throw notFound('cycle');
    if (!isUuid(participantId)) throw notFound('participant');
    assertNotFuture(dto.exitedOn, 'INVESTOR_EXITED');
    const day = dto.exitedOn ? businessDay(dto.exitedOn) : businessToday();

    const done = await this.prisma.$transaction(
      async (tx) => {
        const f = await this.exitFigures(tx, cycleId, participantId);
        const holder = { id: f.userId, name: f.name };
        const note = dto.note?.trim() || undefined;
        const write = async (
          amount: Prisma.Decimal,
          kind: 'DRAW' | 'CAPITAL',
        ) => {
          if (amount.lte(0)) return null;
          return this.writeRows(
            tx,
            {
              id: randomUUID(),
              cycle: f.cycle,
              holder,
              room: null,
              amount,
              day,
              note,
              actorId,
            },
            kind === 'DRAW'
              ? {
                  kind,
                  type: 'PROFIT_DRAW',
                  category: PROFIT_DRAW_CATEGORY,
                  reason: `${holder.name} paid out and removed from ${f.cycle.code}: his profit`,
                  exitParticipantId: participantId,
                }
              : {
                  kind,
                  type: CAPITAL_BACK_TYPE,
                  category: CAPITAL_BACK_CATEGORY,
                  reason: `${holder.name} paid out and removed from ${f.cycle.code}: his capital`,
                  exitParticipantId: participantId,
                },
          );
        };
        const profitRow = await write(f.split.profitPart, 'DRAW');
        const capitalRow = await write(f.split.capitalPart, 'CAPITAL');
        await tx.cycleParticipant.update({
          where: { id: participantId },
          data: {
            exitedOn: dayDate(day),
            exitCapitalEgp: f.capital,
            exitGrossProfitEgp: f.grossProfit,
            exitFeeEgp: f.investorFee,
            exitProfitEgp: f.netProfit,
            exitSharePct: f.sharePct,
            exitCycleProfitEgp: f.cycleProfit,
            exitPaidEgp: f.split.payout,
            exitedAt: new Date(),
            exitedBy: actorId,
          },
        });
        return { f, profitRow, capitalRow };
      },
      { timeout: 30_000 },
    );

    // After the commit, never inside it (one connection in production).
    await this.audit.log({
      actorUserId: actorId,
      action: 'INVESTOR_EXIT',
      entityType: 'CycleParticipant',
      entityId: participantId,
      afterJson: {
        cycleId,
        exitedOn: day,
        ...exitFiguresView(done.f),
        profitDrawId: done.profitRow?.id ?? null,
        capitalRowId: done.capitalRow?.id ?? null,
      },
    });
    return { data: { ...exitFiguresView(done.f), exitedOn: day } };
  }

  /**
   * The reckoning of an exit, under the cycle's lock then his account's, with
   * every refusal: only a temporary investor, once, on a cycle not being
   * settled, with a core partner left to take the rest, a split with a
   * basis, and a payout of nothing or more.
   */
  private async exitFigures(tx: Db, cycleId: string, participantId: string) {
    await lockCycle(tx, cycleId);
    const cycle = await tx.importCycle.findUnique({
      where: { id: cycleId },
      select: { id: true, code: true, status: true },
    });
    if (!cycle) throw notFound('cycle');
    const row = await tx.cycleParticipant.findFirst({
      where: { id: participantId, cycleId },
      include: {
        investor: {
          select: { email: true, partner: { select: { displayName: true } } },
        },
        partner: {
          select: { email: true, partner: { select: { displayName: true } } },
        },
      },
    });
    if (!row) throw notFound('participant');
    const who = row.investor ?? row.partner;
    const name = who?.partner?.displayName ?? who?.email ?? row.id;
    const userId = row.investorUserId ?? row.partnerUserId;
    if (row.participantType !== 'TEMP_INVESTOR' || !row.investorUserId) {
      throw badRequest(
        'EXIT_NOT_AN_INVESTOR',
        `${name} is a core partner on ${cycle.code}; only a temporary investor can be paid out and removed.`,
        { name, cycle: cycle.code },
      );
    }
    if (row.exitedOn) {
      throw badRequest(
        'EXIT_ALREADY_EXITED',
        `${name} was already paid out and removed from ${cycle.code} on ${row.exitedOn.toISOString().slice(0, 10)}.`,
        {
          name,
          cycle: cycle.code,
          day: row.exitedOn.toISOString().slice(0, 10),
        },
      );
    }
    const settled = await tx.settlement.findFirst({
      where: { cycleId, status: { in: ['APPROVED', 'PAID'] } },
      select: { status: true },
    });
    if (settled || CLOSED_FOR_DRAWS.includes(cycle.status)) {
      throw badRequest(
        'EXIT_CYCLE_LOCKED',
        `${cycle.code} is being settled or is closed; nobody can be paid out of it now.`,
        { cycle: cycle.code, status: settled?.status ?? cycle.status },
      );
    }
    // The same person on the cycle as a core partner too: his deductions
    // cannot be told apart, so no exit (GUESS — the case does not exist).
    const twice = await tx.cycleParticipant.count({
      where: { cycleId, partnerUserId: row.investorUserId },
    });
    if (twice > 0) {
      throw badRequest(
        'EXIT_NOT_AN_INVESTOR',
        `${name} is a core partner on ${cycle.code}; only a temporary investor can be paid out and removed.`,
        { name, cycle: cycle.code },
      );
    }
    const partnersLeft = await tx.cycleParticipant.count({
      where: { cycleId, participantType: 'CORE_PARTNER' },
    });
    if (partnersLeft === 0) {
      throw badRequest(
        'EXIT_NO_PARTNER_LEFT',
        `${cycle.code} has no core partner to take over ${name}'s share, so he cannot be removed.`,
        { name, cycle: cycle.code },
      );
    }
    await lockAccounts(tx, [row.investorUserId]);

    // The settlement's own projection, now, exits already made included
    // (rule 11). A split with no basis refuses with its own code.
    const projected = await this.settlements.project(cycleId, tx);
    const line = projected?.distribution.lines.find(
      (l) => l.participantId === row.id,
    );
    if (!projected || !line) throw notFound('participant');
    const capital = line.capitalReturn;
    const { byPartner, capitalByUser } = await deductionsFor(tx, cycleId, [
      row.investorUserId,
    ]);
    const takenProfit = byPartner.get(row.investorUserId) ?? ZERO;
    const takenCapital = capitalByUser.get(row.investorUserId) ?? ZERO;
    const split = exitPayout({
      capital,
      netProfit: line.netProfit,
      takenProfit,
      takenCapital,
    });
    if (!split) {
      const owes = capital
        .add(line.netProfit)
        .sub(takenProfit)
        .sub(takenCapital)
        .neg();
      throw badRequest(
        'EXIT_PAYOUT_NEGATIVE',
        `${name} has already taken ${formatMoney(owes)} EGP more than his capital and share of ${cycle.code}'s profit come to; an exit cannot collect money from him.`,
        { name, cycle: cycle.code, owes: formatMoney(owes) },
      );
    }
    return {
      cycle,
      participantId: row.id,
      userId: userId!,
      name,
      capital,
      cycleProfit: projected.pnl.grossProfit,
      // His share of the cycle's whole profit — after an earlier exit the
      // split's own % is of what was left, which would not read as a share
      // of the profit shown beside it.
      sharePct: projected.pnl.grossProfit.isZero()
        ? line.sharePct
        : line.grossProfit
            .div(projected.pnl.grossProfit)
            .mul(100)
            .toDecimalPlaces(4),
      grossProfit: line.grossProfit,
      investorFee: line.investorFee,
      netProfit: line.netProfit,
      takenProfit,
      takenCapital,
      split,
    };
  }

  /** The person taking: his name as the office knows him. */
  private async holderOf(userId: string): Promise<Holder | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        partner: { select: { displayName: true } },
      },
    });
    if (!user) return null;
    return { id: user.id, name: user.partner?.displayName ?? user.email };
  }

  /**
   * The cycle first, then his account: the order every writer here takes them
   * in. An approval waits on the cycle's lock, so none slips in between the
   * checks that follow and the write.
   */
  private async openForTaking(tx: Db, cycleId: string, holderId: string) {
    await lockCycle(tx, cycleId);
    const cycle = await tx.importCycle.findUnique({
      where: { id: cycleId },
      select: { id: true, code: true, status: true },
    });
    if (!cycle) throw notFound('cycle');
    await assertOpenForDraws(tx, cycle);
    await assertNotExited(tx, cycle, holderId);
    await lockAccounts(tx, [holderId]);
    return cycle;
  }

  /**
   * Profit taken: he is on the cycle — a core partner or an investor (owner
   * 2026-11-16) — the split has a basis, and the amount is within his room —
   * then its cash row and its draw. `room` was read through `tx`, under the
   * locks `openForTaking` took.
   */
  private async writeProfit(tx: Db, w: Write<DrawRoomRead>) {
    const { cycle, holder, room, amount } = w;
    const onCycle = await tx.cycleParticipant.findFirst({
      where: {
        cycleId: cycle.id,
        OR: [{ partnerUserId: holder.id }, { investorUserId: holder.id }],
      },
      select: { id: true },
    });
    if (!onCycle) {
      throw badRequest(
        'PROFIT_DRAW_NOT_ON_CYCLE',
        `${holder.name} is not on ${cycle.code}, so has no share of its profit to take.`,
        { partner: holder.name, cycle: cycle.code },
      );
    }
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
        `${holder.name} can take at most ${formatMoney(available)} EGP from ${cycle.code} now: ` +
          `his share of the profit collected is ${formatMoney(mine.shareOfCollectedEgp)}, ` +
          `he has taken ${formatMoney(mine.drawnEgp)} and owes ${formatMoney(mine.owedEgp)}.`,
        {
          partner: holder.name,
          cycle: cycle.code,
          available: formatMoney(available),
          share: formatMoney(mine.shareOfCollectedEgp),
          drawn: formatMoney(mine.drawnEgp),
          owed: formatMoney(mine.owedEgp),
        },
      );
    }
    return this.writeRows(tx, w, {
      kind: 'DRAW',
      type: 'PROFIT_DRAW',
      category: PROFIT_DRAW_CATEGORY,
      reason: `${holder.name} took part of his profit from ${cycle.code}`,
    });
  }

  /** Capital taken back: he is on the cycle and the amount is within his part recovered. */
  private async writeCapital(tx: Db, w: Write<CapitalRoomRead>) {
    const { cycle, holder, room, amount } = w;
    const mine = room.people.find((p) => p.userId === holder.id);
    if (!mine) {
      throw badRequest(
        'CAPITAL_BACK_NOT_ON_CYCLE',
        `${holder.name} has no capital in ${cycle.code} to take back.`,
        { partner: holder.name, cycle: cycle.code },
      );
    }
    const available = new Prisma.Decimal(mine.availableEgp);
    if (amount.gt(available)) {
      throw badRequest(
        'CAPITAL_BACK_OVER_AVAILABLE',
        `${holder.name} can take back at most ${formatMoney(available)} EGP from ${cycle.code} now: ` +
          `paid sales have recovered ${room.share.mul(100).toFixed(2)}% of its cost, ` +
          `${formatMoney(mine.recoveredEgp)} of the ${formatMoney(mine.contributionEgp)} he put in, ` +
          `and he has taken back ${formatMoney(mine.takenEgp)}.`,
        {
          partner: holder.name,
          cycle: cycle.code,
          available: formatMoney(available),
          pct: room.share.mul(100).toFixed(2),
          recovered: formatMoney(mine.recoveredEgp),
          contribution: formatMoney(mine.contributionEgp),
          taken: formatMoney(mine.takenEgp),
        },
      );
    }
    return this.writeRows(tx, w, {
      kind: 'CAPITAL',
      type: CAPITAL_BACK_TYPE,
      category: CAPITAL_BACK_CATEGORY,
      reason: `${holder.name} took part of his capital back from ${cycle.code}`,
    });
  }

  /** The cash row out, and the draw row that owns it. */
  private async writeRows(
    tx: Db,
    w: Write<unknown>,
    as: {
      kind: 'DRAW' | 'CAPITAL';
      type: string;
      category: string;
      reason: string;
      /** The investor's exit it pays out (§8, 2026-11-27). */
      exitParticipantId?: string;
    },
  ) {
    const entry = await tx.financialTransaction.create({
      data: {
        type: as.type,
        category: as.category,
        direction: 'OUTFLOW',
        amount: w.amount,
        currency: 'EGP',
        cycleId: w.cycle.id,
        relatedType: PROFIT_DRAW_RELATED,
        relatedId: w.id,
        occurredOn: dayDate(w.day),
        reason: as.reason,
        createdBy: w.actorId,
      },
    });
    return tx.profitDraw.create({
      data: {
        id: w.id,
        kind: as.kind,
        cycleId: w.cycle.id,
        partnerUserId: w.holder.id,
        amountEgp: w.amount,
        drawnOn: dayDate(w.day),
        note: w.note?.trim() || null,
        ledgerEntryId: entry.id,
        exitParticipantId: as.exitParticipantId ?? null,
        createdBy: w.actorId,
      },
    });
  }

  private auditProfit(actorId: string, row: Written, day: string) {
    return this.audit.log({
      actorUserId: actorId,
      action: 'PROFIT_DRAW',
      entityType: 'ProfitDraw',
      entityId: row.id,
      afterJson: {
        cycleId: row.cycleId,
        partnerUserId: row.partnerUserId,
        amountEgp: m2(row.amountEgp),
        drawnOn: day,
      },
    });
  }

  private auditCapital(actorId: string, row: Written, day: string) {
    return this.audit.log({
      actorUserId: actorId,
      action: 'CAPITAL_BACK_EARLY',
      entityType: 'ProfitDraw',
      entityId: row.id,
      afterJson: {
        cycleId: row.cycleId,
        userId: row.partnerUserId,
        amountEgp: m2(row.amountEgp),
        takenOn: day,
      },
    });
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
      // Paid out at an exit, or taken by someone since paid out: his
      // figures are frozen (§8, 2026-11-27).
      await assertNotExited(tx, cycle!, draw.partnerUserId);
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

/**
 * Refuse taking, or undoing, for someone paid out and removed from the cycle
 * (§8, 2026-11-27): his figures are frozen at what he was paid.
 */
async function assertNotExited(
  tx: Db,
  cycle: { id: string; code: string },
  userId: string,
) {
  const gone = await tx.cycleParticipant.findFirst({
    where: {
      cycleId: cycle.id,
      investorUserId: userId,
      exitedOn: { not: null },
    },
    select: { exitedOn: true },
  });
  if (!gone) return;
  throw badRequest(
    'EXIT_PARTICIPANT_EXITED',
    `This investor was paid out and removed from ${cycle.code} on ${gone.exitedOn!.toISOString().slice(0, 10)}; nothing he took can change.`,
    { cycle: cycle.code, day: gone.exitedOn!.toISOString().slice(0, 10) },
  );
}

/** An exit's figures as the dialog and the audit read them. */
function exitFiguresView(f: {
  participantId: string;
  userId: string;
  name: string;
  capital: Prisma.Decimal;
  cycleProfit: Prisma.Decimal;
  sharePct: Prisma.Decimal;
  grossProfit: Prisma.Decimal;
  investorFee: Prisma.Decimal;
  netProfit: Prisma.Decimal;
  takenProfit: Prisma.Decimal;
  takenCapital: Prisma.Decimal;
  split: {
    profitPart: Prisma.Decimal;
    capitalPart: Prisma.Decimal;
    payout: Prisma.Decimal;
  };
}) {
  return {
    participantId: f.participantId,
    userId: f.userId,
    name: f.name,
    /** The cycle's profit now, as the settlement projects it. */
    cycleProfitEgp: m2(f.cycleProfit),
    sharePct: f.sharePct.toFixed(4),
    capitalEgp: m2(f.capital),
    /** His share before any fee, and the fee off it. */
    grossProfitEgp: m2(f.grossProfit),
    investorFeeEgp: m2(f.investorFee),
    /** His share of the profit, net of his fee: what he is paid for. */
    profitEgp: m2(f.netProfit),
    /** Taken early: profit drawn (with anything owed from an earlier payout) and capital back. */
    takenProfitEgp: m2(f.takenProfit),
    takenCapitalEgp: m2(f.takenCapital),
    /** Paid now: profit part, capital part, together. */
    payProfitEgp: m2(f.split.profitPart),
    payCapitalEgp: m2(f.split.capitalPart),
    payoutEgp: m2(f.split.payout),
  };
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
