import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { SettlementsService } from '../settlements/settlements.service';
import * as bcrypt from 'bcrypt';
import { PaginationDto, pageSize } from '../../common/dto/pagination.dto';

import { conflict, notFound } from '../../common/api-error';
@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private settlements: SettlementsService,
  ) {}

  async findAll(pagination: PaginationDto & { role?: string; status?: string }) {
    const { cursor, limit: rawLimit = 20, role, status } = pagination;
    const limit = pageSize(rawLimit);
    const where: any = {};
    if (role) where.role = role;
    if (status) where.status = status;

    const items = await this.prisma.user.findMany({
      where,
      take: limit + 1,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { createdAt: 'desc' },
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
    const byParticipant = new Map<string, { returned: Prisma.Decimal; profit: Prisma.Decimal }>();
    for (const line of lines) {
      const entry = byParticipant.get(line.participantId) ?? {
        returned: new Prisma.Decimal(0),
        profit: new Prisma.Decimal(0),
      };
      if (line.component === 'CAPITAL_RETURN') entry.returned = entry.returned.add(line.amount);
      if (line.component === 'PROFIT_SHARE') entry.profit = entry.profit.add(line.amount);
      byParticipant.set(line.participantId, entry);
    }

    const money = (v: Prisma.Decimal) => Number(v.toDecimalPlaces(2));

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
    for (const cycleId of openCycleIds) {
      const projected = await this.settlements.project(cycleId).catch(() => null);
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
      const entries = [...user.cyclePartnerEntries, ...user.cycleInvestorEntries];

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

      const cycles = [...byCycle.values()];

      return {
        id: user.id,
        email: user.email,
        role: user.role,
        status: user.status,
        displayName: user.partner?.displayName ?? null,
        cycleCount: cycles.length,
        openCycleCount: cycles.filter((c) => c.status !== 'CLOSED').length,
        contributedEgp: money(contributed),
        returnedEgp: money(returned),
        profitShareEgp: money(profitShare),
        accruedProfitEgp: money(accruedProfit),
        atRiskEgp: money(contributed.sub(returned)),
        cycles: cycles
          .map((c) => ({
            id: c.id,
            code: c.code,
            status: c.status,
            contributionEgp: money(c.contribution),
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

  async create(data: { email: string; password: string; role: string; displayName?: string }) {
    const existing = await this.prisma.user.findUnique({ where: { email: data.email } });
    if (existing) throw conflict('EMAIL_TAKEN', 'Email already exists');

    const passwordHash = await bcrypt.hash(data.password, 12);
    const user = await this.prisma.user.create({
      data: {
        email: data.email,
        passwordHash,
        role: data.role as any,
        partner: data.displayName ? { create: { displayName: data.displayName } } : undefined,
      },
      include: { partner: true },
    });
    const { passwordHash: _, ...result } = user;
    return { data: result };
  }

  async update(id: string, data: { email?: string; role?: string; status?: string; displayName?: string }) {
    const user = await this.prisma.user.findUnique({ where: { id }, include: { partner: true } });
    if (!user) throw notFound('user');

    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        email: data.email,
        role: data.role as any,
        status: data.status as any,
        partner: data.displayName ? { update: { displayName: data.displayName } } : undefined,
      },
      include: { partner: true },
    });
    const { passwordHash, ...result } = updated;
    return { data: result };
  }

  async deactivate(id: string) {
    return this.update(id, { status: 'INACTIVE' });
  }
}
