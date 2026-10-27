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
import { owedBy } from '../../common/customer-balance';
import {
  buildStatement,
  loadStatementSource,
} from '../../common/customer-statement';
import { samplesAtShop, unitsAtShopsByProduct } from '../../common/samples-out';
import { recordContributionChange } from '../../common/contribution-ledger';

/**
 * Samples into the current order (BUSINESS_LOGIC §4, owner 2026-10-27),
 * against a real Postgres: New Order's lines bought from samples the shop
 * holds, and "They're buying" keeping some units as samples.
 *
 * Every unit here was received the way the business receives it (CLAUDE.md
 * §4): a cycle, a purchase order, a shipping leg that left with the goods, a
 * delivery and a verified receipt — then left at a shop as samples through
 * the service. Figures are read through the services the screens use.
 *
 * Runs only when INTEGRATION_DATABASE_URL points at a THROWAWAY database with
 * the migrations applied — an agent's own (`scripts/agent-env.sh <name>`),
 * never the developer's (CLAUDE.md rule 6). It compares business-wide figures
 * before and after, so run it with `--runInBand`.
 */
// eslint-disable-next-line no-restricted-properties -- an opt-in switch for a suite that must never run by default
const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;

type Order = {
  id: string;
  orderNo: string;
  status: string;
  version: number;
  total: unknown;
};

suite('samples into the current order against Postgres', () => {
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
        email: `into-order-${randomUUID()}@example.test`,
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
      data: { name: `Into ${tag}`, country: 'AE' },
    });
    const cycle = await prisma.importCycle.create({
      data: {
        code: `INTO-${tag}`,
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
      data: { sku: `INTO-${tag}`, name: `Into part ${tag}`, status: 'ACTIVE' },
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
        displayName: `Into shop ${randomUUID().slice(0, 6)}`,
        verificationStatus: 'VERIFIED',
      },
    });
  }

  const leave = async (
    customerId: string,
    items: { productId: string; quantity: number; unitPrice?: number }[],
  ) =>
    (
      (await sales.create(
        {
          samples: true,
          customerId,
          channel: 'B2B',
          currency: 'EGP',
          items: items as CreateSaleOrderInput['items'],
        },
        actor,
      )) as { data: Order }
    ).data;

  /** New Order: create and confirm, or a draft with `confirm: false`. */
  const sell = async (
    customerId: string,
    items: CreateSaleOrderInput['items'],
    extra: Partial<CreateSaleOrderInput> = {},
    key?: string,
  ) =>
    (
      (await sales.create(
        {
          customerId,
          channel: 'B2B',
          currency: 'EGP',
          confirm: true,
          items,
          ...extra,
        },
        actor,
        key,
      )) as { data: Order }
    ).data;

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
  const saleMoves = (orderId: string) =>
    prisma.inventoryMovement.findMany({
      where: { referenceId: orderId, movementType: 'SALE' },
    });
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

  // ─── All, more, less, none ───────────────────────────────────────────

  it('all of a sample: the units and their allocations move into the sale at the batch cost they left at, with no second shelf draw; the samples order closes as bought; revenue, COGS, the balance, the statement and the gate follow', async () => {
    // 5 at 100 + 50/5 = 110 landed.
    const { product, batches, cycles } = await stocked([
      { qty: 5, unitPrice: 100, legCost: 50 },
    ]);
    const s = await shop();
    const left = await leave(s.id, [
      { productId: product.id, quantity: 3, unitPrice: 200 },
    ]);
    expect(await shelf(batches[0].id)).toBe(2);
    expect(await gate(cycles[0].id)).toMatchObject({
      code: 'CYCLE_HAS_SAMPLES_OUT',
    });
    const before = await analytics.profitFigures();
    const owedBefore = await owedBy(prisma, s.id);

    const sale = await sell(s.id, [
      {
        productId: product.id,
        quantity: 3,
        unitPrice: 250,
        fromSamplesOrderId: left.id,
      },
    ]);

    expect(sale.status).toBe('CONFIRMED');
    expect(sale.id).not.toBe(left.id);
    // No second draw: the shelf is where the samples left it.
    expect(await shelf(batches[0].id)).toBe(2);
    expect(await saleMoves(sale.id)).toEqual([]);
    expect(await allocationsOf(sale.id)).toEqual([[batches[0].id, 3, 330]]);
    expect(await atShops(product.id)).toBe(0);
    const closed = await samplesOrder(left.id);
    expect(closed.status).toBe('SAMPLES_BOUGHT');
    expect(closed.items).toEqual([]);
    expect(closed.samplesDecidedAt).not.toBeNull();
    expect([Number(closed.total), Number(closed.outstanding)]).toEqual([0, 0]);
    // The line carries its tag.
    const line = await prisma.saleItem.findFirstOrThrow({
      where: { saleOrderId: sale.id },
    });
    expect(line.fromSamplesOrderId).toBe(left.id);

    // Revenue the sale's 750, COGS the sample's 330, owed by the shop.
    const after = await analytics.profitFigures();
    expect(after.revenue.sub(before.revenue).toFixed(2)).toBe('750.00');
    expect(after.cogs.sub(before.cogs).toFixed(2)).toBe('330.00');
    expect(Number(await owedBy(prisma, s.id)) - Number(owedBefore)).toBe(750);
    const statement = buildStatement(
      { id: s.id, displayName: s.displayName, phone: null },
      await loadStatementSource(prisma, s.id),
    );
    // One row, the sale — never the samples — its profit at the sample's cost.
    expect(
      statement.rows.map((r) => [r.reference, r.amount, r.profit]),
    ).toEqual([[sale.orderNo, '750.00', '420.00']]);
    expect(await samplesAtShop(prisma, s.id)).toEqual([]);
    expect(await gate(cycles[0].id)).toBe('open');
    await accountedFor(product.id, 5);

    // The samples order's history: what was left, and where it went.
    const h = (await history.history(left.id)).data;
    expect(h.events.map((e) => e.kind)).toEqual([
      'SAMPLES_LEFT',
      'SAMPLES_INTO_SALE',
    ]);
    expect(h.events[0].lines?.map((l) => l.qty)).toEqual(['3']);
    expect(h.events[1].reference).toBe(sale.orderNo);
    expect(h.owes).toBe('0.00');
    // The sale's own detail names the samples order on the line.
    const detail = (await sales.findById(sale.id)).data as unknown as {
      items: { fromSamplesOrder: { orderNo: string } | null }[];
    };
    expect(detail.items[0].fromSamplesOrder?.orderNo).toBe(left.orderNo);
    const sampleDetail = (await sales.findById(left.id)).data.samples;
    expect(sampleDetail?.soldInto).toEqual([
      { id: sale.id, orderNo: sale.orderNo },
    ]);
  });

  it('more than the sample: the sample units first at their cost, the rest drawn FIFO from the shelf', async () => {
    // Oldest batch 110 landed, then 150 landed.
    const { product, batches } = await stocked([
      { qty: 4, unitPrice: 100, legCost: 40 },
      { qty: 10, unitPrice: 140, legCost: 100 },
    ]);
    const s = await shop();
    // 2 out, from the oldest batch: it keeps 2.
    const left = await leave(s.id, [{ productId: product.id, quantity: 2 }]);
    expect(await shelf(batches[0].id)).toBe(2);

    const sale = await sell(s.id, [
      {
        productId: product.id,
        quantity: 5,
        unitPrice: 300,
        fromSamplesOrderId: left.id,
      },
    ]);
    // 2 from the sample at 110; 3 from the shelf FIFO: 2 more at 110, 1 at 150.
    expect(await allocationsOf(sale.id)).toEqual([
      [batches[0].id, 2, 220],
      [batches[0].id, 2, 220],
      [batches[1].id, 1, 150],
    ]);
    expect(await shelf(batches[0].id)).toBe(0);
    expect(await shelf(batches[1].id)).toBe(9);
    const moves = await saleMoves(sale.id);
    expect(moves.reduce((t, m) => t + Number(m.qtyDelta), 0)).toBe(-3);
    expect((await samplesOrder(left.id)).status).toBe('SAMPLES_BOUGHT');
    await accountedFor(product.id, 14);
  });

  it('more than the sample and more than the shelf has: refused before anything moves', async () => {
    const { product, batches } = await stocked([
      { qty: 3, unitPrice: 100, legCost: 0 },
    ]);
    const s = await shop();
    const left = await leave(s.id, [{ productId: product.id, quantity: 2 }]);
    // 2 at the shop, 1 on the shelf: 4 needs 2 from the shelf.
    expect(
      await refusal(
        sell(s.id, [
          {
            productId: product.id,
            quantity: 4,
            unitPrice: 300,
            fromSamplesOrderId: left.id,
          },
        ]),
      ),
    ).toBe('NOT_ENOUGH_STOCK');
    // 3 works: 2 from the sample, 1 from the shelf.
    await sell(s.id, [
      {
        productId: product.id,
        quantity: 3,
        unitPrice: 300,
        fromSamplesOrderId: left.id,
      },
    ]);
    expect(await shelf(batches[0].id)).toBe(0);
    await accountedFor(product.id, 3);
  });

  it('less than the sample: the rest stays a sample on the same order, its day left and reminder kept; the gate still holds the cycle', async () => {
    const { product, batches, cycles } = await stocked([
      { qty: 6, unitPrice: 100, legCost: 60 },
    ]);
    const s = await shop();
    const left = await leave(s.id, [{ productId: product.id, quantity: 3 }]);
    const remindedAt = new Date('2026-10-20T08:00:00Z');
    await prisma.saleOrder.update({
      where: { id: left.id },
      data: { samplesRemindedAt: remindedAt },
    });
    const was = await samplesOrder(left.id);

    const sale = await sell(s.id, [
      {
        productId: product.id,
        quantity: 1,
        unitPrice: 300,
        fromSamplesOrderId: left.id,
      },
    ]);
    expect(await allocationsOf(sale.id)).toEqual([[batches[0].id, 1, 110]]);
    const open = await samplesOrder(left.id);
    expect(open.status).toBe('SAMPLES');
    expect(open.samplesLeftAt).toEqual(was.samplesLeftAt);
    expect(open.samplesRemindedAt).toEqual(remindedAt);
    expect(open.samplesDecidedAt).toBeNull();
    expect(open.items.map((i) => Number(i.quantity))).toEqual([2]);
    expect(
      open.items[0].allocations.map((a) => [Number(a.qty), Number(a.cogsEgp)]),
    ).toEqual([[2, 220]]);
    expect(await atShops(product.id)).toBe(2);
    expect(await shelf(batches[0].id)).toBe(3);
    expect(await gate(cycles[0].id)).toMatchObject({
      code: 'CYCLE_HAS_SAMPLES_OUT',
      params: { units: '2' },
    });
    expect((await samplesAtShop(prisma, s.id))[0].lines[0].units).toBe('2');
    await accountedFor(product.id, 6);

    // What is left can still be returned, as any open samples.
    await sales.returnSamples(left.id, actor);
    expect(await shelf(batches[0].id)).toBe(5);
    expect(await gate(cycles[0].id)).toBe('open');
    await accountedFor(product.id, 6);
  });

  it('none of the sample: a sale without the tag draws the shelf and leaves the samples alone (the hint never blocks)', async () => {
    const { product, batches } = await stocked([
      { qty: 6, unitPrice: 100, legCost: 0 },
    ]);
    const s = await shop();
    const left = await leave(s.id, [{ productId: product.id, quantity: 2 }]);
    const sale = await sell(s.id, [
      { productId: product.id, quantity: 2, unitPrice: 300 },
    ]);
    expect(await shelf(batches[0].id)).toBe(2);
    expect((await saleMoves(sale.id)).length).toBe(1);
    expect((await samplesOrder(left.id)).status).toBe('SAMPLES');
    expect(await atShops(product.id)).toBe(2);
    await accountedFor(product.id, 6);
  });

  it('one product taken, another left: a shop with three samples buys two and keeps the third on trial', async () => {
    const a = await stocked([{ qty: 3, unitPrice: 100, legCost: 0 }]);
    const b = await stocked([{ qty: 3, unitPrice: 200, legCost: 0 }]);
    const c = await stocked([{ qty: 3, unitPrice: 300, legCost: 0 }]);
    const s = await shop();
    const left = await leave(s.id, [
      { productId: a.product.id, quantity: 1 },
      { productId: b.product.id, quantity: 1 },
      { productId: c.product.id, quantity: 1 },
    ]);
    await sell(s.id, [
      {
        productId: a.product.id,
        quantity: 1,
        unitPrice: 150,
        fromSamplesOrderId: left.id,
      },
      {
        productId: b.product.id,
        quantity: 1,
        unitPrice: 250,
        fromSamplesOrderId: left.id,
      },
    ]);
    const open = await samplesOrder(left.id);
    expect(open.status).toBe('SAMPLES');
    expect(open.items.map((i) => i.productId)).toEqual([c.product.id]);
    expect(await atShops(c.product.id)).toBe(1);
    for (const p of [a, b, c]) await accountedFor(p.product.id, 3);
  });

  it('two samples orders at once: each line takes from its own order; one closes, the other keeps what was not bought', async () => {
    const { product, batches } = await stocked([
      { qty: 2, unitPrice: 100, legCost: 0 },
      { qty: 5, unitPrice: 150, legCost: 0 },
    ]);
    const s = await shop();
    const first = await leave(s.id, [{ productId: product.id, quantity: 2 }]);
    const second = await leave(s.id, [{ productId: product.id, quantity: 3 }]);
    expect(await atShops(product.id)).toBe(5);

    const sale = await sell(s.id, [
      {
        productId: product.id,
        quantity: 2,
        unitPrice: 300,
        fromSamplesOrderId: first.id,
      },
      {
        productId: product.id,
        quantity: 1,
        unitPrice: 300,
        fromSamplesOrderId: second.id,
      },
    ]);
    // The first order's 2 at 100; 1 of the second's, at 150.
    expect(await allocationsOf(sale.id)).toEqual([
      [batches[0].id, 2, 200],
      [batches[1].id, 1, 150],
    ]);
    expect((await samplesOrder(first.id)).status).toBe('SAMPLES_BOUGHT');
    const still = await samplesOrder(second.id);
    expect(still.status).toBe('SAMPLES');
    expect(Number(still.items[0].quantity)).toBe(2);
    expect(await saleMoves(sale.id)).toEqual([]);
    await accountedFor(product.id, 7);
  });

  // ─── Refused ─────────────────────────────────────────────────────────

  it("another shop's sample, a walk-in, and a samples order on samples are refused; nothing moves", async () => {
    const { product, batches } = await stocked([
      { qty: 6, unitPrice: 100, legCost: 0 },
    ]);
    const mine = await shop();
    const theirs = await shop();
    const left = await leave(theirs.id, [
      { productId: product.id, quantity: 2 },
    ]);
    const line = {
      productId: product.id,
      quantity: 2,
      unitPrice: 300,
      fromSamplesOrderId: left.id,
    };
    expect(await refusal(sell(mine.id, [line]))).toBe('SAMPLES_OTHER_SHOP');
    expect(await refusal(sell(mine.id, [line], { confirm: false }))).toBe(
      'SAMPLES_OTHER_SHOP',
    );
    expect(
      await refusal(
        sales.create(
          {
            walkIn: true,
            channel: 'B2C',
            currency: 'EGP',
            items: [line],
          },
          actor,
        ),
      ),
    ).toBe('SAMPLES_OTHER_SHOP');
    expect(
      await refusal(
        sales.create(
          {
            samples: true,
            customerId: theirs.id,
            channel: 'B2B',
            currency: 'EGP',
            items: [line],
          },
          actor,
        ),
      ),
    ).toBe('VALIDATION_FAILED');
    expect(await shelf(batches[0].id)).toBe(4);
    expect((await samplesOrder(left.id)).status).toBe('SAMPLES');
    expect(await atShops(product.id)).toBe(2);
  });

  it('a returned or written-off sample, an order that never was samples, a product it does not hold, a day before it was left, and an id that is no order are refused', async () => {
    const { product } = await stocked([
      { qty: 10, unitPrice: 100, legCost: 0 },
    ]);
    const other = await stocked([{ qty: 10, unitPrice: 100, legCost: 0 }]);
    const s = await shop();
    const line = (fromSamplesOrderId: string, productId = product.id) => ({
      productId,
      quantity: 1,
      unitPrice: 300,
      fromSamplesOrderId,
    });

    const returned = await leave(s.id, [
      { productId: product.id, quantity: 1 },
    ]);
    await sales.returnSamples(returned.id, actor);
    expect(await refusal(sell(s.id, [line(returned.id)]))).toBe(
      'SAMPLES_ALREADY_DECIDED',
    );

    const writtenOff = await leave(s.id, [
      { productId: product.id, quantity: 1 },
    ]);
    await sales.writeOffSamples(writtenOff.id, {}, actor);
    expect(await refusal(sell(s.id, [line(writtenOff.id)]))).toBe(
      'SAMPLES_ALREADY_DECIDED',
    );

    const aSale = await sell(s.id, [
      { productId: product.id, quantity: 1, unitPrice: 300 },
    ]);
    expect(await refusal(sell(s.id, [line(aSale.id)]))).toBe('NOT_SAMPLES');

    const open = await leave(s.id, [{ productId: product.id, quantity: 1 }]);
    expect(await refusal(sell(s.id, [line(open.id, other.product.id)]))).toBe(
      'SAMPLES_PRODUCT_NOT_OUT',
    );
    expect(
      await refusal(sell(s.id, [line(open.id)], { orderedOn: '2026-01-01' })),
    ).toBe('SAMPLES_SALE_BEFORE_LEFT');
    expect(await refusal(sell(s.id, [line(randomUUID())]))).toBe('NOT_FOUND');
    expect(await refusal(sell(s.id, [line('not-an-id')]))).toBe(
      'VALIDATION_FAILED',
    );
    expect((await samplesOrder(open.id)).status).toBe('SAMPLES');
    // 10 received, less the 1 written off: it is gone for good.
    await accountedFor(product.id, 9);
  });

  // ─── The second time ─────────────────────────────────────────────────

  it('doing it twice never converts the same units twice: the same key answers with the first sale, a new sale of them is refused, and two at once make one', async () => {
    const { product } = await stocked([
      { qty: 10, unitPrice: 100, legCost: 0 },
    ]);
    const s = await shop();
    const left = await leave(s.id, [{ productId: product.id, quantity: 3 }]);
    const line = {
      productId: product.id,
      quantity: 3,
      unitPrice: 300,
      fromSamplesOrderId: left.id,
    };
    const key = randomUUID();
    const first = await sell(s.id, [line], {}, key);
    const again = await sell(s.id, [line], {}, key);
    expect(again.id).toBe(first.id);
    expect(await refusal(sell(s.id, [line]))).toBe('SAMPLES_ALREADY_DECIDED');
    await accountedFor(product.id, 10);

    // Two sales of the same samples at the same moment: one wins.
    const twin = await leave(s.id, [{ productId: product.id, quantity: 2 }]);
    const both = await Promise.allSettled(
      [0, 1].map(() =>
        sell(s.id, [{ ...line, quantity: 2, fromSamplesOrderId: twin.id }]),
      ),
    );
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = both.find(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    )!;
    expect(
      ((lost.reason as HttpException).getResponse() as { code: string }).code,
    ).toBe('SAMPLES_ALREADY_DECIDED');
    const fromTwin = await prisma.saleItemAllocation.aggregate({
      where: { saleItem: { fromSamplesOrderId: twin.id } },
      _sum: { qty: true },
    });
    expect(Number(fromTwin._sum.qty)).toBe(2);
    await accountedFor(product.id, 10);
  });

  it('two sales taking part of one sample at the same moment: the second reads what the first left, so no unit is taken twice', async () => {
    const { product, batches } = await stocked([
      { qty: 3, unitPrice: 100, legCost: 0 },
      { qty: 5, unitPrice: 150, legCost: 0 },
    ]);
    const s = await shop();
    const left = await leave(s.id, [{ productId: product.id, quantity: 3 }]);
    // Two drafts confirmed at once: no new order number to queue them, only
    // the hold on the samples order.
    const drafts = [];
    for (let i = 0; i < 2; i++) {
      drafts.push(
        await sell(
          s.id,
          [
            {
              productId: product.id,
              quantity: 2,
              unitPrice: 300,
              fromSamplesOrderId: left.id,
            },
          ],
          { confirm: false },
        ),
      );
    }
    const results = await Promise.allSettled(
      drafts.map((d) => sales.confirmOrder(d.id, actor, d.version)),
    );
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    // 3 from the sample between them, 1 from the shelf; nothing left out.
    const fromSample = await prisma.saleItemAllocation.aggregate({
      where: {
        saleItem: { fromSamplesOrderId: left.id },
        inventoryBatchId: batches[0].id,
      },
      _sum: { qty: true },
    });
    expect(Number(fromSample._sum.qty)).toBe(3);
    expect(await shelf(batches[1].id)).toBe(4);
    expect((await samplesOrder(left.id)).status).toBe('SAMPLES_BOUGHT');
    expect(await atShops(product.id)).toBe(0);
    await accountedFor(product.id, 8);
  });

  it('a draft saved with a sample line moves nothing; confirmed later, the units move then', async () => {
    const { product, batches } = await stocked([
      { qty: 5, unitPrice: 100, legCost: 0 },
    ]);
    const s = await shop();
    const left = await leave(s.id, [{ productId: product.id, quantity: 2 }]);
    const draft = await sell(
      s.id,
      [
        {
          productId: product.id,
          quantity: 2,
          unitPrice: 300,
          fromSamplesOrderId: left.id,
        },
      ],
      { confirm: false },
    );
    expect(draft.status).toBe('DRAFT');
    expect(await atShops(product.id)).toBe(2);
    expect(await allocationsOf(draft.id)).toEqual([]);
    expect(await owedBy(prisma, s.id)).toBe('0.00');

    await sales.confirmOrder(draft.id, actor, draft.version);
    expect(await allocationsOf(draft.id)).toEqual([[batches[0].id, 2, 200]]);
    expect(await shelf(batches[0].id)).toBe(3);
    expect((await samplesOrder(left.id)).status).toBe('SAMPLES_BOUGHT');
    await accountedFor(product.id, 5);
  });

  it('the samples order changing between opening and confirm: fewer left takes the rest from the shelf; returned meanwhile refuses the confirm and the draft stays a draft', async () => {
    const { product, batches } = await stocked([
      { qty: 2, unitPrice: 100, legCost: 0 },
      { qty: 5, unitPrice: 150, legCost: 0 },
    ]);
    const s = await shop();
    const left = await leave(s.id, [{ productId: product.id, quantity: 2 }]);
    const line = {
      productId: product.id,
      quantity: 2,
      unitPrice: 300,
      fromSamplesOrderId: left.id,
    };
    const draft = await sell(s.id, [line], { confirm: false });
    // Meanwhile another sale buys one of the two samples.
    await sell(s.id, [{ ...line, quantity: 1 }]);
    await sales.confirmOrder(draft.id, actor, draft.version);
    // The one sample left (at 100), and one from the shelf (at 150).
    expect(await allocationsOf(draft.id)).toEqual([
      [batches[0].id, 1, 100],
      [batches[1].id, 1, 150],
    ]);
    expect((await samplesOrder(left.id)).status).toBe('SAMPLES_BOUGHT');
    await accountedFor(product.id, 7);

    // Returned while a draft waits: the confirm is refused, nothing moves.
    const back = await leave(s.id, [{ productId: product.id, quantity: 1 }]);
    const waiting = await sell(
      s.id,
      [{ ...line, quantity: 1, fromSamplesOrderId: back.id }],
      { confirm: false },
    );
    await sales.returnSamples(back.id, actor);
    const shelfBefore = await shelfOf(product.id);
    expect(
      await refusal(sales.confirmOrder(waiting.id, actor, waiting.version)),
    ).toBe('SAMPLES_ALREADY_DECIDED');
    expect(
      (await prisma.saleOrder.findUniqueOrThrow({ where: { id: waiting.id } }))
        .status,
    ).toBe('DRAFT');
    expect(await shelfOf(product.id)).toBe(shelfBefore);
    await accountedFor(product.id, 7);
  });

  // ─── "They're buying": keep as sample, or returned ───────────────────

  it("They're buying with Keep as sample: a new sale takes what is bought, kept units stay on the order, the rest goes back to the shelf", async () => {
    const a = await stocked([{ qty: 4, unitPrice: 100, legCost: 0 }]);
    const b = await stocked([{ qty: 4, unitPrice: 200, legCost: 0 }]);
    const c = await stocked([{ qty: 4, unitPrice: 300, legCost: 0 }]);
    const s = await shop();
    const left = await leave(s.id, [
      { productId: a.product.id, quantity: 3 },
      { productId: b.product.id, quantity: 1 },
      { productId: c.product.id, quantity: 2 },
    ]);
    const before = await analytics.profitFigures();
    const key = randomUUID();
    const body = {
      items: [{ productId: a.product.id, quantity: 1, unitPrice: 150 }],
      // A lowered (2 not bought) and B removed stay; C removed is Returned.
      keepAsSample: [a.product.id, b.product.id],
    };
    const res = (await sales.convertSamples(
      left.id,
      body,
      actor,
      key,
    )) as unknown as { data: Order & { samplesOrder: { id: string } } };
    const sale = res.data;
    expect(sale.id).not.toBe(left.id);
    expect(sale.status).toBe('CONFIRMED');
    expect(sale.samplesOrder.id).toBe(left.id);
    expect(await allocationsOf(sale.id)).toEqual([[a.batches[0].id, 1, 100]]);
    const open = await samplesOrder(left.id);
    expect(open.status).toBe('SAMPLES');
    expect(
      open.items
        .map((i) => [i.productId, Number(i.quantity)])
        .sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    ).toEqual(
      [
        [a.product.id, 2],
        [b.product.id, 1],
      ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    );
    // C is back on the shelf; A and B are not.
    expect(await shelf(c.batches[0].id)).toBe(4);
    expect(await shelf(a.batches[0].id)).toBe(1);
    expect(await shelf(b.batches[0].id)).toBe(3);
    const after = await analytics.profitFigures();
    expect(after.revenue.sub(before.revenue).toFixed(2)).toBe('150.00');
    expect(after.cogs.sub(before.cogs).toFixed(2)).toBe('100.00');
    for (const p of [a, b, c]) await accountedFor(p.product.id, 4);

    // A retry with the same key answers with the same sale.
    const retry = (await sales.convertSamples(left.id, body, actor, key)) as {
      data: Order;
    };
    expect(retry.data.id).toBe(sale.id);
    for (const p of [a, b, c]) await accountedFor(p.product.id, 4);

    // The samples order's history names the sale and what came back.
    const kinds = (await history.history(left.id)).data.events.map(
      (e) => e.kind,
    );
    expect(kinds).toEqual(
      expect.arrayContaining([
        'SAMPLES_LEFT',
        'SAMPLES_PART_RETURNED',
        'SAMPLES_INTO_SALE',
      ]),
    );
  });

  it("They're buying with nothing kept still converts in place, as before; keepAsSample that is not a list is refused", async () => {
    const { product } = await stocked([{ qty: 4, unitPrice: 100, legCost: 0 }]);
    const s = await shop();
    const left = await leave(s.id, [{ productId: product.id, quantity: 3 }]);
    expect(
      await refusal(
        sales.convertSamples(
          left.id,
          {
            items: [{ productId: product.id, quantity: 1, unitPrice: 150 }],
            keepAsSample: 'all' as unknown as string[],
          },
          actor,
        ),
      ),
    ).toBe('VALIDATION_FAILED');
    const res = (await sales.convertSamples(
      left.id,
      {
        items: [{ productId: product.id, quantity: 1, unitPrice: 150 }],
        keepAsSample: [],
      },
      actor,
    )) as { data: Order };
    expect(res.data.id).toBe(left.id);
    expect(res.data.status).toBe('CONFIRMED');
    expect(await atShops(product.id)).toBe(0);
    await accountedFor(product.id, 4);
  });
});
