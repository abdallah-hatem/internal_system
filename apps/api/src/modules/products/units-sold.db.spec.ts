import { randomUUID } from 'crypto';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- this suite talks to a real, throwaway Postgres; that is its point
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { PaymentsService } from '../payments/payments.service';
import { ReturnsService } from '../returns/returns.service';
import { PriceAdjustmentsService } from '../sales/price-adjustments.service';
import { SalesService } from '../sales/sales.service';
import { businessToday } from '../../common/dates';
import { ProductsService } from './products.service';

/**
 * A product page's Units sold card (BUSINESS_LOGIC §3, owner 2026-10-26):
 * units on confirmed, partly paid and paid sales, less units returned. Not
 * drafts, not cancelled orders, not samples still at a shop — they count once
 * "They're buying" makes them a sale. A price cut changes no unit. The same
 * figure the analytics top products show for the product (CLAUDE.md §11).
 *
 * Every state is reached through the services, the way the office makes it
 * (CLAUDE.md §4), and the figure is read after each step.
 *
 * Runs only against a THROWAWAY database (CLAUDE.md rule 6):
 *
 *   INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/motorcycle_parts_<name> \
 *     npx jest units-sold.db
 */
// eslint-disable-next-line no-restricted-properties -- an opt-in switch for a suite that must never run by default
const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;

const daysAgo = (n: number) => {
  const d = new Date(`${businessToday()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

suite('units sold on a product page (Postgres)', () => {
  let prisma: PrismaClient;
  let sales: SalesService;
  let payments: PaymentsService;
  let returns: ReturnsService;
  let adjust: PriceAdjustmentsService;
  let analytics: AnalyticsService;
  let products: ProductsService;
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
    analytics = new AnalyticsService(db);
    products = new ProductsService(db, audit, {} as never);
    const user = await prisma.user.create({
      data: {
        email: `units-sold-${randomUUID()}@example.com`,
        passwordHash: 'x',
        role: 'CORE_PARTNER',
      },
    });
    partner = user.id;
  });
  afterAll(() => prisma.$disconnect());

  /** An active product with `qty` on a verified batch of a selling cycle. */
  async function stocked(qty: number) {
    const tag = randomUUID().slice(0, 8);
    const product = await prisma.product.create({
      data: { sku: `UNS-${tag}`, name: `Units ${tag}`, status: 'ACTIVE' },
    });
    const cycle = await prisma.importCycle.create({
      data: {
        code: `UNS-${tag}`,
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
        productId: product.id,
        receivedQty: qty,
        remainingQty: qty,
        saleableQty: qty,
        landedUnitCostEgp: 50,
        verificationStatus: 'VERIFIED',
        createdAt: new Date(Date.now() - 10 * 86_400_000),
      },
    });
    const shop = await prisma.customer.create({
      data: {
        type: 'B2B',
        displayName: `Shop ${tag}`,
        verificationStatus: 'VERIFIED',
      },
    });
    return { product, shop };
  }

  /** An order of `quantity` at 100 each; confirmed unless `confirm` is false. */
  async function sell(
    shopId: string,
    productId: string,
    quantity: number,
    opts: { confirm?: boolean; samples?: boolean } = {},
  ) {
    const made = (await sales.create(
      {
        customerId: shopId,
        channel: 'B2B',
        currency: 'EGP',
        orderedOn: daysAgo(3),
        items: [{ productId, quantity, unitPrice: 100 }],
        ...(opts.samples
          ? { samples: true }
          : { confirm: opts.confirm ?? true }),
      },
      partner,
    )) as { data: { id: string; status: string } };
    return made.data.id;
  }

  const pay = (shopId: string, orderId: string, amount: number) =>
    payments.create(
      {
        customerId: shopId,
        amount,
        currency: 'EGP',
        method: 'CASH',
        receivedOn: daysAgo(2),
        orderId,
      },
      partner,
    );

  const lineOf = async (orderId: string) =>
    (
      await prisma.saleItem.findFirstOrThrow({
        where: { saleOrderId: orderId },
      })
    ).id;

  const giveBack = async (
    orderId: string,
    qty: number,
    refundMethod: 'CREDIT_NOTE' | 'CASH',
  ) =>
    returns.create(
      {
        saleOrderId: orderId,
        reason: 'Came back',
        returnedOn: daysAgo(1),
        refundMethod,
        items: [{ saleItemId: await lineOf(orderId), qty }],
      },
      partner,
    );

  const status = async (id: string) =>
    (await prisma.saleOrder.findUniqueOrThrow({ where: { id } })).status;

  /** What the product page receives. */
  const card = async (productId: string) => {
    const { data } = (await products.findById(productId)) as {
      data: { unitsSold?: number; unitsSoldOrders?: number };
    };
    return { units: data.unitsSold, orders: data.unitsSoldOrders };
  };

  /** What the analytics top products say for the same product. */
  const topUnits = async (productId: string) =>
    (await analytics.getTopProducts(100_000, 'units')).data.find(
      (p) => p.productId === productId,
    )?.totalQuantitySold;

  it('counts confirmed, partly paid and paid sales; never a draft, a cancelled order or samples still out; a converted samples order counts; both kinds of return subtract; a price cut changes nothing — and agrees with the top products', async () => {
    const { product, shop } = await stocked(100);
    expect(await card(product.id)).toEqual({ units: 0, orders: 0 });

    // Confirmed, nothing paid: 5.
    const confirmed = await sell(shop.id, product.id, 5);
    expect(await status(confirmed)).toBe('CONFIRMED');
    expect(await card(product.id)).toEqual({ units: 5, orders: 1 });

    // Paid in full: 3 more.
    const paid = await sell(shop.id, product.id, 3);
    await pay(shop.id, paid, 300);
    expect(await status(paid)).toBe('PAID');
    expect(await card(product.id)).toEqual({ units: 8, orders: 2 });

    // Partly paid: 4 more.
    const partly = await sell(shop.id, product.id, 4);
    await pay(shop.id, partly, 100);
    expect(await status(partly)).toBe('PARTIALLY_PAID');
    expect(await card(product.id)).toEqual({ units: 12, orders: 3 });

    // A draft is a quote: nothing sold.
    const draft = await sell(shop.id, product.id, 20, { confirm: false });
    expect(await status(draft)).toBe('DRAFT');
    expect(await card(product.id)).toEqual({ units: 12, orders: 3 });

    // Confirmed, then cancelled: nothing sold.
    const cancelled = await sell(shop.id, product.id, 7);
    expect(await card(product.id)).toEqual({ units: 19, orders: 4 });
    await sales.cancelOrder(cancelled, partner);
    expect(await status(cancelled)).toBe('CANCELLED');
    expect(await card(product.id)).toEqual({ units: 12, orders: 3 });

    // Samples still at a shop are off the shelf but not sold.
    const out = await sell(shop.id, product.id, 6, { samples: true });
    expect(await status(out)).toBe('SAMPLES');
    expect(await card(product.id)).toEqual({ units: 12, orders: 3 });

    // Samples the shop is buying: what they keep is sold, from that day.
    const kept = await sell(shop.id, product.id, 4, { samples: true });
    await sales.convertSamples(
      kept,
      { items: [{ productId: product.id, quantity: 2, unitPrice: 100 }] },
      partner,
    );
    expect(await status(kept)).toBe('CONFIRMED');
    expect(await card(product.id)).toEqual({ units: 14, orders: 4 });

    // A credit-note return of 2 off the confirmed order.
    await giveBack(confirmed, 2, 'CREDIT_NOTE');
    expect(await card(product.id)).toEqual({ units: 12, orders: 4 });

    // A cash return of 1 off the paid order.
    await giveBack(paid, 1, 'CASH');
    expect(await card(product.id)).toEqual({ units: 11, orders: 4 });

    // A price cut on the partly paid order: the units are what they were.
    await adjust.create(
      partly,
      {
        saleItemId: await lineOf(partly),
        newUnitPrice: 80,
        adjustedOn: daysAgo(1),
        reason: 'Cheaper now',
      },
      partner,
    );
    expect(await card(product.id)).toEqual({ units: 11, orders: 4 });

    // Every unit of the converted order handed back: it sold nothing, and is
    // no longer one of the orders.
    await giveBack(kept, 2, 'CREDIT_NOTE');
    expect(await card(product.id)).toEqual({ units: 9, orders: 3 });

    // 5 − 2 + 3 − 1 + 4 + 2 − 2 = 9, as the analytics top products count it.
    expect(await topUnits(product.id)).toBe(9);
  });

  it('another product’s sales are not this product’s', async () => {
    const a = await stocked(10);
    const b = await stocked(10);
    await sell(a.shop.id, a.product.id, 4);
    expect(await card(b.product.id)).toEqual({ units: 0, orders: 0 });
    expect(await card(a.product.id)).toEqual({ units: 4, orders: 1 });
  });

  it('an investor’s view of the catalogue carries no sales figure', async () => {
    const { product, shop } = await stocked(10);
    await sell(shop.id, product.id, 4);
    const investor = await prisma.user.create({
      data: {
        email: `investor-${randomUUID()}@example.com`,
        passwordHash: 'x',
        role: 'TEMP_INVESTOR',
      },
    });
    const { data } = (await products.findById(product.id, {
      id: investor.id,
      role: 'TEMP_INVESTOR',
    })) as { data: Record<string, unknown> };
    expect(data).not.toHaveProperty('unitsSold');
    expect(data).not.toHaveProperty('unitsSoldOrders');
  });
});
