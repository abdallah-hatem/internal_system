import { randomUUID } from 'crypto';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- this suite talks to a real, throwaway Postgres; that is its point
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { AuditService } from '../modules/audit/audit.service';
import type { NotificationEvent } from '../modules/notifications/notifications.service';
import { PaymentsService } from '../modules/payments/payments.service';
import { ReturnsService } from '../modules/returns/returns.service';
import { SalesService } from '../modules/sales/sales.service';

/**
 * What one partner did reaches the others (owner 2026-10-25, §10): a sale, a
 * payment, a return, a payment reversed and a confirmed order cancelled each
 * notify every active core partner except the one who did it — through the
 * real services, after the commit.
 *
 * Runs only against a THROWAWAY database (CLAUDE.md rule 6):
 *
 *   INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/motorcycle_parts_<name> \
 *     npx jest partner-news.db
 */
// eslint-disable-next-line no-restricted-properties -- an opt-in switch for a suite that must never run by default
const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;

interface Sent {
  userIds: string[];
  event: NotificationEvent;
}

suite('partner news against Postgres', () => {
  let prisma: PrismaClient;
  let sales: SalesService;
  let payments: PaymentsService;
  let returns: ReturnsService;
  let sent: Sent[];
  let failNext = false;
  let actor: string;
  let other: string;
  let inactive: string;
  let investor: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const db = prisma as unknown as PrismaService;
    const audit = { log: jest.fn() } as unknown as AuditService;
    const notifier = {
      createForMultipleUsers: (userIds: string[], event: NotificationEvent) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error('push down'));
        }
        sent.push({ userIds, event });
        return Promise.resolve({ count: userIds.length });
      },
    };
    payments = new PaymentsService(db, audit, notifier);
    sales = new SalesService(db, audit, payments, notifier);
    returns = new ReturnsService(db, audit, notifier);
    const tag = randomUUID().slice(0, 8);
    const user = (name: string, role: 'CORE_PARTNER' | 'TEMP_INVESTOR', status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE') =>
      prisma.user.create({
        data: { email: `${name}-${tag}@example.com`, passwordHash: 'x', role, status },
      });
    actor = (await user('actor', 'CORE_PARTNER')).id;
    other = (await user('other', 'CORE_PARTNER')).id;
    inactive = (await user('gone', 'CORE_PARTNER', 'INACTIVE')).id;
    investor = (await user('investor', 'TEMP_INVESTOR')).id;
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => {
    sent = [];
  });

  /** A product with 10 units received a few days ago on a selling cycle, and a verified shop. */
  async function setUp() {
    const tag = randomUUID().slice(0, 8);
    const cycle = await prisma.importCycle.create({
      data: { code: `PNW-${tag}`, originType: 'UAE_DIRECT', currency: 'EGP', status: 'SELLING' },
    });
    const product = await prisma.product.create({
      data: { sku: `PNW-${tag}`, name: `Helmet ${tag}`, status: 'ACTIVE' },
    });
    await prisma.inventoryBatch.create({
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
      data: { type: 'B2B', displayName: `Shop ${tag}`, verificationStatus: 'VERIFIED' },
    });
    return { product, shop };
  }

  const sell = (customerId: string, productId: string, confirm: boolean) =>
    sales.create(
      {
        customerId,
        channel: 'B2B',
        currency: 'EGP',
        items: [{ productId, quantity: 4, unitPrice: 250 }],
        confirm,
      },
      actor,
    ) as Promise<{ data: { id: string; orderNo: string } }>;

  /** The one notification sent, checked to reach the other partner and not the actor. */
  function only(eventType: string) {
    const mine = sent.filter((s) => s.event.eventType === eventType);
    expect(mine).toHaveLength(1);
    const [{ userIds, event }] = mine;
    expect(userIds).toContain(other);
    expect(userIds).not.toContain(actor);
    expect(userIds).not.toContain(inactive);
    expect(userIds).not.toContain(investor);
    return event;
  }

  it('a confirmed sale tells the other partners who sold what to whom', async () => {
    const { product, shop } = await setUp();
    const made = await sell(shop.id, product.id, true);
    const event = only('SALE_CONFIRMED');
    expect(event.code).toBe('SALE_RECORDED');
    expect(event.params).toMatchObject({ shop: shop.displayName, orderNo: made.data.orderNo, total: '1,000.00' });
    expect(event.params?.by).toBeTruthy();
    expect(event.payload).toMatchObject({ orderId: made.data.id, customerId: shop.id });
  });

  it('a draft is not news; confirming it is, once', async () => {
    const { product, shop } = await setUp();
    const draft = await sell(shop.id, product.id, false);
    expect(sent).toHaveLength(0);
    const { version } = await prisma.saleOrder.findUniqueOrThrow({ where: { id: draft.data.id } });
    await sales.confirmOrder(draft.data.id, actor, version);
    expect(only('SALE_CONFIRMED').payload).toMatchObject({ orderId: draft.data.id });
  });

  it('a payment tells the other partners the amount, method and orders', async () => {
    const { product, shop } = await setUp();
    const made = await sell(shop.id, product.id, true);
    sent = [];
    await payments.create(
      { customerId: shop.id, amount: 400, currency: 'EGP', method: 'BANK_TRANSFER', orderId: made.data.id },
      actor,
    );
    const event = only('PAYMENT_RECEIVED');
    expect(event.code).toBe('PAYMENT_RECORDED');
    expect(event.params).toMatchObject({ amount: '400.00', method: 'BANK_TRANSFER', orders: made.data.orderNo });
  });

  it('a payment reversed tells them, with the reason', async () => {
    const { product, shop } = await setUp();
    const made = await sell(shop.id, product.id, true);
    const paid = (await payments.create(
      { customerId: shop.id, amount: 400, currency: 'EGP', orderId: made.data.id },
      actor,
    )) as { data: { id: string } };
    sent = [];
    await payments.reverse(paid.data.id, 'Cheque bounced', actor);
    const event = only('PAYMENT_REVERSED');
    expect(event.params).toMatchObject({ amount: '400.00', reason: 'Cheque bounced', shop: shop.displayName });
  });

  it('a return tells them what came back and how it was refunded', async () => {
    const { product, shop } = await setUp();
    const made = await sell(shop.id, product.id, true);
    const item = await prisma.saleItem.findFirstOrThrow({ where: { saleOrderId: made.data.id } });
    sent = [];
    await returns.create(
      { saleOrderId: made.data.id, reason: 'Wrong size', items: [{ saleItemId: item.id, qty: 1 }] },
      actor,
    );
    const event = only('SALE_RETURNED');
    expect(event.code).toBe('SALE_RETURNED_CREDIT');
    expect(event.params).toMatchObject({ orderNo: made.data.orderNo, refund: '250.00', reason: 'Wrong size' });
    expect(String(event.params?.items)).toBe(`1 × ${product.name}`);
  });

  it('a confirmed order cancelled tells them; a draft cancelled does not', async () => {
    const { product, shop } = await setUp();
    const draft = await sell(shop.id, product.id, false);
    await sales.cancelOrder(draft.data.id, actor);
    expect(sent).toHaveLength(0);

    const made = await sell(shop.id, product.id, true);
    sent = [];
    await sales.cancelOrder(made.data.id, actor);
    const event = only('ORDER_CANCELLED');
    expect(event.params).toMatchObject({ orderNo: made.data.orderNo, total: '1,000.00' });
  });

  it('the news failing never fails the sale', async () => {
    const { product, shop } = await setUp();
    failNext = true;
    const made = await sell(shop.id, product.id, true);
    const stored = await prisma.saleOrder.findUniqueOrThrow({ where: { id: made.data.id } });
    expect(stored.status).toBe('CONFIRMED');
  });
});
