import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { SettlementsService } from '../settlements/settlements.service';
import { SessionTokensService } from '../auth/session-tokens.service';
import * as bcrypt from 'bcrypt';
import {
  PaginationDto,
  pageSize,
  cursorPage,
} from '../../common/dto/pagination.dto';

import { conflict, notFound } from '../../common/api-error';
import { assertStrongPassword } from '../../common/assert-password';
import {
  investorName,
  madeUpInvestorEmail,
  madeUpInvestorPassword,
} from './new-investor';
import {
  STANDING_MOVEMENT,
  type Pots,
  accountPots,
  putInSoFar,
} from '../../common/partner-account';
/** How many cycle projections the Partners page runs at once. */
const PROJECTION_CONCURRENCY = 4;

/** `fn` over every item, at most `size` at a time; results in input order. */
async function inBatches<T, R>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private settlements: SettlementsService,
    private sessions: SessionTokensService,
  ) {}

  async findAll(
    pagination: PaginationDto & { role?: string; status?: string },
  ) {
    const { cursor, limit: rawLimit = 20, role, status } = pagination;
    const limit = pageSize(rawLimit);
    const where: any = {};
    if (role) where.role = role;
    if (status) where.status = status;

    const items = await this.prisma.user.findMany({
      where,
      ...cursorPage(cursor, limit),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { partner: true },
    });

    const hasMore = items.length > limit;
    const data = hasMore ? items.slice(0, limit) : items;

    return {
      data: data.map(({ passwordHash, ...user }) => user),
      meta: { nextCursor: hasMore ? data[data.length - 1].id : null, limit },
    };
  }

  /**
   * What each partner and investor has actually put in and taken out.
   *
   * The Partners page showed an avatar, an email, a role badge and a cycle
   * count that was always zero — the count was read from a relation `findAll`
   * never included, so it stayed at zero no matter how many cycles a partner
   * had funded. For a business that is three people splitting profit, none of
   * the money was on the page at all.
   *
   * Everything here is per person, across every cycle they are on:
   *
   *   contributed  — capital put in, from their participant rows
   *   returned     — capital handed back at settlement
   *   profitShare  — their share of profit, paid
   *   atRisk       — contributed less returned: money still out in open cycles
   *
   *   putIn        — what he has put in so far, per cycle the Funding card's
   *                  own figure (`putInSoFar`): his contribution plus his
   *                  advances on that cycle not yet drawn into it. An advance
   *                  tied to no cycle is in his running account only.
   *
   * `atRisk` is the one worth watching. A settled cycle returns capital in full,
   * so a partner with money still at risk has it sitting in goods that have not
   * finished selling.
   */
  async participation() {
    const users = await this.prisma.user.findMany({
      where: { role: { in: ['CORE_PARTNER', 'TEMP_INVESTOR'] } },
      orderBy: { createdAt: 'asc' },
      include: {
        partner: true,
        cyclePartnerEntries: {
          select: {
            id: true,
            contributionAmount: true,
            cycle: { select: { id: true, code: true, status: true } },
          },
        },
        cycleInvestorEntries: {
          select: {
            id: true,
            contributionAmount: true,
            cycle: { select: { id: true, code: true, status: true } },
          },
        },
      },
    });

    // Settled amounts hang off the participant row, not the user, so they are
    // fetched once and indexed rather than queried per person.
    const lines = await this.prisma.settlementLine.findMany({
      where: { settlement: { status: 'PAID' } },
      select: { participantId: true, component: true, amount: true },
    });
    const byParticipant = new Map<
      string,
      { returned: Prisma.Decimal; profit: Prisma.Decimal }
    >();
    for (const line of lines) {
      const entry = byParticipant.get(line.participantId) ?? {
        returned: new Prisma.Decimal(0),
        profit: new Prisma.Decimal(0),
      };
      if (line.component === 'CAPITAL_RETURN')
        entry.returned = entry.returned.add(line.amount);
      if (line.component === 'PROFIT_SHARE')
        entry.profit = entry.profit.add(line.amount);
      byParticipant.set(line.participantId, entry);
    }

    const money = (v: Prisma.Decimal) => Number(v.toDecimalPlaces(2));

    /**
     * Put in so far (BUSINESS_LOGIC §8, owner 2026-10-28: the cards should
     * agree with the Funding card and the running accounts). Each core
     * partner's pots — the same `accountPots` the Funding card reads — give
     * his undrawn advances per cycle, and his CONTRIBUTION movements per
     * cycle what was drawn from his account. A temporary investor has no
     * account: his put in so far is his contribution.
     */
    const coreIds = users
      .filter((u) => u.role === 'CORE_PARTNER')
      .map((u) => u.id);
    const pots =
      coreIds.length > 0
        ? await accountPots(this.prisma, coreIds)
        : new Map<string, Pots>();
    const drawnRows =
      coreIds.length > 0
        ? await this.prisma.partnerAccountMovement.groupBy({
            by: ['partnerUserId', 'cycleId'],
            where: {
              ...STANDING_MOVEMENT,
              kind: 'CONTRIBUTION',
              partnerUserId: { in: coreIds },
              cycleId: { not: null },
            },
            _sum: { amountEgp: true },
          })
        : [];
    const fromAccountOf = (userId: string, cycleId: string) =>
      new Prisma.Decimal(
        drawnRows.find(
          (r) => r.partnerUserId === userId && r.cycleId === cycleId,
        )?._sum.amountEgp ?? 0,
      );
    // A cycle he paid for without being on it still has his money in it — the
    // Funding card lists him there (GUESS 2026-10-28) — so it gets a row.
    const onCycles = new Set(
      users.flatMap((u) =>
        [...u.cyclePartnerEntries, ...u.cycleInvestorEntries].map(
          (e) => e.cycle.id,
        ),
      ),
    );
    const paidOnlyIds = [
      ...new Set([...pots.values()].flatMap((p) => [...p.byCycle.keys()])),
    ].filter((id) => !onCycles.has(id));
    const paidOnlyCycles = new Map(
      (paidOnlyIds.length > 0
        ? await this.prisma.importCycle.findMany({
            where: { id: { in: paidOnlyIds } },
            select: { id: true, code: true, status: true },
          })
        : []
      ).map((c) => [c.id, c]),
    );

    /**
     * Each payout, explained line by line (§8 "a payout explains itself",
     * L7): the very breakdown the settlement screen shows, read from the
     * settlement's own figures — never worked out again here.
     */
    const paidSettlements = await this.prisma.settlement.findMany({
      where: { status: 'PAID' },
      orderBy: [{ paidAt: 'desc' }, { id: 'desc' }],
      include: {
        cycle: { select: { id: true, code: true } },
        lines: { include: { participant: true } },
      },
    });
    const breakdowns = await this.settlements.breakdownsFor(paidSettlements);

    // What running costs each core partner's payouts have taken (§8, L7).
    const charges = await this.prisma.runningCostCharge.groupBy({
      by: ['partnerUserId'],
      where: { releasedAt: null },
      _sum: { amount: true },
    });
    const runningCostsOf = (userId: string) =>
      new Prisma.Decimal(
        charges.find((c) => c.partnerUserId === userId)?._sum.amount ?? 0,
      );

    /**
     * What an open cycle has earned so far, split the way it will be settled.
     *
     * Without this a partner on a cycle that is actively selling saw nothing at
     * all: capital in, profit zero, until the day it settles. Money had clearly
     * been made and none of it was visible to the people who funded it.
     *
     * This is NOT revenue. A partner does not earn revenue — the cycle does,
     * and most of it repays the goods. Showing collected revenue per partner
     * would overstate what they are owed by roughly the cost of the stock.
     *
     * It runs the settlement's own projection, so the number converges on the
     * real one instead of contradicting it, and it stays separate from profit
     * actually paid: this can still fall if the rest of the stock sells badly.
     */
    const openCycleIds = [
      ...new Set(
        users.flatMap((u) =>
          [...u.cyclePartnerEntries, ...u.cycleInvestorEntries]
            .filter((e) => e.cycle.status !== 'CLOSED')
            .map((e) => e.cycle.id),
        ),
      ),
    ];
    const accrued = new Map<string, Prisma.Decimal>();
    // Only the cycles where something has moved the profit: every other open
    // cycle projects exactly zero, and projecting each in turn made this page
    // take 15 s+ once a few hundred cycles were open (2026-10-21). The rest
    // run a few at a time rather than strictly one after another.
    const active =
      await this.settlements.cyclesWithProfitActivity(openCycleIds);
    const projections = await inBatches(
      openCycleIds.filter((id) => active.has(id)),
      PROJECTION_CONCURRENCY,
      (cycleId) => this.settlements.project(cycleId).catch(() => null),
    );
    for (const projected of projections) {
      if (!projected) continue;
      for (const line of projected.distribution.lines) {
        // netProfit, not grossProfit: an investor's fee has already moved to
        // the partners, so gross would count that money on both sides.
        accrued.set(line.participantId, line.netProfit.add(line.feeReceived));
      }
    }

    const data = users.map(({ passwordHash, ...user }) => {
      // Both lists, not the one matching their role. A core partner can also
      // put money into a cycle as an investor — the demo data does exactly
      // that — and picking by role dropped that participation entirely: the
      // cycle was missing from their list and its capital from their totals.
      const entries = [
        ...user.cyclePartnerEntries,
        ...user.cycleInvestorEntries,
      ];

      let contributed = new Prisma.Decimal(0);
      let returned = new Prisma.Decimal(0);
      let profitShare = new Prisma.Decimal(0);
      let accruedProfit = new Prisma.Decimal(0);

      /**
       * One row per cycle, whatever the person's part in it.
       *
       * Nothing stops someone being both a core partner and a temporary
       * investor in the same cycle — the unique constraints are per role, so
       * two participant rows are perfectly legal, and the suite produces them.
       * Listing the entries directly then showed that cycle twice and counted
       * it twice. Both contributions are real money and are summed; the cycle
       * they belong to is still one cycle.
       */
      const byCycle = new Map<
        string,
        {
          id: string;
          code: string;
          status: string;
          contribution: Prisma.Decimal;
          profit: Prisma.Decimal;
          accrued: Prisma.Decimal;
        }
      >();

      for (const entry of entries) {
        contributed = contributed.add(entry.contributionAmount);
        const settled = byParticipant.get(entry.id);
        if (settled) {
          returned = returned.add(settled.returned);
          profitShare = profitShare.add(settled.profit);
        }
        // Only while the cycle is open. Once it closes the settled figure is
        // the truth and a projection alongside it would just disagree.
        const open = entry.cycle.status !== 'CLOSED';
        const entryAccrued = open
          ? new Prisma.Decimal(accrued.get(entry.id) ?? 0)
          : new Prisma.Decimal(0);
        accruedProfit = accruedProfit.add(entryAccrued);

        const row = byCycle.get(entry.cycle.id) ?? {
          id: entry.cycle.id,
          code: entry.cycle.code,
          status: entry.cycle.status,
          contribution: new Prisma.Decimal(0),
          profit: new Prisma.Decimal(0),
          accrued: new Prisma.Decimal(0),
        };
        row.contribution = row.contribution.add(entry.contributionAmount);
        row.profit = row.profit.add(settled?.profit ?? 0);
        row.accrued = row.accrued.add(entryAccrued);
        byCycle.set(entry.cycle.id, row);
      }

      // His undrawn advances on cycles he paid for but is not on.
      const myPots = pots.get(user.id);
      for (const cycleId of myPots?.byCycle.keys() ?? []) {
        const c = paidOnlyCycles.get(cycleId);
        if (byCycle.has(cycleId) || !c) continue;
        byCycle.set(cycleId, {
          id: c.id,
          code: c.code,
          status: c.status,
          contribution: new Prisma.Decimal(0),
          profit: new Prisma.Decimal(0),
          accrued: new Prisma.Decimal(0),
        });
      }

      const cycles = [...byCycle.values()].map((c) => {
        const parts = putInSoFar({
          contributionEgp: c.contribution,
          fromAccountEgp: myPots ? fromAccountOf(user.id, c.id) : 0,
          undrawnAdvancesEgp: myPots?.byCycle.get(c.id) ?? 0,
        });
        return {
          ...c,
          putIn: parts.totalEgp,
          undrawn: parts.undrawnAdvancesEgp,
        };
      });
      const putIn = cycles.reduce(
        (s, c) => s.add(c.putIn),
        new Prisma.Decimal(0),
      );
      const undrawn = cycles.reduce(
        (s, c) => s.add(c.undrawn),
        new Prisma.Decimal(0),
      );

      const mine = new Set(entries.map((e) => e.id));
      const payouts = paidSettlements.flatMap((s) => {
        const b = breakdowns.get(s.id);
        const lines = b?.participants.filter((p) => mine.has(p.participantId));
        if (!b || !lines?.length) return [];
        const { participants: _all, ...cycleLines } = b;
        return [
          {
            settlementId: s.id,
            cycleId: s.cycle.id,
            cycleCode: s.cycle.code,
            paidAt: s.paidAt,
            breakdown: { ...cycleLines, participants: lines },
          },
        ];
      });

      return {
        id: user.id,
        email: user.email,
        role: user.role,
        status: user.status,
        displayName: user.partner?.displayName ?? null,
        cycleCount: cycles.length,
        openCycleCount: cycles.filter((c) => c.status !== 'CLOSED').length,
        contributedEgp: money(contributed),
        /** Put in so far: his contribution + his undrawn advances, over his cycles (§8). */
        putInEgp: money(putIn),
        /** Of it, advances paid for a cycle and not yet drawn into his capital. */
        undrawnAdvancesEgp: money(undrawn),
        returnedEgp: money(returned),
        profitShareEgp: money(profitShare),
        accruedProfitEgp: money(accruedProfit),
        atRiskEgp: money(contributed.sub(returned)),
        /** Running costs his payouts have taken (§8, L7). Zero for an investor. */
        runningCostsEgp: money(runningCostsOf(user.id)),
        payouts,
        cycles: cycles
          .map((c) => ({
            id: c.id,
            code: c.code,
            status: c.status,
            contributionEgp: money(c.contribution),
            putInEgp: money(c.putIn),
            undrawnAdvancesEgp: money(c.undrawn),
            profitShareEgp: money(c.profit),
            accruedProfitEgp: money(c.accrued),
          }))
          .sort((a, b) => b.code.localeCompare(a.code)),
      };
    });

    return { data };
  }

  async findById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { partner: true },
    });
    if (!user) throw notFound('user');
    const { passwordHash, ...result } = user;
    return { data: result };
  }

  async create(data: {
    email: string;
    password: string;
    role: string;
    displayName?: string;
  }) {
    const existing = await this.prisma.user.findUnique({
      where: { email: data.email },
    });
    if (existing) throw conflict('EMAIL_TAKEN', 'Email already exists');
    assertStrongPassword(data.password);

    const passwordHash = await bcrypt.hash(data.password, 12);
    const user = await this.prisma.user.create({
      data: {
        email: data.email,
        passwordHash,
        role: data.role as any,
        partner: data.displayName
          ? { create: { displayName: data.displayName } }
          : undefined,
      },
      include: { partner: true },
    });
    const { passwordHash: _, ...result } = user;
    return { data: result };
  }

  /**
   * A temporary investor from a name alone (§8 "A new temporary investor from
   * the Funding card", owner 2026-10-26). Not `create`: that takes the role
   * from the caller, and the `+` beside a picker must not be a way to make a
   * partner (CLAUDE.md §12). The role is fixed here; the email and password
   * are made up and never used — an investor does not sign in (§12).
   *
   * A name already held by a partner or investor is refused (GUESS,
   * 2026-10-27): the picker lists people by name, and two "Ahmad"s there
   * cannot be told apart, so the second would be picked by chance.
   */
  async createInvestor(rawName: unknown) {
    const displayName = investorName(rawName);
    const passwordHash = await bcrypt.hash(madeUpInvestorPassword(), 12);
    const user = await this.prisma.$transaction(async (tx) => {
      // Two at once with the same name would both pass the check below.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'new-investor-name'}))`;
      const taken = await tx.partner.findFirst({
        where: { displayName: { equals: displayName, mode: 'insensitive' } },
        select: { displayName: true },
      });
      if (taken) {
        throw conflict(
          'INVESTOR_NAME_TAKEN',
          `Someone called ${taken.displayName} already exists.`,
          { name: taken.displayName },
        );
      }
      return tx.user.create({
        data: {
          email: madeUpInvestorEmail(),
          passwordHash,
          role: 'TEMP_INVESTOR',
          partner: { create: { displayName } },
        },
        include: { partner: true },
      });
    });
    const { passwordHash: _, ...result } = user;
    return { data: result };
  }

  async update(
    id: string,
    data: {
      email?: string;
      role?: string;
      status?: string;
      displayName?: string;
    },
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { partner: true },
    });
    if (!user) throw notFound('user');

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        email: data.email,
        role: data.role as any,
        status: data.status as any,
        partner: data.displayName
          ? { update: { displayName: data.displayName } }
          : undefined,
      },
      include: { partner: true },
    });
    // Someone who may no longer come in holds no sign-in that would let them
    // (owner, 2026-10-17). Their access token still lasts its hour on paper,
    // but JwtStrategy re-reads the status and refuses it on the next request.
    if (updated.status !== 'ACTIVE') {
      await this.sessions.revokeAllForUser(id);
    }
    const { passwordHash, ...result } = updated;
    return { data: result };
  }

  async deactivate(id: string) {
    return this.update(id, { status: 'INACTIVE' });
  }
}
