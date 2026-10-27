import { Injectable } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; money must not become a float
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CostingService } from '../costing/costing.service';
import { badRequest, notFound } from '../../common/api-error';
import { formatMoney } from '../../common/money';
import { isUuid } from '../../common/uuid';
import { lockCycle } from '../../common/shipment-load';
import { assertFundingOpen, fundingLockOf } from '../../common/funding-lock';
import {
  assertNotFuture,
  businessDay,
  businessToday,
  type DateField,
} from '../../common/dates';
import { parseCurrencyCode, parseRateToEgp } from '../../common/fx-rate';
import { recordContributionChange } from '../../common/contribution-ledger';
import { profitShareOf, profitSplitView } from '../settlements/settlement-math';
import {
  STANDING_FINANCING,
  exchangeDifferenceEgp,
  repaidOnCycleEgp,
} from '../../common/lender-debt';
import {
  STANDING_MOVEMENT,
  accountPots,
  accountPotsOf,
  assertCycleCovers,
  assertUntiedCovers,
  availableTo,
  balanceOf,
  contributionShares,
  equalShares,
  inTargetCurrency,
  lockAccounts,
  potsOf,
  potsTotal,
  putInSoFar,
  signedEgp,
  untiedAvailable,
  type MovementKind,
} from '../../common/partner-account';
import type {
  ContributeFromAccountsDto,
  CreateAdvanceDto,
  CreateWithdrawalDto,
  FundingTargetDto,
} from './dto/partner-account.dto';

type Db = Prisma.TransactionClient;

const D = (v: Prisma.Decimal.Value | null | undefined) =>
  new Prisma.Decimal(v ?? 0);
const m2 = (v: Prisma.Decimal.Value) => D(v).toFixed(2);

/**
 * A cycle in these states takes no advance, no contribution from an account
 * and no funding target (§8, 2026-10-25 GUESS, as for a friend's payment,
 * §18): it is being split, was split, or never ordered anything (§15).
 */
export const CLOSED_FOR_ACCOUNTS = ['SETTLEMENT', 'CLOSED', 'CANCELLED'];

/** A day as stored in a `@db.Date` column. */
const dayDate = (day: string) => new Date(`${day}T00:00:00Z`);

/**
 * Partners' running accounts (BUSINESS_LOGIC §8, owner 2026-10-25): advances
 * paid straight to suppliers, contributions drawn into cycles, money taken
 * out, and payouts left in. The balance is `common/partner-account.ts`'s,
 * never summed here.
 */
@Injectable()
export class PartnerAccountsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private costing: CostingService,
  ) {}

  // ─── Reading ─────────────────────────────────────────────────────────

  /** Every core partner's account: balance, totals by kind, movements newest first. */
  async list() {
    const holders = await this.prisma.user.findMany({
      where: { role: 'CORE_PARTNER', partner: { isNot: null } },
      select: {
        id: true,
        email: true,
        status: true,
        partner: {
          select: { displayName: true, active: true, createdAt: true },
        },
      },
      orderBy: [{ partner: { createdAt: 'asc' } }, { id: 'asc' }],
    });
    const movements = await this.prisma.partnerAccountMovement.findMany({
      where: { partnerUserId: { in: holders.map((h) => h.id) } },
      include: {
        cycle: { select: { id: true, code: true } },
        expenseEntry: { select: { category: true } },
      },
      orderBy: [{ occurredOn: 'desc' }, { createdAt: 'desc' }],
    });
    return {
      data: holders.map((h) => {
        const mine = movements.filter((m) => m.partnerUserId === h.id);
        return {
          partnerUserId: h.id,
          name: h.partner?.displayName ?? h.email,
          email: h.email,
          active: h.status === 'ACTIVE' && h.partner?.active !== false,
          ...this.totals(mine),
          ...this.potsView(mine),
          movements: mine.map((m) => this.movementView(m)),
        };
      }),
    };
  }

  private totals(
    movements: {
      kind: string;
      amountEgp: Prisma.Decimal;
      reversedAt: Date | null;
    }[],
  ) {
    const by = (kind: MovementKind) =>
      m2(
        movements
          .filter((m) => m.kind === kind && !m.reversedAt)
          .reduce((s, m) => s.add(m.amountEgp), D(0)),
      );
    return {
      balanceEgp: m2(balanceOf(movements)),
      advancedEgp: by('ADVANCE'),
      leftInEgp: by('PAYOUT_LEFT_IN'),
      expensesPaidEgp: by('EXPENSE_PAID'),
      contributedEgp: by('CONTRIBUTION'),
      withdrawnEgp: by('WITHDRAWAL'),
    };
  }

  /**
   * His balance by pot (owner 2026-10-26, "each cycle has its own funding"):
   * untied money any cycle can draw, and each cycle's undrawn advances, which
   * only that cycle can.
   */
  private potsView(
    movements: {
      kind: string;
      amountEgp: Prisma.Decimal;
      cycleId: string | null;
      reversedAt: Date | null;
      cycle?: { id: string; code: string } | null;
    }[],
  ) {
    const pots = potsOf(movements);
    const codeOf = (id: string) =>
      movements.find((m) => m.cycleId === id)?.cycle?.code ?? '';
    return {
      untiedEgp: m2(pots.untied),
      byCycle: [...pots.byCycle.entries()]
        .map(([cycleId, amount]) => ({
          cycleId,
          cycleCode: codeOf(cycleId),
          amountEgp: m2(amount),
        }))
        .sort((a, b) => a.cycleCode.localeCompare(b.cycleCode)),
    };
  }

  private movementView(m: {
    id: string;
    kind: string;
    amountEgp: Prisma.Decimal;
    amount: Prisma.Decimal;
    currency: string;
    fxRateToEgp: Prisma.Decimal;
    occurredOn: Date;
    cycleId: string | null;
    settlementId: string | null;
    expenseEntryId?: string | null;
    note: string | null;
    createdAt: Date;
    reversedAt: Date | null;
    reversalReason: string | null;
    cycle?: { id: string; code: string } | null;
    expenseEntry?: { category: string } | null;
  }) {
    return {
      id: m.id,
      kind: m.kind,
      amountEgp: m2(m.amountEgp),
      /** Signed: what it did to the balance. */
      signedEgp: m2(signedEgp(m)),
      amount: m2(m.amount),
      currency: m.currency,
      fxRateToEgp: m.fxRateToEgp.toString(),
      occurredOn: m.occurredOn.toISOString().slice(0, 10),
      cycleId: m.cycleId,
      cycleCode: m.cycle?.code ?? null,
      settlementId: m.settlementId,
      /** The expense he paid (EXPENSE_PAID): its ledger row and category. */
      expenseEntryId: m.expenseEntryId ?? null,
      expenseCategory: m.expenseEntry?.category ?? null,
      note: m.note,
      createdAt: m.createdAt,
      reversedAt: m.reversedAt,
      reversalReason: m.reversalReason,
    };
  }

  /**
   * A cycle's funding panel: its target, what each partner has put in so far
   * (his contribution and his undrawn advances on this cycle, `putInSoFar`),
   * what each paid as advances, each core partner's account, what is still to
   * be contributed, and — on a cycle a friend paid — what the partners repaid
   * him and the exchange difference on it (owner 2026-10-26).
   */
  async cycleFunding(cycleId: string) {
    if (!isUuid(cycleId)) throw notFound('cycle');
    const cycle = await this.prisma.importCycle.findUnique({
      where: { id: cycleId },
      select: {
        id: true,
        code: true,
        status: true,
        currency: true,
        fundingTargetAmount: true,
        fundingTargetCurrency: true,
        fundingTargetRate: true,
        settlements: {
          where: { status: { in: ['APPROVED', 'PAID'] } },
          select: { status: true },
        },
        participants: {
          select: {
            id: true,
            participantType: true,
            partnerUserId: true,
            investorUserId: true,
            contributionAmount: true,
            customProfitPct: true,
            investorFeePct: true,
            createdAt: true,
            partner: {
              select: {
                email: true,
                partner: { select: { displayName: true } },
              },
            },
            investor: {
              select: {
                email: true,
                partner: { select: { displayName: true } },
              },
            },
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        },
      },
    });
    if (!cycle) throw notFound('cycle');

    const advances = await this.prisma.partnerAccountMovement.findMany({
      where: { cycleId, kind: 'ADVANCE', ...STANDING_MOVEMENT },
      include: {
        partner: {
          select: { email: true, partner: { select: { displayName: true } } },
        },
      },
      orderBy: [{ occurredOn: 'asc' }, { createdAt: 'asc' }],
    });
    const fromAccounts = await this.prisma.partnerAccountMovement.findMany({
      where: { cycleId, kind: 'CONTRIBUTION', ...STANDING_MOVEMENT },
      select: { partnerUserId: true, amountEgp: true },
    });

    const target =
      cycle.fundingTargetAmount && cycle.fundingTargetCurrency
        ? {
            amount: m2(cycle.fundingTargetAmount),
            currency: cycle.fundingTargetCurrency,
            fxRateToEgp: D(cycle.fundingTargetRate ?? 1).toString(),
            amountEgp: m2(
              D(cycle.fundingTargetAmount)
                .mul(D(cycle.fundingTargetRate ?? 1))
                .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
            ),
          }
        : null;
    const toTarget = (a: (typeof advances)[number]) =>
      target
        ? inTargetCurrency(a, {
            currency: target.currency,
            rate: target.fxRateToEgp,
          })
        : null;

    const payers = new Map<
      string,
      {
        name: string;
        totalEgp: Prisma.Decimal;
        inTarget: Prisma.Decimal;
        advances: unknown[];
      }
    >();
    for (const a of advances) {
      const p = payers.get(a.partnerUserId) ?? {
        name: a.partner.partner?.displayName ?? a.partner.email,
        totalEgp: D(0),
        inTarget: D(0),
        advances: [],
      };
      p.totalEgp = p.totalEgp.add(a.amountEgp);
      p.inTarget = p.inTarget.add(toTarget(a) ?? 0);
      p.advances.push(this.movementView(a));
      payers.set(a.partnerUserId, p);
    }
    const paidEgp = advances.reduce((s, a) => s.add(a.amountEgp), D(0));
    const paidInTarget = advances.reduce(
      (s, a) => s.add(toTarget(a) ?? 0),
      D(0),
    );

    const core = cycle.participants.filter(
      (p) => p.participantType === 'CORE_PARTNER' && p.partnerUserId,
    );
    // What THIS cycle can draw from each account: its own advances not yet
    // drawn, and untied money — never another cycle's advance (owner
    // 2026-10-26, "each cycle has its own funding").
    // Payers too: an advance may be recorded for someone not on the cycle.
    const pots = await accountPots(this.prisma, [
      ...new Set([...core.map((p) => p.partnerUserId!), ...payers.keys()]),
    ]);
    const investorsEgp = cycle.participants
      .filter((p) => p.participantType !== 'CORE_PARTNER')
      .reduce((s, p) => s.add(p.contributionAmount), D(0));
    const partnersEgp = core.reduce(
      (s, p) => s.add(p.contributionAmount),
      D(0),
    );
    const { toFund, financed } = await this.costing.fundingFor(cycleId);
    // A friend who paid the supplier (§18): who, what the partners have
    // repaid him in pounds, and the exchange difference on it — the same
    // readers settlement and profit use (`common/lender-debt.ts`, rule 11).
    const financings = await this.prisma.lenderFinancing.findMany({
      where: { cycleId, ...STANDING_FINANCING },
      select: { lender: { select: { name: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const friendNames = [...new Set(financings.map((f) => f.lender.name))];
    const repaidEgp =
      financings.length > 0
        ? await repaidOnCycleEgp(this.prisma, cycleId)
        : D(0);
    const exchangeEgp =
      financings.length > 0
        ? await exchangeDifferenceEgp(this.prisma, cycleId)
        : D(0);
    const still = D(toFund).sub(investorsEgp).sub(partnersEgp);
    const availableOf = (p: (typeof core)[number]) =>
      availableTo(pots.get(p.partnerUserId!)!, cycleId);
    // The Funding card's shares (owner 2026-10-26/27): of the target, or of
    // the cost to fund when there is none or it is lower; on a cycle a friend
    // paid, of what was repaid him or everything put in, whichever is more;
    // each partner's own contribution when they make up the partners' part.
    const shares = contributionShares({
      targetEgp: target ? target.amountEgp : null,
      toFundEgp: toFund,
      repaidEgp,
      investorsEgp,
      partners: core.map((p) => ({
        availableEgp: availableOf(p),
        contributionEgp: p.contributionAmount,
      })),
    });
    const split = profitSplitView(
      cycle.participants.map((p) => ({
        type: p.participantType,
        contribution: D(p.contributionAmount),
        customProfitPct:
          p.customProfitPct === null ? null : D(p.customProfitPct),
      })),
    );
    const personName = (p: (typeof cycle.participants)[number]) =>
      p.partner?.partner?.displayName ??
      p.investor?.partner?.displayName ??
      p.partner?.email ??
      p.investor?.email ??
      '';

    // ── Put in so far, per partner (owner 2026-10-26) ──────────────────
    const fromAccountOf = (partnerUserId: string) =>
      fromAccounts
        .filter((m) => m.partnerUserId === partnerUserId)
        .reduce((s, m) => s.add(m.amountEgp), D(0));
    const toTargetEgp = (egp: Prisma.Decimal) =>
      target
        ? target.currency === 'EGP'
          ? egp
          : egp
              .div(D(target.fxRateToEgp))
              .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
        : D(0);
    const putInRow = (
      partnerUserId: string,
      name: string,
      contributionEgp: Prisma.Decimal.Value,
      participantType: 'CORE_PARTNER' | 'TEMP_INVESTOR' | null,
    ) => {
      const paid = payers.get(partnerUserId);
      const undrawn = pots.get(partnerUserId)?.byCycle.get(cycleId) ?? D(0);
      const parts = putInSoFar({
        contributionEgp,
        fromAccountEgp: fromAccountOf(partnerUserId),
        undrawnAdvancesEgp: undrawn,
      });
      // In the target's currency (GUESS 2026-10-26): his contribution at the
      // target's rate, and his undrawn advances as the share of his advances'
      // face value still undrawn — all of it when nothing is drawn, so an
      // advance paid in the target's currency still counts at face.
      const undrawnInTarget =
        paid && paid.totalEgp.gt(0)
          ? paid.inTarget
              .mul(parts.undrawnAdvancesEgp)
              .div(paid.totalEgp)
              .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
          : D(0);
      const inTarget = toTargetEgp(
        parts.enteredEgp.add(parts.fromAccountEgp),
      ).add(undrawnInTarget);
      return {
        partnerUserId,
        name,
        /** On the cycle as a core partner or an investor; null for someone not on it who paid for it. */
        participantType,
        /** Everything he has put into this cycle: his contribution + his undrawn advances on it. */
        totalEgp: m2(parts.totalEgp),
        inTargetCurrency: target ? m2(inTarget) : null,
        /** His contribution on this cycle (his capital in it). */
        contributionEgp: m2(parts.enteredEgp.add(parts.fromAccountEgp)),
        /** Of it, entered directly — on a cycle a friend paid, his share of repaying him. */
        enteredEgp: m2(parts.enteredEgp),
        /** Of it, drawn from his account. */
        fromAccountEgp: m2(parts.fromAccountEgp),
        /** His advances on this cycle not yet drawn into a contribution. */
        undrawnAdvancesEgp: m2(parts.undrawnAdvancesEgp),
        /** Every standing advance he made on this cycle, with its day. */
        advances: paid?.advances ?? [],
        _inTarget: inTarget,
        _total: parts.totalEgp,
      };
    };
    // Every participant's money, investors' too (owner 2026-10-27: "they
    // should be added to funding as well right?"): the partners first, then
    // the investors — what they put in is their contribution — then anyone
    // not on the cycle who paid for it.
    const investorRows = cycle.participants.filter(
      (p) => p.participantType !== 'CORE_PARTNER',
    );
    const onCycle = new Set(
      [
        ...core.map((p) => p.partnerUserId),
        ...investorRows.map((p) => p.investorUserId),
      ].filter((id): id is string => !!id),
    );
    const putInRows = [
      ...core.map((p) =>
        putInRow(
          p.partnerUserId!,
          p.partner?.partner?.displayName ?? p.partner?.email ?? '',
          p.contributionAmount,
          'CORE_PARTNER',
        ),
      ),
      ...investorRows.map((p) =>
        putInRow(
          p.investorUserId ?? p.id,
          personName(p),
          p.contributionAmount,
          'TEMP_INVESTOR',
        ),
      ),
      // Someone not on the cycle may have paid for it: his advances only.
      ...[...payers.entries()]
        .filter(([id]) => !onCycle.has(id))
        .map(([id, p]) => putInRow(id, p.name, 0, null)),
    ];

    // ── The exchange difference on repaying friends (owner 2026-10-26) ──
    // Each one's part: the profit split's (`profitShareOf`), since
    // settlement takes it off the profit before splitting what is left.
    const exchangeSplit = profitShareOf(
      cycle.participants.map((p) => ({
        id: p.id,
        type:
          p.participantType === 'TEMP_INVESTOR'
            ? ('TEMP_INVESTOR' as const)
            : ('CORE_PARTNER' as const),
        contribution: D(p.contributionAmount),
        customProfitPct:
          p.customProfitPct === null ? null : D(p.customProfitPct),
        investorFeePct: null,
      })),
      exchangeEgp,
    );

    return {
      data: {
        cycleId: cycle.id,
        code: cycle.code,
        status: cycle.status,
        currency: cycle.currency,
        fundingLock: fundingLockOf(cycle.status, cycle.settlements),
        closed: CLOSED_FOR_ACCOUNTS.includes(cycle.status),
        target,
        putIn: {
          totalEgp: m2(putInRows.reduce((s, r) => s.add(r._total), D(0))),
          inTargetCurrency: target
            ? m2(putInRows.reduce((s, r) => s.add(r._inTarget), D(0)))
            : null,
          byPartner: putInRows.map(({ _inTarget, _total, ...r }) => r),
        },
        /** Friends who paid the supplier for this cycle (§18); null when none did. */
        friends:
          financings.length === 0
            ? null
            : {
                names: friendNames,
                /** What they paid, in pounds at their rates. */
                financedEgp: m2(financed),
                /** What the partners repaid them, in pounds actually paid. */
                repaidEgp: m2(repaidEgp),
                /** Pounds repaid − what that cleared at their rates (`exchangeDifferenceEgp`): + a cost, − a gain. */
                exchangeDifferenceEgp: m2(exchangeEgp),
                /** Each participant's part of it, by the profit split; null when settling could not split. */
                exchangeSplit: exchangeSplit
                  ? cycle.participants.map((p, i) => ({
                      participantId: p.id,
                      participantType: p.participantType,
                      name: personName(p),
                      amountEgp: m2(exchangeSplit[i]),
                    }))
                  : null,
              },
        paidSoFar: {
          totalEgp: m2(paidEgp),
          inTargetCurrency: target ? m2(paidInTarget) : null,
          byPartner: [...payers.entries()].map(([partnerUserId, p]) => ({
            partnerUserId,
            name: p.name,
            totalEgp: m2(p.totalEgp),
            inTargetCurrency: target ? m2(p.inTarget) : null,
            /** Of what he paid on this cycle, how much his contributions to it drew: into capital. */
            intoCapitalEgp: m2(
              pots.get(partnerUserId)?.intoCapital.get(cycleId) ?? 0,
            ),
            advances: p.advances,
          })),
        },
        /** The cycle's core partners, in the order an equal split takes them (its last absorbs the residual). */
        partners: core.map((p, i) => {
          const his = pots.get(p.partnerUserId!)!;
          const available = availableOf(p);
          const line = shares.lines[i];
          return {
            /** His share: his contribution when `shares.agreed`, else an equal share (`shares.basis` says of what). */
            shareEgp: m2(line.share),
            /** His share less what he has contributed, never below zero. */
            stillToGiveEgp: m2(line.stillToGive),
            /** What this cycle can draw for him less that: covered (≥ 0, left over) or short (< 0). */
            coverEgp: m2(line.cover),
            partnerUserId: p.partnerUserId!,
            participantId: p.id,
            name: p.partner?.partner?.displayName ?? p.partner?.email ?? '',
            /** What this cycle can draw from his account: the figure Contribute shows and checks. */
            availableEgp: m2(available),
            /** Of that, his advances on this cycle not yet drawn into it. */
            ownAdvancesEgp: m2(his.byCycle.get(cycleId) ?? 0),
            /** Of that, money tied to no cycle (payouts left in). */
            untiedEgp: m2(untiedAvailable(his)),
            /** Advanced for other cycles: in his account, not this cycle's to draw. */
            elsewhereEgp: m2(
              [...his.byCycle.entries()]
                .filter(([id]) => id !== cycleId)
                .reduce((s, [, v]) => s.add(v), D(0)),
            ),
            /** His whole account. */
            balanceEgp: m2(potsTotal(his)),
            contributionEgp: m2(p.contributionAmount),
            fromAccountEgp: m2(
              fromAccounts
                .filter((m) => m.partnerUserId === p.partnerUserId)
                .reduce((s, m) => s.add(m.amountEgp), D(0)),
            ),
          };
        }),
        toFundEgp: m2(toFund),
        investorsEgp: m2(investorsEgp),
        partnersContributedEgp: m2(partnersEgp),
        /** What the partners have still to contribute: the cost to fund less investors' money and theirs, never below zero. */
        stillToContributeEgp: m2(Prisma.Decimal.max(still, 0)),
        /** What the partners' part is of: the target, the cost to fund, what was repaid to friends, or everything put in. */
        shares: {
          basis: shares.basis,
          ofEgp: m2(shares.ofEgp),
          partnersEgp: m2(shares.partnersEgp),
          /** Every partner's share is his own contribution: all entered, and together the partners' part. */
          agreed: shares.agreed,
          /** What "Contribute equal thirds" draws by default: every partner's still to give. */
          stillEgp: m2(
            shares.lines.reduce((s, l) => s.add(l.stillToGive), D(0)),
          ),
        },
        /** Everyone on the cycle, in order, with the profit split (`profitSplitView`). */
        participants: cycle.participants.map((p, i) => ({
          participantId: p.id,
          participantType: p.participantType,
          name: personName(p),
          contributionEgp: m2(p.contributionAmount),
          customProfitPct:
            p.customProfitPct === null ? null : D(p.customProfitPct).toFixed(2),
          investorFeePct:
            p.investorFeePct === null ? null : D(p.investorFeePct).toFixed(2),
          profitPct: split.pcts[i],
        })),
        profitSplit: {
          basis: split.basis,
          equal: split.equal,
          problem: split.problem,
        },
      },
    };
  }

  // ─── Writing ─────────────────────────────────────────────────────────

  /** He paid a supplier for a cycle from his own pocket. Not cash in the business. */
  async recordAdvance(
    partnerUserId: string,
    dto: CreateAdvanceDto,
    actorId: string,
  ) {
    const holder = await this.holder(partnerUserId);
    if (!isUuid(dto.cycleId)) throw notFound('cycle');
    const amount = positive(dto.amount);
    const day = pastDay(dto.paidOn, 'ADVANCE_PAID');
    const askedCurrency = parseCurrencyCode(dto.currency) ?? 'EGP';
    const askedRate = parseRateToEgp(dto.fxRateToEgp);

    const created = await this.prisma.$transaction(async (tx) => {
      const cycle = await this.openCycle(tx, dto.cycleId);
      const rate = await rateFor(tx, askedCurrency, askedRate, cycle.currency);
      const amountEgp = amount
        .mul(rate)
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      if (amountEgp.lte(0)) throw amountNotPositive();
      return tx.partnerAccountMovement.create({
        data: {
          partnerUserId: holder.id,
          kind: 'ADVANCE',
          amount,
          currency: askedCurrency,
          fxRateToEgp: rate,
          amountEgp,
          occurredOn: dayDate(day),
          cycleId: cycle.id,
          note: dto.note?.trim() || null,
          createdBy: actorId,
        },
        include: { cycle: { select: { id: true, code: true } } },
      });
    });
    await this.audit.log({
      actorUserId: actorId,
      action: 'ACCOUNT_ADVANCE',
      entityType: 'PartnerAccountMovement',
      entityId: created.id,
      afterJson: this.movementView(created),
    });
    return { data: this.movementView(created) };
  }

  /** Money he took out of his account, never more than it holds. */
  async withdraw(
    partnerUserId: string,
    dto: CreateWithdrawalDto,
    actorId: string,
  ) {
    const holder = await this.holder(partnerUserId);
    const amount = positive(dto.amountEgp);
    const day = pastDay(dto.takenOn, 'ACCOUNT_WITHDRAWN');
    const created = await this.prisma.$transaction(async (tx) => {
      await lockAccounts(tx, [holder.id]);
      // Only untied money comes out: an advance paid a cycle's supplier.
      assertUntiedCovers({
        pots: await accountPotsOf(tx, holder.id),
        amount,
        partner: holder.name,
      });
      return tx.partnerAccountMovement.create({
        data: {
          partnerUserId: holder.id,
          kind: 'WITHDRAWAL',
          amount,
          amountEgp: amount,
          occurredOn: dayDate(day),
          note: dto.note?.trim() || null,
          createdBy: actorId,
        },
      });
    });
    await this.audit.log({
      actorUserId: actorId,
      action: 'ACCOUNT_WITHDRAWAL',
      entityType: 'PartnerAccountMovement',
      entityId: created.id,
      afterJson: this.movementView(created),
    });
    return { data: this.movementView(created) };
  }

  /**
   * Draw contributions to a cycle from the partners' accounts: `totalEgp` in
   * equal shares among its core partners (the default, owner 2026-10-25), or
   * one line per partner. All or nothing: one partner short refuses the lot.
   */
  async contribute(
    cycleId: string,
    dto: ContributeFromAccountsDto,
    actorId: string,
  ) {
    if (!isUuid(cycleId)) throw notFound('cycle');
    const hasTotal = dto.totalEgp !== undefined && dto.totalEgp !== null;
    const hasLines = Array.isArray(dto.lines) && dto.lines.length > 0;
    if (hasTotal === hasLines) {
      throw badRequest(
        'CONTRIBUTION_TOTAL_OR_LINES',
        'Give either a total to split equally or an amount per partner, not both or neither.',
      );
    }
    const total = hasTotal ? positive(dto.totalEgp) : undefined;
    const asked = hasLines
      ? dto.lines!.map((l) => {
          if (!isUuid(l.partnerUserId)) throw notFound('partner');
          return {
            partnerUserId: l.partnerUserId,
            amount: positive(l.amountEgp),
          };
        })
      : [];
    if (new Set(asked.map((l) => l.partnerUserId)).size !== asked.length) {
      throw badRequest(
        'CONTRIBUTION_PARTNER_TWICE',
        'Each partner can appear once in a contribution.',
      );
    }
    const day = pastDay(dto.contributedOn, 'ACCOUNT_CONTRIBUTED');

    const written = await this.prisma.$transaction(async (tx) => {
      const cycle = await this.openCycle(tx, cycleId);
      const core = await tx.cycleParticipant.findMany({
        where: {
          cycleId,
          participantType: 'CORE_PARTNER',
          partnerUserId: { not: null },
        },
        include: {
          partner: {
            select: { email: true, partner: { select: { displayName: true } } },
          },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      if (core.length === 0) {
        throw badRequest(
          'CYCLE_HAS_NO_PARTNERS',
          `Cycle ${cycle.code} has no core partner to contribute.`,
          { cycle: cycle.code },
        );
      }
      const nameOf = (p: (typeof core)[number]) =>
        p.partner?.partner?.displayName ?? p.partner?.email ?? '';

      let lines: {
        participant: (typeof core)[number];
        amount: Prisma.Decimal;
      }[];
      if (total) {
        const shares = equalShares(total, core.length);
        lines = core.map((participant, i) => ({
          participant,
          amount: shares[i],
        }));
      } else {
        lines = asked.map((l) => {
          const participant = core.find(
            (p) => p.partnerUserId === l.partnerUserId,
          );
          if (!participant) {
            throw badRequest(
              'PARTNER_NOT_ON_CYCLE',
              `That partner is not on cycle ${cycle.code}; add him to the cycle first.`,
              { cycle: cycle.code },
            );
          }
          return { participant, amount: l.amount };
        });
      }
      lines = lines.filter((l) => l.amount.gt(0));

      await lockAccounts(
        tx,
        lines.map((l) => l.participant.partnerUserId!),
      );
      // Each share comes from this cycle's own advances and untied money,
      // never another cycle's advance (owner 2026-10-26) — whatever the
      // client sent: it names no pot, the server decides.
      const pots = await accountPots(
        tx,
        lines.map((l) => l.participant.partnerUserId!),
      );
      for (const l of lines) {
        assertCycleCovers({
          pots: pots.get(l.participant.partnerUserId!)!,
          cycleId,
          cycleCode: cycle.code,
          amount: l.amount,
          partner: nameOf(l.participant),
        });
      }

      const out: {
        partnerUserId: string;
        name: string;
        amountEgp: string;
        movementId: string;
      }[] = [];
      for (const l of lines) {
        const before = l.participant.contributionAmount;
        const after = D(before).add(l.amount);
        await tx.cycleParticipant.update({
          where: { id: l.participant.id },
          data: { contributionAmount: after },
        });
        await recordContributionChange(tx, {
          cycleId,
          cycleCode: cycle.code,
          participantId: l.participant.id,
          before,
          after,
          isInvestor: false,
          actorId,
        });
        const m = await tx.partnerAccountMovement.create({
          data: {
            partnerUserId: l.participant.partnerUserId!,
            kind: 'CONTRIBUTION',
            amount: l.amount,
            amountEgp: l.amount,
            occurredOn: dayDate(day),
            cycleId,
            participantId: l.participant.id,
            note: dto.note?.trim() || null,
            createdBy: actorId,
          },
        });
        out.push({
          partnerUserId: l.participant.partnerUserId!,
          name: nameOf(l.participant),
          amountEgp: m2(l.amount),
          movementId: m.id,
        });
      }
      return { cycleCode: cycle.code, lines: out };
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'ACCOUNT_CONTRIBUTION',
      entityType: 'ImportCycle',
      entityId: cycleId,
      afterJson: { ...written, split: total ? 'EQUAL' : 'LINES' },
    });
    return {
      data: {
        ...written,
        totalEgp: m2(written.lines.reduce((s, l) => s.add(l.amountEgp), D(0))),
      },
    };
  }

  /** Set the cycle's funding target, or clear it (`amount` null). */
  async setTarget(cycleId: string, dto: FundingTargetDto, actorId: string) {
    if (!isUuid(cycleId)) throw notFound('cycle');
    const clearing = dto.amount === null || dto.amount === undefined;
    const amount = clearing ? null : positive(dto.amount);
    const askedCurrency = parseCurrencyCode(dto.currency);
    const askedRate = parseRateToEgp(dto.fxRateToEgp);
    const updated = await this.prisma.$transaction(async (tx) => {
      const cycle = await this.openCycle(tx, cycleId);
      if (clearing) {
        return tx.importCycle.update({
          where: { id: cycleId },
          data: {
            fundingTargetAmount: null,
            fundingTargetCurrency: null,
            fundingTargetRate: null,
          },
        });
      }
      const currency = askedCurrency ?? cycle.currency;
      const rate = await rateFor(
        tx,
        currency,
        askedRate,
        cycle.currency,
        'TARGET',
      );
      return tx.importCycle.update({
        where: { id: cycleId },
        data: {
          fundingTargetAmount: amount,
          fundingTargetCurrency: currency,
          fundingTargetRate: rate,
        },
      });
    });
    await this.audit.log({
      actorUserId: actorId,
      action: 'FUNDING_TARGET',
      entityType: 'ImportCycle',
      entityId: cycleId,
      afterJson: {
        amount: updated.fundingTargetAmount?.toString() ?? null,
        currency: updated.fundingTargetCurrency,
        rate: updated.fundingTargetRate?.toString() ?? null,
      },
    });
    return this.cycleFunding(cycleId);
  }

  /**
   * Undo a movement, once, with a reason (§9: history is never rewritten; the
   * row stays, marked reversed). Never when it would leave the account below
   * zero. A payout left in is undone by reversing its settlement.
   */
  async reverse(
    partnerUserId: string,
    movementId: string,
    reason: string,
    actorId: string,
  ) {
    const holder = await this.holder(partnerUserId);
    if (!isUuid(movementId)) throw notFound('accountMovement');
    if (!reason?.trim()) {
      throw badRequest(
        'REVERSAL_REASON_REQUIRED',
        'A reason is required to reverse this entry.',
      );
    }
    const done = await this.prisma.$transaction(async (tx) => {
      const found = await tx.partnerAccountMovement.findUnique({
        where: { id: movementId },
        select: { cycleId: true, partnerUserId: true },
      });
      // Another partner's movement is not found under this partner's account.
      if (!found || found.partnerUserId !== holder.id) {
        throw notFound('accountMovement');
      }
      if (found.cycleId) await lockCycle(tx, found.cycleId);
      await lockAccounts(tx, [holder.id]);
      const m = await tx.partnerAccountMovement.findUniqueOrThrow({
        where: { id: movementId },
        include: {
          cycle: { select: { id: true, code: true, status: true } },
          participant: true,
        },
      });
      if (m.reversedAt) {
        throw badRequest(
          'ACCOUNT_MOVEMENT_ALREADY_REVERSED',
          'This entry was already reversed.',
        );
      }
      if (m.kind === 'PAYOUT_LEFT_IN') {
        throw badRequest(
          'ACCOUNT_PAYOUT_REVERSE_SETTLEMENT',
          `A payout left in comes out by reversing the settlement of ${m.cycle?.code ?? 'its cycle'}.`,
          { cycle: m.cycle?.code ?? '' },
        );
      }
      if (m.kind === 'EXPENSE_PAID') {
        // The credit is the expense's: undone on its own, the ledger would
        // keep an expense paid by him that nobody owes him for (§9 "Paid by").
        throw badRequest(
          'ACCOUNT_EXPENSE_REVERSE_ON_LEDGER',
          'An expense he paid comes out of his account by reversing the expense in the ledger.',
        );
      }
      if (m.kind === 'ADVANCE' && m.cycleId) {
        // Taking an advance back out must not leave its cycle's pot below
        // zero — what a contribution to that cycle drew from it comes out
        // first. Other cycles' pots, and untied money, are not touched
        // (owner 2026-10-26, "each cycle has its own funding").
        const pot =
          (await accountPotsOf(tx, holder.id)).byCycle.get(m.cycleId) ?? D(0);
        if (m.amountEgp.gt(pot)) {
          const drawn = m.amountEgp.sub(pot);
          throw badRequest(
            'ADVANCE_ALREADY_DRAWN',
            `${formatMoney(drawn)} EGP of this payment was already drawn into ${m.cycle?.code ?? 'its cycle'}; reverse that contribution first.`,
            {
              partner: holder.name,
              cycle: m.cycle?.code ?? '',
              drawn: formatMoney(drawn),
              amount: formatMoney(m.amountEgp),
            },
          );
        }
      }
      if (m.kind === 'CONTRIBUTION') {
        if (!m.cycle || !m.participant) throw notFound('participant');
        if (CLOSED_FOR_ACCOUNTS.includes(m.cycle.status))
          throw closedCycle(m.cycle);
        await assertFundingOpen(tx, m.cycle.id);
        const before = m.participant.contributionAmount;
        if (D(before).lt(m.amountEgp)) {
          throw badRequest(
            'CONTRIBUTION_ALREADY_LOWERED',
            `${holder.name}'s contribution to ${m.cycle.code} is ${formatMoney(before)} EGP, less than the ${formatMoney(m.amountEgp)} EGP this entry put in; it was lowered by hand.`,
            {
              cycle: m.cycle.code,
              contribution: formatMoney(before),
              amount: formatMoney(m.amountEgp),
            },
          );
        }
        const after = D(before).sub(m.amountEgp);
        await tx.cycleParticipant.update({
          where: { id: m.participant.id },
          data: { contributionAmount: after },
        });
        await recordContributionChange(tx, {
          cycleId: m.cycle.id,
          cycleCode: m.cycle.code,
          participantId: m.participant.id,
          before,
          after,
          isInvestor: false,
          actorId,
        });
      }
      return tx.partnerAccountMovement.update({
        where: { id: movementId },
        data: {
          reversedAt: new Date(),
          reversedBy: actorId,
          reversalReason: reason.trim(),
        },
        include: { cycle: { select: { id: true, code: true } } },
      });
    });
    await this.audit.log({
      actorUserId: actorId,
      action: 'ACCOUNT_REVERSE',
      entityType: 'PartnerAccountMovement',
      entityId: movementId,
      afterJson: { kind: done.kind, amountEgp: m2(done.amountEgp), reason },
    });
    return { data: this.movementView(done) };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  /** The account's holder: a core partner with a partner record. */
  private async holder(partnerUserId: string) {
    if (!isUuid(partnerUserId)) throw notFound('partner');
    const user = await this.prisma.user.findUnique({
      where: { id: partnerUserId },
      select: {
        id: true,
        role: true,
        email: true,
        partner: { select: { displayName: true } },
      },
    });
    if (!user || user.role !== 'CORE_PARTNER' || !user.partner) {
      throw notFound('partner');
    }
    return { id: user.id, name: user.partner.displayName ?? user.email };
  }

  /** The cycle, locked, refused when it is being settled, settled or cancelled, or its funding is locked. */
  private async openCycle(tx: Db, cycleId: string) {
    // Locked first, then read: an approval waiting on the lock cannot slip in
    // between the status read and the write.
    await lockCycle(tx, cycleId);
    const cycle = await tx.importCycle.findUnique({
      where: { id: cycleId },
      select: { id: true, code: true, status: true, currency: true },
    });
    if (!cycle) throw notFound('cycle');
    if (CLOSED_FOR_ACCOUNTS.includes(cycle.status)) throw closedCycle(cycle);
    await assertFundingOpen(tx, cycleId);
    return cycle;
  }
}

function amountNotPositive() {
  return badRequest(
    'ACCOUNT_AMOUNT_NOT_POSITIVE',
    'The amount must be greater than zero.',
  );
}

/** Money above zero, at most two decimals — or ACCOUNT_AMOUNT_NOT_POSITIVE. */
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
  return d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/** The day it happened: today in Cairo when left out, never later. */
function pastDay(value: string | undefined, field: DateField): string {
  assertNotFuture(value, field);
  return value ? businessDay(value) : businessToday();
}

function closedCycle(cycle: { code: string; status: string }) {
  return badRequest(
    'CYCLE_CLOSED_FOR_ACCOUNTS',
    `Cycle ${cycle.code} is ${cycle.status}; its funding from the partners' accounts cannot change.`,
    { cycle: cycle.code, status: cycle.status },
  );
}

/**
 * The rate an advance (or a target) is recorded at: EGP is 1; any other
 * currency needs that day's rate typed (`ACCOUNT_RATE_REQUIRED` — the page's
 * rate is today's, not his day's, so it only prefills) and must be the
 * cycle's own or one the business keeps a rate for.
 */
async function rateFor(
  tx: Db,
  currency: string,
  asked: Prisma.Decimal | undefined,
  cycleCurrency: string,
  what: 'ADVANCE' | 'TARGET' = 'ADVANCE',
): Promise<Prisma.Decimal> {
  if (currency === 'EGP') {
    if (asked && !asked.eq(1)) {
      throw badRequest(
        'BASE_CURRENCY_RATE_FIXED',
        'EGP is the base currency — its rate is 1 by definition and cannot be changed.',
        { currency: 'EGP' },
      );
    }
    return D(1);
  }
  if (currency !== cycleCurrency) {
    const known = await tx.currencyRate.findUnique({
      where: { code: currency },
      select: { rateToEgp: true },
    });
    if (!known || known.rateToEgp === null) {
      throw badRequest(
        'NO_RATE_RECORDED',
        `No exchange rate has been recorded for ${currency}.`,
        { currency },
      );
    }
  }
  if (!asked) {
    throw badRequest(
      'ACCOUNT_RATE_REQUIRED',
      what === 'TARGET'
        ? `Say what ${currency} is worth in pounds for this target.`
        : `Say what ${currency} was worth in pounds on the day he paid.`,
      { currency },
    );
  }
  return asked;
}
