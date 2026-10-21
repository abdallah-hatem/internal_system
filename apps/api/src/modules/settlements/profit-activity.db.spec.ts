import { randomUUID } from 'crypto';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- this suite talks to a real, throwaway Postgres; that is its point
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import { PaymentsService } from '../payments/payments.service';
import { SalesService } from '../sales/sales.service';
import { SettlementsService } from './settlements.service';

/**
 * The Partners page projected every open cycle in turn, ten queries each, to
 * show what each partner has earned so far — 15 s and more once a few hundred
 * cycles were open (2026-10-21, found in the full e2e run). It now projects only
 * the cycles `cyclesWithProfitActivity` names. That is only safe if a cycle it
 * leaves out really projects a profit of zero: these tests hold it to that, and
 * check the cycles that did move money are always named.
 *
 * Runs only against a THROWAWAY database (CLAUDE.md rule 6):
 *
 *   INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/motorcycle_parts_<name> \
 *     npx jest profit-activity.db
 */
// eslint-disable-next-line no-restricted-properties -- an opt-in switch for a suite that must never run by default
const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('which open cycles can have earned anything (Postgres)', () => {
  let prisma: PrismaClient;
  let settlements: SettlementsService;
  let sales: SalesService;
  let partner: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const db = prisma as unknown as PrismaService;
    const audit = { log: jest.fn() } as unknown as AuditService;
    settlements = new SettlementsService(db, audit);
    sales = new SalesService(db, audit, new PaymentsService(db, audit), {
      createForMultipleUsers: () => Promise.resolve({ count: 0 }),
    });
    const user = await prisma.user.create({
      data: {
        email: `activity-${randomUUID()}@example.com`,
        passwordHash: 'x',
        role: 'CORE_PARTNER',
      },
    });
    partner = user.id;
  });
  afterAll(() => prisma.$disconnect());

  /** An open cycle funded by one partner with 10,000 — its contribution in the ledger, as the app writes it. */
  async function fundedCycle(label: string) {
    const tag = randomUUID().slice(0, 8);
    const cycle = await prisma.importCycle.create({
      data: {
        code: `ACT-${label}-${tag}`,
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
    await prisma.financialTransaction.create({
      data: {
        type: 'CAPITAL_CONTRIBUTION',
        category: 'contribution',
        direction: 'INFLOW',
        amount: 10_000,
        currency: 'EGP',
        cycleId: cycle.id,
      },
    });
    return cycle;
  }

  async function stockOn(cycleId: string) {
    const tag = randomUUID().slice(0, 8);
    const product = await prisma.product.create({
      data: {
        sku: `ACT-${tag}`,
        name: `Activity part ${tag}`,
        status: 'ACTIVE',
      },
    });
    await prisma.inventoryBatch.create({
      data: {
        cycleId,
        productId: product.id,
        receivedQty: 10,
        remainingQty: 10,
        saleableQty: 10,
        landedUnitCostEgp: 100,
        verificationStatus: 'VERIFIED',
        createdAt: new Date(Date.now() - 3 * 86_400_000),
      },
    });
    return product;
  }

  it('a funded cycle with stock and nothing sold, spent or lost is left out — and it does project exactly zero', async () => {
    const quiet = await fundedCycle('quiet');
    await stockOn(quiet.id);
    const active = await settlements.cyclesWithProfitActivity([quiet.id]);
    expect(active.has(quiet.id)).toBe(false);

    const projected = await settlements.project(quiet.id);
    expect(projected?.pnl.grossProfit.toFixed(2)).toBe('0.00');
    for (const line of projected?.distribution.lines ?? []) {
      expect(line.netProfit.add(line.feeReceived).toFixed(2)).toBe('0.00');
    }
  });

  it('a cycle with only an expense charged to it is named: it projects a loss, not zero', async () => {
    const spent = await fundedCycle('spent');
    await prisma.financialTransaction.create({
      data: {
        type: 'EXPENSE',
        category: 'customs',
        direction: 'OUTFLOW',
        amount: 600,
        currency: 'EGP',
        cycleId: spent.id,
      },
    });
    expect(
      (await settlements.cyclesWithProfitActivity([spent.id])).has(spent.id),
    ).toBe(true);
    expect(
      (await settlements.project(spent.id))?.pnl.grossProfit.toFixed(2),
    ).toBe('-600.00');
  });

  it('a cycle that sold something is named', async () => {
    const sold = await fundedCycle('sold');
    const product = await stockOn(sold.id);
    const shop = await prisma.customer.create({
      data: {
        type: 'B2B',
        displayName: `Activity shop ${randomUUID().slice(0, 6)}`,
        verificationStatus: 'VERIFIED',
      },
    });
    await sales.create(
      {
        customerId: shop.id,
        channel: 'B2B',
        currency: 'EGP',
        items: [{ productId: product.id, quantity: 2, unitPrice: 250 }],
        confirm: true,
      },
      partner,
    );
    expect(
      (await settlements.cyclesWithProfitActivity([sold.id])).has(sold.id),
    ).toBe(true);
    expect(
      (await settlements.project(sold.id))?.pnl.grossProfit.toFixed(2),
    ).toBe('300.00');
  });

  it('asks about many cycles at once, and an empty list asks nothing', async () => {
    const quiet = await fundedCycle('many-quiet');
    const spent = await fundedCycle('many-spent');
    await prisma.financialTransaction.create({
      data: {
        type: 'EXPENSE',
        category: 'transport_delivery',
        direction: 'OUTFLOW',
        amount: 50,
        currency: 'EGP',
        cycleId: spent.id,
      },
    });
    const active = await settlements.cyclesWithProfitActivity([
      quiet.id,
      spent.id,
      randomUUID(),
    ]);
    expect([...active]).toEqual([spent.id]);
    expect((await settlements.cyclesWithProfitActivity([])).size).toBe(0);
  });
});
