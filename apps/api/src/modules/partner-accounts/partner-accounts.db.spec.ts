import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- this suite talks to a real, throwaway Postgres; that is its point
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { CostingService } from '../costing/costing.service';
import { CyclesService } from '../cycles/cycles.service';
import { DeliveriesService } from '../shipping/deliveries.service';
import { InventoryService } from '../inventory/inventory.service';
import { PaymentsService } from '../payments/payments.service';
import { SalesService } from '../sales/sales.service';
import { SettlementsService } from '../settlements/settlements.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { cashPosition } from '../../common/cash-position';
import { businessToday } from '../../common/dates';
import { PartnerAccountsService } from './partner-accounts.service';

/**
 * Partners' running accounts (BUSINESS_LOGIC §8, owner 2026-10-25: "equal
 * thirds, no negative, paid straight to supplier"), against a real Postgres:
 * the locks, the all-or-nothing contribution and the settlement's payout left
 * in are only honest there.
 *
 * Built the way the business builds it (CLAUDE.md §4): an order, a leg, a
 * departure, a delivery, a checked-in receipt and a confirmed sale, through
 * the real services.
 *
 * Runs only against a THROWAWAY database (CLAUDE.md rule 6):
 *
 *   INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/motorcycle_parts_<name> \
 *     npx jest partner-accounts.db --runInBand
 */
// eslint-disable-next-line no-restricted-properties -- an opt-in switch for a suite that must never run by default
const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;

const daysAgo = (n: number) =>
  new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

suite('partner running accounts (Postgres)', () => {
  let prisma: PrismaClient;
  let accounts: PartnerAccountsService;
  let deliveries: DeliveriesService;
  let inventory: InventoryService;
  let sales: SalesService;
  let settlements: SettlementsService;
  let analytics: AnalyticsService;
  let actor: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const db = prisma as unknown as PrismaService;
    const audit = { log: jest.fn() } as unknown as AuditService;
    const notifications = {
      createForMultipleUsers: jest.fn(),
      create: jest.fn(),
    } as unknown as NotificationsService;
    const costing = new CostingService(db);
    const cycles = new CyclesService(db, audit, notifications);
    deliveries = new DeliveriesService(
      db,
      audit,
      notifications,
      costing,
      cycles,
    );
    inventory = new InventoryService(db, audit, notifications, costing, cycles);
    sales = new SalesService(db, audit, new PaymentsService(db, audit), {
      createForMultipleUsers: () => Promise.resolve({ count: 0 }),
    });
    settlements = new SettlementsService(db, audit, costing);
    analytics = new AnalyticsService(db);
    accounts = new PartnerAccountsService(db, audit, costing);
    actor = (await partner('Actor')).id;
  });
  afterAll(() => prisma.$disconnect());

  // ─── Fixtures ───────────────────────────────────────────────────────

  /** A core partner: an active CORE_PARTNER login with a partner record. */
  async function partner(name: string) {
    const tag = randomUUID().slice(0, 8);
    return prisma.user.create({
      data: {
        email: `acct-${name.toLowerCase()}-${tag}@example.test`,
        passwordHash: 'x',
        role: 'CORE_PARTNER',
        partner: { create: { displayName: `${name} ${tag}` } },
      },
    });
  }

  /** Three partners on a fresh cycle (contributions 0), the cycle in `status`. */
  async function cycleWithPartners(
    status: string = 'PURCHASING',
    currency = 'EGP',
  ) {
    const tag = randomUUID().slice(0, 8);
    const people = [
      await partner('Abdallah'),
      await partner('Shady'),
      await partner('Fares'),
    ];
    const cycle = await prisma.importCycle.create({
      data: {
        code: `ACCT-${tag}`,
        originType: 'UAE_DIRECT',
        currency,
        status: status as never,
      },
    });
    const participants = [];
    for (const p of people) {
      participants.push(
        await prisma.cycleParticipant.create({
          data: {
            cycleId: cycle.id,
            participantType: 'CORE_PARTNER',
            partnerUserId: p.id,
            contributionAmount: 0,
          },
        }),
      );
    }
    return { cycle, people, participants };
  }

  /**
   * A cycle as the business makes it: 40 ordered at 100, a 400 leg that
   * left with everything, all delivered and checked in (the purchase is in
   * the ledger, at receipt), and 10 sold at 200 to a verified shop.
   */
  async function tradedCycle() {
    const base = await cycleWithPartners('ARRIVED_EGYPT');
    const tag = randomUUID().slice(0, 8);
    const supplier = await prisma.supplier.create({
      data: { name: `Acct ${tag}`, country: 'AE' },
    });
    const product = await prisma.product.create({
      data: { sku: `ACCT-${tag}`, name: `Account part ${tag}` },
    });
    const po = await prisma.purchaseOrder.create({
      data: {
        cycleId: base.cycle.id,
        supplierId: supplier.id,
        reference: `PO-${tag}`,
        currency: 'EGP',
        fxRateToEgp: 1,
        orderedOn: new Date(`${daysAgo(30)}T00:00:00Z`),
        status: 'CONFIRMED',
      },
    });
    const item = await prisma.purchaseOrderItem.create({
      data: {
        purchaseOrderId: po.id,
        productId: product.id,
        orderedQty: 40,
        unitPrice: 100,
        lineTotal: 4000,
      },
    });
    const leg = await prisma.shippingLeg.create({
      data: {
        cycleId: base.cycle.id,
        sequence: 1,
        origin: 'Dubai, UAE',
        destination: 'Cairo, Egypt',
        departedOn: new Date(`${daysAgo(20)}T00:00:00Z`),
        status: 'IN_TRANSIT',
        costBasis: 'FLAT',
        amount: 400,
        amountEgp: 400,
      },
    });
    await prisma.shipmentDeparture.create({
      data: {
        legId: leg.id,
        departedOn: new Date(`${daysAgo(20)}T00:00:00Z`),
        lines: { create: [{ purchaseOrderItemId: item.id, qty: 40 }] },
      },
    });
    const { data: delivery } = await deliveries.recordDelivery(
      leg.id,
      {
        arrivedOn: daysAgo(5),
        lines: [{ purchaseOrderItemId: item.id, qty: 40 }],
      },
      actor,
    );
    const d = delivery as unknown as { id: string; lines: { id: string }[] };
    await inventory.verifyStock(
      base.cycle.id,
      {
        deliveryId: d.id,
        items: [{ deliveryLineId: d.lines[0].id, receivedQty: 40 }],
      },
      actor,
    );
    const shop = await prisma.customer.create({
      data: {
        type: 'B2B',
        displayName: `Acct shop ${tag}`,
        verificationStatus: 'VERIFIED',
      },
    });
    await sales.create(
      {
        customerId: shop.id,
        channel: 'B2B',
        currency: 'EGP',
        items: [{ productId: product.id, quantity: 10, unitPrice: 200 }],
        confirm: true,
      },
      actor,
    );
    return base;
  }

  async function refusal(p: Promise<unknown>) {
    try {
      await p;
    } catch (e) {
      if (!(e instanceof HttpException)) throw e;
      const body = e.getResponse() as {
        code: string;
        params?: Record<string, unknown>;
      };
      return { status: e.getStatus(), code: body.code, params: body.params };
    }
    throw new Error('expected a refusal');
  }

  const balanceOf = async (userId: string) => {
    const { data } = await accounts.list();
    return data.find((a) => a.partnerUserId === userId)!.balanceEgp;
  };
  const advance = (
    userId: string,
    cycleId: string,
    amount: number,
    extra: Record<string, unknown> = {},
  ) => accounts.recordAdvance(userId, { cycleId, amount, ...extra }, actor);

  /** Everything a reader of the business's money sees: cash, P&L, the cycle's profit. */
  async function moneyFigures() {
    const kpis = await analytics.getDashboardKPIs();
    const pnl = await analytics.getProfitAndLoss();
    const cycles = await analytics.getCycleProfitability();
    const cash = await cashPosition(prisma);
    return JSON.stringify({
      kpis,
      pnl,
      cycles,
      cash: [cash.cashIn, cash.cashOut, cash.cashOnHand].map(String),
    });
  }

  // ─── Advances ───────────────────────────────────────────────────────

  it('an advance puts money in his account and shows on the cycle as paid so far, by whom', async () => {
    const { cycle, people } = await cycleWithPartners();
    await advance(people[1].id, cycle.id, 1000, { note: 'deposit' });
    await advance(people[2].id, cycle.id, 400);
    expect(await balanceOf(people[1].id)).toBe('1000.00');
    const { data } = await accounts.cycleFunding(cycle.id);
    expect(data.paidSoFar.totalEgp).toBe('1400.00');
    expect(
      data.paidSoFar.byPartner.map((p) => [p.partnerUserId, p.totalEgp]),
    ).toEqual([
      [people[1].id, '1000.00'],
      [people[2].id, '400.00'],
    ]);
  });

  it('an advance never moves cash on hand, profit, the P&L or a cycle’s profitability', async () => {
    const { cycle, people } = await tradedCycle();
    const before = await moneyFigures();
    const rowsBefore = await prisma.financialTransaction.count();
    await advance(people[0].id, cycle.id, 2500);
    await advance(people[1].id, cycle.id, 100, {
      currency: 'USD',
      fxRateToEgp: 50,
    });
    expect(await moneyFigures()).toBe(before);
    // No ledger row of any kind was written for them.
    expect(await prisma.financialTransaction.count()).toBe(rowsBefore);
  });

  it('refuses a zero or negative advance', async () => {
    const { cycle, people } = await cycleWithPartners();
    for (const amount of [0, -50]) {
      expect(
        (await refusal(advance(people[0].id, cycle.id, amount))).code,
      ).toBe('ACCOUNT_AMOUNT_NOT_POSITIVE');
    }
    expect(await balanceOf(people[0].id)).toBe('0.00');
  });

  it('refuses an advance dated in the future, and takes today’s', async () => {
    const { cycle, people } = await cycleWithPartners();
    const tomorrow = new Date(`${businessToday()}T12:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const r = await refusal(
      advance(people[0].id, cycle.id, 10, {
        paidOn: tomorrow.toISOString().slice(0, 10),
      }),
    );
    expect(r.code).toBe('DATE_IN_FUTURE');
    const { data } = await advance(people[0].id, cycle.id, 10, {
      paidOn: businessToday(),
    });
    expect(data.occurredOn).toBe(businessToday());
  });

  it('refuses an advance to a cycle that does not exist, or one being settled, settled or cancelled', async () => {
    const { people } = await cycleWithPartners();
    expect((await refusal(advance(people[0].id, randomUUID(), 10))).code).toBe(
      'NOT_FOUND',
    );
    for (const status of ['SETTLEMENT', 'CLOSED', 'CANCELLED']) {
      const { cycle } = await cycleWithPartners(status);
      expect((await refusal(advance(people[0].id, cycle.id, 10))).code).toBe(
        'CYCLE_CLOSED_FOR_ACCOUNTS',
      );
    }
  });

  it('refuses an advance once the cycle’s settlement is approved (funding locked)', async () => {
    const { cycle, people } = await cycleWithPartners('SELLING');
    await prisma.settlement.create({
      data: { cycleId: cycle.id, status: 'APPROVED' },
    });
    expect((await refusal(advance(people[0].id, cycle.id, 10))).code).toBe(
      'FUNDING_LOCKED_AFTER_SETTLEMENT',
    );
  });

  it('an account belongs to a core partner: an investor or a stranger has none', async () => {
    const { cycle } = await cycleWithPartners();
    const investor = await prisma.user.create({
      data: {
        email: `acct-inv-${randomUUID()}@example.test`,
        passwordHash: 'x',
        role: 'TEMP_INVESTOR',
      },
    });
    expect((await refusal(advance(investor.id, cycle.id, 10))).params).toEqual({
      entity: 'partner',
    });
    expect((await refusal(advance(randomUUID(), cycle.id, 10))).code).toBe(
      'NOT_FOUND',
    );
  });

  it('an advance in another currency needs that day’s rate and counts its pounds', async () => {
    const { cycle, people } = await cycleWithPartners('PURCHASING', 'USD');
    expect(
      (await refusal(advance(people[0].id, cycle.id, 100, { currency: 'USD' })))
        .code,
    ).toBe('ACCOUNT_RATE_REQUIRED');
    const { data } = await advance(people[0].id, cycle.id, 100, {
      currency: 'USD',
      fxRateToEgp: 50.25,
    });
    expect(data.amountEgp).toBe('5025.00');
  });

  // ─── Contributions ──────────────────────────────────────────────────

  it('equal thirds of a non-zero total sum to it exactly, the last partner taking the odd piastre', async () => {
    const { cycle, people, participants } = await cycleWithPartners();
    for (const p of people) await advance(p.id, cycle.id, 500);
    const { data } = await accounts.contribute(
      cycle.id,
      { totalEgp: 1000 },
      actor,
    );
    expect(data.lines.map((l) => l.amountEgp)).toEqual([
      '333.33',
      '333.33',
      '333.34',
    ]);
    expect(data.totalEgp).toBe('1000.00');
    const after = await prisma.cycleParticipant.findMany({
      where: { id: { in: participants.map((p) => p.id) } },
    });
    expect(
      after.reduce((s, p) => s + Number(p.contributionAmount), 0),
    ).toBeCloseTo(1000, 10);
    // The contribution is the cash event, as an entered one always was.
    const inflow = await prisma.financialTransaction.aggregate({
      where: {
        cycleId: cycle.id,
        category: 'contribution',
        direction: 'INFLOW',
      },
      _sum: { amount: true },
    });
    expect(inflow._sum.amount?.toFixed(2)).toBe('1000.00');
    expect(await balanceOf(people[2].id)).toBe('166.66');
  });

  it('refuses a contribution larger than an account holds — and writes nothing for anyone', async () => {
    const { cycle, people, participants } = await cycleWithPartners();
    await advance(people[0].id, cycle.id, 1000);
    await advance(people[1].id, cycle.id, 1000);
    await advance(people[2].id, cycle.id, 400); // Fares: his third of 2,000 is 666.67
    const r = await refusal(
      accounts.contribute(cycle.id, { totalEgp: 2000 }, actor),
    );
    expect(r.code).toBe('ACCOUNT_BALANCE_TOO_LOW');
    expect(r.params).toEqual(
      expect.objectContaining({
        balance: '400.00',
        amount: '666.68',
        short: '266.68',
      }),
    );
    const after = await prisma.cycleParticipant.findMany({
      where: { id: { in: participants.map((p) => p.id) } },
    });
    expect(after.every((p) => Number(p.contributionAmount) === 0)).toBe(true);
    expect(
      await prisma.financialTransaction.count({
        where: { cycleId: cycle.id, category: 'contribution' },
      }),
    ).toBe(0);
    expect(await balanceOf(people[0].id)).toBe('1000.00');
  });

  it('contributing twice: the second is checked against what is left', async () => {
    const { cycle, people } = await cycleWithPartners();
    for (const p of people) await advance(p.id, cycle.id, 600);
    await accounts.contribute(cycle.id, { totalEgp: 1500 }, actor);
    expect(
      (await refusal(accounts.contribute(cycle.id, { totalEgp: 600 }, actor)))
        .code,
    ).toBe('ACCOUNT_BALANCE_TOO_LOW');
    await accounts.contribute(cycle.id, { totalEgp: 300 }, actor);
    for (const p of people) expect(await balanceOf(p.id)).toBe('0.00');
    const { data } = await accounts.cycleFunding(cycle.id);
    expect(data.partners.map((p) => p.contributionEgp)).toEqual([
      '600.00',
      '600.00',
      '600.00',
    ]);
  });

  it('per-partner lines: a partner not on the cycle, a partner twice, both or neither of total and lines are refused', async () => {
    const { cycle, people } = await cycleWithPartners();
    const outsider = await partner('Outsider');
    await advance(outsider.id, cycle.id, 100);
    expect(
      (
        await refusal(
          accounts.contribute(
            cycle.id,
            { lines: [{ partnerUserId: outsider.id, amountEgp: 50 }] },
            actor,
          ),
        )
      ).code,
    ).toBe('PARTNER_NOT_ON_CYCLE');
    expect(
      (
        await refusal(
          accounts.contribute(
            cycle.id,
            {
              lines: [
                { partnerUserId: people[0].id, amountEgp: 1 },
                { partnerUserId: people[0].id, amountEgp: 1 },
              ],
            },
            actor,
          ),
        )
      ).code,
    ).toBe('CONTRIBUTION_PARTNER_TWICE');
    expect((await refusal(accounts.contribute(cycle.id, {}, actor))).code).toBe(
      'CONTRIBUTION_TOTAL_OR_LINES',
    );
    expect(
      (await refusal(accounts.contribute(cycle.id, { totalEgp: 0 }, actor)))
        .code,
    ).toBe('ACCOUNT_AMOUNT_NOT_POSITIVE');
  });

  it('refuses contributing to the wrong cycle, or a settled or closed one', async () => {
    expect(
      (
        await refusal(
          accounts.contribute(randomUUID(), { totalEgp: 10 }, actor),
        )
      ).code,
    ).toBe('NOT_FOUND');
    for (const status of ['SETTLEMENT', 'CLOSED']) {
      const { cycle, people } = await cycleWithPartners(status);
      for (const p of people)
        await prisma.partnerAccountMovement.create({
          data: {
            partnerUserId: p.id,
            kind: 'ADVANCE',
            amount: 100,
            amountEgp: 100,
            occurredOn: new Date(),
          },
        });
      expect(
        (await refusal(accounts.contribute(cycle.id, { totalEgp: 30 }, actor)))
          .code,
      ).toBe('CYCLE_CLOSED_FOR_ACCOUNTS');
    }
  });

  // ─── Withdrawals ────────────────────────────────────────────────────

  it('refuses taking out more than the account holds, the second time too, and at the same moment', async () => {
    const { cycle, people } = await cycleWithPartners();
    const who = people[0].id;
    await advance(who, cycle.id, 1000);
    expect(
      (await refusal(accounts.withdraw(who, { amountEgp: 1000.01 }, actor)))
        .code,
    ).toBe('ACCOUNT_BALANCE_TOO_LOW');
    await accounts.withdraw(who, { amountEgp: 300 }, actor);
    expect(
      (await refusal(accounts.withdraw(who, { amountEgp: 700.01 }, actor)))
        .code,
    ).toBe('ACCOUNT_BALANCE_TOO_LOW');
    // Two of 600 at once against 700: one waits for the other, then is refused.
    const both = await Promise.allSettled(
      [0, 1].map(() => accounts.withdraw(who, { amountEgp: 600 }, actor)),
    );
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await balanceOf(who)).toBe('100.00');
    expect(
      (await refusal(accounts.withdraw(who, { amountEgp: 0 }, actor))).code,
    ).toBe('ACCOUNT_AMOUNT_NOT_POSITIVE');
  });

  it('a withdrawal waits while another writer holds the account, so two cannot both read the same balance', async () => {
    const { cycle, people } = await cycleWithPartners();
    const who = people[0].id;
    await advance(who, cycle.id, 500);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    // Another writer takes his account's lock and keeps it.
    const other = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM partners WHERE user_id = ${who}::uuid FOR UPDATE`;
        locked();
        await held;
      },
      { timeout: 30_000 },
    );
    await isLocked;
    let done = false;
    const mine = accounts
      .withdraw(who, { amountEgp: 100 }, actor)
      .then(() => (done = true));
    await new Promise((r) => setTimeout(r, 1500));
    expect(done).toBe(false);
    release();
    await other;
    await mine;
    expect(done).toBe(true);
    expect(await balanceOf(who)).toBe('400.00');
  });

  it('a withdrawal moves no cash on hand and no profit either', async () => {
    const { cycle, people } = await tradedCycle();
    await advance(people[0].id, cycle.id, 1000);
    const before = await moneyFigures();
    await accounts.withdraw(people[0].id, { amountEgp: 400 }, actor);
    expect(await moneyFigures()).toBe(before);
  });

  // ─── Reversals ──────────────────────────────────────────────────────

  it('another partner’s movement is not found under this partner; a reversal happens once', async () => {
    const { cycle, people } = await cycleWithPartners();
    const { data: mine } = await advance(people[0].id, cycle.id, 50);
    expect(
      (await refusal(accounts.reverse(people[1].id, mine.id, 'typo', actor)))
        .params,
    ).toEqual({ entity: 'accountMovement' });
    await accounts.reverse(people[0].id, mine.id, 'typo', actor);
    expect(
      (await refusal(accounts.reverse(people[0].id, mine.id, 'again', actor)))
        .code,
    ).toBe('ACCOUNT_MOVEMENT_ALREADY_REVERSED');
    expect(await balanceOf(people[0].id)).toBe('0.00');
  });

  it('an advance already drawn into a cycle cannot be reversed: the account would go negative', async () => {
    const { cycle, people } = await cycleWithPartners();
    const adv = [];
    for (const p of people) adv.push((await advance(p.id, cycle.id, 300)).data);
    await accounts.contribute(cycle.id, { totalEgp: 600 }, actor);
    expect(
      (
        await refusal(
          accounts.reverse(people[0].id, adv[0].id, 'mistake', actor),
        )
      ).code,
    ).toBe('ACCOUNT_BALANCE_TOO_LOW');
  });

  it('reversing a contribution puts it back in his account and hands the capital back in the ledger', async () => {
    const { cycle, people, participants } = await cycleWithPartners();
    for (const p of people) await advance(p.id, cycle.id, 100);
    const { data } = await accounts.contribute(
      cycle.id,
      { totalEgp: 300 },
      actor,
    );
    await accounts.reverse(
      people[0].id,
      data.lines[0].movementId,
      'wrong cycle',
      actor,
    );
    expect(await balanceOf(people[0].id)).toBe('100.00');
    const p0 = await prisma.cycleParticipant.findUniqueOrThrow({
      where: { id: participants[0].id },
    });
    expect(p0.contributionAmount.toFixed(2)).toBe('0.00');
    const out = await prisma.financialTransaction.aggregate({
      where: {
        cycleId: cycle.id,
        category: 'contribution',
        direction: 'OUTFLOW',
      },
      _sum: { amount: true },
    });
    expect(out._sum.amount?.toFixed(2)).toBe('100.00');
  });

  // ─── Funding target ─────────────────────────────────────────────────

  it('a funding target reads "1,600 of 2,000 funded", by whom, in its currency', async () => {
    const { cycle, people } = await cycleWithPartners('PURCHASING', 'USD');
    await accounts.setTarget(
      cycle.id,
      { amount: 2000, currency: 'USD', fxRateToEgp: 50 },
      actor,
    );
    await advance(people[1].id, cycle.id, 1000, {
      currency: 'USD',
      fxRateToEgp: 50,
    });
    await advance(people[2].id, cycle.id, 400, {
      currency: 'USD',
      fxRateToEgp: 51,
    });
    await advance(people[0].id, cycle.id, 10000); // pounds: 200 USD at the target's 50
    const { data } = await accounts.cycleFunding(cycle.id);
    expect(data.target).toEqual(
      expect.objectContaining({
        amount: '2000.00',
        currency: 'USD',
        amountEgp: '100000.00',
      }),
    );
    expect(data.paidSoFar.inTargetCurrency).toBe('1600.00');
    expect(
      (await refusal(accounts.setTarget(cycle.id, { amount: -1 }, actor))).code,
    ).toBe('ACCOUNT_AMOUNT_NOT_POSITIVE');
    await accounts.setTarget(cycle.id, { amount: null }, actor);
    expect((await accounts.cycleFunding(cycle.id)).data.target).toBeNull();
  });

  // ─── Phase 2: a payout left in ──────────────────────────────────────

  it('a payout left in goes into his account; the settlement cannot be reversed once he has spent it', async () => {
    const { cycle, people } = await tradedCycle();
    // The partners fund the cycle's 4,400 from their accounts, equally.
    for (const p of people) await advance(p.id, cycle.id, 1500);
    await accounts.contribute(cycle.id, { totalEgp: 4400 }, actor);
    const calc = (await settlements.calculate(cycle.id, actor)).data!;
    await settlements.approve(calc.id, actor);
    const outsider = await partner('Outsider');
    expect(
      (
        await refusal(
          settlements.markPaid(calc.id, actor, {
            acceptRemainingStock: true,
            leaveInPartnerUserIds: [outsider.id],
          }),
        )
      ).code,
    ).toBe('PAYOUT_LEFT_IN_NOT_A_PARTNER');
    const before = await balanceOf(people[0].id);
    await settlements.markPaid(calc.id, actor, {
      acceptRemainingStock: true,
      leaveInPartnerUserIds: [people[0].id],
    });
    const left = await prisma.partnerAccountMovement.findFirstOrThrow({
      where: { settlementId: calc.id },
    });
    expect(left.kind).toBe('PAYOUT_LEFT_IN');
    expect(Number(await balanceOf(people[0].id))).toBeCloseTo(
      Number(before) + Number(left.amountEgp),
      2,
    );
    // He takes it all out; reversing the settlement would leave him below zero.
    await accounts.withdraw(
      people[0].id,
      { amountEgp: Number(await balanceOf(people[0].id)) },
      actor,
    );
    expect(
      (await refusal(settlements.reverse(calc.id, 'recount', actor))).code,
    ).toBe('ACCOUNT_BALANCE_TOO_LOW');
    expect(
      (await prisma.settlement.findUniqueOrThrow({ where: { id: calc.id } }))
        .status,
    ).toBe('PAID');
  });

  it('reversing a settlement whose payout was left in takes it back out of the account', async () => {
    const { cycle, people } = await tradedCycle();
    for (const p of people) await advance(p.id, cycle.id, 1500);
    await accounts.contribute(cycle.id, { totalEgp: 4400 }, actor);
    const calc = (await settlements.calculate(cycle.id, actor)).data!;
    await settlements.approve(calc.id, actor);
    await settlements.markPaid(calc.id, actor, {
      acceptRemainingStock: true,
      leaveInPartnerUserIds: [people[1].id],
    });
    const before = await balanceOf(people[1].id);
    await settlements.reverse(calc.id, 'recount', actor);
    const left = await prisma.partnerAccountMovement.findFirstOrThrow({
      where: { settlementId: calc.id },
    });
    expect(left.reversedAt).not.toBeNull();
    expect(Number(await balanceOf(people[1].id))).toBeCloseTo(
      Number(before) - Number(left.amountEgp),
      2,
    );
  });
});
