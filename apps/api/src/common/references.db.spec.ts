import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- this suite talks to a real, throwaway Postgres; that is its point
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../modules/audit/audit.service';
import type { NotificationsService } from '../modules/notifications/notifications.service';
import { PaymentsService } from '../modules/payments/payments.service';
import { PurchasesService } from '../modules/purchases/purchases.service';
import {
  SalesService,
  type CreateSaleOrderInput,
} from '../modules/sales/sales.service';

/**
 * Numbers handed out at the same instant, and a payment dated at night, against
 * a real Postgres (plan F9). A race only exists where there is a second
 * connection and a real index, so a fake cannot show either.
 *
 * Runs only when INTEGRATION_DATABASE_URL points at a THROWAWAY database with
 * the migrations applied — never the dev database (CLAUDE.md rule 6):
 *
 *   docker run -d --name f9_scratch -p 55472:5432 -e POSTGRES_PASSWORD=scratch \
 *     -e POSTGRES_DB=f9scratch --tmpfs /var/lib/postgresql/data postgres:16
 *   DATABASE_URL=postgresql://postgres:scratch@localhost:55472/f9scratch npx prisma migrate deploy
 *   INTEGRATION_DATABASE_URL=postgresql://postgres:scratch@localhost:55472/f9scratch \
 *     npx jest references.db
 */
// eslint-disable-next-line no-restricted-properties -- an opt-in switch for a suite that must never run by default
const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('reference numbers and dates against Postgres', () => {
  let prisma: PrismaClient;
  let sales: SalesService;
  let purchases: PurchasesService;
  let payments: PaymentsService;
  let actor: string;

  beforeAll(async () => {
    // Enough connections that the requests below really do run side by side.
    prisma = new PrismaClient({
      datasources: { db: { url: `${url}?connection_limit=12` } },
    });
    const db = prisma as unknown as PrismaService;
    const audit = { log: jest.fn() } as unknown as AuditService;
    const notifications = {
      createForMultipleUsers: jest.fn(),
    } as unknown as NotificationsService;
    payments = new PaymentsService(db, audit);
    sales = new SalesService(db, audit, payments);
    purchases = new PurchasesService(db, audit, notifications);
    const user = await prisma.user.create({
      data: {
        email: `f9-${randomUUID()}@example.com`,
        passwordHash: 'x',
        role: 'CORE_PARTNER',
      },
    });
    actor = user.id;
  });
  afterAll(() => prisma.$disconnect());

  const tag = () => randomUUID().slice(0, 8);

  /**
   * A product with `qty` units received and verified on a selling cycle, at a
   * landed cost of 100 — stock as a verified receipt leaves it.
   */
  async function stocked(qty: number) {
    const t = tag();
    const product = await prisma.product.create({
      data: { sku: `F9-${t}`, name: `Numbered part ${t}` },
    });
    const cycle = await prisma.importCycle.create({
      data: {
        code: `F9-${t}`,
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

  const shop = () =>
    prisma.customer.create({
      data: {
        type: 'B2B',
        displayName: `Shop ${tag()}`,
        verificationStatus: 'VERIFIED',
      },
    });

  const sale = (
    customerId: string,
    productId: string,
    confirm: boolean,
  ): CreateSaleOrderInput => ({
    customerId,
    channel: 'B2B',
    currency: 'EGP',
    confirm,
    items: [{ productId, quantity: 1, unitPrice: 300 }],
  });

  type Made = { data: { id: string; orderNo: string } };

  const onShelf = async (productId: string) =>
    Number(
      (
        await prisma.inventoryBatch.aggregate({
          where: { productId },
          _sum: { saleableQty: true },
        })
      )._sum.saleableQty,
    );

  const numberOf = (orderNo: string) => Number(orderNo.slice(-5));

  describe('sale order numbers', () => {
    it('eight drafts at once → eight orders, eight different ORD-YYYY-NNNNN numbers', async () => {
      const product = await stocked(100);
      const customer = await shop();

      const made = (await Promise.all(
        Array.from({ length: 8 }, () =>
          sales.create(sale(customer.id, product.id, false), actor),
        ),
      )) as Made[];

      const numbers = made.map((m) => m.data.orderNo);
      expect(new Set(numbers).size).toBe(8);
      const year = new Date().getFullYear();
      for (const n of numbers)
        expect(n).toMatch(new RegExp(`^ORD-${year}-\\d{5}$`));
      expect(
        await prisma.saleOrder.count({ where: { customerId: customer.id } }),
      ).toBe(8);
    });

    it('six "create & confirm" at once → all six sold, numbered apart, stock down by six', async () => {
      const product = await stocked(100);
      const customer = await shop();

      const made = (await Promise.all(
        Array.from({ length: 6 }, () =>
          sales.create(sale(customer.id, product.id, true), actor),
        ),
      )) as Made[];

      expect(new Set(made.map((m) => m.data.orderNo)).size).toBe(6);
      expect(await onShelf(product.id)).toBe(94);
      const orders = await prisma.saleOrder.findMany({
        where: { customerId: customer.id },
      });
      expect(orders.every((o) => o.status === 'CONFIRMED')).toBe(true);
    });

    it('a sale that loses the race is checked again: two on the shelf, three sold at once → two sold, one NOT_ENOUGH_STOCK', async () => {
      const product = await stocked(2);
      const customer = await shop();

      const settled = await Promise.allSettled(
        Array.from({ length: 3 }, () =>
          sales.create(sale(customer.id, product.id, true), actor),
        ),
      );

      const sold = settled.filter((s) => s.status === 'fulfilled');
      const refused = settled.filter((s) => s.status === 'rejected');
      expect(sold).toHaveLength(2);
      expect(refused).toHaveLength(1);
      const reason: unknown = refused[0].reason;
      expect(reason).toBeInstanceOf(HttpException);
      expect(
        ((reason as HttpException).getResponse() as { code: string }).code,
      ).toBe('NOT_ENOUGH_STOCK');
      expect(await onShelf(product.id)).toBe(0);
      expect(
        await prisma.saleOrder.count({ where: { customerId: customer.id } }),
      ).toBe(2);
    });

    it('the same idempotency key twice at once is still one order, not two numbered apart', async () => {
      const product = await stocked(10);
      const customer = await shop();
      const key = `f9-${tag()}`;

      const [a, b] = (await Promise.all([
        sales.create(sale(customer.id, product.id, true), actor, key),
        sales.create(sale(customer.id, product.id, true), actor, key),
      ])) as Made[];

      expect(a.data.id).toBe(b.data.id);
      expect(
        await prisma.saleOrder.count({ where: { customerId: customer.id } }),
      ).toBe(1);
      expect(await onShelf(product.id)).toBe(9);
    });

    it('after a race, the next sale takes the number after the highest', async () => {
      const product = await stocked(10);
      const customer = await shop();
      const year = new Date().getFullYear();
      const highest = await prisma.saleOrder.findFirstOrThrow({
        where: { orderNo: { startsWith: `ORD-${year}` } },
        orderBy: { orderNo: 'desc' },
      });

      const next = (await sales.create(
        sale(customer.id, product.id, false),
        actor,
      )) as Made;

      expect(numberOf(next.data.orderNo)).toBe(numberOf(highest.orderNo) + 1);
    });
  });

  describe('purchase order references', () => {
    async function openCycle() {
      const t = tag();
      const supplier = await prisma.supplier.create({
        data: { name: `F9 supplier ${t}`, country: 'AE' },
      });
      const product = await prisma.product.create({
        data: { sku: `F9P-${t}`, name: `F9 bought part ${t}` },
      });
      const cycle = await prisma.importCycle.create({
        data: {
          code: `F9C-${t}`,
          originType: 'UAE_DIRECT',
          currency: 'AED',
          status: 'PURCHASING',
        },
      });
      return { supplier, product, cycle };
    }

    it('six purchase orders at once → six different PO-YYYY-NNNN references', async () => {
      const { supplier, product, cycle } = await openCycle();

      const made = await Promise.all(
        Array.from({ length: 6 }, () =>
          purchases.create(
            cycle.id,
            {
              supplierId: supplier.id,
              currency: 'AED',
              fxRateToEgp: 13.5,
              orderedOn: '2026-01-05',
              items: [{ productId: product.id, orderedQty: 5, unitPrice: 10 }],
            },
            actor,
          ),
        ),
      );

      const refs = made.map((m) => m.data.reference);
      expect(new Set(refs).size).toBe(6);
      const year = new Date().getFullYear();
      for (const r of refs)
        expect(r).toMatch(new RegExp(`^PO-${year}-\\d{4}$`));
      expect(
        await prisma.purchaseOrder.count({ where: { cycleId: cycle.id } }),
      ).toBe(6);
    });
  });

  describe('an undated payment', () => {
    afterEach(() => jest.useRealTimers());

    it('at 22:30 UTC on the 10th is received on the 11th — the Cairo day', async () => {
      const customer = await shop();
      const product = await stocked(5);
      const order = (await sales.create(
        sale(customer.id, product.id, true),
        actor,
      )) as Made;

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
      const { data } = await payments.create(
        {
          customerId: customer.id,
          amount: 100,
          currency: 'EGP',
          orderId: order.data.id,
        },
        actor,
      );
      jest.useRealTimers();

      const stored = await prisma.payment.findUniqueOrThrow({
        where: { id: data.id },
      });
      expect(stored.receivedOn.toISOString().slice(0, 10)).toBe('2026-10-11');
    });
  });
});
