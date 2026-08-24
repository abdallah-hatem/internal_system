import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PaginationDto, pageSize } from '../../common/dto/pagination.dto';

import { conflict, notFound } from '../../common/api-error';
@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

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

    const data = users.map(({ passwordHash, ...user }) => {
      const entries =
        user.role === 'TEMP_INVESTOR' ? user.cycleInvestorEntries : user.cyclePartnerEntries;

      let contributed = new Prisma.Decimal(0);
      let returned = new Prisma.Decimal(0);
      let profitShare = new Prisma.Decimal(0);

      for (const entry of entries) {
        contributed = contributed.add(entry.contributionAmount);
        const settled = byParticipant.get(entry.id);
        if (settled) {
          returned = returned.add(settled.returned);
          profitShare = profitShare.add(settled.profit);
        }
      }

      return {
        id: user.id,
        email: user.email,
        role: user.role,
        status: user.status,
        displayName: user.partner?.displayName ?? null,
        cycleCount: entries.length,
        openCycleCount: entries.filter((e) => e.cycle.status !== 'CLOSED').length,
        contributedEgp: money(contributed),
        returnedEgp: money(returned),
        profitShareEgp: money(profitShare),
        atRiskEgp: money(contributed.sub(returned)),
        cycles: entries
          .map((e) => ({
            id: e.cycle.id,
            code: e.cycle.code,
            status: e.cycle.status,
            contributionEgp: money(new Prisma.Decimal(e.contributionAmount)),
            profitShareEgp: money(byParticipant.get(e.id)?.profit ?? new Prisma.Decimal(0)),
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
