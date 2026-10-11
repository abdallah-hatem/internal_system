import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- this suite talks to a real, throwaway Postgres; that is its point
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { CostingService } from '../costing/costing.service';
import { DeliveriesService } from './deliveries.service';
import { CyclesService } from '../cycles/cycles.service';

/**
 * The race, against a real Postgres (plan B2: "two deliveries sent at once
 * that together exceed what is on the way → exactly one succeeds").
 *
 * The unit suite proves the code takes the lock before it reads; only a real
 * database proves `SELECT … FOR UPDATE` on the cycle row makes the second
 * transaction wait and then read the first one's delivery.
 *
 * Runs only when INTEGRATION_DATABASE_URL points at a THROWAWAY database with
 * the migrations applied — never the dev database (CLAUDE.md rule 6):
 *
 *   docker run -d --name b2_scratch -p 55462:5432 -e POSTGRES_PASSWORD=scratch \
 *     -e POSTGRES_DB=b2scratch --tmpfs /var/lib/postgresql/data postgres:16
 *   DATABASE_URL=postgresql://postgres:scratch@localhost:55462/b2scratch npx prisma migrate deploy
 *   INTEGRATION_DATABASE_URL=postgresql://postgres:scratch@localhost:55462/b2scratch \
 *     npx jest deliveries.db
 */
// eslint-disable-next-line no-restricted-properties -- an opt-in switch for a suite that must never run by default
const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;
const ACTOR = randomUUID();

suite('deliveries and losses against Postgres', () => {
  let prisma: PrismaClient;
  let deliveries: DeliveriesService;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const db = prisma as unknown as PrismaService;
    const audit = { log: jest.fn() } as unknown as AuditService;
    const notifications = {
      createForMultipleUsers: jest.fn(),
    } as unknown as NotificationsService;
    deliveries = new DeliveriesService(
      db,
      audit,
      notifications,
      new CostingService(db),
      new CyclesService(db, audit, notifications),
    );
  });
  afterAll(() => prisma.$disconnect());

  /** A UAE-direct cycle in transit: 40 ordered at 100, one leg costing 400. */
  async function cycleInTransit(china = false) {
    const tag = randomUUID().slice(0, 8);
    const supplier = await prisma.supplier.create({
      data: { name: `Race ${tag}`, country: 'AE' },
    });
    const product = await prisma.product.create({
      data: { sku: `RACE-${tag}`, name: `Race part ${tag}` },
    });
    const cycle = await prisma.importCycle.create({
      data: {
        code: `RACE-${tag}`,
        originType: china ? 'CHINA' : 'UAE_DIRECT',
        currency: 'EGP',
        status: 'IN_TRANSIT',
      },
    });
    const po = await prisma.purchaseOrder.create({
      data: {
        cycleId: cycle.id,
        supplierId: supplier.id,
        reference: `PO-${tag}`,
        currency: 'EGP',
        fxRateToEgp: 1,
        orderedOn: new Date('2026-08-20T00:00:00Z'),
        status: 'CONFIRMED',
      },
    });
    const item = await prisma.purchaseOrderItem.create({
      data: {
        purchaseOrderId: po.id,
        productId: product.id,
        orderedQty: 40,
        unitPrice: 100,
        lineTotal: 4000,
      },
    });
    const leg = await prisma.shippingLeg.create({
      data: {
        cycleId: cycle.id,
        sequence: 1,
        origin: china ? 'Guangzhou, CN' : 'Dubai, UAE',
        destination: china ? 'Dubai, UAE' : 'Cairo, Egypt',
        departedOn: new Date('2026-09-01T00:00:00Z'),
        status: 'IN_TRANSIT',
        costBasis: 'FLAT',
        amount: 400,
        amountEgp: 400,
      },
    });
    if (china) {
      await prisma.shippingLeg.create({
        data: {
          cycleId: cycle.id,
          sequence: 2,
          origin: 'Dubai, UAE',
          destination: 'Cairo, Egypt',
          costBasis: 'FLAT',
          amount: 0,
          amountEgp: 0,
        },
      });
    }
    return { cycle, item, leg, product };
  }

  const line = (item: { id: string }, qty: number) => [
    { purchaseOrderItemId: item.id, qty },
  ];

  it('Two deliveries sent at once that together exceed what is on the way → exactly one succeeds', async () => {
    const { item, leg } = await cycleInTransit();
    const results = await Promise.allSettled(
      [0, 1].map(() =>
        deliveries.recordDelivery(
          leg.id,
          { arrivedOn: '2026-09-20', lines: line(item, 30) },
          ACTOR,
        ),
      ),
    );
    const refused = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toBeInstanceOf(HttpException);
    expect((refused[0].reason as HttpException).getResponse()).toEqual(
      expect.objectContaining({ code: 'DELIVERY_EXCEEDS_IN_TRANSIT' }),
    );
    expect(
      await prisma.shipmentDelivery.count({ where: { legId: leg.id } }),
    ).toBe(1);
  });

  it('A loss and a delivery sent at once that together exceed what is on the way → exactly one succeeds', async () => {
    // Leg 1 of a China cycle: not the last leg, so a loss can take only what
    // is on the way — 40 — and 25 + 25 cannot both fit.
    const { item, leg } = await cycleInTransit(true);
    const results = await Promise.allSettled([
      deliveries.recordLoss(leg.id, { lines: line(item, 25) }, ACTOR),
      deliveries.recordDelivery(
        leg.id,
        { arrivedOn: '2026-09-20', lines: line(item, 25) },
        ACTOR,
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    )!;
    expect((refused.reason as HttpException).getResponse()).toEqual(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- jest's asymmetric matchers are typed any
        code: expect.stringMatching(/^(DELIVERY|LOSS)_EXCEEDS_IN_TRANSIT$/),
      }),
    );
    const [d, l] = await Promise.all([
      prisma.shipmentDelivery.count({ where: { legId: leg.id } }),
      prisma.shipmentLoss.count({ where: { legId: leg.id } }),
    ]);
    expect(d + l).toBe(1);
  });

  it('Loss of 5 → stored at 5 × 110 with no ledger row; the leg reads what the rows say', async () => {
    const { cycle, item, leg } = await cycleInTransit();
    await deliveries.recordDelivery(
      leg.id,
      { arrivedOn: '2026-09-20', lines: line(item, 15) },
      ACTOR,
    );
    await deliveries.recordLoss(leg.id, { lines: line(item, 5) }, ACTOR);
    const loss = await prisma.shipmentLoss.findFirstOrThrow({
      where: { legId: leg.id },
    });
    expect(loss.costEgp.toFixed(2)).toBe('550.00');
    expect(
      await prisma.financialTransaction.count({ where: { cycleId: cycle.id } }),
    ).toBe(0);
    const stored = await prisma.shippingLeg.findUniqueOrThrow({
      where: { id: leg.id },
    });
    expect(stored.status).toBe('PARTLY_ARRIVED');
  });
});
