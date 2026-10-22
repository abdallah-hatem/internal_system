import { randomUUID } from 'crypto';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- this suite talks to a real, throwaway Postgres; that is its point
import { Prisma, PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import { CustomersService } from '../customers/customers.service';
import type { PaymentPlansService } from '../payment-plans/payment-plans.service';
import { PaymentsService } from '../payments/payments.service';
import { ReturnsService } from '../returns/returns.service';
import { businessToday } from '../../common/dates';
import { OWED_STATUSES } from '../../common/customer-balance';
import { OrderHistoryService } from './order-history.service';
import { PriceAdjustmentsService } from './price-adjustments.service';
import { SalesService } from './sales.service';

/**
 * What a sale order is worth now (BUSINESS_LOGIC §4, owner 2026-10-22,
 * Option A), from a real order built the way the business builds one: stock
 * on a selling cycle, a confirmed sale, returns, a price cut, a payment.
 *
 * The figure must agree with what the order already says — its outstanding,
 * and its History's per-product table — for every order:
 *
 *     value now − payments standing + cash refunded = outstanding
 *
 * Runs only against a THROWAWAY database (CLAUDE.md rule 6):
 *
 *   INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/motorcycle_parts_<name> \
 *     npx jest order-value-now.db
 */
// eslint-disable-next-line no-restricted-properties -- an opt-in switch for a suite that must never run by default
const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;

const daysAgo = (n: number) => {
  const d = new Date(`${businessToday()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

interface ShownLine {
  id: string;
  productId: string;
  quantity: Prisma.Decimal.Value;
  lineTotal: Prisma.Decimal.Value;
  returnedQty: string;
  heldQty: string;
  soldUnitPrice: string;
  unitPriceNow: string;
  priceCut: boolean;
  lineValueNow: string;
}
interface ShownOrder {
  id: string;
  total: Prisma.Decimal.Value;
  valueNowEgp: string;
  items: ShownLine[];
}

suite('what a sale order is worth now (Postgres)', () => {
  let prisma: PrismaClient<Prisma.PrismaClientOptions, 'query'>;
  let sales: SalesService;
  let customers: CustomersService;
  let payments: PaymentsService;
  let returns: ReturnsService;
  let adjust: PriceAdjustmentsService;
  let history: OrderHistoryService;
  let partner: string;
  /** Every statement Postgres was sent, while counting. */
  let queries: string[] | null = null;

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url } },
      log: [{ emit: 'event', level: 'query' }],
    });
    prisma.$on('query', (e) => queries?.push(e.query));
    const db = prisma as unknown as PrismaService;
    const audit = {
      log: (row: Record<string, unknown>) =>
        prisma.auditLog.create({ data: row as never }),
    } as unknown as AuditService;
    payments = new PaymentsService(db, audit);
    sales = new SalesService(db, audit, payments, {
      createForMultipleUsers: () => Promise.resolve({ count: 0 }),
    });
    // findById never reaches the plans; the shop's page is what is read here.
    customers = new CustomersService(db, audit, {} as PaymentPlansService);
    returns = new ReturnsService(db, audit);
    adjust = new PriceAdjustmentsService(db, audit);
    history = new OrderHistoryService(db);
    const user = await prisma.user.create({
      data: {
        email: `value-now-${randomUUID()}@example.com`,
        passwordHash: 'x',
        role: 'CORE_PARTNER',
      },
    });
    partner = user.id;
  });
  afterAll(() => prisma.$disconnect());

  /** A selling cycle, funded, holding `qty` of a new product. */
  async function stocked(name: string, qty: number) {
    const tag = randomUUID().slice(0, 8);
    const product = await prisma.product.create({
      data: { sku: `VN-${tag}`, name: `${name} ${tag}`, status: 'ACTIVE' },
    });
    const cycle = await prisma.importCycle.create({
      data: {
        code: `VN-${tag}`,
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
        landedUnitCostEgp: 500,
        verificationStatus: 'VERIFIED',
        // Received a week ago, so a sale three days ago can draw on it.
        createdAt: new Date(Date.now() - 7 * 86_400_000),
      },
    });
    return product;
  }

  async function shop() {
    return prisma.customer.create({
      data: {
        type: 'B2B',
        displayName: `Koshary ${randomUUID().slice(0, 8)}`,
        verificationStatus: 'VERIFIED',
      },
    });
  }

  /** A confirmed sale of `lines` to `customerId`, three days ago. */
  async function sold(
    customerId: string,
    lines: { productId: string; quantity: number; unitPrice: number }[],
  ) {
    const created = await sales.create(
      {
        customerId,
        channel: 'B2B',
        currency: 'EGP',
        orderedOn: daysAgo(3),
        items: lines,
        confirm: true,
      },
      partner,
    );
    const id = (created as { data: { id: string } }).data.id;
    const items = await prisma.saleItem.findMany({
      where: { saleOrderId: id },
    });
    const lineOf = (productId: string) =>
      items.find((i) => i.productId === productId)!.id;
    return { id, lineOf };
  }

  const pay = (customerId: string, orderId: string, amount: number) =>
    payments.create(
      {
        customerId,
        amount,
        currency: 'EGP',
        method: 'CASH',
        receivedOn: daysAgo(2),
        orderId,
      },
      partner,
    );

  const giveBack = (
    saleOrderId: string,
    items: { saleItemId: string; qty: number }[],
    refundMethod: 'CREDIT_NOTE' | 'CASH' = 'CREDIT_NOTE',
  ) =>
    returns.create(
      {
        saleOrderId,
        reason: 'Came back',
        returnedOn: daysAgo(2),
        refundMethod,
        items,
      },
      partner,
    );

  const lower = (saleOrderId: string, saleItemId: string, to: number) =>
    adjust.create(
      saleOrderId,
      { saleItemId, newUnitPrice: to, adjustedOn: daysAgo(1) },
      partner,
    );

  const detail = async (id: string) =>
    (await sales.findById(id)).data as unknown as ShownOrder;
  const listed = async (customerId: string) =>
    (await sales.findAll({ customerId })).data as unknown as ShownOrder[];

  /**
   * The rule the figure must keep: what it is worth now, less the money
   * standing on it, plus any cash handed back, is what the order owes —
   * and its list row, its popup and its shop's page all say the same.
   */
  async function agrees(orderId: string, customerId: string) {
    const order = await prisma.saleOrder.findUniqueOrThrow({
      where: { id: orderId },
      include: {
        paymentAllocations: { include: { payment: true } },
        returns: true,
      },
    });
    const shown = await detail(orderId);
    const row = (await listed(customerId)).find((o) => o.id === orderId)!;
    const onShopPage = (
      (await customers.findById(customerId)).data
        .saleOrders as unknown as ShownOrder[]
    ).find((o) => o.id === orderId)!;
    expect(row.valueNowEgp).toBe(shown.valueNowEgp);
    expect(onShopPage.valueNowEgp).toBe(shown.valueNowEgp);
    expect(row.items.map((i) => i.lineValueNow)).toEqual(
      shown.items.map((i) => i.lineValueNow),
    );

    const standing = order.paymentAllocations
      .filter((a) => a.payment.status !== 'REVERSED')
      .reduce((s, a) => s.add(a.amount), D(0));
    const cashBack = order.returns
      .filter((r) => r.refundMethod === 'CASH')
      .reduce((s, r) => s.add(r.refundEgp), D(0));
    if (
      (OWED_STATUSES as readonly string[]).includes(order.status) ||
      order.status === 'PAID'
    ) {
      expect(D(shown.valueNowEgp).sub(standing).add(cashBack).toFixed(2)).toBe(
        order.outstanding.toFixed(2),
      );
    }
    // Lines add up to the order.
    expect(
      shown.items.reduce((s, i) => s.add(i.lineValueNow), D(0)).toFixed(2),
    ).toBe(shown.valueNowEgp);

    // History's per-product table says the same of every line.
    const h = (await history.history(orderId)).data;
    for (const line of shown.items) {
      const p = h.products.find((x) => x.saleItemId === line.id)!;
      expect([p.returned, p.holds, p.priceNow, p.soldAt]).toEqual([
        line.returnedQty,
        line.heldQty,
        line.unitPriceNow,
        line.soldUnitPrice,
      ]);
    }
    expect(h.replayedOwes).toBe(h.owes);
    return shown;
  }

  it('nothing returned, nothing lowered: worth exactly what was sold', async () => {
    const c = await shop();
    const q = await stocked('Q58', 4);
    const o = await sold(c.id, [
      { productId: q.id, quantity: 4, unitPrice: 1250 },
    ]);
    await pay(c.id, o.id, 1000);
    const shown = await agrees(o.id, c.id);
    expect(shown.valueNowEgp).toBe('5000.00');
    expect(D(shown.total).toFixed(2)).toBe('5000.00');
    expect(shown.items[0]).toMatchObject({
      returnedQty: '0',
      heldQty: '4',
      unitPriceNow: '1250.00',
      priceCut: false,
      lineValueNow: '5000.00',
    });
  });

  it('returns only: worth less by the refund; the total still says what was sold', async () => {
    const c = await shop();
    const q = await stocked('Q58', 4);
    const o = await sold(c.id, [
      { productId: q.id, quantity: 4, unitPrice: 1250 },
    ]);
    await giveBack(o.id, [{ saleItemId: o.lineOf(q.id), qty: 1 }]);
    const shown = await agrees(o.id, c.id);
    expect(D(shown.total).toFixed(2)).toBe('5000.00');
    expect(shown.valueNowEgp).toBe('3750.00');
    expect(shown.items[0]).toMatchObject({
      returnedQty: '1',
      heldQty: '3',
      priceCut: false,
      lineValueNow: '3750.00',
    });
  });

  it('cuts only: worth less by the cut, the line at its new price', async () => {
    const c = await shop();
    const q = await stocked('Q58', 4);
    const o = await sold(c.id, [
      { productId: q.id, quantity: 4, unitPrice: 1250 },
    ]);
    await lower(o.id, o.lineOf(q.id), 1150);
    const shown = await agrees(o.id, c.id);
    expect(shown.valueNowEgp).toBe('4600.00');
    expect(shown.items[0]).toMatchObject({
      soldUnitPrice: '1250.00',
      unitPriceNow: '1150.00',
      priceCut: true,
      lineValueNow: '4600.00',
    });
  });

  it('Koshary (ORD-2026-00002): 30,300 sold, 3,050 back, 5,000 paid, 100 off the 23 held — worth 24,950, owes 19,950', async () => {
    const c = await shop();
    const q58 = await stocked('Q58', 4);
    const y20 = await stocked('Y20', 12);
    const z = await stocked('Z10', 10);
    const o = await sold(c.id, [
      { productId: q58.id, quantity: 4, unitPrice: 1250 },
      { productId: y20.id, quantity: 12, unitPrice: 900 },
      { productId: z.id, quantity: 10, unitPrice: 1450 },
    ]);
    await giveBack(o.id, [{ saleItemId: o.lineOf(q58.id), qty: 1 }]);
    await giveBack(o.id, [{ saleItemId: o.lineOf(y20.id), qty: 2 }]);
    await pay(c.id, o.id, 5000);
    await lower(o.id, o.lineOf(q58.id), 1150);
    await lower(o.id, o.lineOf(y20.id), 800);
    await lower(o.id, o.lineOf(z.id), 1350);

    const shown = await agrees(o.id, c.id);
    expect(D(shown.total).toFixed(2)).toBe('30300.00');
    expect(shown.valueNowEgp).toBe('24950.00');
    const stored = await prisma.saleOrder.findUniqueOrThrow({
      where: { id: o.id },
    });
    expect(stored.outstanding.toFixed(2)).toBe('19950.00');
    expect(shown.items.find((i) => i.productId === q58.id)).toMatchObject({
      returnedQty: '1',
      heldQty: '3',
      soldUnitPrice: '1250.00',
      unitPriceNow: '1150.00',
      priceCut: true,
      lineValueNow: '3450.00',
    });
    expect(
      D(shown.items.find((i) => i.productId === q58.id)!.quantity).toString(),
    ).toBe('4');
  });

  it('a cut, then a cut unit handed back: refunded at the lower price, worth the rest at it', async () => {
    const c = await shop();
    const q = await stocked('Q58', 4);
    const o = await sold(c.id, [
      { productId: q.id, quantity: 4, unitPrice: 1250 },
    ]);
    await lower(o.id, o.lineOf(q.id), 1150);
    const back = await giveBack(o.id, [{ saleItemId: o.lineOf(q.id), qty: 1 }]);
    expect(back.data!.refundEgp.toFixed(2)).toBe('1150.00');
    const shown = await agrees(o.id, c.id);
    expect(shown.valueNowEgp).toBe('3450.00');
    expect(shown.items[0]).toMatchObject({
      heldQty: '3',
      lineValueNow: '3450.00',
    });
  });

  it('everything returned: worth nothing', async () => {
    const c = await shop();
    const q = await stocked('Q58', 2);
    const o = await sold(c.id, [
      { productId: q.id, quantity: 2, unitPrice: 500 },
    ]);
    await giveBack(o.id, [{ saleItemId: o.lineOf(q.id), qty: 2 }]);
    const shown = await agrees(o.id, c.id);
    expect(
      (await prisma.saleOrder.findUniqueOrThrow({ where: { id: o.id } }))
        .status,
    ).toBe('RETURNED');
    expect(shown.valueNowEgp).toBe('0.00');
  });

  it('a cash refund: worth less, owes the same — the cash went back to the shop instead', async () => {
    const c = await shop();
    const q = await stocked('Q58', 4);
    const o = await sold(c.id, [
      { productId: q.id, quantity: 4, unitPrice: 1250 },
    ]);
    await pay(c.id, o.id, 2500);
    await giveBack(o.id, [{ saleItemId: o.lineOf(q.id), qty: 1 }], 'CASH');
    const shown = await agrees(o.id, c.id);
    expect(shown.valueNowEgp).toBe('3750.00');
    expect(
      (
        await prisma.saleOrder.findUniqueOrThrow({ where: { id: o.id } })
      ).outstanding.toFixed(2),
    ).toBe('2500.00');
  });

  it('the second cut: the later price is the price now, “sold at” stays 1,250', async () => {
    const c = await shop();
    const q = await stocked('Q58', 4);
    const o = await sold(c.id, [
      { productId: q.id, quantity: 4, unitPrice: 1250 },
    ]);
    await lower(o.id, o.lineOf(q.id), 1150);
    await lower(o.id, o.lineOf(q.id), 1100);
    const shown = await agrees(o.id, c.id);
    expect(shown.items[0]).toMatchObject({
      soldUnitPrice: '1250.00',
      unitPriceNow: '1100.00',
      lineValueNow: '4400.00',
    });
    expect(shown.valueNowEgp).toBe('4400.00');
  });

  it('the list asks Postgres the same number of times for one order as for six: no query per row', async () => {
    const one = await shop();
    const six = await shop();
    const q = await stocked('Q58', 20);
    const first = await sold(one.id, [
      { productId: q.id, quantity: 1, unitPrice: 1250 },
    ]);
    await giveBack(first.id, [{ saleItemId: first.lineOf(q.id), qty: 1 }]);
    for (let i = 0; i < 6; i++) {
      const o = await sold(six.id, [
        { productId: q.id, quantity: 2, unitPrice: 1250 },
      ]);
      await giveBack(o.id, [{ saleItemId: o.lineOf(q.id), qty: 1 }]);
      await lower(o.id, o.lineOf(q.id), 1000 + i);
    }

    const count = async (customerId: string) => {
      queries = [];
      const rows = await listed(customerId);
      const n = queries.length;
      queries = null;
      return { n, rows };
    };
    const a = await count(one.id);
    const b = await count(six.id);
    expect(a.rows).toHaveLength(1);
    expect(b.rows).toHaveLength(6);
    expect(b.n).toBe(a.n);
    // And every row carries its own figure: 1 of 2 back, the other at its cut.
    expect(b.rows.map((r) => r.valueNowEgp).sort()).toEqual(
      [1000, 1001, 1002, 1003, 1004, 1005].map((p) => p.toFixed(2)),
    );
  });
});
