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
import { LendersService } from '../lenders/lenders.service';
import { exchangeDifferenceEgp } from '../../common/lender-debt';
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
  let lenders: LendersService;
  let cyclesService: CyclesService;
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
    lenders = new LendersService(db, audit, notifications, costing);
    cyclesService = cycles;
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
    // A second apart, so the order they joined in — which decides who takes
    // the odd piastre — never ties on a fast run (it did, flakily).
    const joined = Date.now() - 60_000; // in the past: a settlement reads anything newer as changed
    for (const [i, p] of people.entries()) {
      participants.push(
        await prisma.cycleParticipant.create({
          data: {
            cycleId: cycle.id,
            participantType: 'CORE_PARTNER',
            partnerUserId: p.id,
            contributionAmount: 0,
            createdAt: new Date(joined + i * 1000),
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
  const m2 = (v: { toFixed: (n: number) => string }) => v.toFixed(2);

  /**
   * Untied money in his account: a settlement's payout left in, which is how
   * the business puts any there (§8 phase 2). Written as the row Mark paid
   * writes, without settling a whole cycle for each withdrawal test — the
   * real path is tested end to end under "a payout left in" below.
   */
  const leftIn = (userId: string, amountEgp: number) =>
    prisma.partnerAccountMovement.create({
      data: {
        partnerUserId: userId,
        kind: 'PAYOUT_LEFT_IN',
        amount: amountEgp,
        amountEgp,
        occurredOn: new Date(`${businessToday()}T00:00:00Z`),
        note: 'Payout left in (fixture)',
      },
    });

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
            cycleId: cycle.id,
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
    const { people } = await cycleWithPartners();
    const who = people[0].id;
    await leftIn(who, 1000);
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
    const { people } = await cycleWithPartners();
    const who = people[0].id;
    await leftIn(who, 500);
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
    const { people } = await tradedCycle();
    await leftIn(people[0].id, 1000);
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

  it('an advance already drawn into a cycle cannot be reversed: its cycle’s pot would go negative', async () => {
    const { cycle, people } = await cycleWithPartners();
    const adv = [];
    for (const p of people) adv.push((await advance(p.id, cycle.id, 300)).data);
    await accounts.contribute(cycle.id, { totalEgp: 600 }, actor);
    const refused = await refusal(
      accounts.reverse(people[0].id, adv[0].id, 'mistake', actor),
    );
    expect(refused.code).toBe('ADVANCE_ALREADY_DRAWN');
    expect(refused.params).toMatchObject({ drawn: '200.00', amount: '300.00' });
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

  it('the Funding card (owner 2026-10-26): production’s cycle 2 — thirds of 120,000, covered or short, and into capital once contributed', async () => {
    const { cycle, people } = await cycleWithPartners();
    await accounts.setTarget(
      cycle.id,
      { amount: 120000, currency: 'EGP' },
      actor,
    );
    await advance(people[0].id, cycle.id, 50775);
    await advance(people[1].id, cycle.id, 10000);
    // Another cycle's advance is never this cycle's to draw (2026-10-26).
    const other = await cycleWithPartners();
    await advance(people[2].id, other.cycle.id, 99999);

    let { data } = await accounts.cycleFunding(cycle.id);
    expect(data.shares).toEqual(
      expect.objectContaining({
        basis: 'TARGET',
        partnersEgp: '120000.00',
        stillEgp: '120000.00',
      }),
    );
    expect(data.partners.map((p) => [p.shareEgp, p.coverEgp])).toEqual([
      ['40000.00', '10775.00'],
      ['40000.00', '-30000.00'],
      ['40000.00', '-40000.00'],
    ]);
    expect(data.paidSoFar.byPartner.map((p) => p.intoCapitalEgp)).toEqual([
      '0.00',
      '0.00',
    ]);
    expect(data.profitSplit.basis).toBe('NONE');
    expect(data.participants.map((p) => p.profitPct)).toEqual([
      null,
      null,
      null,
    ]);

    // 10,000 each: Abdallah's and Shady's come from their advances here.
    await advance(people[2].id, cycle.id, 10000);
    await accounts.contribute(cycle.id, { totalEgp: 30000 }, actor);
    ({ data } = await accounts.cycleFunding(cycle.id));
    expect(
      data.paidSoFar.byPartner.map((p) => [p.totalEgp, p.intoCapitalEgp]),
    ).toEqual([
      ['50775.00', '10000.00'],
      ['10000.00', '10000.00'],
      ['10000.00', '10000.00'],
    ]);
    // What each still owes of his third counts what he already put in.
    expect(data.partners.map((p) => [p.stillToGiveEgp, p.coverEgp])).toEqual([
      ['30000.00', '10775.00'],
      ['30000.00', '-30000.00'],
      ['30000.00', '-30000.00'],
    ]);
    expect(data.shares.stillEgp).toBe('90000.00');
    expect(data.profitSplit).toEqual({
      basis: 'CONTRIBUTIONS',
      equal: true,
      problem: null,
    });
    expect(data.participants.map((p) => p.profitPct)).toEqual([
      '33.33',
      '33.33',
      '33.34',
    ]);
  });

  // ─── The Funding card on a cycle a friend paid (owner 2026-10-26) ────

  /**
   * Production's cycle 1, rebuilt the way it happened: an AED order of
   * 13,905.69 at 13.9066 (193,380.87 EGP) and a 1.41 EGP leg — a cost to fund
   * of 193,382.28 — that a friend paid in full at the order's rate. The
   * partners then repay him in three dirham thirds (4,635.23) at 14, 14.50
   * and 14.90 — 64,893.22 + 67,210.84 + 69,064.93 = 201,168.99 EGP — through
   * the real repayment path (`lender-math`), the last one settling exactly.
   */
  async function friendPaidCycle(
    opts: {
      rates?: [number, number, number];
      repay?: boolean;
      /** His loan in dirhams; 9,878.84 once 60,000 of it stayed in as his investment (2026-10-27). */
      loanAed?: number;
    } = {},
  ) {
    const base = await cycleWithPartners('PURCHASING', 'AED');
    const tag = randomUUID().slice(0, 8);
    const supplier = await prisma.supplier.create({
      data: { name: `Friend ${tag}`, country: 'AE' },
    });
    const product = await prisma.product.create({
      data: { sku: `FRIEND-${tag}`, name: `Friend part ${tag}` },
    });
    const po = await prisma.purchaseOrder.create({
      data: {
        cycleId: base.cycle.id,
        supplierId: supplier.id,
        reference: `PO-${tag}`,
        currency: 'AED',
        fxRateToEgp: 13.9066,
        orderedOn: new Date(`${daysAgo(40)}T00:00:00Z`),
        status: 'CONFIRMED',
        items: {
          create: [
            {
              productId: product.id,
              orderedQty: 1,
              unitPrice: 13905.69,
              lineTotal: 13905.69,
            },
          ],
        },
      },
    });
    await prisma.shippingLeg.create({
      data: {
        cycleId: base.cycle.id,
        sequence: 1,
        origin: 'Dubai, UAE',
        destination: 'Cairo, Egypt',
        status: 'PLANNED',
        costBasis: 'FLAT',
        amount: 1.41,
        amountEgp: 1.41,
      },
    });
    const friend = await prisma.lender.create({
      data: { name: `Ahmad Eraiby ${tag}` },
    });
    const { data: financing } = await lenders.finance(
      po.id,
      {
        lenderId: friend.id,
        amount: opts.loanAed ?? 13905.69,
        paidOn: daysAgo(35),
      },
      actor,
    );
    const f = financing as unknown as { id: string };
    if (opts.repay !== false) {
      const rates = opts.rates ?? [14, 14.5, 14.9];
      const third = 4635.23;
      // Half up to the piastre: 4,635.23 × 14.50 = 67,210.835 → 67,210.84.
      const pounds = (rate: number) =>
        Number(
          (Math.round(Number((third * rate * 100).toFixed(4))) / 100).toFixed(
            2,
          ),
        );
      await lenders.repay(
        f.id,
        {
          amountEgp: pounds(rates[0]),
          rateToEgp: rates[0],
          paidOn: daysAgo(20),
        },
        actor,
      );
      await lenders.repay(
        f.id,
        {
          amountEgp: pounds(rates[1]),
          rateToEgp: rates[1],
          paidOn: daysAgo(10),
        },
        actor,
      );
      const { data: quote } = await lenders.quote(f.id, rates[2]);
      await lenders.repay(
        f.id,
        {
          amountEgp: Number(quote.settlingEgp),
          rateToEgp: rates[2],
          paidOn: daysAgo(2),
        },
        actor,
      );
    }
    return { ...base, friend };
  }

  /** Each partner's share of repaying him, entered directly (Enter amounts). */
  async function enterContributions(
    participants: { id: string }[],
    amounts: number[],
  ) {
    for (const [i, p] of participants.entries()) {
      await cyclesService.updateParticipant(
        p.id,
        { contributionAmount: amounts[i] },
        actor,
      );
    }
  }

  it('production’s cycle 1: 67,056.33 put in by each (201,168.99), shares of what was repaid, and the exchange difference settlement takes', async () => {
    const { cycle, participants, friend } = await friendPaidCycle();
    // Before the partners enter who repaid what: shares already follow the
    // repayments, and nobody has put anything in yet.
    let { data } = await accounts.cycleFunding(cycle.id);
    expect(data.shares.basis).toBe('REPAID');
    expect(data.putIn.totalEgp).toBe('0.00');

    await enterContributions(participants, [67056.33, 67056.33, 67056.33]);
    ({ data } = await accounts.cycleFunding(cycle.id));

    // 1. Put in so far: his contribution, entered directly — repaying him.
    expect(data.putIn.totalEgp).toBe('201168.99');
    expect(
      data.putIn.byPartner.map((p) => [
        p.totalEgp,
        p.enteredEgp,
        p.fromAccountEgp,
        p.undrawnAdvancesEgp,
      ]),
    ).toEqual([0, 1, 2].map(() => ['67056.33', '67056.33', '0.00', '0.00']));
    // The advances-only figure the card used to show is still zero here.
    expect(data.paidSoFar.totalEgp).toBe('0.00');

    // 2. Shares: thirds of what was repaid him, not of the cost to fund.
    expect(data.toFundEgp).toBe('193382.28');
    expect(data.shares).toEqual(
      expect.objectContaining({ basis: 'REPAID', ofEgp: '201168.99' }),
    );
    expect(data.partners.map((p) => [p.shareEgp, p.coverEgp])).toEqual(
      [0, 1, 2].map(() => ['67056.33', '0.00']),
    );

    // 3. The exchange difference: the very figure settlement and profit use.
    expect(data.friends).toEqual(
      expect.objectContaining({
        names: [friend.name],
        financedEgp: '193380.87',
        repaidEgp: '201168.99',
      }),
    );
    const reader = await exchangeDifferenceEgp(prisma, cycle.id);
    const projected = (await settlements.project(cycle.id))!;
    expect(data.friends!.exchangeDifferenceEgp).toBe(reader.toFixed(2));
    expect(data.friends!.exchangeDifferenceEgp).toBe(
      projected.exchangeDifferenceEgp.toFixed(2),
    );
    // Repaid 201,168.99 − his 193,380.87 at his own rate.
    expect(data.friends!.exchangeDifferenceEgp).toBe('7788.12');
    // Each one's part is what settlement takes off his profit share for it:
    // nothing sold yet, so the projected profit is exactly minus the difference.
    expect(projected.pnl.grossProfit.toFixed(2)).toBe('-7788.12');
    expect(data.friends!.exchangeSplit!.map((p) => p.amountEgp)).toEqual(
      projected.distribution.lines.map((l) => l.grossProfit.neg().toFixed(2)),
    );
    expect(data.friends!.exchangeSplit!.map((p) => p.amountEgp)).toEqual([
      '2596.04',
      '2596.04',
      '2596.04',
    ]);
  });

  it('production’s cycle 1 as corrected (2026-10-27): investors in what was put in, the partners’ part what they put in, shares as agreed, every percentage over all five', async () => {
    const { cycle, participants } = await friendPaidCycle({ loanAed: 9878.84 });
    await enterContributions(participants, [55000, 33084.5, 33084.49]);
    const joined = Date.now() - 30_000;
    const investors = [];
    for (const [i, [name, amount]] of (
      [
        ['Ahmad Eraiby', 60000],
        ['Mohammed Setta', 20000],
      ] as const
    ).entries()) {
      const user = await prisma.user.create({
        data: {
          email: `acct-inv-${randomUUID()}@example.test`,
          passwordHash: 'x',
          role: 'TEMP_INVESTOR',
          partner: { create: { displayName: name } },
        },
      });
      investors.push(user);
      await prisma.cycleParticipant.create({
        data: {
          cycleId: cycle.id,
          participantType: 'TEMP_INVESTOR',
          investorUserId: user.id,
          contributionAmount: amount,
          createdAt: new Date(joined + i * 1000),
        },
      });
    }

    let { data } = await accounts.cycleFunding(cycle.id);
    // Repaid 141,168.92: the 60,000 that stayed in was never part of it.
    expect(data.friends!.repaidEgp).toBe('141168.92');

    // 1. Put in so far: everyone's money — 201,168.99, not the partners' 121,168.99.
    expect(data.putIn.totalEgp).toBe('201168.99');
    expect(
      data.putIn.byPartner.map((p) => [p.participantType, p.name, p.totalEgp]),
    ).toEqual([
      ['CORE_PARTNER', expect.stringContaining('Abdallah'), '55000.00'],
      ['CORE_PARTNER', expect.stringContaining('Shady'), '33084.50'],
      ['CORE_PARTNER', expect.stringContaining('Fares'), '33084.49'],
      ['TEMP_INVESTOR', 'Ahmad Eraiby', '60000.00'],
      ['TEMP_INVESTOR', 'Mohammed Setta', '20000.00'],
    ]);
    expect(data.putIn.byPartner[3].partnerUserId).toBe(investors[0].id);

    // 2. The partners' part is what funds the cycle less investors — not
    //    repaid − all investors (61,168.92 → 20,389.64 each); shares as agreed.
    expect(data.shares).toEqual({
      basis: 'PUT_IN',
      ofEgp: '201168.99',
      partnersEgp: '121168.99',
      agreed: true,
      stillEgp: '0.00',
    });
    expect(data.partners.map((p) => [p.shareEgp, p.coverEgp])).toEqual([
      ['55000.00', '0.00'],
      ['33084.50', '0.00'],
      ['33084.49', '0.00'],
    ]);

    // 3. Each one's share of the cycle: all five, the settlement's split.
    expect(data.participants.map((p) => p.profitPct)).toEqual([
      '27.34',
      '16.45',
      '16.45',
      '29.82',
      '9.94',
    ]);
    const projected = (await settlements.project(cycle.id))!;
    projected.distribution.lines.forEach((l, i) => {
      expect(
        l.sharePct.sub(data.participants[i].profitPct!).abs().lte('0.01'),
      ).toBe(true);
    });

    // A target counts investors' money towards it, as its shares take it off.
    await accounts.setTarget(
      cycle.id,
      { amount: 250000, currency: 'EGP' },
      actor,
    );
    ({ data } = await accounts.cycleFunding(cycle.id));
    expect(data.putIn.inTargetCurrency).toBe('201168.99');
    expect(data.shares).toEqual(
      expect.objectContaining({
        basis: 'TARGET',
        partnersEgp: '170000.00',
        agreed: false,
      }),
    );
  });

  it('a friend-paid cycle before any repayment: shares of the cost to fund, nothing repaid, no exchange difference', async () => {
    const { cycle } = await friendPaidCycle({ repay: false });
    const { data } = await accounts.cycleFunding(cycle.id);
    expect(data.shares).toEqual(
      expect.objectContaining({ basis: 'COST_TO_FUND', ofEgp: '193382.28' }),
    );
    expect(data.partners.map((p) => p.shareEgp)).toEqual([
      '64460.76',
      '64460.76',
      '64460.76',
    ]);
    expect(data.friends).toEqual(
      expect.objectContaining({
        repaidEgp: '0.00',
        exchangeDifferenceEgp: '0.00',
      }),
    );
  });

  it('the dirham fell before he was repaid: the difference is a gain (negative), split as one', async () => {
    const { cycle, participants } = await friendPaidCycle({
      rates: [13.5, 13.4, 13.3],
    });
    const { data: before } = await accounts.cycleFunding(cycle.id);
    const repaidCents = Math.round(Number(before.friends!.repaidEgp) * 100);
    const third = Math.floor(repaidCents / 3);
    await enterContributions(participants, [
      third / 100,
      third / 100,
      (repaidCents - 2 * third) / 100,
    ]);
    const { data } = await accounts.cycleFunding(cycle.id);
    const diff = Number(data.friends!.exchangeDifferenceEgp);
    expect(diff).toBeLessThan(0);
    expect(data.friends!.exchangeDifferenceEgp).toBe(
      (await exchangeDifferenceEgp(prisma, cycle.id)).toFixed(2),
    );
    const parts = data.friends!.exchangeSplit!.map((p) =>
      Math.round(Number(p.amountEgp) * 100),
    );
    expect(parts.reduce((a, b) => a + b, 0)).toBe(Math.round(diff * 100));
    expect(parts.every((v) => v < 0)).toBe(true);
    // Shares follow what was repaid — less than the cost to fund this time.
    expect(data.shares.basis).toBe('REPAID');
    expect(Number(data.shares.ofEgp)).toBeLessThan(Number(data.toFundEgp));
    expect(data.partners.map((p) => p.coverEgp)).toEqual([
      '0.00',
      '0.00',
      '0.00',
    ]);
  });

  it('put in so far with advances partly drawn: contribution + undrawn advances, a drawn advance counted once', async () => {
    const { cycle, people } = await cycleWithPartners();
    await accounts.setTarget(
      cycle.id,
      { amount: 120000, currency: 'EGP' },
      actor,
    );
    await advance(people[0].id, cycle.id, 50775);
    await advance(people[1].id, cycle.id, 10000);
    let { data } = await accounts.cycleFunding(cycle.id);
    expect(data.friends).toBeNull();
    expect(data.putIn.totalEgp).toBe('60775.00');
    expect(data.putIn.inTargetCurrency).toBe('60775.00');
    expect(data.putIn.byPartner.map((p) => p.totalEgp)).toEqual([
      '50775.00',
      '10000.00',
      '0.00',
    ]);

    // 10,000 each drawn from the accounts; Fares pays his in first.
    await advance(people[2].id, cycle.id, 10000);
    await accounts.contribute(cycle.id, { totalEgp: 30000 }, actor);
    ({ data } = await accounts.cycleFunding(cycle.id));
    expect(
      data.putIn.byPartner.map((p) => [
        p.totalEgp,
        p.contributionEgp,
        p.fromAccountEgp,
        p.enteredEgp,
        p.undrawnAdvancesEgp,
      ]),
    ).toEqual([
      ['50775.00', '10000.00', '10000.00', '0.00', '40775.00'],
      ['10000.00', '10000.00', '10000.00', '0.00', '0.00'],
      ['10000.00', '10000.00', '10000.00', '0.00', '0.00'],
    ]);
    // 70,775, not 100,775: the drawn 30,000 is inside the contributions.
    expect(data.putIn.totalEgp).toBe('70775.00');
    expect(data.putIn.inTargetCurrency).toBe('70775.00');
    // The advances keep their day.
    expect(data.putIn.byPartner[0].advances).toHaveLength(1);
    // No friend: the target's thirds, as before.
    expect(data.shares.basis).toBe('TARGET');
  });

  it('put in so far in a target of another currency: an undrawn advance in it at face, a contribution at the target’s rate', async () => {
    const { cycle, people } = await cycleWithPartners('PURCHASING', 'USD');
    await accounts.setTarget(
      cycle.id,
      { amount: 2000, currency: 'USD', fxRateToEgp: 50 },
      actor,
    );
    await advance(people[0].id, cycle.id, 1000, {
      currency: 'USD',
      fxRateToEgp: 51,
    });
    const { data } = await accounts.cycleFunding(cycle.id);
    expect(data.putIn.byPartner[0].inTargetCurrency).toBe('1000.00');
    expect(data.putIn.byPartner[0].totalEgp).toBe('51000.00');
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
    // He takes all his untied money out; reversing the settlement would take
    // the payout from the 33.34 left of his advance on this cycle — money
    // only that cycle could draw (owner 2026-10-26) — so it is refused.
    const untied = (await accounts.list()).data.find(
      (a) => a.partnerUserId === people[0].id,
    )!.untiedEgp;
    expect(untied).toBe(m2(left.amountEgp));
    await accounts.withdraw(people[0].id, { amountEgp: Number(untied) }, actor);
    expect(
      (await refusal(settlements.reverse(calc.id, 'recount', actor))).code,
    ).toBe('ACCOUNT_MONEY_TIED_TO_CYCLES');
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

  // ─── Each cycle's funding is its own (owner 2026-10-26) ─────────────

  /**
   * Production's case: the same three partners on two cycles; Abdallah
   * advanced 50,775 and Shady 10,000 for cycle 2. Cycle 1's Contribute form
   * offered Abdallah's 50,775 — money paid for cycle 2's goods.
   */
  async function twoCycles() {
    const one = await cycleWithPartners();
    const people = one.people;
    const tag = randomUUID().slice(0, 8);
    const two = await prisma.importCycle.create({
      data: {
        code: `ACCT2-${tag}`,
        originType: 'UAE_DIRECT',
        currency: 'EGP',
        status: 'PURCHASING',
      },
    });
    const joined = Date.now() - 60_000; // in the past: a settlement reads anything newer as changed
    for (const [i, p] of people.entries()) {
      await prisma.cycleParticipant.create({
        data: {
          cycleId: two.id,
          participantType: 'CORE_PARTNER',
          partnerUserId: p.id,
          contributionAmount: 0,
          createdAt: new Date(joined + i * 1000),
        },
      });
    }
    const [abdallah, shady, fares] = people.map((p) => p.id);
    const advA = (await advance(abdallah, two.id, 50_775)).data;
    const advS = (await advance(shady, two.id, 10_000)).data;
    return { one: one.cycle, two, abdallah, shady, fares, advA, advS };
  }
  const fundingOf = async (cycleId: string) =>
    (await accounts.cycleFunding(cycleId)).data.partners.map((p) => ({
      available: p.availableEgp,
      own: p.ownAdvancesEgp,
      untied: p.untiedEgp,
      elsewhere: p.elsewhereEgp,
      balance: p.balanceEgp,
    }));
  const potsOfPartner = async (id: string) => {
    const a = (await accounts.list()).data.find((x) => x.partnerUserId === id)!;
    return {
      untied: a.untiedEgp,
      byCycle: a.byCycle.map((c) => [c.cycleCode, c.amountEgp]),
    };
  };

  it('an advance on cycle 2 is not offered to cycle 1, and cycle 1 cannot draw it whatever is sent', async () => {
    const { one, two, abdallah } = await twoCycles();
    // Cycle 1 can draw nothing: the 50,775 is shown as cycle 2's, not offered.
    expect(await fundingOf(one.id)).toEqual([
      {
        available: '0.00',
        own: '0.00',
        untied: '0.00',
        elsewhere: '50775.00',
        balance: '50775.00',
      },
      {
        available: '0.00',
        own: '0.00',
        untied: '0.00',
        elsewhere: '10000.00',
        balance: '10000.00',
      },
      {
        available: '0.00',
        own: '0.00',
        untied: '0.00',
        elsewhere: '0.00',
        balance: '0.00',
      },
    ]);
    // Asked straight, one line for Abdallah alone: refused, naming why.
    const r = await refusal(
      accounts.contribute(
        one.id,
        { lines: [{ partnerUserId: abdallah, amountEgp: 100 }] },
        actor,
      ),
    );
    expect(r.code).toBe('ACCOUNT_MONEY_FOR_OTHER_CYCLE');
    expect(r.params).toMatchObject({
      available: '0.00',
      elsewhere: '50,775.00',
      amount: '100.00',
      short: '100.00',
      cycle: one.code,
    });
    // Nothing written.
    expect(
      await prisma.partnerAccountMovement.count({ where: { cycleId: one.id } }),
    ).toBe(0);
    expect(
      (await accounts.cycleFunding(two.id)).data.partners[0].availableEgp,
    ).toBe('50775.00');
  });

  it('on cycle 2 the advances are offered; equal thirds of 60,775 show and refuse the shortfalls', async () => {
    const { two, abdallah, shady, fares } = await twoCycles();
    expect((await fundingOf(two.id)).map((p) => [p.available, p.own])).toEqual([
      ['50775.00', '50775.00'],
      ['10000.00', '10000.00'],
      ['0.00', '0.00'],
    ]);
    // Thirds of 60,775: 20,258.33 / 20,258.33 / 20,258.34 — Shady 10,258.33
    // short, Fares all of his. All or nothing.
    const r = await refusal(
      accounts.contribute(two.id, { totalEgp: 60_775 }, actor),
    );
    expect(r.code).toBe('ACCOUNT_BALANCE_TOO_LOW');
    expect(r.params).toMatchObject({
      balance: '10,000.00',
      short: '10,258.33',
    });
    expect(
      await prisma.partnerAccountMovement.count({
        where: { cycleId: two.id, kind: 'CONTRIBUTION' },
      }),
    ).toBe(0);
    // Thirds that fit everyone are drawn from cycle 2's own advances.
    await advance(fares, two.id, 10_000);
    await accounts.contribute(two.id, { totalEgp: 30_000 }, actor);
    expect((await fundingOf(two.id)).map((p) => p.available)).toEqual([
      '40775.00',
      '0.00',
      '0.00',
    ]);
    expect((await potsOfPartner(abdallah)).untied).toBe('0.00');
    expect((await potsOfPartner(shady)).byCycle).toEqual([]);
  });

  it('a payout left in can fund either cycle; a draw takes the cycle’s own advance first', async () => {
    const { one, two, fares } = await twoCycles();
    await leftIn(fares, 500);
    expect((await fundingOf(one.id))[2].available).toBe('500.00');
    expect((await fundingOf(two.id))[2].available).toBe('500.00');
    await accounts.contribute(
      one.id,
      { lines: [{ partnerUserId: fares, amountEgp: 300 }] },
      actor,
    );
    expect((await fundingOf(two.id))[2]).toMatchObject({
      available: '200.00',
      untied: '200.00',
    });
    // On cycle 2 he advances 100 and contributes 250: his 100 first, then 150 untied.
    await advance(fares, two.id, 100);
    await accounts.contribute(
      two.id,
      { lines: [{ partnerUserId: fares, amountEgp: 250 }] },
      actor,
    );
    expect(await potsOfPartner(fares)).toEqual({
      untied: '50.00',
      byCycle: [],
    });
    expect(await balanceOf(fares)).toBe('50.00');
  });

  it('never negative, per pot: a withdrawal or a draw never reaches another cycle’s advance', async () => {
    const { one, abdallah, fares } = await twoCycles();
    // Abdallah's whole 50,775 is cycle 2's: not one pound comes out.
    const w = await refusal(
      accounts.withdraw(abdallah, { amountEgp: 1 }, actor),
    );
    expect(w.code).toBe('ACCOUNT_MONEY_TIED_TO_CYCLES');
    expect(w.params).toMatchObject({ available: '0.00', tied: '50,775.00' });
    // With 200 untied, cycle 1 can draw 200 of him and not a piastre more.
    await leftIn(abdallah, 200);
    const more = await refusal(
      accounts.contribute(
        one.id,
        { lines: [{ partnerUserId: abdallah, amountEgp: 200.01 }] },
        actor,
      ),
    );
    expect(more.code).toBe('ACCOUNT_MONEY_FOR_OTHER_CYCLE');
    expect(more.params).toMatchObject({ available: '200.00', short: '0.01' });
    await accounts.contribute(
      one.id,
      { lines: [{ partnerUserId: abdallah, amountEgp: 200 }] },
      actor,
    );
    // Twice: the second sees what is left, which is cycle 2's alone.
    expect(
      (
        await refusal(
          accounts.contribute(
            one.id,
            { lines: [{ partnerUserId: abdallah, amountEgp: 0.01 }] },
            actor,
          ),
        )
      ).code,
    ).toBe('ACCOUNT_MONEY_FOR_OTHER_CYCLE');
    expect(
      (await refusal(accounts.withdraw(abdallah, { amountEgp: 0.01 }, actor)))
        .code,
    ).toBe('ACCOUNT_MONEY_TIED_TO_CYCLES');
    expect(await potsOfPartner(abdallah)).toMatchObject({ untied: '0.00' });
    // Fares has nothing anywhere: the plain refusal.
    expect(
      (await refusal(accounts.withdraw(fares, { amountEgp: 1 }, actor))).code,
    ).toBe('ACCOUNT_BALANCE_TOO_LOW');
  });

  it('reversing an advance on cycle 2 touches neither cycle 1 nor untied money; a drawn one is refused', async () => {
    const { one, two, abdallah, shady, advA, advS } = await twoCycles();
    // Shady funds cycle 1 from a payout left in.
    await leftIn(shady, 1_000);
    await accounts.contribute(
      one.id,
      { lines: [{ partnerUserId: shady, amountEgp: 1_000 }] },
      actor,
    );
    const before1 = await fundingOf(one.id);
    // His cycle 2 advance, undrawn, can be reversed — cycle 1 is untouched.
    await accounts.reverse(shady, advS.id, 'entered twice', actor);
    const after1 = await fundingOf(one.id);
    expect(after1[1]).toEqual({
      ...before1[1],
      elsewhere: '0.00',
      balance: '0.00',
    });
    expect(after1[1].available).toBe('0.00');
    expect(
      (await accounts.cycleFunding(one.id)).data.partners[1].contributionEgp,
    ).toBe('1000.00');
    // Abdallah's, once 10,000 of it is drawn into cycle 2, cannot be.
    await accounts.contribute(
      two.id,
      { lines: [{ partnerUserId: abdallah, amountEgp: 45_000 }] },
      actor,
    );
    const r = await refusal(
      accounts.reverse(abdallah, advA.id, 'mistake', actor),
    );
    expect(r.code).toBe('ADVANCE_ALREADY_DRAWN');
    expect(r.params).toMatchObject({ drawn: '45,000.00', cycle: two.code });
    expect(await potsOfPartner(abdallah)).toEqual({
      untied: '0.00',
      byCycle: [[two.code, '5775.00']],
    });
  });
});
