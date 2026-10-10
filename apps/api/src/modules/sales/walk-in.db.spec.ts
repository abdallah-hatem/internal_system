import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- this suite talks to a real, throwaway Postgres; that is its point
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { CustomersService } from '../customers/customers.service';
import { PaymentsService } from '../payments/payments.service';
import { ReturnsService } from '../returns/returns.service';
import { SalesService, type CreateSaleOrderInput } from './sales.service';

/**
 * Walk-in sales against a real Postgres (plan W1, BUSINESS_LOGIC §4,
 * DECIDED 2026-10-11): one transaction, the partial unique index, the payment
 * and the return, which an in-memory fake cannot prove.
 *
 * Runs only when INTEGRATION_DATABASE_URL points at a THROWAWAY database with
 * the migrations applied — never the dev database (CLAUDE.md rule 6):
 *
 *   docker run -d --name w1_scratch -p 55471:5432 -e POSTGRES_PASSWORD=scratch \
 *     -e POSTGRES_DB=w1scratch --tmpfs /var/lib/postgresql/data postgres:16
 *   DATABASE_URL=postgresql://postgres:scratch@localhost:55471/w1scratch npx prisma migrate deploy
 *   INTEGRATION_DATABASE_URL=postgresql://postgres:scratch@localhost:55471/w1scratch \
 *     npx jest walk-in.db
 *
 * The first two tests need a database without the walk-in record; each starts
 * by un-flagging any left from an earlier run, so the suite can run again.
 */
// eslint-disable-next-line no-restricted-properties -- an opt-in switch for a suite that must never run by default
const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('walk-in sales against Postgres', () => {
  let prisma: PrismaClient;
  let sales: SalesService;
  let customers: CustomersService;
  let returns: ReturnsService;
  let analytics: AnalyticsService;
  let actor: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const db = prisma as unknown as PrismaService;
    const audit = { log: jest.fn() } as unknown as AuditService;
    sales = new SalesService(db, audit, new PaymentsService(db, audit));
    customers = new CustomersService(db, audit);
    returns = new ReturnsService(db, audit);
    analytics = new AnalyticsService(db);
    const user = await prisma.user.create({
      data: {
        email: `w1-${randomUUID()}@example.com`,
        passwordHash: 'x',
        role: 'CORE_PARTNER',
      },
    });
    actor = user.id;
  });
  afterAll(() => prisma.$disconnect());

  /** Forget any walk-in record an earlier test or run made. */
  async function noWalkInRecord() {
    await prisma.customer.updateMany({
      where: { isWalkIn: true },
      data: { isWalkIn: false, displayName: 'Walk-in (earlier run)' },
    });
  }

  /**
   * A product with `qty` units received and verified on a selling cycle, at a
   * landed cost of 100 — stock as a verified receipt leaves it.
   */
  async function stocked(qty: number) {
    const tag = randomUUID().slice(0, 8);
    const product = await prisma.product.create({
      data: { sku: `W1-${tag}`, name: `Walk-in part ${tag}` },
    });
    const cycle = await prisma.importCycle.create({
      data: {
        code: `W1-${tag}`,
        originType: 'UAE_DIRECT',
        currency: 'EGP',
        status: 'SELLING',
      },
    });
    await prisma.inventoryBatch.create({
      data: {
        cycleId: cycle.id,
        productId: product.id,
        receivedQty: qty,
        remainingQty: qty,
        saleableQty: qty,
        landedUnitCostEgp: 100,
        verificationStatus: 'VERIFIED',
      },
    });
    return product;
  }

  const onShelf = async (productId: string) =>
    Number(
      (
        await prisma.inventoryBatch.aggregate({
          where: { productId },
          _sum: { saleableQty: true },
        })
      )._sum.saleableQty,
    );

  const walkIn = (
    productId: string,
    quantity: number,
    extra: Partial<CreateSaleOrderInput> & { discount?: number } = {},
  ): CreateSaleOrderInput => {
    const { discount, ...rest } = extra;
    return {
      walkIn: true,
      currency: 'EGP',
      items: [{ productId, quantity, unitPrice: 450, discount }],
      ...rest,
    } as CreateSaleOrderInput;
  };

  async function refusal(p: Promise<unknown>) {
    try {
      await p;
    } catch (e) {
      if (!(e instanceof HttpException)) throw e;
      return (e.getResponse() as { code: string }).code;
    }
    throw new Error('expected a refusal, got success');
  }

  const ordersOf = (productId: string) =>
    prisma.saleOrder.findMany({
      where: { items: { some: { productId } } },
      include: { paymentAllocations: { include: { payment: true } } },
    });

  type Sold = { data: { id: string; total: unknown; customerId: string } };

  it('Not enough stock → NOT_ENOUGH_STOCK; no order, no payment, no walk-in record left half-made', async () => {
    await noWalkInRecord();
    const product = await stocked(1);
    const paymentsBefore = await prisma.payment.count();

    expect(await refusal(sales.create(walkIn(product.id, 2), actor))).toBe(
      'NOT_ENOUGH_STOCK',
    );

    expect(await ordersOf(product.id)).toHaveLength(0);
    expect(await prisma.payment.count()).toBe(paymentsBefore);
    // The first walk-in sale ever made the record inside the transaction; the
    // refusal took it down with the rest.
    expect(await prisma.customer.count({ where: { isWalkIn: true } })).toBe(0);
    expect(await onShelf(product.id)).toBe(1);
  });

  it('Two walk-in sales at once on a database without the record → exactly one walk-in customer exists afterwards', async () => {
    await noWalkInRecord();
    const product = await stocked(10);

    const [a, b] = (await Promise.all([
      sales.create(walkIn(product.id, 1), actor),
      sales.create(walkIn(product.id, 1), actor),
    ])) as Sold[];

    const records = await prisma.customer.findMany({
      where: { isWalkIn: true },
    });
    expect(records).toHaveLength(1);
    expect(a.data.customerId).toBe(records[0].id);
    expect(b.data.customerId).toBe(records[0].id);
    expect(await onShelf(product.id)).toBe(8);
  });

  it('Walk-in sale of 2 at retail → one CONFIRMED order on the walk-in record, a payment of the full total allocated, stock down by 2, outstanding 0', async () => {
    const product = await stocked(10);

    const sold = (await sales.create(walkIn(product.id, 2), actor)) as Sold;

    const [order] = await ordersOf(product.id);
    const record = await prisma.customer.findFirstOrThrow({
      where: { isWalkIn: true },
    });
    expect(order.id).toBe(sold.data.id);
    expect(order.customerId).toBe(record.id);
    expect(order.channel).toBe('B2C');
    // Confirmed and then paid in full in the same step: PAID is the confirmed
    // state once nothing is owed.
    expect(order.status).toBe('PAID');
    expect(Number(order.total)).toBe(900);
    expect(Number(order.outstanding)).toBe(0);

    expect(order.paymentAllocations).toHaveLength(1);
    const [allocation] = order.paymentAllocations;
    expect(Number(allocation.amount)).toBe(900);
    expect(Number(allocation.payment.amount)).toBe(900);
    expect(allocation.payment.method).toBe('CASH');
    expect(allocation.payment.customerId).toBe(record.id);

    // The money reached the ledger as it arrived (§9), once.
    const inflows = await prisma.financialTransaction.findMany({
      where: { relatedType: 'PAYMENT', relatedId: allocation.payment.id },
    });
    expect(inflows).toHaveLength(1);
    expect(Number(inflows[0].amount)).toBe(900);

    expect(await onShelf(product.id)).toBe(8);
  });

  it('a chosen payment method is recorded on the payment', async () => {
    const product = await stocked(5);
    await sales.create(
      walkIn(product.id, 1, { payment: { method: 'MOBILE_WALLET' } }),
      actor,
    );
    const [order] = await ordersOf(product.id);
    expect(order.paymentAllocations[0].payment.method).toBe('MOBILE_WALLET');
  });

  it('Repeated idempotency key → the same order, one payment', async () => {
    const product = await stocked(10);
    const key = randomUUID();

    const first = (await sales.create(
      walkIn(product.id, 2),
      actor,
      key,
    )) as Sold;
    const again = (await sales.create(
      walkIn(product.id, 2),
      actor,
      key,
    )) as Sold;
    // A double click: both in flight at once.
    const [x, y] = (await Promise.all([
      sales.create(walkIn(product.id, 2), actor, key),
      sales.create(walkIn(product.id, 2), actor, key),
    ])) as Sold[];

    for (const r of [again, x, y]) expect(r.data.id).toBe(first.data.id);
    const orders = await ordersOf(product.id);
    expect(orders).toHaveLength(1);
    expect(
      await prisma.payment.count({
        where: { allocations: { some: { saleOrderId: first.data.id } } },
      }),
    ).toBe(1);
    expect(await onShelf(product.id)).toBe(8);
  });

  it('Repeated idempotency key racing on a database without the record → one order, one payment, one walk-in record', async () => {
    await noWalkInRecord();
    const product = await stocked(10);
    const key = randomUUID();
    const [x, y] = (await Promise.all([
      sales.create(walkIn(product.id, 2), actor, key),
      sales.create(walkIn(product.id, 2), actor, key),
    ])) as Sold[];
    expect(x.data.id).toBe(y.data.id);
    expect(await ordersOf(product.id)).toHaveLength(1);
    expect(await prisma.customer.count({ where: { isWalkIn: true } })).toBe(1);
    expect(await onShelf(product.id)).toBe(8);
  });

  it('Discount larger than the line, or negative → refused as usual', async () => {
    const product = await stocked(10);
    const paymentsBefore = await prisma.payment.count();

    expect(
      await refusal(
        sales.create(walkIn(product.id, 1, { discount: 451 }), actor),
      ),
    ).toBe('DISCOUNT_EXCEEDS_LINE');
    expect(
      await refusal(
        sales.create(walkIn(product.id, 1, { discount: -10 }), actor),
      ),
    ).toBe('DISCOUNT_NEGATIVE');

    expect(await ordersOf(product.id)).toHaveLength(0);
    expect(await prisma.payment.count()).toBe(paymentsBefore);
    expect(await onShelf(product.id)).toBe(10);
  });

  it("The walk-in record never shows a balance; the customers list and pickers don't list it; revenue and the dashboard include its sales", async () => {
    const product = await stocked(10);
    const before = (await analytics.getDashboardKPIs()).data;
    const monthly = async () =>
      (
        (await analytics.getRevenueByMonth(1)) as unknown as {
          data: { revenue: number }[];
        }
      ).data.reduce((s, m) => s + Number(m.revenue), 0);
    const monthlyBefore = await monthly();

    const sold = (await sales.create(walkIn(product.id, 3), actor)) as Sold;
    const record = await prisma.customer.findFirstOrThrow({
      where: { isWalkIn: true },
    });

    const page = (await customers.findById(record.id)).data;
    expect(page.outstandingBalance).toBe('0.00');

    for (const query of [
      {},
      { search: 'Walk' },
      { verification: 'ALL' },
      { type: 'B2C', limit: 100 },
    ]) {
      const listed = (await customers.findAll(query)).data;
      expect(listed.map((c) => c.id)).not.toContain(record.id);
    }

    const after = (await analytics.getDashboardKPIs()).data;
    expect(Number(after.totalRevenue) - Number(before.totalRevenue)).toBe(
      Number(sold.data.total),
    );
    expect(after.totalCustomers).toBe(before.totalCustomers);
    expect((await monthly()) - monthlyBefore).toBe(Number(sold.data.total));
  });

  it('Return on a walk-in order → refunded in money; asking for credit → refused', async () => {
    const product = await stocked(10);
    const sold = (await sales.create(walkIn(product.id, 2), actor)) as Sold;
    const item = await prisma.saleItem.findFirstOrThrow({
      where: { saleOrderId: sold.data.id },
    });
    const line = [{ saleItemId: item.id, qty: 1 }];

    expect(
      await refusal(
        returns.create(
          {
            saleOrderId: sold.data.id,
            reason: 'wrong size',
            refundMethod: 'CREDIT_NOTE',
            items: line,
          },
          actor,
        ),
      ),
    ).toBe('WALK_IN_REFUND_IN_MONEY');
    expect(
      await prisma.saleReturn.count({ where: { saleOrderId: sold.data.id } }),
    ).toBe(0);

    const back = await returns.create(
      { saleOrderId: sold.data.id, reason: 'wrong size', items: line },
      actor,
    );
    expect(back.data!.refundMethod).toBe('CASH');
    const refunds = await prisma.financialTransaction.findMany({
      where: { relatedId: back.data!.id, type: 'REFUND_PAID' },
    });
    expect(refunds).toHaveLength(1);
    expect(Number(refunds[0].amount)).toBe(450);

    const record = await prisma.customer.findFirstOrThrow({
      where: { isWalkIn: true },
    });
    expect((await customers.findById(record.id)).data.outstandingBalance).toBe(
      '0.00',
    );
  });

  it('Editing or deleting the walk-in customer → WALK_IN_RESERVED', async () => {
    const product = await stocked(1);
    await sales.create(walkIn(product.id, 1), actor);
    const record = await prisma.customer.findFirstOrThrow({
      where: { isWalkIn: true },
    });
    expect(
      await refusal(
        customers.update(record.id, { displayName: 'Ahmed' }, actor),
      ),
    ).toBe('WALK_IN_RESERVED');
    expect(
      await refusal(
        sales.create(
          {
            customerId: record.id,
            channel: 'B2C',
            currency: 'EGP',
            items: [{ productId: product.id, quantity: 1, unitPrice: 1 }],
          },
          actor,
        ),
      ),
    ).toBe('WALK_IN_RESERVED');
    // There is no delete endpoint for customers; the database itself refuses
    // to remove a record that sales hang off.
    await expect(
      prisma.customer.delete({ where: { id: record.id } }),
    ).rejects.toThrow();
    expect(
      (await prisma.customer.findUniqueOrThrow({ where: { id: record.id } }))
        .displayName,
    ).not.toBe('Ahmed');
  });

  describe('dated', () => {
    afterEach(() => jest.useRealTimers());

    it('Payment dated now, in Cairo', async () => {
      const product = await stocked(5);
      // 22:30 UTC on the 10th is 01:30 on the 11th in Cairo.
      jest.useFakeTimers({
        now: new Date('2026-10-10T22:30:00Z'),
        doNotFake: [
          'hrtime',
          'nextTick',
          'performance',
          'queueMicrotask',
          'setImmediate',
          'clearImmediate',
          'setInterval',
          'clearInterval',
          'setTimeout',
          'clearTimeout',
        ],
      });
      await sales.create(walkIn(product.id, 1), actor);
      jest.useRealTimers();

      const [order] = await ordersOf(product.id);
      const received = order.paymentAllocations[0].payment.receivedOn;
      expect(received.toISOString().slice(0, 10)).toBe('2026-10-11');
    });
  });
});
