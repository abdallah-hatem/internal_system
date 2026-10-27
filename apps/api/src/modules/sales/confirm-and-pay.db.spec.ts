import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- this suite talks to a real, throwaway Postgres; that is its point
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import { PaymentsService } from '../payments/payments.service';
import { SalesService, type CreateSaleOrderInput } from './sales.service';
import { businessToday } from '../../common/dates';

/**
 * Confirm & paid in one step against a real Postgres (BUSINESS_LOGIC §4,
 * "Confirm & paid in one step", owner 2026-10-27): one transaction, all or
 * nothing, the order row lock that makes a double click pay once, and the
 * notifications after the commit — which an in-memory fake cannot prove.
 *
 * Runs only when INTEGRATION_DATABASE_URL points at a THROWAWAY database with
 * the migrations applied — an agent's own (`scripts/agent-env.sh <name>`),
 * never the dev database (CLAUDE.md rule 6).
 */
// eslint-disable-next-line no-restricted-properties -- an opt-in switch for a suite that must never run by default
const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;

type Event = { eventType: string };

suite('Confirm & paid against Postgres', () => {
  let prisma: PrismaClient;
  let sales: SalesService;
  let payments: PaymentsService;
  let actor: string;
  const audit = { log: jest.fn((_row: unknown) => Promise.resolve()) };
  const notifier = {
    createForMultipleUsers: jest.fn((_users: string[], _event: Event) =>
      Promise.resolve({ count: 1 }),
    ),
  };

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const db = prisma as unknown as PrismaService;
    const auditService = audit as unknown as AuditService;
    payments = new PaymentsService(db, auditService, notifier);
    sales = new SalesService(db, auditService, payments, notifier);
    const user = await prisma.user.create({
      data: {
        email: `cp-${randomUUID()}@example.com`,
        passwordHash: 'x',
        role: 'CORE_PARTNER',
      },
    });
    actor = user.id;
    // Somebody to tell: the news goes to the other active core partners.
    await prisma.user.create({
      data: {
        email: `cp-other-${randomUUID()}@example.com`,
        passwordHash: 'x',
        role: 'CORE_PARTNER',
      },
    });
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => {
    audit.log.mockClear();
    notifier.createForMultipleUsers.mockClear();
  });

  const DAY = 86_400_000;
  const daysAgo = (n: number) =>
    new Date(Date.parse(businessToday()) - n * DAY).toISOString().slice(0, 10);

  /**
   * A product with `qty` units received ten days ago and verified on a
   * selling cycle, at a landed cost of 100 — stock as a verified receipt
   * leaves it, early enough for a back-dated sale to draw.
   */
  async function stocked(qty: number) {
    const tag = randomUUID().slice(0, 8);
    const product = await prisma.product.create({
      data: { sku: `CP-${tag}`, name: `Confirm-pay part ${tag}` },
    });
    const cycle = await prisma.importCycle.create({
      data: {
        code: `CP-${tag}`,
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
        createdAt: new Date(Date.now() - 10 * DAY),
      },
    });
    return product;
  }

  const shop = () =>
    prisma.customer.create({
      data: {
        type: 'B2B',
        displayName: `Shop ${randomUUID().slice(0, 6)}`,
        verificationStatus: 'VERIFIED',
      },
    });

  const onShelf = async (productId: string) =>
    Number(
      (
        await prisma.inventoryBatch.aggregate({
          where: { productId },
          _sum: { saleableQty: true },
        })
      )._sum.saleableQty,
    );

  const sale = (
    customerId: string,
    productId: string,
    quantity: number,
    extra: Partial<CreateSaleOrderInput> & {
      unitPrice?: number;
      discount?: number;
    } = {},
  ): CreateSaleOrderInput => {
    const { unitPrice = 450, discount, ...rest } = extra;
    return {
      customerId,
      channel: 'B2B',
      currency: 'EGP',
      items: [{ productId, quantity, unitPrice, discount }],
      ...rest,
    };
  };

  type Order = { id: string; version: number; status: string };
  async function draft(
    customerId: string,
    productId: string,
    quantity: number,
    extra: Parameters<typeof sale>[3] = {},
  ) {
    const res = (await sales.create(
      sale(customerId, productId, quantity, extra),
      actor,
    )) as { data: Order };
    return res.data;
  }

  async function refusal(p: Promise<unknown>) {
    try {
      await p;
    } catch (e) {
      if (!(e instanceof HttpException)) throw e;
      return (e.getResponse() as { code: string }).code;
    }
    throw new Error('expected a refusal, got success');
  }

  const order = (id: string) =>
    prisma.saleOrder.findUniqueOrThrow({
      where: { id },
      include: {
        paymentAllocations: { include: { payment: true } },
        items: { include: { allocations: true } },
      },
    });

  const paymentsOn = (orderId: string) =>
    prisma.payment.findMany({
      where: { allocations: { some: { saleOrderId: orderId } } },
    });

  const inflowsFor = (paymentIds: string[]) =>
    prisma.financialTransaction.findMany({
      where: { relatedType: 'PAYMENT', relatedId: { in: paymentIds } },
    });

  const unitsDrawn = (o: Awaited<ReturnType<typeof order>>) =>
    o.items
      .flatMap((i) => i.allocations)
      .reduce((s, a) => s + Number(a.qty), 0);

  const told = (eventType: string) =>
    notifier.createForMultipleUsers.mock.calls.filter(
      ([, e]) => e.eventType === eventType,
    ).length;

  /** Nothing confirmed and nothing paid: still the draft it was. */
  async function untouched(o: Order, productId: string, shelf: number) {
    const now = await order(o.id);
    expect(now.status).toBe(o.status);
    expect(now.paymentAllocations).toHaveLength(0);
    expect(unitsDrawn(now)).toBe(0);
    expect(await onShelf(productId)).toBe(shelf);
  }

  it('a draft → PAID, owes 0, one payment of the full total on it (cash, the sale’s day, its number), one ledger inflow, stock drawn once, each notification once', async () => {
    const product = await stocked(10);
    const s = await shop();
    const d = await draft(s.id, product.id, 2);

    const res = (await sales.confirmAndPay(d.id, actor, d.version)) as {
      data: { status: string; payment: { id: string } | null };
    };

    const o = await order(d.id);
    expect(o.status).toBe('PAID');
    expect(res.data.status).toBe('PAID');
    expect(Number(o.total)).toBe(900);
    expect(Number(o.outstanding)).toBe(0);
    expect(o.paymentAllocations).toHaveLength(1);
    const [allocation] = o.paymentAllocations;
    expect(Number(allocation.amount)).toBe(900);
    expect(Number(allocation.payment.amount)).toBe(900);
    expect(allocation.payment.customerId).toBe(s.id);
    expect(allocation.payment.method).toBe('CASH');
    expect(allocation.payment.reference).toBe(o.orderNo);
    expect(allocation.payment.receivedOn.toISOString().slice(0, 10)).toBe(
      businessToday(),
    );
    expect(res.data.payment?.id).toBe(allocation.payment.id);

    // The money reached the ledger as it arrived (§9), once.
    const inflows = await inflowsFor([allocation.payment.id]);
    expect(inflows).toHaveLength(1);
    expect(inflows[0].direction).toBe('INFLOW');
    expect(Number(inflows[0].amount)).toBe(900);

    expect(unitsDrawn(o)).toBe(2);
    expect(await onShelf(product.id)).toBe(8);

    // After the commit: the sale and the payment, each told once.
    expect(told('SALE_CONFIRMED')).toBe(1);
    expect(told('PAYMENT_RECEIVED')).toBe(1);
    const actions = audit.log.mock.calls.map(
      ([row]) =>
        `${(row as { entityType: string }).entityType}:${(row as { action: string }).action}`,
    );
    expect(actions.filter((a) => a === 'SaleOrder:CONFIRM')).toHaveLength(1);
    expect(actions.filter((a) => a === 'Payment:CREATE')).toHaveLength(1);
    expect(actions.filter((a) => a === 'Payment:ALLOCATE')).toHaveLength(1);
  });

  it('a back-dated draft is paid on its own day, not today', async () => {
    const product = await stocked(5);
    const s = await shop();
    const day = daysAgo(3);
    const d = await draft(s.id, product.id, 1, { orderedOn: day });

    await sales.confirmAndPay(d.id, actor, d.version);

    const [payment] = await paymentsOn(d.id);
    expect(payment.receivedOn.toISOString().slice(0, 10)).toBe(day);
  });

  it('a discounted draft is paid what it owes after the discount', async () => {
    const product = await stocked(5);
    const s = await shop();
    const d = await draft(s.id, product.id, 2, { discount: 100 });

    await sales.confirmAndPay(d.id, actor, d.version);

    const o = await order(d.id);
    expect(Number(o.total)).toBe(800);
    expect(o.status).toBe('PAID');
    expect(Number(o.paymentAllocations[0].payment.amount)).toBe(800);
  });

  it('a chosen method is recorded; one nobody offers is refused before anything is written', async () => {
    const product = await stocked(5);
    const s = await shop();
    const d = await draft(s.id, product.id, 1);

    expect(
      await refusal(
        sales.confirmAndPay(d.id, actor, d.version, { method: 'GOLD' }),
      ),
    ).toBe('VALIDATION_FAILED');
    await untouched(d, product.id, 5);

    await sales.confirmAndPay(d.id, actor, d.version, {
      method: 'BANK_TRANSFER',
    });
    const [payment] = await paymentsOn(d.id);
    expect(payment.method).toBe('BANK_TRANSFER');
  });

  it('an order already confirmed → ONLY_DRAFT_CONFIRMABLE, and no payment is taken on it', async () => {
    const product = await stocked(5);
    const s = await shop();
    const d = await draft(s.id, product.id, 1);
    const confirmed = (await sales.confirmOrder(d.id, actor, d.version)) as {
      data: Order;
    };
    const shelf = await onShelf(product.id);

    expect(
      await refusal(sales.confirmAndPay(d.id, actor, confirmed.data.version)),
    ).toBe('ONLY_DRAFT_CONFIRMABLE');
    const o = await order(d.id);
    expect(o.status).toBe('CONFIRMED');
    expect(Number(o.outstanding)).toBe(450);
    expect(await paymentsOn(d.id)).toHaveLength(0);
    expect(await onShelf(product.id)).toBe(shelf);
  });

  it('a cancelled draft → ONLY_DRAFT_CONFIRMABLE; nothing confirmed, nothing paid', async () => {
    const product = await stocked(5);
    const s = await shop();
    const d = await draft(s.id, product.id, 1);
    await sales.cancelOrder(d.id, actor);
    const cancelled = await order(d.id);

    expect(
      await refusal(sales.confirmAndPay(d.id, actor, cancelled.version)),
    ).toBe('ONLY_DRAFT_CONFIRMABLE');
    await untouched(
      { id: d.id, version: cancelled.version, status: 'CANCELLED' },
      product.id,
      5,
    );
  });

  it('samples at a shop → SAMPLES_NOT_PAYABLE; still samples, nothing paid', async () => {
    const product = await stocked(5);
    const s = await shop();
    const left = (await sales.create(
      sale(s.id, product.id, 2, { samples: true }),
      actor,
    )) as { data: Order };
    const before = await order(left.data.id);

    expect(
      await refusal(sales.confirmAndPay(left.data.id, actor, before.version)),
    ).toBe('SAMPLES_NOT_PAYABLE');
    const after = await order(left.data.id);
    expect(after.status).toBe(before.status);
    expect(await paymentsOn(left.data.id)).toHaveLength(0);
    expect(await onShelf(product.id)).toBe(3);
  });

  it('not enough stock any more → INSUFFICIENT_STOCK (Confirm’s own refusal); not confirmed, not paid, no ledger row, the shelf as it was (all or nothing)', async () => {
    const product = await stocked(5);
    const s = await shop();
    const d = await draft(s.id, product.id, 5);
    // Another sale takes three of the five while the draft waits.
    await sales.create(sale(s.id, product.id, 3, { confirm: true }), actor);
    const paymentsBefore = await prisma.payment.count();
    const ledgerBefore = await prisma.financialTransaction.count();

    expect(await refusal(sales.confirmAndPay(d.id, actor, d.version))).toBe(
      'INSUFFICIENT_STOCK',
    );

    await untouched(d, product.id, 2);
    expect(await prisma.payment.count()).toBe(paymentsBefore);
    expect(await prisma.financialTransaction.count()).toBe(ledgerBefore);
    expect(told('PAYMENT_RECEIVED')).toBe(0);
  });

  it('the payment refused after the confirm went through → the confirm is undone too: still a draft, the stock back, nothing told', async () => {
    const product = await stocked(5);
    const s = await shop();
    const d = await draft(s.id, product.id, 2);
    const spy = jest
      .spyOn(payments, 'recordWithin')
      .mockRejectedValueOnce(new Error('the payment failed'));
    audit.log.mockClear();

    try {
      await expect(sales.confirmAndPay(d.id, actor, d.version)).rejects.toThrow(
        'the payment failed',
      );
    } finally {
      spy.mockRestore();
    }

    await untouched(d, product.id, 5);
    expect(told('SALE_CONFIRMED')).toBe(0);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('a stale version → ORDER_VERSION_CONFLICT; nothing written', async () => {
    const product = await stocked(5);
    const s = await shop();
    const d = await draft(s.id, product.id, 1);

    expect(await refusal(sales.confirmAndPay(d.id, actor, d.version + 7))).toBe(
      'ORDER_VERSION_CONFLICT',
    );
    await untouched(d, product.id, 5);
  });

  it('an unverified customer → CUSTOMER_NOT_VERIFIED, as Record payment refuses; nothing written', async () => {
    const product = await stocked(5);
    const s = await shop();
    const d = await draft(s.id, product.id, 1);
    await prisma.customer.update({
      where: { id: s.id },
      data: { verificationStatus: 'PENDING' },
    });

    expect(await refusal(sales.confirmAndPay(d.id, actor, d.version))).toBe(
      'CUSTOMER_NOT_VERIFIED',
    );
    await untouched(d, product.id, 5);
  });

  it('an id that is not an order → a coded 404, never a 500', async () => {
    expect(await refusal(sales.confirmAndPay('not-a-uuid', actor, 1))).toBe(
      'NOT_FOUND',
    );
    expect(await refusal(sales.confirmAndPay(randomUUID(), actor, 1))).toBe(
      'NOT_FOUND',
    );
  });

  it('the second time → refused; one payment, the stock drawn once', async () => {
    const product = await stocked(10);
    const s = await shop();
    const d = await draft(s.id, product.id, 2);

    await sales.confirmAndPay(d.id, actor, d.version);
    expect(await refusal(sales.confirmAndPay(d.id, actor, d.version))).toBe(
      'ONLY_DRAFT_CONFIRMABLE',
    );

    expect(await paymentsOn(d.id)).toHaveLength(1);
    expect(unitsDrawn(await order(d.id))).toBe(2);
    expect(await onShelf(product.id)).toBe(8);
  });

  it('a double click (two at once) → confirmed and paid exactly once; the other refused with a code', async () => {
    const product = await stocked(10);
    const s = await shop();
    const d = await draft(s.id, product.id, 2);

    const results = await Promise.allSettled([
      sales.confirmAndPay(d.id, actor, d.version),
      sales.confirmAndPay(d.id, actor, d.version),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [lost] = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(lost.reason).toBeInstanceOf(HttpException);
    expect((lost.reason as HttpException).getResponse()).toMatchObject({
      code: 'ONLY_DRAFT_CONFIRMABLE',
    });
    const o = await order(d.id);
    expect(o.status).toBe('PAID');
    expect(await paymentsOn(d.id)).toHaveLength(1);
    expect(unitsDrawn(o)).toBe(2);
    expect(await onShelf(product.id)).toBe(8);
    expect(told('PAYMENT_RECEIVED')).toBe(1);
  });

  it('an order worth nothing → confirmed, owes 0, and no payment of 0 is recorded', async () => {
    const product = await stocked(5);
    const s = await shop();
    const d = await draft(s.id, product.id, 1, { unitPrice: 0 });

    const res = (await sales.confirmAndPay(d.id, actor, d.version)) as {
      data: { payment: unknown };
    };

    const o = await order(d.id);
    expect(o.status).toBe('CONFIRMED');
    expect(Number(o.outstanding)).toBe(0);
    expect(res.data.payment).toBeNull();
    expect(await paymentsOn(d.id)).toHaveLength(0);
    expect(await onShelf(product.id)).toBe(4);
    expect(told('PAYMENT_RECEIVED')).toBe(0);
  });

  describe('New Order: created, confirmed and paid in one go (`paid: true`)', () => {
    const ordersOf = (productId: string) =>
      prisma.saleOrder.findMany({
        where: { items: { some: { productId } } },
        include: { paymentAllocations: { include: { payment: true } } },
      });

    it('→ one PAID order with one payment of its total on it, each notification once', async () => {
      const product = await stocked(10);
      const s = await shop();

      await sales.create(
        sale(s.id, product.id, 2, {
          paid: true,
          payment: { method: 'CHEQUE' },
        }),
        actor,
      );

      const [o] = await ordersOf(product.id);
      expect(o.status).toBe('PAID');
      expect(Number(o.outstanding)).toBe(0);
      expect(o.paymentAllocations).toHaveLength(1);
      expect(Number(o.paymentAllocations[0].payment.amount)).toBe(900);
      expect(o.paymentAllocations[0].payment.method).toBe('CHEQUE');
      expect(await onShelf(product.id)).toBe(8);
      expect(told('SALE_CONFIRMED')).toBe(1);
      expect(told('PAYMENT_RECEIVED')).toBe(1);
    });

    it('not enough stock → refused; no order, no payment', async () => {
      const product = await stocked(1);
      const s = await shop();
      const paymentsBefore = await prisma.payment.count();

      expect(
        await refusal(
          sales.create(sale(s.id, product.id, 2, { paid: true }), actor),
        ),
      ).toBe('NOT_ENOUGH_STOCK');
      expect(await ordersOf(product.id)).toHaveLength(0);
      expect(await prisma.payment.count()).toBe(paymentsBefore);
      expect(await onShelf(product.id)).toBe(1);
    });

    it('paid with confirm: false, paid samples, or paid that is not a boolean → VALIDATION_FAILED; nothing written', async () => {
      const product = await stocked(5);
      const s = await shop();

      expect(
        await refusal(
          sales.create(
            sale(s.id, product.id, 1, { paid: true, confirm: false }),
            actor,
          ),
        ),
      ).toBe('VALIDATION_FAILED');
      expect(
        await refusal(
          sales.create(
            sale(s.id, product.id, 1, { paid: true, samples: true }),
            actor,
          ),
        ),
      ).toBe('VALIDATION_FAILED');
      expect(
        await refusal(
          sales.create(
            sale(s.id, product.id, 1, {
              paid: 'yes' as unknown as boolean,
            }),
            actor,
          ),
        ),
      ).toBe('VALIDATION_FAILED');
      expect(await ordersOf(product.id)).toHaveLength(0);
      expect(await onShelf(product.id)).toBe(5);
    });

    it('a payment method on an ordinary sale without paid is still refused, not dropped', async () => {
      const product = await stocked(5);
      const s = await shop();
      expect(
        await refusal(
          sales.create(
            sale(s.id, product.id, 1, {
              confirm: true,
              payment: { method: 'CASH' },
            }),
            actor,
          ),
        ),
      ).toBe('VALIDATION_FAILED');
      expect(await ordersOf(product.id)).toHaveLength(0);
    });

    it('the same idempotency key twice (and twice at once) → one order, one payment', async () => {
      const product = await stocked(10);
      const s = await shop();
      const key = randomUUID();
      const body = sale(s.id, product.id, 2, { paid: true });

      await sales.create(body, actor, key);
      await Promise.all([
        sales.create(body, actor, key),
        sales.create(body, actor, key),
      ]);

      const orders = await ordersOf(product.id);
      expect(orders).toHaveLength(1);
      expect(await paymentsOn(orders[0].id)).toHaveLength(1);
      expect(await onShelf(product.id)).toBe(8);
    });

    it('a walk-in sale with paid: true is the walk-in sale it already was — one payment', async () => {
      const product = await stocked(5);
      await sales.create(
        {
          walkIn: true,
          paid: true,
          currency: 'EGP',
          items: [{ productId: product.id, quantity: 1, unitPrice: 450 }],
        } as CreateSaleOrderInput,
        actor,
      );
      const [o] = await ordersOf(product.id);
      expect(o.status).toBe('PAID');
      expect(o.paymentAllocations).toHaveLength(1);
    });
  });
});
