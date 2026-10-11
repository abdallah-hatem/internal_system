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
 * Loss refunds against a real Postgres (plan B5): the race on the loss cap
 * through a real `SELECT … FOR UPDATE`, the cycle page's read through real
 * Prisma (the payer names come through two relations the fake only imitates),
 * and the foreign key that backs `LOSS_REFUNDED`.
 *
 * Runs only when INTEGRATION_DATABASE_URL points at a THROWAWAY database with
 * the migrations applied — never the dev database (CLAUDE.md rule 6). See
 * `deliveries.db.spec.ts` for the container to start.
 */
// eslint-disable-next-line no-restricted-properties -- an opt-in switch for a suite that must never run by default
const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;
const ACTOR = randomUUID();

suite('loss refunds against Postgres', () => {
  let prisma: PrismaClient;
  let deliveries: DeliveriesService;
  let purchases: PurchasesService;
  let cycles: CyclesService;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.user.create({
      data: {
        id: ACTOR,
        email: `loss-refunds-${ACTOR}@example.test`,
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
      data: { name: `Refund supplier ${tag}`, country: 'AE' },
    });
    const provider = await prisma.provider.create({
      data: { name: `Refund freight ${tag}` },
    });
    const product = await prisma.product.create({
      data: { sku: `LREF-${tag}`, name: `Refund part ${tag}` },
    });
    const cycle = await prisma.importCycle.create({
      data: {
        code: `LREF-${tag}`,
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
    const { data } = await deliveries.recordLoss(
      leg.id,
      { lines: [{ purchaseOrderItemId: item.id, qty: 5 }] },
      ACTOR,
    );
    return { cycle, supplier, provider, loss: data[0] };
  }

  const today = () =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(
      new Date(),
    );

  it('Two refunds of 300 against a 550 loss at once → one succeeds, the other `REFUND_EXCEEDS_LOSS`, not a 500', async () => {
    const { loss, provider } = await cycleWithALoss();
    expect(loss.costEgp.toFixed(2)).toBe('550.00');
    const results = await Promise.allSettled(
      [0, 1].map(() =>
        purchases.recordLossRefund(
          loss.id,
          {
            amount: 300,
            currency: 'EGP',
            fxRateToEgp: 1,
            recordedOn: today(),
            payer: { type: 'SHIPPING_PROVIDER', id: provider.id },
          },
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
      expect.objectContaining({ code: 'REFUND_EXCEEDS_LOSS' }),
    );
    expect(
      await prisma.supplierRefund.count({ where: { shipmentLossId: loss.id } }),
    ).toBe(1);
  });

  it('the shipment read names each payer; a refunded loss is not taken back, and the database refuses the delete too', async () => {
    const { cycle, loss, provider, supplier } = await cycleWithALoss();
    await purchases.recordLossRefund(
      loss.id,
      {
        amount: 2,
        currency: 'USD',
        fxRateToEgp: 50,
        payer: { type: 'SHIPPING_PROVIDER', id: provider.id },
      },
      ACTOR,
    );
    await purchases.recordLossRefund(
      loss.id,
      {
        amount: 100,
        currency: 'EGP',
        fxRateToEgp: 1,
        payer: { type: 'SUPPLIER', id: supplier.id },
      },
      ACTOR,
    );

    const { data } = await cycles.getShipment(cycle.id);
    expect(data.losses[0]).toMatchObject({
      costEgp: '550.00',
      refundedEgp: '200.00',
      unrecoveredEgp: '350.00',
    });
    expect(
      data.losses[0].refunds.map((r) => [
        r.payerType,
        r.payerName,
        r.amountEgp,
      ]),
    ).toEqual(
      expect.arrayContaining([
        ['SHIPPING_PROVIDER', provider.name, '100.00'],
        ['SUPPLIER', supplier.name, '100.00'],
      ]),
    );

    const refused = await deliveries
      .takeBackLoss(loss.id, ACTOR)
      .catch((e: HttpException) => e.getResponse());
    expect(refused).toEqual(expect.objectContaining({ code: 'LOSS_REFUNDED' }));
    await expect(
      prisma.shipmentLoss.delete({ where: { id: loss.id } }),
    ).rejects.toThrow();

    const ledger = await prisma.financialTransaction.findMany({
      where: { cycleId: cycle.id, category: 'loss_refund' },
    });
    expect(ledger.map((t) => t.amount.toFixed(2)).sort()).toEqual([
      '100.00',
      '100.00',
    ]);
  });
});
