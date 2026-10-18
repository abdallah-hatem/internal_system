import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- this suite talks to a real, throwaway Postgres; that is its point
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import { PaymentsService } from '../payments/payments.service';
import { SalesService } from './sales.service';
import { owedBy } from '../../common/customer-balance';

/**
 * A cancelled order owes nothing (scripts/check-data.sh 12.2, 2026-08-23).
 *
 * Cancelling put the stock back and marked the order CANCELLED, and left its
 * `outstanding` at the full total — so every cancel made through the app
 * produced exactly the record check 12.2 exists to find. Found 2026-10-18 when
 * the history seed cancelled one unpaid order and the check flagged it.
 *
 * Runs only against a THROWAWAY database (CLAUDE.md rule 6):
 *
 *   INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/motorcycle_parts_<name> \
 *     npx jest sales.cancel.db
 */
// eslint-disable-next-line no-restricted-properties -- an opt-in switch for a suite that must never run by default
const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('cancelling a sale against Postgres', () => {
  let prisma: PrismaClient;
  let sales: SalesService;
  let payments: PaymentsService;
  let actor: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const db = prisma as unknown as PrismaService;
    const audit = { log: jest.fn() } as unknown as AuditService;
    payments = new PaymentsService(db, audit);
    sales = new SalesService(db, audit, payments, {
      createForMultipleUsers: () => Promise.resolve({ count: 0 }),
    });
    const user = await prisma.user.create({
      data: {
        email: `cancel-${randomUUID()}@example.com`,
        passwordHash: 'x',
        role: 'CORE_PARTNER',
      },
    });
    actor = user.id;
  });
  afterAll(() => prisma.$disconnect());

  /** A product with 10 units received a few days ago on a selling cycle, and a verified shop. */
  async function setUp() {
    const tag = randomUUID().slice(0, 8);
    const cycle = await prisma.importCycle.create({
      data: {
        code: `CNL-${tag}`,
        originType: 'UAE_DIRECT',
        currency: 'EGP',
        status: 'SELLING',
      },
    });
    const product = await prisma.product.create({
      data: { sku: `CNL-${tag}`, name: `Cancel part ${tag}`, status: 'ACTIVE' },
    });
    const batch = await prisma.inventoryBatch.create({
      data: {
        cycleId: cycle.id,
        productId: product.id,
        receivedQty: 10,
        remainingQty: 10,
        saleableQty: 10,
        landedUnitCostEgp: 100,
        verificationStatus: 'VERIFIED',
        createdAt: new Date(Date.now() - 3 * 86_400_000),
      },
    });
    const shop = await prisma.customer.create({
      data: {
        type: 'B2B',
        displayName: `Shop ${tag}`,
        verificationStatus: 'VERIFIED',
      },
    });
    return { product, batch, shop };
  }

  const order = (customerId: string, productId: string, confirm: boolean) =>
    sales.create(
      {
        customerId,
        channel: 'B2B',
        currency: 'EGP',
        items: [{ productId, quantity: 4, unitPrice: 250 }],
        confirm,
      },
      actor,
    ) as Promise<{ data: { id: string } }>;

  const read = (id: string) =>
    prisma.saleOrder.findUniqueOrThrow({ where: { id } });

  async function refusal(p: Promise<unknown>) {
    try {
      await p;
    } catch (e) {
      if (!(e instanceof HttpException)) throw e;
      return (e.getResponse() as { code: string }).code;
    }
    throw new Error('expected a refusal, got success');
  }

  it('a confirmed, unpaid order cancelled owes nothing, and the shop owes nothing for it', async () => {
    const { product, batch, shop } = await setUp();
    const made = await order(shop.id, product.id, true);
    expect(Number((await read(made.data.id)).outstanding)).toBe(1000);
    expect(Number(await owedBy(prisma, shop.id))).toBe(1000);

    await sales.cancelOrder(made.data.id, actor);

    const after = await read(made.data.id);
    expect(after.status).toBe('CANCELLED');
    expect(Number(after.outstanding)).toBe(0);
    // The total stays: it is what the order was, not what it owes.
    expect(Number(after.total)).toBe(1000);
    expect(Number(await owedBy(prisma, shop.id))).toBe(0);
    const b = await prisma.inventoryBatch.findUniqueOrThrow({
      where: { id: batch.id },
    });
    expect([Number(b.remainingQty), Number(b.saleableQty)]).toEqual([10, 10]);
  });

  it('a draft cancelled owes nothing either', async () => {
    const { product, shop } = await setUp();
    const made = await order(shop.id, product.id, false);
    await sales.cancelOrder(made.data.id, actor);
    const after = await read(made.data.id);
    expect(after.status).toBe('CANCELLED');
    expect(Number(after.outstanding)).toBe(0);
  });

  it('the second time is refused, and the stock comes back once', async () => {
    const { product, batch, shop } = await setUp();
    const made = await order(shop.id, product.id, true);
    await sales.cancelOrder(made.data.id, actor);
    expect(await refusal(sales.cancelOrder(made.data.id, actor))).toBe(
      'ORDER_ALREADY_CLOSED',
    );
    const b = await prisma.inventoryBatch.findUniqueOrThrow({
      where: { id: batch.id },
    });
    expect(Number(b.remainingQty)).toBe(10);
    expect(Number((await read(made.data.id)).outstanding)).toBe(0);
  });

  it('an order with money on it is still refused, and keeps its balance', async () => {
    const { product, shop } = await setUp();
    const made = await order(shop.id, product.id, true);
    await payments.create(
      {
        customerId: shop.id,
        amount: 300,
        currency: 'EGP',
        orderId: made.data.id,
      },
      actor,
    );
    expect(await refusal(sales.cancelOrder(made.data.id, actor))).toBe(
      'ORDER_PAID_CANNOT_CANCEL',
    );
    const after = await read(made.data.id);
    expect(after.status).not.toBe('CANCELLED');
    expect(Number(after.outstanding)).toBe(700);
  });
});
