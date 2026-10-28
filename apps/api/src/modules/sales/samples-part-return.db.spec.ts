import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- this suite talks to a real, throwaway Postgres; that is its point
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { AuditService } from '../audit/audit.service';
import { CostingService } from '../costing/costing.service';
import { CyclesService } from '../cycles/cycles.service';
import { InventoryService } from '../inventory/inventory.service';
import { PaymentsService } from '../payments/payments.service';
import { SettlementsService } from '../settlements/settlements.service';
import { DeliveriesService } from '../shipping/deliveries.service';
import { OrderHistoryService } from './order-history.service';
import { SalesService, type CreateSaleOrderInput } from './sales.service';
import { samplesAtShop, unitsAtShopsByProduct } from '../../common/samples-out';
import { recordContributionChange } from '../../common/contribution-ledger';

/**
 * Return some samples, not all (BUSINESS_LOGIC §4, owner 2026-10-28: "I
 * should be able to pick which sample a shop returned"), against a real
 * Postgres: "Returned" with lines puts those units back on the batches they
 * left, at their cost, and the rest stay samples on the same order.
 *
 * Every unit here was received the way the business receives it (CLAUDE.md
 * §4): a cycle, a purchase order, a shipping leg that left with the goods, a
 * delivery and a verified receipt — then left at a shop through the service.
 *
 * Runs only when INTEGRATION_DATABASE_URL points at a THROWAWAY database with
 * the migrations applied — an agent's own (`scripts/agent-env.sh <name>`),
 * never the developer's (CLAUDE.md rule 6). It compares business-wide figures
 * before and after, so run it with `--runInBand`.
 */
// eslint-disable-next-line no-restricted-properties -- an opt-in switch for a suite that must never run by default
const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;
jest.setTimeout(60_000);

type Order = {
  id: string;
  orderNo: string;
  status: string;
  version: number;
  total: unknown;
};

suite('returning some samples, not all, against Postgres', () => {
  let prisma: PrismaClient;
  let sales: SalesService;
  let analytics: AnalyticsService;
  let settlements: SettlementsService;
  let deliveries: DeliveriesService;
  let inventory: InventoryService;
  let history: OrderHistoryService;
  let actor: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const db = prisma as unknown as PrismaService;
    // The real audit log: an order's history reads it.
    const audit = new AuditService(db);
    const notifications = {
      createForMultipleUsers: jest.fn().mockResolvedValue({ count: 0 }),
    } as unknown as NotificationsService;
    const costing = new CostingService(db);
    const cycles = new CyclesService(db, audit, notifications);
    deliveries = new DeliveriesService(
      db,
      audit,
      notifications,
      costing,
      cycles,
    );
    inventory = new InventoryService(db, audit, notifications, costing, cycles);
    sales = new SalesService(
      db,
      audit,
      new PaymentsService(db, audit),
      notifications,
    );
    analytics = new AnalyticsService(db);
    settlements = new SettlementsService(db, audit);
    history = new OrderHistoryService(db);
    const user = await prisma.user.create({
      data: {
        email: `part-return-${randomUUID()}@example.test`,
        passwordHash: 'x',
        role: 'CORE_PARTNER',
      },
    });
    actor = user.id;
  });
  afterAll(() => prisma.$disconnect());

  // ─── Fixtures: stock as the business receives it ─────────────────────

  /**
   * A cycle that bought `qty` of the product at `unitPrice` with a flat leg of
   * `legCost`, shipped, delivered and received: one verified batch, landed at
   * unitPrice + legCost / qty. Funded by the partner, so it can be settled.
   */
  async function received(
    productId: string,
    qty: number,
    unitPrice: number,
    legCost: number,
  ) {
    const tag = randomUUID().slice(0, 8);
    const supplier = await prisma.supplier.create({
      data: { name: `Part return ${tag}`, country: 'AE' },
    });
    const cycle = await prisma.importCycle.create({
      data: {
        code: `PRT-${tag}`,
        originType: 'UAE_DIRECT',
        currency: 'EGP',
        status: 'ARRIVED_EGYPT',
      },
    });
    const funded = qty * unitPrice + legCost;
    const participant = await prisma.cycleParticipant.create({
      data: {
        cycleId: cycle.id,
        participantType: 'CORE_PARTNER',
        partnerUserId: actor,
        contributionAmount: funded,
      },
    });
    // The capital arriving, as the cycle page records it (check-data 14).
    await prisma.$transaction((tx) =>
      recordContributionChange(tx, {
        cycleId: cycle.id,
        cycleCode: cycle.code,
        participantId: participant.id,
        before: 0,
        after: funded,
        isInvestor: false,
        actorId: actor,
      }),
    );
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
        productId,
        orderedQty: qty,
        unitPrice,
        lineTotal: qty * unitPrice,
      },
    });
    const leg = await prisma.shippingLeg.create({
      data: {
        cycleId: cycle.id,
        sequence: 1,
        origin: 'Dubai, UAE',
        destination: 'Cairo, Egypt',
        departedOn: new Date('2026-09-01T00:00:00Z'),
        status: 'IN_TRANSIT',
        costBasis: 'FLAT',
        amount: legCost,
        amountEgp: legCost,
      },
    });
    await prisma.shipmentDeparture.create({
      data: {
        legId: leg.id,
        departedOn: new Date('2026-09-01T00:00:00Z'),
        lines: { create: [{ purchaseOrderItemId: item.id, qty }] },
      },
    });
    const { data: delivery } = await deliveries.recordDelivery(
      leg.id,
      {
        arrivedOn: '2026-09-20',
        lines: [{ purchaseOrderItemId: item.id, qty }],
      },
      actor,
    );
    await inventory.verifyStock(
      cycle.id,
      {
        deliveryId: delivery.id,
        items: [{ deliveryLineId: delivery.lines[0].id, receivedQty: qty }],
      },
      actor,
    );
    const batch = await prisma.inventoryBatch.findFirstOrThrow({
      where: { cycleId: cycle.id, productId },
    });
    return { cycle, batch };
  }

  /** A product with one received batch per `{ qty, unitPrice, legCost }`, oldest first. */
  async function stocked(
    batches: { qty: number; unitPrice: number; legCost: number }[],
  ) {
    const tag = randomUUID().slice(0, 8);
    const product = await prisma.product.create({
      data: { sku: `PRT-${tag}`, name: `Return part ${tag}`, status: 'ACTIVE' },
    });
    const made = [];
    for (const b of batches) {
      made.push(await received(product.id, b.qty, b.unitPrice, b.legCost));
    }
    return {
      product,
      batches: made.map((m) => m.batch),
      cycles: made.map((m) => m.cycle),
    };
  }

  async function shop() {
    return prisma.customer.create({
      data: {
        type: 'B2B',
        displayName: `Return shop ${randomUUID().slice(0, 6)}`,
        verificationStatus: 'VERIFIED',
      },
    });
  }

  const leave = async (
    customerId: string,
    items: { productId: string; quantity: number; unitPrice?: number }[],
    extra: Partial<CreateSaleOrderInput> = {},
  ) =>
    (
      (await sales.create(
        {
          samples: true,
          customerId,
          channel: 'B2B',
          currency: 'EGP',
          items: items as CreateSaleOrderInput['items'],
          ...extra,
        },
        actor,
      )) as { data: Order }
    ).data;

  const giveBack = (
    id: string,
    lines: { productId: string; quantity: number | string }[],
    extra: { customerId?: string; version?: number } = {},
  ) => sales.returnSamples(id, actor, { lines, ...extra });

  async function refusal(p: Promise<unknown>) {
    try {
      await p;
    } catch (e) {
      if (!(e instanceof HttpException)) throw e;
      return (e.getResponse() as { code: string }).code;
    }
    throw new Error('expected a refusal, got success');
  }

  const shelf = async (batchId: string) =>
    Number(
      (
        await prisma.inventoryBatch.findUniqueOrThrow({
          where: { id: batchId },
        })
      ).remainingQty,
    );
  const shelfOf = async (productId: string) =>
    Number(
      (
        await prisma.inventoryBatch.aggregate({
          where: { productId },
          _sum: { remainingQty: true },
        })
      )._sum.remainingQty ?? 0,
    );
  const atShops = async (productId: string) =>
    Number(
      (await unitsAtShopsByProduct(prisma, { productId })).byProduct.get(
        productId,
      ) ?? 0,
    );
  const sold = async (productId: string) =>
    Number(
      (
        await prisma.saleItemAllocation.aggregate({
          where: {
            inventoryBatch: { productId },
            saleItem: {
              saleOrder: {
                status: { in: ['CONFIRMED', 'PARTIALLY_PAID', 'PAID'] },
              },
            },
          },
          _sum: { qty: true },
        })
      )._sum.qty ?? 0,
    );
  /** Shelf + at shops + sold = received: no unit counted twice, none lost. */
  async function accountedFor(productId: string, received: number) {
    const [s, a, x] = [
      await shelfOf(productId),
      await atShops(productId),
      await sold(productId),
    ];
    expect({ shelf: s, atShops: a, sold: x, total: s + a + x }).toEqual({
      shelf: s,
      atShops: a,
      sold: x,
      total: received,
    });
  }
  const samplesOrder = (id: string) =>
    prisma.saleOrder.findUniqueOrThrow({
      where: { id },
      include: { items: { include: { allocations: true } } },
    });
  /** [batch, units, cost] of an order's allocations, oldest batch first. */
  const allocationsOf = async (orderId: string) =>
    (
      await prisma.saleItemAllocation.findMany({
        where: { saleItem: { saleOrderId: orderId } },
        include: { inventoryBatch: { select: { createdAt: true } } },
      })
    )
      .sort(
        (a, b) =>
          a.inventoryBatch.createdAt.getTime() -
          b.inventoryBatch.createdAt.getTime(),
      )
      .map((a) => [a.inventoryBatchId, Number(a.qty), Number(a.cogsEgp)]);
  const backMoves = async (orderId: string) =>
    (
      await prisma.inventoryMovement.findMany({
        where: { referenceId: orderId, movementType: 'SAMPLE_BACK' },
      })
    ).map((m) => [m.batchId, Number(m.qtyDelta), m.referenceType]);
  /** Whether the settlement gate still holds the cycle back for samples out. */
  async function gate(cycleId: string) {
    try {
      await settlements.calculate(cycleId, actor);
      return 'open';
    } catch (e) {
      return (e as HttpException).getResponse() as {
        code: string;
        params?: { units?: string };
      };
    }
  }

  // ─── Some, all, none ─────────────────────────────────────────────────

  it('some: those units go back to the newer batch they left, at its cost; the rest stay samples on the same order with the day left and reminder; stock, the gate and History follow', async () => {
    // Oldest batch 2 at 110 landed, then 10 at 150.
    const a = await stocked([
      { qty: 2, unitPrice: 100, legCost: 20 },
      { qty: 10, unitPrice: 140, legCost: 100 },
    ]);
    const b = await stocked([{ qty: 5, unitPrice: 50, legCost: 0 }]);
    const s = await shop();
    // 3 of A out: 2 from the oldest batch, 1 from the next. 2 of B.
    const left = await leave(s.id, [
      { productId: a.product.id, quantity: 3 },
      { productId: b.product.id, quantity: 2 },
    ]);
    const remindedAt = new Date('2026-10-20T08:00:00Z');
    await prisma.saleOrder.update({
      where: { id: left.id },
      data: { samplesRemindedAt: remindedAt },
    });
    const was = await samplesOrder(left.id);
    const before = await analytics.profitFigures();

    const res = await giveBack(left.id, [
      { productId: a.product.id, quantity: 2 },
    ]);

    expect(res.data.status).toBe('SAMPLES');
    expect(res.data.samples?.unitsOut).toBe('3');
    // The oldest unit stays; the two back went to the batch each left.
    expect(await shelf(a.batches[0].id)).toBe(1);
    expect(await shelf(a.batches[1].id)).toBe(10);
    expect(
      (await backMoves(left.id)).sort((x, y) =>
        String(x[0]).localeCompare(String(y[0])),
      ),
    ).toEqual(
      [
        [a.batches[0].id, 1, 'SAMPLES_ORDER'],
        [a.batches[1].id, 1, 'SAMPLES_ORDER'],
      ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    );
    // What stays is at the cost it left at: 1 × 110, and B untouched.
    const open = await samplesOrder(left.id);
    expect(open.status).toBe('SAMPLES');
    expect(open.samplesLeftAt).toEqual(was.samplesLeftAt);
    expect(open.samplesRemindedAt).toEqual(remindedAt);
    expect(open.samplesDecidedAt).toBeNull();
    expect(
      open.items
        .map((i) => [i.productId, Number(i.quantity)])
        .sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    ).toEqual(
      [
        [a.product.id, 1],
        [b.product.id, 2],
      ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    );
    expect(await allocationsOf(left.id)).toEqual(
      expect.arrayContaining([
        [a.batches[0].id, 1, 110],
        [b.batches[0].id, 2, 100],
      ]),
    );
    expect(await atShops(a.product.id)).toBe(1);
    expect(await atShops(b.product.id)).toBe(2);
    await accountedFor(a.product.id, 12);
    await accountedFor(b.product.id, 5);
    // Still not a sale; the cycles are still held back by what stays out.
    const after = await analytics.profitFigures();
    expect(after.revenue.sub(before.revenue).toFixed(2)).toBe('0.00');
    expect(after.cogs.sub(before.cogs).toFixed(2)).toBe('0.00');
    expect(await gate(a.cycles[0].id)).toMatchObject({
      code: 'CYCLE_HAS_SAMPLES_OUT',
      params: { units: '1' },
    });
    // The newer cycle has nothing out any more.
    expect(await gate(a.cycles[1].id)).toBe('open');
    expect(await gate(b.cycles[0].id)).toMatchObject({
      code: 'CYCLE_HAS_SAMPLES_OUT',
    });
    const held = await samplesAtShop(prisma, s.id);
    expect(held[0].lines.find((l) => l.productId === a.product.id)?.units).toBe(
      '1',
    );

    // History: what was left, then what came back.
    const h = (await history.history(left.id)).data;
    expect(h.events.map((e) => e.kind)).toEqual([
      'SAMPLES_LEFT',
      'SAMPLES_PART_RETURNED',
    ]);
    expect(h.events[1].lines?.map((l) => [l.product, l.qty])).toEqual([
      [a.product.name, '2'],
    ]);
    expect(h.owes).toBe('0.00');
  });

  it('all, named line by line: every unit back, the order ends SAMPLES_RETURNED as "Returned" always did, and the gate opens', async () => {
    const a = await stocked([{ qty: 4, unitPrice: 100, legCost: 0 }]);
    const b = await stocked([{ qty: 4, unitPrice: 200, legCost: 0 }]);
    const s = await shop();
    const left = await leave(s.id, [
      { productId: a.product.id, quantity: 2 },
      { productId: b.product.id, quantity: 1 },
    ]);
    const res = await giveBack(left.id, [
      { productId: a.product.id, quantity: 2 },
      { productId: b.product.id, quantity: '1' },
    ]);
    expect(res.data.status).toBe('SAMPLES_RETURNED');
    const closed = await samplesOrder(left.id);
    expect(closed.samplesDecidedAt).not.toBeNull();
    // Its lines stay as the record of what went out, as before.
    expect(closed.items.map((i) => Number(i.quantity)).sort()).toEqual([1, 2]);
    expect(await shelf(a.batches[0].id)).toBe(4);
    expect(await shelf(b.batches[0].id)).toBe(4);
    expect(await atShops(a.product.id)).toBe(0);
    expect(await gate(a.cycles[0].id)).toBe('open');
    expect(await gate(b.cycles[0].id)).toBe('open');
    await accountedFor(a.product.id, 4);
    await accountedFor(b.product.id, 4);
    const kinds = (await history.history(left.id)).data.events.map(
      (e) => e.kind,
    );
    expect(kinds).toEqual(['SAMPLES_LEFT', 'SAMPLES_RETURNED']);
  });

  it('none: no line at all is refused (SAMPLES_RETURN_NOTHING) and nothing moves; no lines given at all is still the whole order', async () => {
    const a = await stocked([{ qty: 4, unitPrice: 100, legCost: 0 }]);
    const s = await shop();
    const left = await leave(s.id, [{ productId: a.product.id, quantity: 3 }]);
    expect(await refusal(giveBack(left.id, []))).toBe('SAMPLES_RETURN_NOTHING');
    expect((await samplesOrder(left.id)).status).toBe('SAMPLES');
    expect(await shelf(a.batches[0].id)).toBe(1);
    expect(await backMoves(left.id)).toEqual([]);
    // An older client, and Cancel: no lines means every unit.
    const res = await sales.returnSamples(left.id, actor, {});
    expect(res.data.status).toBe('SAMPLES_RETURNED');
    expect(await shelf(a.batches[0].id)).toBe(4);
  });

  // ─── The second time ─────────────────────────────────────────────────

  it('twice: the second return reads what the first left; then the rest closes it; then anything more is already decided', async () => {
    const a = await stocked([{ qty: 5, unitPrice: 100, legCost: 0 }]);
    const s = await shop();
    const left = await leave(s.id, [{ productId: a.product.id, quantity: 4 }]);
    await giveBack(left.id, [{ productId: a.product.id, quantity: 1 }]);
    await giveBack(left.id, [{ productId: a.product.id, quantity: 1 }]);
    expect(await shelf(a.batches[0].id)).toBe(3);
    expect(await atShops(a.product.id)).toBe(2);
    // Three now would be more than is out.
    expect(
      await refusal(
        giveBack(left.id, [{ productId: a.product.id, quantity: 3 }]),
      ),
    ).toBe('SAMPLES_RETURN_MORE_THAN_OUT');
    const res = await giveBack(left.id, [
      { productId: a.product.id, quantity: 2 },
    ]);
    expect(res.data.status).toBe('SAMPLES_RETURNED');
    expect(await shelf(a.batches[0].id)).toBe(5);
    expect(
      await refusal(
        giveBack(left.id, [{ productId: a.product.id, quantity: 1 }]),
      ),
    ).toBe('SAMPLES_ALREADY_DECIDED');
    await accountedFor(a.product.id, 5);
    const kinds = (await history.history(left.id)).data.events.map(
      (e) => e.kind,
    );
    expect(kinds).toEqual([
      'SAMPLES_LEFT',
      'SAMPLES_PART_RETURNED',
      'SAMPLES_PART_RETURNED',
      'SAMPLES_RETURNED',
    ]);
  });

  it('the same click twice, or a screen read before another return: the version it showed is refused (ORDER_VERSION_CONFLICT), so nothing comes back twice', async () => {
    const a = await stocked([{ qty: 5, unitPrice: 100, legCost: 0 }]);
    const s = await shop();
    const left = await leave(s.id, [{ productId: a.product.id, quantity: 4 }]);
    const seen = (await samplesOrder(left.id)).version;
    await giveBack(left.id, [{ productId: a.product.id, quantity: 1 }], {
      version: seen,
    });
    expect(
      await refusal(
        giveBack(left.id, [{ productId: a.product.id, quantity: 1 }], {
          version: seen,
        }),
      ),
    ).toBe('ORDER_VERSION_CONFLICT');
    expect(await shelf(a.batches[0].id)).toBe(2);
    expect(await atShops(a.product.id)).toBe(3);
    // Two at once with the same version: one wins.
    const fresh = (await samplesOrder(left.id)).version;
    const both = await Promise.allSettled([
      giveBack(left.id, [{ productId: a.product.id, quantity: 1 }], {
        version: fresh,
      }),
      giveBack(left.id, [{ productId: a.product.id, quantity: 1 }], {
        version: fresh,
      }),
    ]);
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await shelf(a.batches[0].id)).toBe(3);
    expect(await atShops(a.product.id)).toBe(2);
    await accountedFor(a.product.id, 5);
  });

  // ─── Then buying the rest ────────────────────────────────────────────

  it("some back, then They're buying the rest: the sale is the units that stayed, at the cost they left at", async () => {
    const a = await stocked([
      { qty: 2, unitPrice: 100, legCost: 20 },
      { qty: 4, unitPrice: 140, legCost: 40 },
    ]);
    const s = await shop();
    const left = await leave(s.id, [{ productId: a.product.id, quantity: 4 }]);
    await giveBack(left.id, [{ productId: a.product.id, quantity: 2 }]);
    const before = await analytics.profitFigures();
    const res = (await sales.convertSamples(
      left.id,
      { items: [{ productId: a.product.id, quantity: 2, unitPrice: 300 }] },
      actor,
    )) as { data: Order };
    expect(res.data.id).toBe(left.id);
    expect(res.data.status).toBe('CONFIRMED');
    // The two that stayed were the oldest: 2 × 110.
    expect(await allocationsOf(left.id)).toEqual([[a.batches[0].id, 2, 220]]);
    const after = await analytics.profitFigures();
    expect(after.revenue.sub(before.revenue).toFixed(2)).toBe('600.00');
    expect(after.cogs.sub(before.cogs).toFixed(2)).toBe('220.00');
    expect(await shelf(a.batches[1].id)).toBe(4);
    expect(await atShops(a.product.id)).toBe(0);
    expect(await gate(a.cycles[0].id)).toBe('open');
    await accountedFor(a.product.id, 6);
  });

  it("some back, then New Order's Add to order takes the rest: the samples order closes as bought, no second shelf draw", async () => {
    const a = await stocked([{ qty: 5, unitPrice: 100, legCost: 50 }]);
    const s = await shop();
    const left = await leave(s.id, [{ productId: a.product.id, quantity: 3 }]);
    await giveBack(left.id, [{ productId: a.product.id, quantity: 1 }]);
    expect(await shelf(a.batches[0].id)).toBe(3);
    const sale = (
      (await sales.create(
        {
          customerId: s.id,
          channel: 'B2B',
          currency: 'EGP',
          confirm: true,
          items: [
            {
              productId: a.product.id,
              quantity: 2,
              unitPrice: 250,
              fromSamplesOrderId: left.id,
            },
          ],
        },
        actor,
      )) as { data: Order }
    ).data;
    expect(sale.status).toBe('CONFIRMED');
    expect(await allocationsOf(sale.id)).toEqual([[a.batches[0].id, 2, 220]]);
    expect(await shelf(a.batches[0].id)).toBe(3);
    const closed = await samplesOrder(left.id);
    expect(closed.status).toBe('SAMPLES_BOUGHT');
    expect(closed.items).toEqual([]);
    expect(await gate(a.cycles[0].id)).toBe('open');
    await accountedFor(a.product.id, 5);
    // A return now finds nothing at the shop.
    expect(
      await refusal(
        giveBack(left.id, [{ productId: a.product.id, quantity: 1 }]),
      ),
    ).toBe('SAMPLES_ALREADY_DECIDED');
  });

  // ─── The limits ──────────────────────────────────────────────────────

  it('more than is out, alone or in two lines of one product, is refused and nothing moves', async () => {
    const a = await stocked([{ qty: 5, unitPrice: 100, legCost: 0 }]);
    const s = await shop();
    const left = await leave(s.id, [{ productId: a.product.id, quantity: 2 }]);
    for (const lines of [
      [{ productId: a.product.id, quantity: 3 }],
      [
        { productId: a.product.id, quantity: 1 },
        { productId: a.product.id, quantity: 2 },
      ],
      [{ productId: a.product.id, quantity: 2.5 }],
    ]) {
      const e = await giveBack(left.id, lines).then(
        () => null,
        (err: HttpException) => err.getResponse() as { code: string },
      );
      expect(e).toMatchObject({
        code: 'SAMPLES_RETURN_MORE_THAN_OUT',
        params: { out: '2', product: a.product.name },
      });
    }
    expect(await shelf(a.batches[0].id)).toBe(3);
    expect(await backMoves(left.id)).toEqual([]);
    expect((await samplesOrder(left.id)).status).toBe('SAMPLES');
  });

  it.each([0, -1, '-2', '0'])(
    'a quantity of %s is refused (QTY_NOT_POSITIVE) and nothing moves',
    async (quantity) => {
      const a = await stocked([{ qty: 5, unitPrice: 100, legCost: 0 }]);
      const s = await shop();
      const left = await leave(s.id, [
        { productId: a.product.id, quantity: 2 },
      ]);
      expect(
        await refusal(
          giveBack(left.id, [{ productId: a.product.id, quantity }]),
        ),
      ).toBe('QTY_NOT_POSITIVE');
      expect(await shelf(a.batches[0].id)).toBe(3);
      expect(await backMoves(left.id)).toEqual([]);
    },
  );

  it('a quantity that is no number, a line with no product, and lines that are not a list are refused (VALIDATION_FAILED)', async () => {
    const a = await stocked([{ qty: 5, unitPrice: 100, legCost: 0 }]);
    const s = await shop();
    const left = await leave(s.id, [{ productId: a.product.id, quantity: 2 }]);
    for (const body of [
      { lines: [{ productId: a.product.id, quantity: 'two' }] },
      { lines: [{ productId: a.product.id }] },
      { lines: [{ productId: 'not-an-id', quantity: 1 }] },
      { lines: [{ quantity: 1 }] },
      { lines: 'all' },
      { lines: [{ productId: a.product.id, quantity: 1 }], version: 'x' },
    ]) {
      expect(
        await refusal(
          sales.returnSamples(
            left.id,
            actor,
            body as unknown as Parameters<SalesService['returnSamples']>[2],
          ),
        ),
      ).toBe('VALIDATION_FAILED');
    }
    expect(await shelf(a.batches[0].id)).toBe(3);
  });

  it('a product not on the order — a real one never left, or one bought out of it already — is refused (SAMPLES_RETURN_PRODUCT_NOT_OUT)', async () => {
    const a = await stocked([{ qty: 5, unitPrice: 100, legCost: 0 }]);
    const b = await stocked([{ qty: 5, unitPrice: 100, legCost: 0 }]);
    const other = await stocked([{ qty: 5, unitPrice: 100, legCost: 0 }]);
    const s = await shop();
    const left = await leave(s.id, [
      { productId: a.product.id, quantity: 2 },
      { productId: b.product.id, quantity: 1 },
    ]);
    const e = await giveBack(left.id, [
      { productId: other.product.id, quantity: 1 },
    ]).then(
      () => null,
      (err: HttpException) => err.getResponse() as { code: string },
    );
    expect(e).toMatchObject({
      code: 'SAMPLES_RETURN_PRODUCT_NOT_OUT',
      params: { order: left.orderNo, product: other.product.name },
    });
    expect(
      await refusal(
        giveBack(left.id, [{ productId: randomUUID(), quantity: 1 }]),
      ),
    ).toBe('SAMPLES_RETURN_PRODUCT_NOT_OUT');
    // B bought into a sale: it is no longer on the order.
    await sales.create(
      {
        customerId: s.id,
        channel: 'B2B',
        currency: 'EGP',
        confirm: true,
        items: [
          {
            productId: b.product.id,
            quantity: 1,
            unitPrice: 200,
            fromSamplesOrderId: left.id,
          },
        ],
      },
      actor,
    );
    expect(
      await refusal(
        giveBack(left.id, [{ productId: b.product.id, quantity: 1 }]),
      ),
    ).toBe('SAMPLES_RETURN_PRODUCT_NOT_OUT');
    // One good line and one bad: nothing moves.
    expect(
      await refusal(
        giveBack(left.id, [
          { productId: a.product.id, quantity: 1 },
          { productId: other.product.id, quantity: 1 },
        ]),
      ),
    ).toBe('SAMPLES_RETURN_PRODUCT_NOT_OUT');
    expect(await shelf(a.batches[0].id)).toBe(3);
    await accountedFor(a.product.id, 5);
  });

  // ─── The wrong context ───────────────────────────────────────────────

  it('an order already decided — returned, written off, bought in place — or never samples is refused, and an id that is no order is 404', async () => {
    const a = await stocked([{ qty: 10, unitPrice: 100, legCost: 0 }]);
    const s = await shop();
    const line = (q = 1) => [{ productId: a.product.id, quantity: q }];

    const returned = await leave(s.id, line(2));
    await sales.returnSamples(returned.id, actor);
    const writtenOff = await leave(s.id, line(2));
    await sales.writeOffSamples(writtenOff.id, {}, actor);
    const bought = await leave(s.id, line(2));
    await sales.convertSamples(
      bought.id,
      { items: [{ productId: a.product.id, quantity: 2, unitPrice: 100 }] },
      actor,
    );
    for (const o of [returned, writtenOff, bought]) {
      expect(await refusal(giveBack(o.id, line()))).toBe(
        'SAMPLES_ALREADY_DECIDED',
      );
    }
    const sale = (
      (await sales.create(
        {
          customerId: s.id,
          channel: 'B2B',
          currency: 'EGP',
          confirm: true,
          items: [{ productId: a.product.id, quantity: 1, unitPrice: 100 }],
        },
        actor,
      )) as { data: Order }
    ).data;
    expect(await refusal(giveBack(sale.id, line()))).toBe('NOT_SAMPLES');
    expect(await refusal(giveBack(randomUUID(), line()))).toBe('NOT_FOUND');
    // 10 received, 2 written off and gone for good: 8 on the shelf or sold.
    await accountedFor(a.product.id, 8);
  });

  it("another shop's order: naming a shop it was not left with is refused (SAMPLES_OTHER_SHOP) and nothing moves", async () => {
    const a = await stocked([{ qty: 5, unitPrice: 100, legCost: 0 }]);
    const s = await shop();
    const t = await shop();
    const left = await leave(s.id, [{ productId: a.product.id, quantity: 2 }]);
    expect(
      await refusal(
        giveBack(left.id, [{ productId: a.product.id, quantity: 1 }], {
          customerId: t.id,
        }),
      ),
    ).toBe('SAMPLES_OTHER_SHOP');
    expect(await shelf(a.batches[0].id)).toBe(3);
    // Its own shop named: fine.
    await giveBack(left.id, [{ productId: a.product.id, quantity: 1 }], {
      customerId: s.id,
    });
    expect(await shelf(a.batches[0].id)).toBe(4);
  });

  it('a samples order on a branch: what stays is still at that branch, and the list says so', async () => {
    const a = await stocked([{ qty: 5, unitPrice: 100, legCost: 0 }]);
    const s = await shop();
    const branch = await prisma.customerBranch.create({
      data: { customerId: s.id, name: 'LS2', isDefault: false },
    });
    const left = await leave(s.id, [{ productId: a.product.id, quantity: 3 }], {
      branchId: branch.id,
    });
    await giveBack(left.id, [{ productId: a.product.id, quantity: 2 }]);
    const open = await prisma.saleOrder.findUniqueOrThrow({
      where: { id: left.id },
    });
    expect(open.branchId).toBe(branch.id);
    const held = await samplesAtShop(prisma, s.id);
    expect(held).toHaveLength(1);
    expect(held[0].branch).toMatchObject({ id: branch.id, name: 'LS2' });
    expect(held[0].lines[0].units).toBe('1');
    expect(await shelf(a.batches[0].id)).toBe(4);
    await accountedFor(a.product.id, 5);
  });
});
