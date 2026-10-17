import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- this suite talks to a real, throwaway Postgres; that is its point
import { PrismaClient, Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { CostingService } from '../costing/costing.service';
import { CyclesService } from '../cycles/cycles.service';
import { InventoryService } from '../inventory/inventory.service';
import { PaymentsService } from '../payments/payments.service';
import { ReturnsService } from '../returns/returns.service';
import { SalesService } from '../sales/sales.service';
import { SettlementsService } from '../settlements/settlements.service';
import { StockTransfersService } from '../stock-transfers/stock-transfers.service';
import { DeliveriesService } from './deliveries.service';
import { ShippingService } from './shipping.service';

/**
 * Correcting a leg's cost after goods arrived re-costs the cycle (BUSINESS_LOGIC
 * §2, owner 2026-10-17: "per-product cost is very important").
 *
 * Against a real Postgres, because the re-cost touches batches, purchase rows,
 * sale allocations and returns written by the real receipt, sale and return
 * services — a fake would only prove the fake agrees with itself. Every
 * fixture is built through those services: an order, a departure, a delivery,
 * a verified receipt, a walk-in sale, a return.
 *
 * Runs only when INTEGRATION_DATABASE_URL points at a THROWAWAY database with
 * the migrations applied — never the dev database (CLAUDE.md rule 6). An
 * agent's own database does (`scripts/agent-env.sh <name>`):
 *
 *   INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/motorcycle_parts_<name> \
 *     npx jest leg-recost.db --runInBand
 *
 * The dashboard figures are whole-database sums, read before and after; run
 * the file on its own so nothing else writes in between.
 */
// eslint-disable-next-line no-restricted-properties -- an opt-in switch for a suite that must never run by default
const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;
const ACTOR = randomUUID();
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

suite(
  'correcting a leg cost after arrival re-costs the cycle (Postgres)',
  () => {
    let prisma: PrismaClient;
    let audit: { log: jest.Mock };
    let shipping: ShippingService;
    let deliveries: DeliveriesService;
    let inventory: InventoryService;
    let cycles: CyclesService;
    let sales: SalesService;
    let returns: ReturnsService;
    let analytics: AnalyticsService;
    let settlements: SettlementsService;
    let transfers: StockTransfersService;

    beforeAll(async () => {
      prisma = new PrismaClient({ datasources: { db: { url } } });
      await prisma.user.create({
        data: {
          id: ACTOR,
          email: `legcost-${ACTOR}@example.test`,
          passwordHash: 'x',
          role: 'CORE_PARTNER',
        },
      });
      const db = prisma as unknown as PrismaService;
      audit = { log: jest.fn() };
      const auditService = audit as unknown as AuditService;
      const notifications = {
        createForMultipleUsers: jest.fn(),
      } as unknown as NotificationsService;
      const costing = new CostingService(db);
      cycles = new CyclesService(db, auditService, notifications, costing);
      deliveries = new DeliveriesService(
        db,
        auditService,
        notifications,
        costing,
        cycles,
      );
      shipping = new ShippingService(db, auditService, costing, deliveries);
      inventory = new InventoryService(
        db,
        auditService,
        notifications,
        costing,
        cycles,
      );
      sales = new SalesService(
        db,
        auditService,
        new PaymentsService(db, auditService),
        { createForMultipleUsers: () => Promise.resolve({ count: 0 }) },
      );
      returns = new ReturnsService(db, auditService);
      analytics = new AnalyticsService(db);
      settlements = new SettlementsService(db, auditService, costing);
      transfers = new StockTransfersService(db, auditService);
    });
    afterAll(() => prisma.$disconnect());

    // ─── Fixtures, through the services ─────────────────────────────────────

    interface Line {
      qty: number;
      lineTotal: number;
    }

    /**
     * A UAE-direct cycle in Egypt: one order of `lines`, one Dubai → Cairo leg
     * at `legAmount` that left with everything, and a participant funding it.
     */
    async function arrivedCycle(lines: Line[], legAmount: number) {
      const tag = randomUUID().slice(0, 8);
      const supplier = await prisma.supplier.create({
        data: { name: `Recost ${tag}`, country: 'AE' },
      });
      const cycle = await prisma.importCycle.create({
        data: {
          code: `RC-${tag}`,
          originType: 'UAE_DIRECT',
          currency: 'EGP',
          status: 'ARRIVED_EGYPT',
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
      const items = [];
      const products = [];
      for (const [i, l] of lines.entries()) {
        const product = await prisma.product.create({
          data: { sku: `RC-${tag}-${i}`, name: `Recost part ${tag}-${i}` },
        });
        products.push(product);
        items.push(
          await prisma.purchaseOrderItem.create({
            data: {
              purchaseOrderId: po.id,
              productId: product.id,
              orderedQty: l.qty,
              unitPrice: l.lineTotal / l.qty,
              lineTotal: l.lineTotal,
            },
          }),
        );
      }
      const leg = await prisma.shippingLeg.create({
        data: {
          cycleId: cycle.id,
          sequence: 1,
          origin: 'Dubai, UAE',
          destination: 'Cairo, Egypt',
          departedOn: new Date('2026-09-01T00:00:00Z'),
          status: 'IN_TRANSIT',
          costBasis: 'FLAT',
          amount: legAmount,
          amountEgp: legAmount,
        },
      });
      await prisma.shipmentDeparture.create({
        data: {
          legId: leg.id,
          departedOn: new Date('2026-09-01T00:00:00Z'),
          lines: {
            create: items.map((it, i) => ({
              purchaseOrderItemId: it.id,
              qty: lines[i].qty,
            })),
          },
        },
      });
      // The partner's capital, declared and recorded arriving, as the wizard
      // books it (check-data 14).
      const capital = lines.reduce((s, l) => s + l.lineTotal, legAmount);
      const participant = await prisma.cycleParticipant.create({
        data: {
          cycleId: cycle.id,
          participantType: 'CORE_PARTNER',
          partnerUserId: ACTOR,
          contributionAmount: capital,
        },
      });
      await prisma.financialTransaction.create({
        data: {
          type: 'CAPITAL_CONTRIBUTION',
          category: 'contribution',
          direction: 'INFLOW',
          amount: capital,
          currency: 'EGP',
          cycleId: cycle.id,
          relatedType: 'CYCLE_PARTICIPANT',
          relatedId: participant.id,
          createdBy: ACTOR,
        },
      });
      return { cycle, leg, items, products };
    }

    /** One delivery to Cairo of `qtys` per line, on 9 September. */
    async function deliver(legId: string, itemIds: string[], qtys: number[]) {
      const { data } = await deliveries.recordDelivery(
        legId,
        {
          arrivedOn: '2026-09-09',
          lines: itemIds.map((id, i) => ({
            purchaseOrderItemId: id,
            qty: qtys[i],
          })),
        },
        ACTOR,
      );
      return data;
    }

    type Delivery = Awaited<ReturnType<typeof deliver>>;

    /** A verified receipt of `qtys` from the delivery's lines (same order). */
    async function receive(
      cycleId: string,
      delivery: Delivery,
      qtys: number[],
      override?: number,
    ) {
      await inventory.verifyStock(
        cycleId,
        {
          deliveryId: delivery.id,
          receivedOn: '2026-09-09',
          items: delivery.lines
            .map((l, i) => ({
              deliveryLineId: l.id,
              receivedQty: qtys[i],
              landedUnitCostEgp: i === 0 ? override : undefined,
            }))
            .filter((x) => x.receivedQty > 0),
        },
        ACTOR,
      );
    }

    /** A walk-in sale of `qty` at 1,000 each; its one sale item. */
    async function sell(productId: string, qty: number) {
      const sold = (await sales.create(
        {
          walkIn: true,
          channel: 'B2C',
          currency: 'EGP',
          items: [{ productId, quantity: qty, unitPrice: 1000 }],
        },
        ACTOR,
      )) as { data: { id: string } };
      const item = await prisma.saleItem.findFirstOrThrow({
        where: { saleOrderId: sold.data.id },
      });
      return { orderId: sold.data.id, saleItemId: item.id };
    }

    async function giveBack(
      sale: { orderId: string; saleItemId: string },
      qty: number,
      restock: boolean,
    ) {
      await returns.create(
        {
          saleOrderId: sale.orderId,
          reason: 'Came back from the shop',
          refundMethod: 'CASH',
          items: [{ saleItemId: sale.saleItemId, qty, restock }],
        },
        ACTOR,
      );
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

    const setLeg = (legId: string, amount: number) =>
      shipping.updateLeg(legId, { costBasis: 'FLAT', amount }, ACTOR);

    /**
     * Every stored figure a re-cost touches, by product, in receipt order —
     * comparable between two cycles (no ids).
     */
    async function figures(cycleId: string) {
      const batches = await prisma.inventoryBatch.findMany({
        where: { cycleId },
        include: {
          product: true,
          saleItemAllocations: { orderBy: { createdAt: 'asc' } },
          returnItems: { include: { saleReturn: true } },
          movements: { where: { movementType: 'RECEIVE' } },
        },
      });
      batches.sort(
        (a, b) =>
          a.movements[0].occurredAt.getTime() -
            b.movements[0].occurredAt.getTime() ||
          a.product.name.localeCompare(b.product.name),
      );
      const ledger = await prisma.financialTransaction.findMany({
        where: { cycleId, type: 'PURCHASE_COST' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      return {
        batches: batches.map((b) => ({
          product: b.product.name.replace(/^Recost part [^-]+-/, ''),
          qty: b.receivedQty.toString(),
          remaining: b.remainingQty.toString(),
          unit: b.landedUnitCostEgp.toFixed(4),
          allocations: b.saleItemAllocations.map(
            (a) =>
              `${a.qty.toString()}@${a.unitCostEgp.toFixed(4)}=${a.cogsEgp.toFixed(2)}`,
          ),
          returns: b.returnItems.map(
            (r) =>
              `${r.qty.toString()}@${r.unitCostEgp.toFixed(4)}=${r.cogsReversedEgp.toFixed(2)}/${r.saleReturn.cogsReversedEgp.toFixed(2)}`,
          ),
        })),
        ledger: ledger.map((t) => `${t.amount.toFixed(2)} ${t.reason}`),
      };
    }

    const dashboard = async () => (await analytics.getDashboardKPIs()).data;
    const profitability = async (cycleId: string) =>
      (await analytics.getCycleProfitability()).data.find(
        (c) => c.cycleId === cycleId,
      )!;

    /**
     * The owner's case, CYC-2026-0001: a leg entered at 0, every line received
     * in one batch, sales drawn, one return restocked and one damaged.
     * A: 3 ordered for 300, B: 7 for 350. The real fee is 1,000 → A carries
     * 300 of it (100 a unit), B 700 (100 a unit).
     */
    async function ownersCase() {
      const world = await arrivedCycle(
        [
          { qty: 3, lineTotal: 300 },
          { qty: 7, lineTotal: 350 },
        ],
        0,
      );
      const ids = world.items.map((i) => i.id);
      const delivery = await deliver(world.leg.id, ids, [3, 7]);
      await receive(world.cycle.id, delivery, [3, 7]);
      const saleA = await sell(world.products[0].id, 2);
      const saleB = await sell(world.products[1].id, 4);
      await giveBack(saleA, 1, false); // damaged: its cost stays spent
      await giveBack(saleB, 1, true); // back on the shelf
      return { ...world, saleA, saleB };
    }

    // ─── The happy path, once, with every reader ─────────────────────────────

    it("The owner's case: leg 0 → 1,000 after receipt and sales → batches, purchase rows, allocations and returns all carry the freight; dashboard COGS and cycle profit move by the freight on the units sold, stock value by the freight on the units left", async () => {
      const w = await ownersCase();
      const kpiBefore = await dashboard();
      const cycleBefore = await profitability(w.cycle.id);
      const projBefore = (await settlements.project(w.cycle.id))!;
      const topBefore = (await analytics.getTopProducts(1000)).data;

      // The form is told the cost can still change, and that it re-prices.
      const shipment = (await cycles.getShipment(w.cycle.id)).data;
      expect(shipment.costEditable).toBe(true);
      expect(shipment.costLockedReason).toBeNull();
      expect(shipment.costChangeRecosts).toBe(true);

      audit.log.mockClear();
      await setLeg(w.leg.id, 1000);

      const f = await figures(w.cycle.id);
      expect(f.batches).toEqual([
        {
          product: '0',
          qty: '3',
          remaining: '1',
          unit: '200.0000',
          allocations: ['2@200.0000=400.00'],
          returns: ['1@200.0000=0.00/0.00'],
        },
        {
          product: '1',
          qty: '7',
          remaining: '4',
          unit: '150.0000',
          allocations: ['4@150.0000=600.00'],
          returns: ['1@150.0000=150.00/150.00'],
        },
      ]);
      expect(f.ledger.sort()).toEqual([
        '1050.00 Auto: 7 units received at 150.00 EGP/unit landed',
        '600.00 Auto: 3 units received at 200.00 EGP/unit landed',
      ]);

      // Freight on the units sold: A 2 (one came back damaged, its cost stays
      // spent) and B 3 net → 5 × 100. On the units left: A 1, B 4 → 5 × 100.
      const kpiAfter = await dashboard();
      expect(D(kpiAfter.totalCogs).sub(kpiBefore.totalCogs).toFixed(2)).toBe(
        '500.00',
      );
      expect(
        D(kpiAfter.inventoryValue).sub(kpiBefore.inventoryValue).toFixed(2),
      ).toBe('500.00');

      const cycleAfter = await profitability(w.cycle.id);
      expect(
        D(cycleAfter.totalCost).sub(cycleBefore.totalCost).toFixed(2),
      ).toBe('500.00');
      expect(D(cycleBefore.profit).sub(cycleAfter.profit).toFixed(2)).toBe(
        '500.00',
      );
      expect(
        D(cycleAfter.unsoldValueEgp).sub(cycleBefore.unsoldValueEgp).toFixed(2),
      ).toBe('500.00');
      // What the cycle consumed: the purchase rows now carry the freight.
      expect(
        D(cycleAfter.investment).sub(cycleBefore.investment).toFixed(2),
      ).toBe('1000.00');

      // The settlement projection reads the same rows.
      const projAfter = (await settlements.project(w.cycle.id))!;
      expect(projAfter.pnl.cogs.sub(projBefore.pnl.cogs).toFixed(2)).toBe(
        '500.00',
      );
      expect(
        projAfter.pnl.unsoldValue.sub(projBefore.pnl.unsoldValue).toFixed(2),
      ).toBe('500.00');

      // Per product: the margin now carries the freight.
      const top = (await analytics.getTopProducts(1000)).data;
      const cogsOf = (list: typeof top, id: string) =>
        list.find((p) => p.productId === id)!.cogsEgp;
      expect(cogsOf(topBefore, w.products[0].id)).toBe(200);
      expect(cogsOf(top, w.products[0].id)).toBe(400);
      expect(cogsOf(topBefore, w.products[1].id)).toBe(150);
      expect(cogsOf(top, w.products[1].id)).toBe(450);

      // Everything the line cost lands once: sold cost less what came back
      // onto the shelf, plus what is still on it, is its landed total.
      const landed = await new CostingService(
        prisma as unknown as PrismaService,
      ).computeCycleLandedCosts(w.cycle.id);
      for (const item of landed.items) {
        const batches = await prisma.inventoryBatch.findMany({
          where: { sourcePoItemId: item.purchaseOrderItemId },
          include: { saleItemAllocations: true, returnItems: true },
        });
        const accounted = batches.reduce(
          (s, b) =>
            s
              .add(
                b.saleItemAllocations.reduce((x, a) => x.add(a.cogsEgp), D(0)),
              )
              .sub(
                b.returnItems.reduce((x, r) => x.add(r.cogsReversedEgp), D(0)),
              )
              .add(b.remainingQty.mul(b.landedUnitCostEgp)),
          D(0),
        );
        expect(accounted.toFixed(2)).toBe(item.totalLandedCostEgp.toFixed(2));
      }
      expect(landed.totalLandedEgp.toFixed(2)).toBe('1650.00');

      // One audit entry, written in the transaction, with old and new costs.
      const entries = audit.log.mock.calls.filter(
        ([p]) => (p as { entityType: string }).entityType === 'ShippingLeg',
      );
      expect(entries).toHaveLength(1);
      const [params, tx] = entries[0] as [
        { afterJson: { recost: Record<string, unknown> } },
        unknown,
      ];
      expect(tx).toBeDefined();
      expect(params.afterJson.recost).toEqual({
        oldAmountEgp: '0.00',
        newAmountEgp: '1000.00',
        batches: expect.arrayContaining([
          expect.objectContaining({
            oldUnitCostEgp: '100.0000',
            newUnitCostEgp: '200.0000',
          }),
          expect.objectContaining({
            oldUnitCostEgp: '50.0000',
            newUnitCostEgp: '150.0000',
          }),
        ]) as unknown,
      });

      // The data stays sane: the same unit on every allocation as its batch.
      const stray = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM sale_item_allocations a
      JOIN inventory_batches b ON b.id = a.inventory_batch_id
      WHERE b.cycle_id = ${w.cycle.id}::uuid AND a.unit_cost_egp <> b.landed_unit_cost_egp`;
      expect(Number(stray[0].n)).toBe(0);
    });

    // ─── The limits ──────────────────────────────────────────────────────────

    it('A cost moved down, all the way to 0 → every unit drops back to goods only; purchase rows are the goods cost', async () => {
      const w = await arrivedCycle(
        [
          { qty: 3, lineTotal: 300 },
          { qty: 7, lineTotal: 350 },
        ],
        1000,
      );
      const d = await deliver(
        w.leg.id,
        w.items.map((i) => i.id),
        [3, 7],
      );
      await receive(w.cycle.id, d, [3, 7]);
      await sell(w.products[0].id, 1);

      await setLeg(w.leg.id, 400); // down, not to zero
      let f = await figures(w.cycle.id);
      expect(f.batches.map((b) => b.unit)).toEqual(['140.0000', '90.0000']);

      await setLeg(w.leg.id, 0);
      f = await figures(w.cycle.id);
      expect(f.batches.map((b) => b.unit)).toEqual(['100.0000', '50.0000']);
      expect(f.batches[0].allocations).toEqual(['1@100.0000=100.00']);
      expect(f.ledger.map((l) => l.split(' ')[0]).sort()).toEqual([
        '300.00',
        '350.00',
      ]);
    });

    it('A line received in three batches → the residual lands on the last batch exactly as a fresh receipt at the new cost gives it', async () => {
      // 3 ordered for 100: 33.3333 a unit. A 1-pound fee makes it 101 — 33.6667.
      const corrected = await arrivedCycle([{ qty: 3, lineTotal: 100 }], 0);
      const fresh = await arrivedCycle([{ qty: 3, lineTotal: 100 }], 1);
      for (const w of [corrected, fresh]) {
        const d = await deliver(w.leg.id, [w.items[0].id], [3]);
        for (let i = 0; i < 3; i++) await receive(w.cycle.id, d, [1]);
      }
      const before = await figures(corrected.cycle.id);
      expect(before.batches.map((b) => b.unit)).toEqual([
        '33.3333',
        '33.3333',
        '33.3400',
      ]);

      await setLeg(corrected.leg.id, 1);

      const after = await figures(corrected.cycle.id);
      expect(after).toEqual(await figures(fresh.cycle.id));
      expect(after.batches.map((b) => b.unit)).toEqual([
        '33.6667',
        '33.6667',
        '33.6600',
      ]);
      expect(after.ledger.map((l) => l.split(' ')[0])).toEqual([
        '33.67',
        '33.67',
        '33.66',
      ]);
    });

    it('Nothing received yet → the cost moves freely and nothing is re-costed (unchanged rule)', async () => {
      const w = await arrivedCycle([{ qty: 3, lineTotal: 300 }], 0);
      await deliver(w.leg.id, [w.items[0].id], [3]);
      const shipment = (await cycles.getShipment(w.cycle.id)).data;
      expect(shipment.costEditable).toBe(true);
      expect(shipment.costChangeRecosts).toBe(false);
      await setLeg(w.leg.id, 900);
      expect(
        (
          await prisma.shippingLeg.findUniqueOrThrow({
            where: { id: w.leg.id },
          })
        ).amountEgp?.toFixed(2),
      ).toBe('900.00');
    });

    // ─── The wrong context: each refusal, and nothing moves ─────────────────

    /** Refused with `code`; the leg, its batches and the form all say so. */
    async function expectLocked(
      w: { cycle: { id: string }; leg: { id: string } },
      code: string,
    ) {
      const before = await figures(w.cycle.id);
      const legBefore = await prisma.shippingLeg.findUniqueOrThrow({
        where: { id: w.leg.id },
      });
      expect(await refusal(setLeg(w.leg.id, 1000))).toBe(code);
      expect(await figures(w.cycle.id)).toEqual(before);
      const legAfter = await prisma.shippingLeg.findUniqueOrThrow({
        where: { id: w.leg.id },
      });
      expect(legAfter.amountEgp?.toFixed(2)).toBe(
        legBefore.amountEgp?.toFixed(2),
      );
      // The edit form reads the same verdict, by the same code.
      const shipment = (await cycles.getShipment(w.cycle.id)).data;
      expect(shipment.costEditable).toBe(false);
      expect(shipment.costLockedReason).toBe(code);
    }

    async function receivedCycle() {
      const w = await arrivedCycle([{ qty: 3, lineTotal: 300 }], 0);
      const d = await deliver(w.leg.id, [w.items[0].id], [3]);
      await receive(w.cycle.id, d, [3]);
      return w;
    }

    it('A draft settlement → LEG_COST_LOCKED_SETTLEMENT; approved → the same; reversed → re-cost allowed', async () => {
      const w = await receivedCycle();
      await sell(w.products[0].id, 1);
      await settlements.calculate(w.cycle.id, ACTOR);
      await expectLocked(w, 'LEG_COST_LOCKED_SETTLEMENT');

      const s = await prisma.settlement.findFirstOrThrow({
        where: { cycleId: w.cycle.id },
      });
      await prisma.settlement.update({
        where: { id: s.id },
        data: { status: 'APPROVED' },
      });
      await expectLocked(w, 'LEG_COST_LOCKED_SETTLEMENT');

      // A reversed settlement agreed nothing that stands.
      await prisma.settlement.update({
        where: { id: s.id },
        data: { status: 'REVERSED' },
      });
      await setLeg(w.leg.id, 300);
      expect((await figures(w.cycle.id)).batches[0].unit).toBe('200.0000');
    });

    it('A cycle being settled, closed or cancelled → LEG_COST_LOCKED_SETTLEMENT', async () => {
      const w = await receivedCycle();
      // Everything is received, so the cycle can walk to SETTLEMENT for real.
      await cycles.transition(w.cycle.id, 'SETTLEMENT', ACTOR);
      await expectLocked(w, 'LEG_COST_LOCKED_SETTLEMENT');
      for (const status of ['CLOSED', 'CANCELLED'] as const) {
        await prisma.importCycle.update({
          where: { id: w.cycle.id },
          data: { status },
        });
        await expectLocked(w, 'LEG_COST_LOCKED_SETTLEMENT');
      }
    });

    it('A loss on the cycle → LEG_COST_LOCKED_LOSSES', async () => {
      const w = await arrivedCycle([{ qty: 3, lineTotal: 300 }], 0);
      const d = await deliver(w.leg.id, [w.items[0].id], [2]);
      await deliveries.recordLoss(
        w.leg.id,
        { lines: [{ purchaseOrderItemId: w.items[0].id, qty: 1 }] },
        ACTOR,
      );
      await receive(w.cycle.id, d, [2]);
      await expectLocked(w, 'LEG_COST_LOCKED_LOSSES');
    });

    it('Stock moved to another cycle → LEG_COST_LOCKED_TRANSFERS; once the transfer is undone → re-cost allowed', async () => {
      const w = await receivedCycle();
      await prisma.importCycle.update({
        where: { id: w.cycle.id },
        data: { status: 'SELLING' },
      });
      const target = await prisma.importCycle.create({
        data: {
          code: `RC-T-${randomUUID().slice(0, 6)}`,
          originType: 'UAE_DIRECT',
          currency: 'EGP',
          status: 'PLANNING',
        },
      });
      const moved = (await transfers.create(
        w.cycle.id,
        {
          toCycleId: target.id,
          reason: 'Leftovers to the next cycle',
          lines: [{ productId: w.products[0].id, qty: 1 }],
        },
        ACTOR,
      )) as { data: { id: string } };
      await expectLocked(w, 'LEG_COST_LOCKED_TRANSFERS');

      await transfers.undo(moved.data.id, 'Moved by mistake', ACTOR);
      await setLeg(w.leg.id, 300);
      expect((await figures(w.cycle.id)).batches[0].unit).toBe('200.0000');
    });

    it('A batch received at a cost typed by hand → LEG_COST_LOCKED_OVERRIDE (a re-cost would silently erase it)', async () => {
      const w = await arrivedCycle([{ qty: 3, lineTotal: 300 }], 0);
      const d = await deliver(w.leg.id, [w.items[0].id], [3]);
      await receive(w.cycle.id, d, [3], 120);
      await expectLocked(w, 'LEG_COST_LOCKED_OVERRIDE');
    });

    it('Purchase rows that no longer pair with the batches → LEG_COST_LOCKED_LEDGER, not a guess', async () => {
      const w = await receivedCycle();
      const row = await prisma.financialTransaction.findFirstOrThrow({
        where: { cycleId: w.cycle.id, type: 'PURCHASE_COST' },
      });
      await prisma.financialTransaction.update({
        where: { id: row.id },
        data: { amount: 299 },
      });
      await expectLocked(w, 'LEG_COST_LOCKED_LEDGER');
    });

    // ─── The second time ─────────────────────────────────────────────────────

    it('Edited twice (0 → 1,000 → 1,500) → exactly what one edit straight to 1,500 gives', async () => {
      const twice = await ownersCase();
      const once = await ownersCase();
      await setLeg(twice.leg.id, 1000);
      await setLeg(twice.leg.id, 1500);
      await setLeg(once.leg.id, 1500);
      expect(await figures(twice.cycle.id)).toEqual(
        await figures(once.cycle.id),
      );
    });

    it('Edited and then put back (0 → 1,000 → 0) → every figure returns to the original exactly', async () => {
      const w = await ownersCase();
      const original = await figures(w.cycle.id);
      const kpi = await dashboard();
      await setLeg(w.leg.id, 1000);
      expect(await figures(w.cycle.id)).not.toEqual(original);
      await setLeg(w.leg.id, 0);
      expect(await figures(w.cycle.id)).toEqual(original);
      const back = await dashboard();
      expect(back.totalCogs).toBe(kpi.totalCogs);
      expect(back.inventoryValue).toBe(kpi.inventoryValue);
    });

    it('The same amount sent again → nothing re-costed, no batch version moves', async () => {
      const w = await receivedCycle();
      const before = await prisma.inventoryBatch.findFirstOrThrow({
        where: { cycleId: w.cycle.id },
      });
      await setLeg(w.leg.id, 0);
      await shipping.updateLeg(w.leg.id, { trackingRef: 'T-9' }, ACTOR);
      const after = await prisma.inventoryBatch.findFirstOrThrow({
        where: { cycleId: w.cycle.id },
      });
      expect(after.version).toBe(before.version);
    });

    // ─── At the same moment ──────────────────────────────────────────────────

    it('A receipt being booked while the leg is corrected → the correction waits for the cycle lock, then re-costs that batch too; no batch is left at the old cost', async () => {
      const w = await arrivedCycle([{ qty: 10, lineTotal: 1000 }], 0);
      const d = await deliver(w.leg.id, [w.items[0].id], [10]);
      await receive(w.cycle.id, d, [5]);

      // The second receipt is held after it priced its batch at 100 a unit,
      // with the cycle's lock taken, until the correction has had every chance
      // to run past it.
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let reached!: () => void;
      const atCreate = new Promise<void>((r) => (reached = r));
      const gated = prisma.$extends({
        query: {
          inventoryBatch: {
            async create({ args, query }) {
              reached();
              await held;
              return query(args);
            },
          },
        },
      }) as unknown as PrismaService;
      const auditService = audit as unknown as AuditService;
      const notifications = {
        createForMultipleUsers: jest.fn(),
      } as unknown as NotificationsService;
      const gatedCosting = new CostingService(gated);
      const gatedInventory = new InventoryService(
        gated,
        auditService,
        notifications,
        gatedCosting,
        new CyclesService(gated, auditService, notifications, gatedCosting),
      );
      const receipt = gatedInventory.verifyStock(
        w.cycle.id,
        {
          deliveryId: d.id,
          receivedOn: '2026-09-09',
          items: [{ deliveryLineId: d.lines[0].id, receivedQty: 5 }],
        },
        ACTOR,
      );
      await atCreate;
      const correction = setLeg(w.leg.id, 500); // 150 a unit
      await new Promise((r) => setTimeout(r, 400));
      release();
      await Promise.all([receipt, correction]);

      const f = await figures(w.cycle.id);
      expect(f.batches.map((b) => b.unit)).toEqual(['150.0000', '150.0000']);
      expect(f.ledger.map((l) => l.split(' ')[0])).toEqual([
        '750.00',
        '750.00',
      ]);
    });

    it('A sale that read the batch, then waited while the leg was corrected → its allocation is at the corrected cost, never the one it read first', async () => {
      const w = await arrivedCycle([{ qty: 10, lineTotal: 1000 }], 0);
      const d = await deliver(w.leg.id, [w.items[0].id], [10]);
      await receive(w.cycle.id, d, [10]);

      // The sale is held at the moment it takes units off the batch — after
      // its FIFO read saw 100 a unit — until the correction has committed.
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let reached!: () => void;
      const atBatch = new Promise<void>((r) => (reached = r));
      const gated = prisma.$extends({
        query: {
          inventoryBatch: {
            async update({ args, query }) {
              reached();
              await held;
              return query(args);
            },
          },
        },
      }) as unknown as PrismaService;
      const gatedSales = new SalesService(
        gated,
        audit as unknown as AuditService,
        new PaymentsService(gated, audit as unknown as AuditService),
        { createForMultipleUsers: () => Promise.resolve({ count: 0 }) },
      );
      const sale = gatedSales.create(
        {
          walkIn: true,
          channel: 'B2C',
          currency: 'EGP',
          items: [
            { productId: w.products[0].id, quantity: 2, unitPrice: 1000 },
          ],
        },
        ACTOR,
      );
      await atBatch;
      await setLeg(w.leg.id, 500); // 150 a unit now
      release();
      await sale;

      const allocations = await prisma.saleItemAllocation.findMany({
        where: { inventoryBatch: { cycleId: w.cycle.id } },
      });
      expect(
        allocations.map(
          (a) => `${a.unitCostEgp.toFixed(4)}=${a.cogsEgp.toFixed(2)}`,
        ),
      ).toEqual(['150.0000=300.00']);
    });
  },
);
