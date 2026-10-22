import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- this suite talks to a real, throwaway Postgres; that is its point
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { PaymentsService } from '../payments/payments.service';
import { ReturnsService } from '../returns/returns.service';
import { SettlementsService } from '../settlements/settlements.service';
import { businessToday } from '../../common/dates';
import {
  buildStatement,
  loadStatementSource,
} from '../../common/customer-statement';
import { OrderHistoryService } from './order-history.service';
import { PriceAdjustmentsService } from './price-adjustments.service';
import { SalesService } from './sales.service';

/**
 * Lowering a price after the order is confirmed (BUSINESS_LOGIC §4, owner
 * 2026-10-22) — Koshary's case, and every way to abuse it (CLAUDE.md §0, §1).
 * One shop, one product sold from two cycles' batches, a payment and a return
 * before the price is lowered, as it happened.
 *
 * Runs only against a THROWAWAY database (CLAUDE.md rule 6):
 *
 *   INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/motorcycle_parts_<name> \
 *     npx jest price-adjustment.db
 */
// eslint-disable-next-line no-restricted-properties -- an opt-in switch for a suite that must never run by default
const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;

const daysAgo = (n: number) => {
  const d = new Date(`${businessToday()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof HttpException)) throw e;
    const body = e.getResponse() as {
      code?: string;
      params?: Record<string, unknown>;
    };
    return { status: e.getStatus(), code: body.code, params: body.params };
  }
  throw new Error('expected a refusal');
}

suite('lowering a price after the order is confirmed (Postgres)', () => {
  let prisma: PrismaClient;
  let sales: SalesService;
  let payments: PaymentsService;
  let returns: ReturnsService;
  let adjust: PriceAdjustmentsService;
  let history: OrderHistoryService;
  let analytics: AnalyticsService;
  let settlements: SettlementsService;
  let partner: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const db = prisma as unknown as PrismaService;
    const audit = {
      log: (row: Record<string, unknown>) =>
        prisma.auditLog.create({ data: row as never }),
    } as unknown as AuditService;
    payments = new PaymentsService(db, audit);
    sales = new SalesService(db, audit, payments, {
      createForMultipleUsers: () => Promise.resolve({ count: 0 }),
    });
    returns = new ReturnsService(db, audit);
    adjust = new PriceAdjustmentsService(db, audit);
    history = new OrderHistoryService(db);
    analytics = new AnalyticsService(db);
    settlements = new SettlementsService(db, audit);
    const user = await prisma.user.create({
      data: {
        email: `adjust-${randomUUID()}@example.com`,
        passwordHash: 'x',
        role: 'CORE_PARTNER',
      },
    });
    partner = user.id;
  });
  afterAll(() => prisma.$disconnect());

  /** A selling cycle, funded by the partner, holding `qty` of the product. */
  async function cycleWith(
    productId: string,
    qty: number,
    cost: number,
    ageDays: number,
  ) {
    const tag = randomUUID().slice(0, 8);
    const cycle = await prisma.importCycle.create({
      data: {
        code: `ADJ-${tag}`,
        originType: 'UAE_DIRECT',
        currency: 'EGP',
        status: 'SELLING',
      },
    });
    await prisma.cycleParticipant.create({
      data: {
        cycleId: cycle.id,
        participantType: 'CORE_PARTNER',
        partnerUserId: partner,
        contributionAmount: 10_000,
      },
    });
    await prisma.inventoryBatch.create({
      data: {
        cycleId: cycle.id,
        productId,
        receivedQty: qty,
        remainingQty: qty,
        saleableQty: qty,
        landedUnitCostEgp: cost,
        verificationStatus: 'VERIFIED',
        createdAt: new Date(Date.now() - ageDays * 86_400_000),
      },
    });
    return cycle;
  }

  /**
   * Koshary, as it stood: 10 sold at 1,250 three days ago — 6 from the older
   * cycle's batch, 4 from the newer — 5,000 paid, and 2 handed back on a
   * credit note (from the newer batch, the last to leave). Owes 5,000.
   */
  async function koshary(extraLine = false) {
    const tag = randomUUID().slice(0, 8);
    const product = await prisma.product.create({
      data: { sku: `ADJ-${tag}`, name: `Q58 ${tag}`, status: 'ACTIVE' },
    });
    const older = await cycleWith(product.id, 6, 900, 6);
    const newer = await cycleWith(product.id, 4, 950, 5);
    let second: { id: string } | null = null;
    if (extraLine) {
      second = await prisma.product.create({
        data: { sku: `ADJ2-${tag}`, name: `Y20 ${tag}`, status: 'ACTIVE' },
      });
      await cycleWith(second.id, 2, 500, 5);
    }
    const shop = await prisma.customer.create({
      data: {
        type: 'B2B',
        displayName: `Koshary ${tag}`,
        verificationStatus: 'VERIFIED',
      },
    });
    const created = await sales.create(
      {
        customerId: shop.id,
        channel: 'B2B',
        currency: 'EGP',
        orderedOn: daysAgo(3),
        items: [
          { productId: product.id, quantity: 10, unitPrice: 1250 },
          ...(second
            ? [{ productId: second.id, quantity: 2, unitPrice: 1000 }]
            : []),
        ],
        confirm: true,
      },
      partner,
    );
    const orderId = (created as { data: { id: string } }).data.id;
    await payments.create(
      {
        customerId: shop.id,
        amount: 5000,
        currency: 'EGP',
        method: 'CASH',
        receivedOn: daysAgo(3),
        orderId,
      },
      partner,
    );
    const order = await prisma.saleOrder.findUniqueOrThrow({
      where: { id: orderId },
      include: { items: { include: { product: true } } },
    });
    const line = order.items.find((i) => i.productId === product.id)!;
    await returns.create(
      {
        saleOrderId: orderId,
        reason: 'Two came back',
        returnedOn: daysAgo(2),
        refundMethod: 'CREDIT_NOTE',
        items: [{ saleItemId: line.id, qty: 2 }],
      } as never,
      partner,
    );
    return {
      shop,
      orderId,
      line,
      secondLine: order.items.find((i) => i.productId === second?.id),
      older,
      newer,
    };
  }

  const outstanding = async (id: string) =>
    (
      await prisma.saleOrder.findUniqueOrThrow({ where: { id } })
    ).outstanding.toFixed(2);
  const salesOn = async (day: string) =>
    (await analytics.getProfitAndLoss(day, day)).data.salesEgp;
  const cycleRevenue = async (cycleId: string) =>
    (await settlements.project(cycleId))!.pnl.revenue.toFixed(2);

  it('Koshary: 100 off the 8 he holds — 800 off what he owes, the revenue gone on the adjustment’s day, split by the cycles the units came from', async () => {
    const k = await koshary();
    expect(await outstanding(k.orderId)).toBe('5000.00');
    const day = daysAgo(1);
    const [orderDayBefore, dayBefore, olderBefore, newerBefore] = [
      await salesOn(daysAgo(3)),
      await salesOn(day),
      await cycleRevenue(k.older.id),
      await cycleRevenue(k.newer.id),
    ];

    const preview = await adjust.preview(k.orderId, {
      saleItemId: k.line.id,
      newUnitPrice: 1150,
      adjustedOn: day,
    });
    expect(preview.data).toMatchObject({
      previousUnitPrice: '1250.00',
      newUnitPrice: '1150.00',
      qty: '8',
      amountEgp: '800.00',
      owedBefore: '5000.00',
      owedAfter: '4200.00',
    });
    // The preview writes nothing.
    expect(await outstanding(k.orderId)).toBe('5000.00');
    expect(
      await prisma.salePriceAdjustment.count({
        where: { saleOrderId: k.orderId },
      }),
    ).toBe(0);

    await adjust.create(
      k.orderId,
      {
        saleItemId: k.line.id,
        newUnitPrice: 1150,
        adjustedOn: day,
        reason: 'Koshary discount',
      },
      partner,
    );
    expect(await outstanding(k.orderId)).toBe('4200.00');
    const order = await prisma.saleOrder.findUniqueOrThrow({
      where: { id: k.orderId },
    });
    // The sale keeps saying what it said: its total and the line's price stand.
    expect(order.total.toFixed(2)).toBe('12500.00');
    expect(order.status).toBe('PARTIALLY_PAID');
    const line = await prisma.saleItem.findUniqueOrThrow({
      where: { id: k.line.id },
    });
    expect(line.unitPrice.toFixed(2)).toBe('1250.00');

    // Per batch: the 2 returned came off the newer one, so it holds 2, the older 6.
    const stored = await prisma.salePriceAdjustment.findFirstOrThrow({
      where: { saleOrderId: k.orderId },
      include: { items: { include: { inventoryBatch: true } } },
    });
    const byCycle = Object.fromEntries(
      stored.items.map((i) => [
        i.inventoryBatch.cycleId,
        [i.qty.toString(), i.amountEgp.toFixed(2)],
      ]),
    );
    expect(byCycle).toEqual({
      [k.older.id]: ['6', '600.00'],
      [k.newer.id]: ['2', '200.00'],
    });

    // Revenue: down 800 on the adjustment's day, the sale's own day untouched.
    expect(await salesOn(daysAgo(3))).toBe(orderDayBefore);
    expect(Number((await salesOn(day)) - dayBefore).toFixed(2)).toBe('-800.00');
    // Each cycle loses its own units' share, nothing more.
    expect(
      (Number(await cycleRevenue(k.older.id)) - Number(olderBefore)).toFixed(2),
    ).toBe('-600.00');
    expect(
      (Number(await cycleRevenue(k.newer.id)) - Number(newerBefore)).toFixed(2),
    ).toBe('-200.00');
  });

  it('the second time: the same price again is refused (a double click lowers once), and a later, lower one starts from 1,150', async () => {
    const k = await koshary();
    const body = { saleItemId: k.line.id, newUnitPrice: 1150 };
    await adjust.create(k.orderId, body, partner);
    const again = await refusal(adjust.create(k.orderId, body, partner));
    expect(again.code).toBe('PRICE_ADJUSTMENT_NOT_LOWER');
    expect(again.params).toMatchObject({ current: '1150.00' });
    expect(await outstanding(k.orderId)).toBe('4200.00');

    const second = await adjust.create(
      k.orderId,
      { saleItemId: k.line.id, newUnitPrice: 1100 },
      partner,
    );
    expect(second.data).toMatchObject({
      previousUnitPrice: '1150.00',
      amountEgp: '400.00',
      owedAfter: '3800.00',
    });
  });

  it('five sent at once: one lowers the price, the others are refused — the order is lowered once', async () => {
    const k = await koshary();
    const body = { saleItemId: k.line.id, newUnitPrice: 1150 };
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => adjust.create(k.orderId, body, partner)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      await prisma.salePriceAdjustment.count({
        where: { saleOrderId: k.orderId },
      }),
    ).toBe(1);
    expect(await outstanding(k.orderId)).toBe('4200.00');
  });

  it('a unit handed back after the price was lowered is refunded at the lower price, and nets to nothing in its cycle', async () => {
    const k = await koshary();
    await adjust.create(
      k.orderId,
      { saleItemId: k.line.id, newUnitPrice: 1150 },
      partner,
    );
    const olderBefore = await cycleRevenue(k.older.id);
    const newerBefore = await cycleRevenue(k.newer.id);
    const back = await returns.create(
      {
        saleOrderId: k.orderId,
        reason: 'One more',
        refundMethod: 'CREDIT_NOTE',
        items: [{ saleItemId: k.line.id, qty: 1 }],
      } as never,
      partner,
    );
    expect(back.data!.refundEgp.toFixed(2)).toBe('1150.00');
    expect(await outstanding(k.orderId)).toBe('3050.00');
    // It came off the newer batch: that cycle loses the unit at 1,150, the other nothing.
    expect(
      (Number(await cycleRevenue(k.newer.id)) - Number(newerBefore)).toFixed(2),
    ).toBe('-1150.00');
    expect(await cycleRevenue(k.older.id)).toBe(olderBefore);
  });

  it('the statement shows the lower price on its day, and closes on what the order owes', async () => {
    const k = await koshary();
    await adjust.create(
      k.orderId,
      { saleItemId: k.line.id, newUnitPrice: 1150, adjustedOn: daysAgo(1) },
      partner,
    );
    const statement = buildStatement(
      { id: k.shop.id, displayName: k.shop.displayName, phone: null },
      await loadStatementSource(prisma, k.shop.id),
    );
    const row = statement.rows.find((r) => r.kind === 'ADJUSTMENT');
    expect(row).toMatchObject({
      date: daysAgo(1),
      amount: '800.00',
      effect: '-800.00',
    });
    expect(statement.closingBalance).toBe('4200.00');
  });

  it('the order’s history: started with, returned, paid, price lowered — each with what it owed after, ending on its outstanding', async () => {
    const k = await koshary();
    await adjust.create(
      k.orderId,
      { saleItemId: k.line.id, newUnitPrice: 1150, adjustedOn: daysAgo(1) },
      partner,
    );
    const h = (await history.history(k.orderId)).data;
    expect(h.events.map((e) => [e.kind, e.owes])).toEqual([
      ['CREATED', '0.00'],
      ['CONFIRMED', '12500.00'],
      ['PAYMENT', '7500.00'],
      ['RETURN', '5000.00'],
      ['PRICE_ADJUSTED', '4200.00'],
    ]);
    expect(h.owes).toBe('4200.00');
    expect(h.replayedOwes).toBe(h.owes);
    const adjusted = h.events.find((e) => e.kind === 'PRICE_ADJUSTED')!;
    expect(adjusted.by).toBeTruthy();
    expect(adjusted.lines?.[0]).toMatchObject({
      qty: '8',
      previousUnitPrice: '1250.00',
      unitPrice: '1150.00',
    });
    expect(h.products[0]).toMatchObject({
      startedWith: '10',
      returned: '2',
      holds: '8',
      soldAt: '1250.00',
      priceNow: '1150.00',
    });
  });

  it('limits: higher, the same, negative, not a number — each refused with its code, nothing written', async () => {
    const k = await koshary();
    for (const [newUnitPrice, code] of [
      [1300, 'PRICE_ADJUSTMENT_NOT_LOWER'],
      [1250, 'PRICE_ADJUSTMENT_NOT_LOWER'],
      [-1, 'PRICE_ADJUSTMENT_BAD_PRICE'],
      ['abc', 'PRICE_ADJUSTMENT_BAD_PRICE'],
      [undefined, 'PRICE_ADJUSTMENT_BAD_PRICE'],
    ] as const) {
      const r = await refusal(
        adjust.create(
          k.orderId,
          { saleItemId: k.line.id, newUnitPrice },
          partner,
        ),
      );
      expect([String(newUnitPrice), r.code]).toEqual([
        String(newUnitPrice),
        code,
      ]);
    }
    expect(
      await prisma.salePriceAdjustment.count({
        where: { saleOrderId: k.orderId },
      }),
    ).toBe(0);
    expect(await outstanding(k.orderId)).toBe('5000.00');
  });

  it('more off than is owed is a refund, not a price change: refused; exactly what is owed is accepted and leaves it paid up', async () => {
    const k = await koshary();
    // 8 held: down to 500 takes 6,000 off a 5,000 balance.
    const over = await refusal(
      adjust.create(
        k.orderId,
        { saleItemId: k.line.id, newUnitPrice: 500 },
        partner,
      ),
    );
    expect(over).toMatchObject({
      code: 'PRICE_ADJUSTMENT_EXCEEDS_OWED',
      params: { amount: '6000.00', owed: '5000.00' },
    });
    // Down to 625 takes 5,000 exactly.
    await adjust.create(
      k.orderId,
      { saleItemId: k.line.id, newUnitPrice: 625 },
      partner,
    );
    const order = await prisma.saleOrder.findUniqueOrThrow({
      where: { id: k.orderId },
    });
    expect(order.outstanding.toFixed(2)).toBe('0.00');
    expect(order.status).toBe('PAID');
    // Paid up: nothing more can come off.
    expect(
      (
        await refusal(
          adjust.create(
            k.orderId,
            { saleItemId: k.line.id, newUnitPrice: 600 },
            partner,
          ),
        )
      ).code,
    ).toBe('PRICE_ADJUSTMENT_ORDER_NOT_OPEN');
  });

  it('dates: not in the future, not before the sale', async () => {
    const k = await koshary();
    const tomorrow = new Date(`${businessToday()}T00:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    expect(
      (
        await refusal(
          adjust.create(
            k.orderId,
            {
              saleItemId: k.line.id,
              newUnitPrice: 1150,
              adjustedOn: tomorrow.toISOString().slice(0, 10),
            },
            partner,
          ),
        )
      ).code,
    ).toBe('DATE_IN_FUTURE');
    expect(
      (
        await refusal(
          adjust.create(
            k.orderId,
            {
              saleItemId: k.line.id,
              newUnitPrice: 1150,
              adjustedOn: daysAgo(4),
            },
            partner,
          ),
        )
      ).code,
    ).toBe('PRICE_ADJUSTMENT_BEFORE_SALE');
    expect(
      (
        await refusal(
          adjust.create(
            k.orderId,
            {
              saleItemId: k.line.id,
              newUnitPrice: 1150,
              adjustedOn: '2026-02-30',
            },
            partner,
          ),
        )
      ).code,
    ).toBe('BAD_DATE');
  });

  it('the wrong context: another order’s line, an order that does not exist, a line fully returned', async () => {
    const a = await koshary(true);
    const b = await koshary();
    expect(
      (
        await refusal(
          adjust.create(
            a.orderId,
            { saleItemId: b.line.id, newUnitPrice: 1000 },
            partner,
          ),
        )
      ).code,
    ).toBe('SALE_ITEM_NOT_IN_ORDER');
    expect(
      (
        await refusal(
          adjust.create(
            randomUUID(),
            { saleItemId: a.line.id, newUnitPrice: 1000 },
            partner,
          ),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await refusal(
          adjust.create(
            'not-a-uuid',
            { saleItemId: a.line.id, newUnitPrice: 1000 },
            partner,
          ),
        )
      ).status,
    ).toBe(404);

    await returns.create(
      {
        saleOrderId: a.orderId,
        reason: 'All of them',
        refundMethod: 'CREDIT_NOTE',
        items: [{ saleItemId: a.secondLine!.id, qty: 2 }],
      } as never,
      partner,
    );
    expect(
      (
        await refusal(
          adjust.create(
            a.orderId,
            { saleItemId: a.secondLine!.id, newUnitPrice: 900 },
            partner,
          ),
        )
      ).code,
    ).toBe('PRICE_ADJUSTMENT_NOTHING_HELD');
  });

  it('not on a draft, a cancelled order, an order under contract, or units from a cycle being settled', async () => {
    const k = await koshary();
    const shop = k.shop;
    const product = await prisma.product.findUniqueOrThrow({
      where: { id: k.line.productId },
    });
    const draft = await sales.create(
      {
        customerId: shop.id,
        channel: 'B2B',
        currency: 'EGP',
        items: [{ productId: product.id, quantity: 1, unitPrice: 1250 }],
      },
      partner,
    );
    const draftOrder = await prisma.saleOrder.findUniqueOrThrow({
      where: { id: (draft as { data: { id: string } }).data.id },
      include: { items: true },
    });
    expect(
      (
        await refusal(
          adjust.create(
            draftOrder.id,
            { saleItemId: draftOrder.items[0].id, newUnitPrice: 1000 },
            partner,
          ),
        )
      ).code,
    ).toBe('PRICE_ADJUSTMENT_ORDER_NOT_OPEN');

    const plan = await prisma.paymentPlan.create({
      data: {
        customerId: shop.id,
        reference: `PLAN-${randomUUID().slice(0, 8)}`,
        totalEgp: 5000,
        agreedOn: new Date(),
        saleOrderId: k.orderId,
      },
    });
    expect(
      (
        await refusal(
          adjust.create(
            k.orderId,
            { saleItemId: k.line.id, newUnitPrice: 1150 },
            partner,
          ),
        )
      ).code,
    ).toBe('PRICE_ADJUSTMENT_UNDER_CONTRACT');
    await prisma.paymentPlan.update({
      where: { id: plan.id },
      data: { status: 'CANCELLED' },
    });

    await prisma.importCycle.update({
      where: { id: k.newer.id },
      data: { status: 'SETTLEMENT' },
    });
    expect(
      (
        await refusal(
          adjust.create(
            k.orderId,
            { saleItemId: k.line.id, newUnitPrice: 1150 },
            partner,
          ),
        )
      ).code,
    ).toBe('PRICE_ADJUSTMENT_CYCLE_SETTLED');
    await prisma.importCycle.update({
      where: { id: k.newer.id },
      data: { status: 'SELLING' },
    });
    // With both lifted it goes through.
    await adjust.create(
      k.orderId,
      { saleItemId: k.line.id, newUnitPrice: 1150 },
      partner,
    );
    expect(await outstanding(k.orderId)).toBe('4200.00');
  });
});
