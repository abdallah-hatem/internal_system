import { randomUUID } from 'crypto';
import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { HttpException, type ExecutionContext } from '@nestjs/common';
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
import { ReturnsService } from '../returns/returns.service';
import { PriceAdjustmentsService } from '../sales/price-adjustments.service';
import { LedgerService } from '../ledger/ledger.service';
import { LendersService } from '../lenders/lenders.service';
import { RolesGuard } from '../../common/guards/roles.guard';
import { businessToday } from '../../common/dates';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';

/**
 * What made a bar of Analytics' profit and loss (owner 2026-10-28;
 * BUSINESS_LOGIC §9 "What made a bar"), against a real Postgres — and every
 * way to make the popup disagree with the bar it opens from (CLAUDE.md §0, §1).
 *
 * Built as the business builds it (CLAUDE.md §4): a cycle, a purchase order, a
 * leg that left with it, a delivery, a checked-in receipt, then confirmed
 * sales, a return, a price cut, expenses and a friend repaid at a moved rate.
 *
 * Each test trades in its own month of a random past year, so what it asserts
 * about "its" days is not disturbed by other suites sharing the database —
 * and the comparisons with the bar hold whatever else is there.
 *
 * Runs only against a THROWAWAY database (CLAUDE.md rule 6):
 *
 *   INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/motorcycle_parts_<name> \
 *     npx jest profit-breakdown.db --runInBand
 */
// eslint-disable-next-line no-restricted-properties -- an opt-in switch for a suite that must never run by default
const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;

const DAY_MS = 86_400_000;
const plus = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS)
    .toISOString()
    .slice(0, 10);

let used = new Set<string>();

suite('what made a profit and loss bar (Postgres)', () => {
  let prisma: PrismaClient;
  let analytics: AnalyticsService;
  let deliveries: DeliveriesService;
  let inventory: InventoryService;
  let sales: SalesService;
  let returns: ReturnsService;
  let adjust: PriceAdjustmentsService;
  let ledger: LedgerService;
  let lenders: LendersService;
  let actor: string;

  beforeAll(async () => {
    used = new Set();
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
    returns = new ReturnsService(db, audit);
    adjust = new PriceAdjustmentsService(db, audit);
    ledger = new LedgerService(db, audit);
    lenders = new LendersService(db, audit, notifications, costing);
    analytics = new AnalyticsService(db);
    actor = (await partner('Actor')).id;
  });
  afterAll(() => prisma.$disconnect());

  // ─── Fixtures ───────────────────────────────────────────────────────

  /**
   * A month nobody trades in — a random one between 2001 and 2020 in which
   * this database holds no profit at all, nor in the two months after it (a
   * test reads up to 60 days on). An earlier run's month is never reused.
   */
  async function quietMonth(): Promise<string> {
    for (;;) {
      const y = 2001 + Math.floor(Math.random() * 20);
      const m = 1 + Math.floor(Math.random() * 10);
      const key = `${y}-${String(m).padStart(2, '0')}`;
      if (used.has(key)) continue;
      used.add(key);
      const parts = (
        await analytics.getProfitAndLoss(`${key}-01`, plus(`${key}-01`, 89))
      ).data.buckets.filter(
        (b) => b.salesEgp !== 0 || b.expensesEgp !== 0 || b.netProfitEgp !== 0,
      );
      if (parts.length === 0) return key;
    }
  }

  async function partner(name: string) {
    const tag = randomUUID().slice(0, 8);
    return prisma.user.create({
      data: {
        email: `pnlbd-${name.toLowerCase()}-${tag}@example.test`,
        passwordHash: 'x',
        role: 'CORE_PARTNER',
        partner: { create: { displayName: `${name} ${tag}` } },
      },
    });
  }

  /**
   * A cycle as the business makes it, its stock checked in on `receivedOn`:
   * 40 ordered at 10 AED (rate 10: 4,000 EGP), a 400 EGP leg that left with
   * everything, all delivered and received — 110 EGP a unit landed.
   */
  async function stockedCycle(receivedOn: string) {
    const tag = randomUUID().slice(0, 8);
    const shady = await partner('Shady');
    const cycle = await prisma.importCycle.create({
      data: {
        code: `PNLBD-${tag}`,
        originType: 'UAE_DIRECT',
        currency: 'AED',
        status: 'ARRIVED_EGYPT',
      },
    });
    await prisma.cycleParticipant.create({
      data: {
        cycleId: cycle.id,
        participantType: 'CORE_PARTNER',
        partnerUserId: shady.id,
        contributionAmount: 0,
      },
    });
    const supplier = await prisma.supplier.create({
      data: { name: `PnlBd ${tag}`, country: 'AE' },
    });
    const product = await prisma.product.create({
      data: { sku: `PNLBD-${tag}`, name: `Breakdown part ${tag}` },
    });
    const po = await prisma.purchaseOrder.create({
      data: {
        cycleId: cycle.id,
        supplierId: supplier.id,
        reference: `PO-${tag}`,
        currency: 'AED',
        fxRateToEgp: 10,
        orderedOn: new Date(`${plus(receivedOn, -30)}T00:00:00Z`),
        status: 'CONFIRMED',
      },
    });
    const item = await prisma.purchaseOrderItem.create({
      data: {
        purchaseOrderId: po.id,
        productId: product.id,
        orderedQty: 40,
        unitPrice: 10,
        lineTotal: 400,
      },
    });
    const leg = await prisma.shippingLeg.create({
      data: {
        cycleId: cycle.id,
        sequence: 1,
        origin: 'Dubai, UAE',
        destination: 'Cairo, Egypt',
        departedOn: new Date(`${plus(receivedOn, -20)}T00:00:00Z`),
        status: 'IN_TRANSIT',
        costBasis: 'FLAT',
        amount: 400,
        amountEgp: 400,
      },
    });
    await prisma.shipmentDeparture.create({
      data: {
        legId: leg.id,
        departedOn: new Date(`${plus(receivedOn, -20)}T00:00:00Z`),
        lines: { create: [{ purchaseOrderItemId: item.id, qty: 40 }] },
      },
    });
    const { data: delivery } = await deliveries.recordDelivery(
      leg.id,
      {
        arrivedOn: receivedOn,
        lines: [{ purchaseOrderItemId: item.id, qty: 40 }],
      },
      actor,
    );
    const d = delivery as unknown as { id: string; lines: { id: string }[] };
    await inventory.verifyStock(
      cycle.id,
      {
        deliveryId: d.id,
        receivedOn,
        items: [{ deliveryLineId: d.lines[0].id, receivedQty: 40 }],
      },
      actor,
    );
    const batch = await prisma.inventoryBatch.findFirstOrThrow({
      where: { productId: product.id },
    });
    expect(batch.landedUnitCostEgp.toFixed(2)).toBe('110.00');
    const shop = await prisma.customer.create({
      data: {
        type: 'B2B',
        displayName: `Breakdown shop ${tag}`,
        verificationStatus: 'VERIFIED',
      },
    });
    return { cycle, product, po, shop, shady };
  }

  type World = Awaited<ReturnType<typeof stockedCycle>>;

  /** A confirmed sale on `day`: `qty` at `price`. */
  async function sell(w: World, day: string, qty: number, price: number) {
    const created = await sales.create(
      {
        customerId: w.shop.id,
        channel: 'B2B',
        currency: 'EGP',
        orderedOn: day,
        items: [{ productId: w.product.id, quantity: qty, unitPrice: price }],
        confirm: true,
      },
      actor,
    );
    const id = (created as { data: { id: string } }).data.id;
    return prisma.saleOrder.findUniqueOrThrow({
      where: { id },
      include: { items: true },
    });
  }

  const expense = (
    w: World,
    day: string,
    amount: number,
    extra: Record<string, unknown> = {},
  ) =>
    ledger.create(
      {
        kind: 'EXPENSE',
        category: 'fuel',
        amount,
        currency: 'EGP',
        occurredOn: day,
        cycleId: w.cycle.id,
        ...extra,
      },
      actor,
    );

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

  const breakdown = async (
    from: string,
    to: string,
    more: Record<string, unknown> = {},
  ) => (await analytics.getProfitBreakdown({ from, to, ...more })).data;

  type Data = Awaited<ReturnType<typeof breakdown>>;
  type OrdersSection = {
    total: number;
    totalPages: number;
    page: number;
    pageSize: number;
    totals: Record<string, number>;
    rows: {
      orderId: string;
      day: string;
      saleEgp: number;
      returnsEgp: number;
      priceCutsEgp: number;
      revenueEgp: number;
      cogsEgp: number;
      grossProfitEgp: number;
      order: { orderNo: string; customer: string } | null;
      events: { kind: string; day: string; revenueEgp: number }[];
    }[];
  };
  type ExpenseSection = {
    total: number;
    totals: { amountEgp: number };
    rows: {
      kind: string;
      id: string;
      amountEgp: number;
      entry: {
        paidBy: { id: string; name: string } | null;
        cycle: { id: string } | null;
      } | null;
    }[];
  };
  type ExchangeSection = {
    total: number;
    totals: { amountEgp: number };
    rows: {
      id: string;
      amountEgp: number;
      repayment: { cycle: { id: string } | null; lender: string } | null;
    }[];
  };
  const ordersOf = (d: Data) => d.sections.orders as OrdersSection;
  const expensesOf = (d: Data) => d.sections.expenses as ExpenseSection;
  const exchangeOf = (d: Data) => d.sections.exchange as ExchangeSection;

  /**
   * The popup's totals against the bar's, and its sections against its
   * totals: everything a reader could add up and find unequal.
   */
  function expectAddsUp(
    d: Data,
    bar: {
      salesEgp: number;
      grossProfitEgp: number;
      expensesEgp: number;
      netProfitEgp: number;
    },
  ) {
    const t = d.totals;
    expect({
      salesEgp: t.salesEgp,
      grossProfitEgp: t.grossProfitEgp,
      expensesEgp: t.expensesEgp,
      netProfitEgp: t.netProfitEgp,
    }).toEqual({
      salesEgp: bar.salesEgp,
      grossProfitEgp: bar.grossProfitEgp,
      expensesEgp: bar.expensesEgp,
      netProfitEgp: bar.netProfitEgp,
    });
    const o = ordersOf(d).totals;
    expect(o.revenueEgp).toBe(t.salesEgp);
    expect(o.cogsEgp).toBe(t.cogsEgp);
    expect(o.grossProfitEgp).toBe(t.grossProfitEgp);
    expect(expensesOf(d).totals.amountEgp).toBe(t.expensesEgp);
    expect(exchangeOf(d).totals.amountEgp).toBe(t.exchangeDifferenceEgp);
    const other = d.sections.other as {
      totals: { recoveredEgp: number; otherIncomeEgp: number };
    };
    expect(other.totals.recoveredEgp).toBe(t.recoveredEgp);
    expect(other.totals.otherIncomeEgp).toBe(t.otherIncomeEgp);
    const net =
      Math.round(
        (t.grossProfitEgp -
          t.expensesEgp +
          t.recoveredEgp +
          t.otherIncomeEgp -
          t.exchangeDifferenceEgp) *
          100,
      ) / 100;
    expect(net).toBe(t.netProfitEgp);
  }

  /**
   * A month of trading in `month`: two sales on the 10th (one at a loss),
   * one on the 12th, two returned on the 14th, a price cut on the 15th, fuel
   * on the 10th (by the business) and the 20th (by Shady), and a friend
   * repaid at a moved rate on the 18th.
   */
  async function tradedMonth(month: string) {
    const d = (n: number) => `${month}-${String(n).padStart(2, '0')}`;
    const w = await stockedCycle(d(1));
    const good = await sell(w, d(10), 10, 200); // 2,000 for 1,100: +900
    const cheap = await sell(w, d(10), 2, 50); // 100 for 220: −120
    const later = await sell(w, d(12), 5, 160); // 800 for 550: +250
    await returns.create(
      {
        saleOrderId: good.id,
        reason: 'Two came back',
        returnedOn: d(14),
        refundMethod: 'CREDIT_NOTE',
        items: [{ saleItemId: good.items[0].id, qty: 2 }],
      } as never,
      actor,
    );
    await adjust.create(
      later.id,
      {
        saleItemId: later.items[0].id,
        newUnitPrice: 140,
        adjustedOn: d(15),
        reason: 'Price cut',
      },
      actor,
    );
    const fuel10 = (await expense(w, d(10), 300)).data;
    const fuel20 = (await expense(w, d(20), 75, { paidByUserId: w.shady.id }))
      .data;
    const friend = await prisma.lender.create({
      data: { name: `Friend ${randomUUID().slice(0, 8)}` },
    });
    const { data: financing } = await lenders.finance(
      w.po.id,
      { lenderId: friend.id, amount: 200, paidOn: d(2) },
      actor,
    );
    // 100 AED repaid at 11 instead of 10: 100 EGP more than they were worth.
    const financingId = (financing as unknown as { id: string }).id;
    await lenders.repay(
      financingId,
      { amountEgp: 1100, rateToEgp: 11, paidOn: d(18) },
      actor,
    );
    const repaid = await prisma.lenderRepayment.findFirstOrThrow({
      where: { financingId },
    });
    return {
      w,
      d,
      good,
      cheap,
      later,
      fuel10,
      fuel20,
      friend,
      repaid,
    };
  }

  // ─── The popup equals the bar ───────────────────────────────────────

  it('a day: every day of a traded month, the popup’s totals equal its bar to the piastre', async () => {
    const m = await tradedMonth(await quietMonth());
    const pnl = (await analytics.getProfitAndLoss(m.d(1), m.d(28))).data;
    expect(pnl.granularity).toBe('day');
    let busy = 0;
    for (const bar of pnl.buckets) {
      const d = await breakdown(bar.from, bar.to);
      expectAddsUp(d, bar);
      if (!d.empty) busy++;
    }
    // The 10th, 12th, 14th, 15th, 18th, 20th, and the 2nd (the friend's
    // payment is not profit, so the 2nd stays empty).
    expect(busy).toBe(6);

    // The 10th: two orders, the cheap one first (worst first), and the fuel.
    const tenth = await breakdown(m.d(10), m.d(10));
    expect(
      ordersOf(tenth).rows.map((r) => [r.orderId, r.grossProfitEgp]),
    ).toEqual([
      [m.cheap.id, -120],
      [m.good.id, 900],
    ]);
    expect(ordersOf(tenth).rows[0].order?.orderNo).toBe(m.cheap.orderNo);
    expect(expensesOf(tenth).rows.map((r) => [r.id, r.amountEgp])).toEqual([
      [m.fuel10.id, 300],
    ]);
    expect(tenth.totals).toMatchObject({
      salesEgp: 2100,
      cogsEgp: 1320,
      grossProfitEgp: 780,
      expensesEgp: 300,
      netProfitEgp: 480,
    });
  });

  it('a week and a month: the popup for each bar of a longer period equals that bar', async () => {
    const m = await tradedMonth(await quietMonth());
    // 60 days: drawn by week, Saturday to Friday, the edges cut to the period.
    const weeks = (await analytics.getProfitAndLoss(m.d(1), plus(m.d(1), 59)))
      .data;
    expect(weeks.granularity).toBe('week');
    for (const bar of weeks.buckets) {
      expectAddsUp(await breakdown(bar.from, bar.to), bar);
    }
    // The year: drawn by month; the traded month holds everything.
    const year = m.d(1).slice(0, 4);
    const months = (
      await analytics.getProfitAndLoss(`${year}-01-01`, `${year}-12-31`)
    ).data;
    expect(months.granularity).toBe('month');
    for (const bar of months.buckets) {
      expectAddsUp(await breakdown(bar.from, bar.to), bar);
    }
    const bar = months.buckets.find((b) => b.key === m.d(1).slice(0, 7))!;
    const d = await breakdown(bar.from, bar.to);
    // 2,900 sold, 400 back, 100 cut: 2,400; cost 1,870 less 220 back.
    expect(d.totals).toMatchObject({
      salesEgp: 2400,
      cogsEgp: 1650,
      grossProfitEgp: 750,
      expensesEgp: 375,
      exchangeDifferenceEgp: 100,
      netProfitEgp: 275,
    });
    expect(ordersOf(d).total).toBe(3);
    expect(exchangeOf(d).rows).toHaveLength(1);
    const [repayment] = exchangeOf(d).rows;
    expect(repayment).toMatchObject({ id: m.repaid.id, amountEgp: 100 });
    expect(repayment.repayment?.lender).toBe(m.friend.name);
    expect(repayment.repayment?.cycle?.id).toBe(m.w.cycle.id);
  });

  it('this month and all time, with whatever else the database holds: every bar’s popup equals it', async () => {
    const today = businessToday();
    const month = (await analytics.getProfitAndLoss(`${today.slice(0, 8)}01`))
      .data;
    for (const bar of month.buckets) {
      expectAddsUp(await breakdown(bar.from, bar.to), bar);
    }
    const all = (await analytics.getProfitAndLoss()).data;
    for (const bar of all.buckets.slice(-3)) {
      expectAddsUp(await breakdown(bar.from, bar.to), bar);
    }
  });

  // ─── Tracing a loss ─────────────────────────────────────────────────

  it('a loss day: the bar is below zero, and the popup names the sale at a loss and the expense that made it', async () => {
    const month = await quietMonth();
    const day = `${month}-08`;
    const w = await stockedCycle(`${month}-01`);
    const sold = await sell(w, day, 3, 100); // 300 for 330: −30
    const { data: fee } = await expense(w, day, 500);
    const bar = (await analytics.getProfitAndLoss(day, day)).data.buckets[0];
    expect(bar.netProfitEgp).toBe(-530);
    const d = await breakdown(day, day);
    expectAddsUp(d, bar);
    expect(d.totals.netProfitEgp).toBeLessThan(0);
    expect(ordersOf(d).rows).toEqual([
      expect.objectContaining({
        orderId: sold.id,
        revenueEgp: 300,
        cogsEgp: 330,
        grossProfitEgp: -30,
      }),
    ]);
    expect(expensesOf(d).rows).toEqual([
      expect.objectContaining({ kind: 'ledger', id: fee.id, amountEgp: 500 }),
    ]);
  });

  it('an empty day says so: no rows, every total zero, and it equals its empty bar', async () => {
    const day = `${await quietMonth()}-11`;
    const d = await breakdown(day, day);
    expect(d.empty).toBe(true);
    expect(Object.values(d.totals).every((v) => v === 0)).toBe(true);
    for (const s of ['orders', 'expenses', 'exchange', 'other'] as const) {
      expect((d.sections[s] as { total: number; rows: unknown[] }).total).toBe(
        0,
      );
    }
    const bar = (await analytics.getProfitAndLoss(day, day)).data.buckets[0];
    expectAddsUp(d, bar);
  });

  it('a return and a price cut on later days than the sale: each counts on its own day, under its order, and the sale’s day is untouched', async () => {
    const m = await tradedMonth(await quietMonth());
    // The 14th: only the return — the good sale's revenue and cost, given back.
    const fourteenth = await breakdown(m.d(14), m.d(14));
    expect(ordersOf(fourteenth).rows).toEqual([
      expect.objectContaining({
        orderId: m.good.id,
        saleEgp: 0,
        returnsEgp: -400,
        priceCutsEgp: 0,
        revenueEgp: -400,
        cogsEgp: -220,
        grossProfitEgp: -180,
        events: [
          expect.objectContaining({
            kind: 'return',
            day: m.d(14),
            revenueEgp: -400,
          }),
        ],
      }),
    ]);
    // The 15th: only the price cut on the later sale (5 × 20), no cost moved.
    const fifteenth = await breakdown(m.d(15), m.d(15));
    expect(ordersOf(fifteenth).rows).toEqual([
      expect.objectContaining({
        orderId: m.later.id,
        saleEgp: 0,
        priceCutsEgp: -100,
        cogsEgp: 0,
        grossProfitEgp: -100,
        events: [expect.objectContaining({ kind: 'priceCut', day: m.d(15) })],
      }),
    ]);
    // The sale's own days still show the whole sale.
    const tenth = await breakdown(m.d(10), m.d(10));
    expect(
      ordersOf(tenth).rows.find((r) => r.orderId === m.good.id),
    ).toMatchObject({ saleEgp: 2000, returnsEgp: 0, events: [] });
    // Across the month the order is one row, its return inside it.
    const whole = await breakdown(m.d(1), m.d(28));
    expect(
      ordersOf(whole).rows.find((r) => r.orderId === m.good.id),
    ).toMatchObject({
      saleEgp: 2000,
      returnsEgp: -400,
      revenueEgp: 1600,
      cogsEgp: 880,
      grossProfitEgp: 720,
    });
  });

  it('an expense paid by a partner is still an expense: in the total, named as his, linked to its cycle', async () => {
    const m = await tradedMonth(await quietMonth());
    const d = await breakdown(m.d(20), m.d(20));
    expect(d.totals.expensesEgp).toBe(75);
    expect(d.totals.netProfitEgp).toBe(-75);
    const row = expensesOf(d).rows[0];
    expect(row).toMatchObject({
      kind: 'ledger',
      id: m.fuel20.id,
      amountEgp: 75,
    });
    expect(row.entry?.paidBy?.id).toBe(m.w.shady.id);
    expect(row.entry?.paidBy?.name).toMatch(/^Shady /);
    expect(row.entry?.cycle?.id).toBe(m.w.cycle.id);
    // The business's own fuel says so too.
    const tenth = await breakdown(m.d(10), m.d(10));
    expect(expensesOf(tenth).rows[0].entry?.paidBy).toBeNull();
    const bar = (await analytics.getProfitAndLoss(m.d(20), m.d(20))).data
      .buckets[0];
    expectAddsUp(d, bar);
  });

  it('a sale at 23:30 UTC is the next Cairo day’s: on that day’s bar and popup, not the day before', async () => {
    const month = await quietMonth();
    const w = await stockedCycle(`${month}-01`);
    const day = `${month}-16`;
    const eve = `${month}-15`;
    const sale = await sell(w, day, 1, 500);
    // Entered late: 23:30 UTC on the 15th is 01:30 or 02:30 on the 16th in Cairo.
    await prisma.saleOrder.update({
      where: { id: sale.id },
      data: { orderedAt: new Date(`${eve}T23:30:00Z`) },
    });
    const pnl = (await analytics.getProfitAndLoss(eve, day)).data;
    const [barEve, barDay] = pnl.buckets;
    expect(barEve.salesEgp).toBe(0);
    expect(barDay.salesEgp).toBe(500);
    const onEve = await breakdown(eve, eve);
    const onDay = await breakdown(day, day);
    expectAddsUp(onEve, barEve);
    expectAddsUp(onDay, barDay);
    expect(ordersOf(onEve).rows).toEqual([]);
    expect(ordersOf(onDay).rows.map((r) => r.orderId)).toEqual([sale.id]);
    expect(ordersOf(onDay).rows[0].day).toBe(day);
  });

  // ─── Paging ─────────────────────────────────────────────────────────

  it('paging: pages of a section never overlap, cover every row, and leave the totals of all rows', async () => {
    const month = await quietMonth();
    const day = `${month}-09`;
    const w = await stockedCycle(`${month}-01`);
    const ids: string[] = [];
    for (const price of [120, 130, 140, 150, 160]) {
      ids.push((await sell(w, day, 1, price)).id);
    }
    const page = async (n: number) =>
      ordersOf(
        await breakdown(day, day, {
          section: 'orders',
          page: String(n),
          pageSize: '2',
        }),
      );
    const [p1, p2, p3, p4] = [
      await page(1),
      await page(2),
      await page(3),
      await page(4),
    ];
    expect([
      p1.rows.length,
      p2.rows.length,
      p3.rows.length,
      p4.rows.length,
    ]).toEqual([2, 2, 1, 0]);
    expect(p1).toMatchObject({ total: 5, totalPages: 3, page: 1, pageSize: 2 });
    const seen = [...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.orderId);
    expect(new Set(seen).size).toBe(5);
    expect([...seen].sort()).toEqual([...ids].sort());
    // Worst first: 120 (gross 10) to 160 (gross 50).
    expect(
      [...p1.rows, ...p2.rows, ...p3.rows].map((r) => r.grossProfitEgp),
    ).toEqual([10, 20, 30, 40, 50]);
    // Every page carries the section's totals of all five, and the period's.
    for (const p of [p1, p2, p3, p4]) {
      expect(p.totals.revenueEgp).toBe(700);
      expect(p.totals.grossProfitEgp).toBe(150);
    }
    // Asked for one section, only that one is answered.
    const d = await breakdown(day, day, {
      section: 'orders',
      page: '2',
      pageSize: '2',
    });
    expect(Object.keys(d.sections)).toEqual(['orders']);
    expect(d.totals.salesEgp).toBe(700);
    // Without a page: the first, of the default size.
    expect(ordersOf(await breakdown(day, day)).rows).toHaveLength(5);
    // Left blank, as a form sends them: the same first page, never a 500.
    expect(
      ordersOf(await breakdown(day, day, { page: '', pageSize: '' })),
    ).toMatchObject({ page: 1, pageSize: 25, total: 5 });
  });

  it('paging limits: a page or size that is not a whole number in range, and an unknown section, are refused with codes', async () => {
    const day = `${await quietMonth()}-03`;
    for (const [more, code] of [
      [{ page: '0' }, 'LIST_PAGE_INVALID'],
      [{ page: '-1' }, 'LIST_PAGE_INVALID'],
      [{ page: 'abc' }, 'LIST_PAGE_INVALID'],
      [{ pageSize: '0' }, 'LIST_PAGE_SIZE_INVALID'],
      [{ pageSize: '201' }, 'LIST_PAGE_SIZE_INVALID'],
      [{ section: 'payments' }, 'LIST_FILTER_INVALID'],
      [{ section: ['orders'] }, 'LIST_FILTER_INVALID'],
    ] as const) {
      const r = await refusal(breakdown(day, day, more));
      expect([JSON.stringify(more), r.status, r.code]).toEqual([
        JSON.stringify(more),
        400,
        code,
      ]);
    }
  });

  // ─── The period asked for ───────────────────────────────────────────

  it('the period: both days required, a real range, not starting in the future, at most 31 days', async () => {
    const today = businessToday();
    const cases: [unknown, unknown, string][] = [
      [undefined, undefined, 'PNL_BREAKDOWN_NEEDS_PERIOD'],
      ['2020-01-01', undefined, 'PNL_BREAKDOWN_NEEDS_PERIOD'],
      [undefined, '2020-01-01', 'PNL_BREAKDOWN_NEEDS_PERIOD'],
      ['', '', 'PNL_BREAKDOWN_NEEDS_PERIOD'],
      ['2020-02-30', '2020-03-01', 'BAD_DATE'],
      ['01/03/2020', '2020-03-01', 'BAD_DATE'],
      [['2020-01-01'], '2020-01-02', 'BAD_DATE'],
      ['2020-03-05', '2020-03-01', 'DATE_RANGE_REVERSED'],
      [plus(today, 1), plus(today, 1), 'PERIOD_NOT_STARTED'],
      ['2020-01-01', '2020-02-01', 'PNL_BREAKDOWN_TOO_LONG'],
    ];
    for (const [from, to, code] of cases) {
      const r = await refusal(analytics.getProfitBreakdown({ from, to }));
      expect([from, to, r.status, r.code]).toEqual([from, to, 400, code]);
    }
    // 31 days — the longest month — is a bar; so is today.
    await breakdown('2020-01-01', '2020-01-31');
    await breakdown(today, today);
  });

  it('the second time: asked again it answers the same; a new expense on the day shows at once, in the popup and on the bar', async () => {
    const month = await quietMonth();
    const day = `${month}-21`;
    const w = await stockedCycle(`${month}-01`);
    await sell(w, day, 2, 200);
    const first = await breakdown(day, day);
    expect(await breakdown(day, day)).toEqual(first);
    const { data: fee } = await expense(w, day, 40);
    const again = await breakdown(day, day);
    expect(again.totals.expensesEgp).toBe(first.totals.expensesEgp + 40);
    expect(expensesOf(again).rows.map((r) => r.id)).toContain(fee.id);
    const bar = (await analytics.getProfitAndLoss(day, day)).data.buckets[0];
    expectAddsUp(again, bar);
  });

  it('an expense undone stays out of both, as the bar leaves it out', async () => {
    const month = await quietMonth();
    const day = `${month}-22`;
    const w = await stockedCycle(`${month}-01`);
    const { data: fee } = await expense(w, day, 90);
    await ledger.reverse(fee.id, 'typed twice', actor);
    const d = await breakdown(day, day);
    expect(expensesOf(d).rows).toEqual([]);
    expect(d.empty).toBe(true);
    const bar = (await analytics.getProfitAndLoss(day, day)).data.buckets[0];
    expectAddsUp(d, bar);
  });
});

// ─── Who may read it (CLAUDE.md §12) ──────────────────────────────────

describe('GET /analytics/profit-and-loss/breakdown — who may read it', () => {
  const guard = new RolesGuard(new Reflector());
  const h = Object.getOwnPropertyDescriptor(
    AnalyticsController.prototype,
    'getProfitBreakdown',
  )!.value as object;
  const as = (role: string | undefined) =>
    ({
      getHandler: () => h,
      getClass: () => AnalyticsController,
      switchToHttp: () => ({
        getRequest: () => ({ user: role ? { role } : undefined }),
      }),
    }) as unknown as ExecutionContext;

  it.each(['TEMP_INVESTOR', 'SHOP_OWNER_PORTAL', 'SOMETHING_NEW', undefined])(
    '%s is refused with 403 ROLE_NOT_ALLOWED',
    (role) => {
      let e: unknown;
      try {
        guard.canActivate(as(role));
      } catch (err) {
        e = err;
      }
      expect(e).toBeInstanceOf(HttpException);
      expect((e as HttpException).getStatus()).toBe(403);
      expect((e as HttpException).getResponse()).toMatchObject({
        code: 'ROLE_NOT_ALLOWED',
      });
    },
  );

  it.each(['CORE_PARTNER', 'ADMIN_SUPPORT'])('%s is let through', (role) => {
    expect(guard.canActivate(as(role))).toBe(true);
  });

  it('the route carries the RolesGuard', () => {
    const guards = Reflect.getMetadata('__guards__', h) as unknown[];
    expect(guards).toContain(RolesGuard);
  });
});
