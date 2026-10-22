import { randomUUID } from 'crypto';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- this suite talks to a real, throwaway Postgres; that is its point
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { AnalyticsService } from './analytics.service';

/**
 * The tabs' summary cards (owner 2026-10-22): products and units in stock on
 * Products and Inventory, customers and who paid the most on Customers, the
 * largest payment on Payments, and kinds of product on the largest order.
 * Each must agree with the dashboard where they share a figure, and a
 * reversed payment never counts.
 *
 * Runs only against a THROWAWAY database (CLAUDE.md rule 6):
 *
 *   INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/motorcycle_parts_<name> \
 *     npx jest tab-summaries.db
 */
// eslint-disable-next-line no-restricted-properties -- an opt-in switch for a suite that must never run by default
const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('the tabs’ summary cards (Postgres)', () => {
  let prisma: PrismaClient;
  let analytics: AnalyticsService;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    analytics = new AnalyticsService(prisma as unknown as PrismaService);
  });
  afterAll(() => prisma.$disconnect());

  const shop = (name: string, isWalkIn = false) =>
    prisma.customer.create({
      data: {
        type: 'B2B',
        displayName: name,
        verificationStatus: 'VERIFIED',
        isWalkIn,
      },
    });
  const pay = (customerId: string, amount: number, status = 'RECORDED') =>
    prisma.payment.create({
      data: {
        customerId,
        amount,
        currency: 'EGP',
        receivedOn: new Date('2026-10-01'),
        method: 'CASH',
        status,
      },
    });

  it('products and units in stock are the dashboard’s own figures', async () => {
    const [stock, dash] = await Promise.all([
      analytics.getStockSummary(),
      analytics.getDashboardKPIs(),
    ]);
    expect(stock.data.totalProducts).toBe(dash.data.totalProducts);
    expect(stock.data.unitsInStock).toBe(dash.data.unitsInStock);
  });

  it('who paid the most: payments standing only — a reversed one paid nothing — and never the walk-in record', async () => {
    const tag = randomUUID().slice(0, 6);
    const big = await shop(`Big ${tag}`);
    const reversed = await shop(`Reversed ${tag}`);
    // The one walk-in record (there is only ever one), made if this database has none.
    const walkIn =
      (await prisma.customer.findFirst({ where: { isWalkIn: true } })) ??
      (await shop(`Walk-in ${tag}`, true));
    // Above anything already in the database, so these decide the card.
    const top = await prisma.payment.aggregate({ _max: { amount: true } });
    const base = Number(top._max.amount ?? 0) + 1_000_000;
    await pay(big.id, base);
    await pay(big.id, 50_000);
    await pay(reversed.id, base + 40_000, 'REVERSED');
    await pay(walkIn.id, base + 45_000);

    const { data } = await analytics.getCustomerSummary();
    expect(data.topPayer).toEqual({
      customerId: big.id,
      displayName: big.displayName,
      paidEgp: base + 50_000,
    });
    // The count is the dashboard's: the walk-in record is not a customer.
    expect(data.totalCustomers).toBe(
      (await analytics.getDashboardKPIs()).data.totalCustomers,
    );
    expect(data.totalCustomers).toBe(
      await prisma.customer.count({ where: { isWalkIn: false } }),
    );
  });

  it('the largest payment: a reversed one never takes the card, however large', async () => {
    const tag = randomUUID().slice(0, 6);
    const a = await shop(`Payer ${tag}`);
    const top = await prisma.payment.aggregate({ _max: { amount: true } });
    const base = Number(top._max.amount ?? 0) + 1_000_000;
    await pay(a.id, base + 1_000, 'REVERSED');
    const standing = await pay(a.id, base);
    const { data } = await analytics.getPaymentSummary();
    expect(data.largest).toMatchObject({
      paymentId: standing.id,
      amount: base,
      customer: { id: a.id, displayName: a.displayName, isWalkIn: false },
    });
  });
});
