import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- this suite talks to a real, throwaway Postgres; that is its point
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { CostingService } from '../costing/costing.service';
import { CyclesService } from '../cycles/cycles.service';
import { DeliveriesService } from '../shipping/deliveries.service';
import { PurchasesService } from './purchases.service';

/**
 * Undoing a refund against a real Postgres (plan B5b): the two foreign keys
 * the fake cannot model — the loss's RESTRICT that `LOSS_REFUNDED` leans on,
 * and the refund's link to its balancing ledger row — and two undos racing
 * through a real `SELECT … FOR UPDATE`.
 *
 * Runs only when INTEGRATION_DATABASE_URL points at a THROWAWAY database with
 * the migrations applied — never the dev database (CLAUDE.md rule 6). See
 * `deliveries.db.spec.ts` for the container to start.
 */
// eslint-disable-next-line no-restricted-properties -- an opt-in switch for a suite that must never run by default
const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;
const ACTOR = randomUUID();

suite('undoing a refund against Postgres', () => {
  let prisma: PrismaClient;
  let deliveries: DeliveriesService;
  let purchases: PurchasesService;
  let cycles: CyclesService;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.user.create({
      data: {
        id: ACTOR,
        email: `refund-reversal-${ACTOR}@example.test`,
        passwordHash: 'x',
        role: 'CORE_PARTNER',
      },
    });
    const db = prisma as unknown as PrismaService;
    const audit = { log: jest.fn() } as unknown as AuditService;
    const notifications = {
      createForMultipleUsers: jest.fn(),
    } as unknown as NotificationsService;
    const costing = new CostingService(db);
    cycles = new CyclesService(db, audit, notifications);
    deliveries = new DeliveriesService(
      db,
      audit,
      notifications,
      costing,
      cycles,
    );
    purchases = new PurchasesService(db, audit, notifications);
  });
  afterAll(() => prisma.$disconnect());

  /** 40 ordered at 100 and a 400 leg (110 a unit); 5 lost on the way = 550. */
  async function cycleWithALoss() {
    const tag = randomUUID().slice(0, 8);
    const supplier = await prisma.supplier.create({
      data: { name: `Undo supplier ${tag}`, country: 'AE' },
    });
    const provider = await prisma.provider.create({
      data: { name: `Undo freight ${tag}` },
    });
    const product = await prisma.product.create({
      data: { sku: `UREF-${tag}`, name: `Undo part ${tag}` },
    });
    const cycle = await prisma.importCycle.create({
      data: {
        code: `UREF-${tag}`,
        originType: 'UAE_DIRECT',
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
        origin: 'Dubai, UAE',
        destination: 'Cairo, Egypt',
        providerId: provider.id,
        departedOn: new Date('2026-09-01T00:00:00Z'),
        status: 'IN_TRANSIT',
        costBasis: 'FLAT',
        amount: 400,
        amountEgp: 400,
      },
    });
    // L8 (2026-10-12): a leg's goods leave in departures. This one left with
    // everything ordered, as the migration reads a dated leg.
    await prisma.shipmentDeparture.create({
      data: {
        legId: leg.id,
        departedOn: new Date('2026-09-01T00:00:00Z'),
        lines: { create: [{ purchaseOrderItemId: item.id, qty: 40 }] },
      },
    });
    const { data } = await deliveries.recordLoss(
      leg.id,
      { lines: [{ purchaseOrderItemId: item.id, qty: 5 }] },
      ACTOR,
    );
    return { cycle, supplier, provider, loss: data[0] };
  }

  const refundOn = async (lossId: string, providerId: string, amount: number) =>
    (
      await purchases.recordLossRefund(
        lossId,
        {
          amount,
          currency: 'EGP',
          fxRateToEgp: 1,
          payer: { type: 'SHIPPING_PROVIDER', id: providerId },
        },
        ACTOR,
      )
    ).data;

  it('After every refund on a loss is undone → the loss is taken back past the foreign key; the refunds and both ledger pairs stay', async () => {
    const { cycle, loss, provider } = await cycleWithALoss();
    const a = await refundOn(loss.id, provider.id, 300);
    const b = await refundOn(loss.id, provider.id, 200);

    await purchases.reverseRefund(a.id, { reason: 'Turned up' }, ACTOR);
    const refused = await deliveries
      .takeBackLoss(loss.id, ACTOR)
      .catch((e: HttpException) => e.getResponse());
    expect(refused).toEqual(expect.objectContaining({ code: 'LOSS_REFUNDED' }));

    await purchases.reverseRefund(b.id, { reason: 'Turned up' }, ACTOR);
    await deliveries.takeBackLoss(loss.id, ACTOR);
    expect(
      await prisma.shipmentLoss.findUnique({ where: { id: loss.id } }),
    ).toBeNull();

    const refunds = await prisma.supplierRefund.findMany({
      where: { id: { in: [a.id, b.id] } },
      include: { reversalTransaction: true },
    });
    expect(refunds).toHaveLength(2);
    for (const r of refunds) {
      expect(r.reversedAt).not.toBeNull();
      expect(r.shipmentLossId).toBeNull();
      expect(r.reversalTransaction).toMatchObject({
        direction: 'OUTFLOW',
        relatedId: r.id,
      });
    }
    const ledger = await prisma.financialTransaction.findMany({
      where: { cycleId: cycle.id, category: 'loss_refund' },
    });
    expect(ledger).toHaveLength(4);
    const net = ledger.reduce(
      (s, t) => s + (t.direction === 'INFLOW' ? 1 : -1) * Number(t.amount),
      0,
    );
    expect(net).toBe(0);

    const { data } = await cycles.getShipment(cycle.id);
    expect(data.losses).toEqual([]);
  });

  it('Two undos of one refund at once → one balancing entry, the other `ENTRY_ALREADY_REVERSED`', async () => {
    const { loss, provider } = await cycleWithALoss();
    const r = await refundOn(loss.id, provider.id, 100);
    const results = await Promise.allSettled(
      [0, 1].map(() =>
        purchases.reverseRefund(r.id, { reason: 'Double click' }, ACTOR),
      ),
    );
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find(
      (x): x is PromiseRejectedResult => x.status === 'rejected',
    )!;
    expect((failed.reason as HttpException).getResponse()).toEqual(
      expect.objectContaining({ code: 'ENTRY_ALREADY_REVERSED' }),
    );
    const original = await prisma.financialTransaction.findFirst({
      where: { relatedId: r.id, reversalOfId: null },
    });
    expect(
      await prisma.financialTransaction.count({
        where: { reversalOfId: original!.id },
      }),
    ).toBe(1);
  });
});
