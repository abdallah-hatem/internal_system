import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- this suite talks to a real, throwaway Postgres; that is its point
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { InventoryService } from '../inventory/inventory.service';
import { PaymentsService } from '../payments/payments.service';
import { SettlementsService } from '../settlements/settlements.service';
import { SalesService, type CreateSaleOrderInput } from './sales.service';
import { owedBy } from '../../common/customer-balance';
import {
  buildStatement,
  loadStatementSource,
} from '../../common/customer-statement';
import { samplesWrittenOffEgp } from '../../common/cycle-losses';
import { unitsAtShopsByProduct } from '../../common/samples-out';
import { businessDay, businessToday } from '../../common/dates';
import { addDays } from '../../common/samples';

/**
 * Samples left at shops against a real Postgres (BUSINESS_LOGIC §4, "Samples
 * at shops", owner 2026-10-18). Every figure the feature promises to leave
 * alone — revenue, COGS, receivables, the shop's balance and statement, the
 * dashboard and the P&L — is read through the very services the screens use,
 * before and after, so a samples order that leaked into any of them fails here.
 *
 * Runs only when INTEGRATION_DATABASE_URL points at a THROWAWAY database with
 * the migrations applied — an agent's own (`scripts/agent-env.sh <name>`), never
 * the developer's (CLAUDE.md rule 6):
 *
 *   INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/motorcycle_parts_<name> \
 *     npx jest samples.db
 *
 * Each test builds its own product, cycle and shop, so the suite can run again
 * on the same database. It compares business-wide figures (revenue, the
 * dashboard, the P&L) before and after, so run it alone or with `--runInBand`:
 * another suite selling in parallel moves those figures under it.
 */
// eslint-disable-next-line no-restricted-properties -- an opt-in switch for a suite that must never run by default
const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;

type Notified = {
  userIds: string[];
  event: {
    eventType: string;
    code?: string;
    params?: Record<string, unknown>;
    payload?: Record<string, unknown>;
  };
};

suite('samples at shops against Postgres', () => {
  let prisma: PrismaClient;
  let sales: SalesService;
  let payments: PaymentsService;
  let analytics: AnalyticsService;
  let settlements: SettlementsService;
  let inventory: InventoryService;
  let actor: string;
  const notified: Notified[] = [];

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const db = prisma as unknown as PrismaService;
    const audit = { log: jest.fn() } as unknown as AuditService;
    payments = new PaymentsService(db, audit);
    sales = new SalesService(db, audit, payments, {
      createForMultipleUsers: (userIds: string[], event: Notified['event']) => {
        notified.push({ userIds, event });
        return Promise.resolve({ count: userIds.length });
      },
    });
    analytics = new AnalyticsService(db);
    settlements = new SettlementsService(db, audit);
    inventory = new InventoryService(
      db,
      audit,
      {} as never,
      {} as never,
      {} as never,
    );
    const user = await prisma.user.create({
      data: {
        email: `samples-${randomUUID()}@example.com`,
        passwordHash: 'x',
        role: 'CORE_PARTNER',
      },
    });
    actor = user.id;
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => {
    notified.length = 0;
  });

  /** A selling cycle funded by one core partner, so it can be settled. */
  async function cycleFor(tag: string) {
    const cycle = await prisma.importCycle.create({
      data: {
        code: `SMP-${tag}-${randomUUID().slice(0, 4)}`,
        originType: 'UAE_DIRECT',
        currency: 'EGP',
        status: 'SELLING',
      },
    });
    await prisma.cycleParticipant.create({
      data: {
        cycleId: cycle.id,
        participantType: 'CORE_PARTNER',
        partnerUserId: actor,
        contributionAmount: 10_000,
      },
    });
    return cycle;
  }

  /**
   * A product with verified batches, oldest first: each `{ qty, cost }` on its
   * own cycle unless `cycle` is given, received `daysAgo` days ago.
   */
  async function stocked(
    batches: { qty: number; cost: number; daysAgo: number; cycleId?: string }[],
    product: { minStock?: number } = {},
  ) {
    const tag = randomUUID().slice(0, 8);
    const p = await prisma.product.create({
      data: {
        sku: `SMP-${tag}`,
        name: `Sample part ${tag}`,
        status: 'ACTIVE',
        ...(product.minStock !== undefined
          ? { minStock: product.minStock }
          : {}),
      },
    });
    const made = [];
    for (const b of batches) {
      const cycleId = b.cycleId ?? (await cycleFor(tag)).id;
      made.push(
        await prisma.inventoryBatch.create({
          data: {
            cycleId,
            productId: p.id,
            receivedQty: b.qty,
            remainingQty: b.qty,
            saleableQty: b.qty,
            landedUnitCostEgp: b.cost,
            verificationStatus: 'VERIFIED',
            createdAt: new Date(Date.now() - b.daysAgo * 86_400_000),
          },
        }),
      );
    }
    return { product: p, batches: made };
  }

  async function shop(type: 'B2B' | 'B2C' = 'B2B') {
    return prisma.customer.create({
      data: {
        type,
        displayName: `Shop ${randomUUID().slice(0, 6)}`,
        verificationStatus: 'VERIFIED',
      },
    });
  }

  const leave = (
    customerId: string,
    items: CreateSaleOrderInput['items'],
    extra: Partial<CreateSaleOrderInput> = {},
  ) =>
    sales.create(
      {
        samples: true,
        customerId,
        channel: 'B2B',
        currency: 'EGP',
        items,
        ...extra,
      },
      actor,
    ) as Promise<{ data: { id: string; orderNo: string; status: string } }>;

  async function refusal(p: Promise<unknown>) {
    try {
      await p;
    } catch (e) {
      if (!(e instanceof HttpException)) throw e;
      return (e.getResponse() as { code: string }).code;
    }
    throw new Error('expected a refusal, got success');
  }

  const shelf = async (batchId: string) => {
    const b = await prisma.inventoryBatch.findUniqueOrThrow({
      where: { id: batchId },
    });
    return [Number(b.remainingQty), Number(b.saleableQty)];
  };
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
  /** Sold, net of nothing: every realised allocation of the product. */
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
  /** The units of a product add up: shelf + at shops + sold = received (§4). */
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

  /** The business-wide figures the feature must leave alone. */
  async function figures(customerId: string) {
    const f = await analytics.profitFigures();
    const kpis = (await analytics.getDashboardKPIs()) as {
      data: { receivables: number };
    };
    const statement = buildStatement(
      { id: customerId, displayName: 'x', phone: null },
      await loadStatementSource(prisma, customerId),
    );
    const pnl = (await analytics.getProfitAndLoss()).data;
    return {
      revenue: f.revenue.toFixed(2),
      cogs: f.cogs.toFixed(2),
      netProfit: f.netProfit.toFixed(2),
      expenses: f.operatingExpenses.toFixed(2),
      receivables: kpis.data.receivables.toFixed(2),
      owed: await owedBy(prisma, customerId),
      statementRows: statement.rows.length,
      pnlSales: pnl.salesEgp.toFixed(2),
      pnlNet: pnl.netProfitEgp.toFixed(2),
    };
  }

  // ─── Leaving samples ─────────────────────────────────────────────────

  it('leaving samples takes the units off the shelf FIFO at landed cost and adds nothing to revenue, COGS, receivables, the shop balance, its statement, the dashboard or the P&L', async () => {
    const { product, batches } = await stocked([
      { qty: 2, cost: 100, daysAgo: 10 },
      { qty: 10, cost: 130, daysAgo: 5 },
    ]);
    const s = await shop();
    const before = await figures(s.id);

    const left = await leave(s.id, [
      { productId: product.id, quantity: 5, unitPrice: 250 },
    ]);

    const order = await prisma.saleOrder.findUniqueOrThrow({
      where: { id: left.data.id },
      include: { items: { include: { allocations: true } } },
    });
    expect(order.status).toBe('SAMPLES');
    expect(order.orderNo).toMatch(/^ORD-\d{4}-\d{5}$/);
    expect([
      Number(order.total),
      Number(order.outstanding),
      Number(order.subtotal),
    ]).toEqual([0, 0, 0]);
    expect(order.samplesLeftAt).not.toBeNull();
    // The noted price is kept for the decision; the line is worth nothing yet.
    expect([
      Number(order.items[0].unitPrice),
      Number(order.items[0].lineTotal),
    ]).toEqual([250, 0]);
    // FIFO: the old batch's 2 at 100, then 3 of the newer at 130.
    const draws = order.items[0].allocations
      .map((a) => [a.inventoryBatchId, Number(a.qty), Number(a.cogsEgp)])
      .sort((a, b) => Number(a[2]) - Number(b[2]));
    expect(draws).toEqual([
      [batches[0].id, 2, 200],
      [batches[1].id, 3, 390],
    ]);
    expect(await shelf(batches[0].id)).toEqual([0, 0]);
    expect(await shelf(batches[1].id)).toEqual([7, 7]);
    expect(await atShops(product.id)).toBe(5);
    const moves = await prisma.inventoryMovement.findMany({
      where: { referenceId: order.id },
    });
    expect(moves.every((m) => m.movementType === 'SAMPLE_OUT')).toBe(true);
    expect(moves.reduce((t, m) => t + Number(m.qtyDelta), 0)).toBe(-5);

    expect(await figures(s.id)).toEqual(before);
    await accountedFor(product.id, 12);
  });

  it('prices are optional: a line with no price is left at 0, nothing charged', async () => {
    const { product } = await stocked([{ qty: 4, cost: 100, daysAgo: 3 }]);
    const s = await shop();
    const left = await leave(s.id, [
      { productId: product.id, quantity: 2 } as never,
    ]);
    const item = await prisma.saleItem.findFirstOrThrow({
      where: { saleOrderId: left.data.id },
    });
    expect(Number(item.unitPrice)).toBe(0);
    expect(left.data.status).toBe('SAMPLES');
  });

  it('more than is on the shelf, zero or a negative quantity → refused, and nothing is left behind', async () => {
    const { product, batches } = await stocked([
      { qty: 3, cost: 100, daysAgo: 3 },
    ]);
    const s = await shop();
    expect(
      await refusal(
        leave(s.id, [{ productId: product.id, quantity: 4, unitPrice: 1 }]),
      ),
    ).toBe('NOT_ENOUGH_STOCK');
    // Two lines of 2 against 3 is 4: summed per product, as a sale is.
    expect(
      await refusal(
        leave(s.id, [
          { productId: product.id, quantity: 2, unitPrice: 1 },
          { productId: product.id, quantity: 2, unitPrice: 1 },
        ]),
      ),
    ).toBe('NOT_ENOUGH_STOCK');
    expect(
      await refusal(
        leave(s.id, [{ productId: product.id, quantity: 0, unitPrice: 1 }]),
      ),
    ).toBe('QTY_NOT_POSITIVE');
    expect(
      await refusal(
        leave(s.id, [{ productId: product.id, quantity: -2, unitPrice: 1 }]),
      ),
    ).toBe('QTY_NOT_POSITIVE');
    expect(await shelf(batches[0].id)).toEqual([3, 3]);
    expect(await prisma.saleOrder.count({ where: { customerId: s.id } })).toBe(
      0,
    );
  });

  it('samples need a real shop: walk-in, no customer or a customer that does not exist are refused', async () => {
    const { product } = await stocked([{ qty: 3, cost: 100, daysAgo: 3 }]);
    const line = [{ productId: product.id, quantity: 1, unitPrice: 1 }];
    expect(
      await refusal(leave(undefined as never, line, { walkIn: true })),
    ).toBe('SAMPLES_NEED_SHOP');
    const walkInRecord = await prisma.customer.findFirst({
      where: { isWalkIn: true },
    });
    if (walkInRecord) {
      expect(await refusal(leave(walkInRecord.id, line))).toBe(
        'SAMPLES_NEED_SHOP',
      );
    }
    expect(await refusal(leave(undefined as never, line))).toBe(
      'CUSTOMER_REQUIRED',
    );
    expect(await refusal(leave(randomUUID(), line))).toBe('NOT_FOUND');
  });

  it('a payment cannot be recorded against samples — chosen on the order or allocated afterwards', async () => {
    const { product } = await stocked([{ qty: 3, cost: 100, daysAgo: 3 }]);
    const s = await shop();
    const left = await leave(s.id, [
      { productId: product.id, quantity: 2, unitPrice: 100 },
    ]);
    // On the order directly.
    const onOrder = await refusal(
      payments.create(
        {
          customerId: s.id,
          amount: 100,
          currency: 'EGP',
          receivedOn: businessToday(),
          orderId: left.data.id,
        },
        actor,
      ),
    );
    expect(onOrder).toBe('SAMPLES_NOT_PAYABLE');
    // Allocated: give the shop a real sale to pay on, then aim the money at the samples.
    await sales.create(
      {
        customerId: s.id,
        channel: 'B2B',
        currency: 'EGP',
        confirm: true,
        items: [{ productId: product.id, quantity: 1, unitPrice: 500 }],
      },
      actor,
    );
    const paid = (await payments.create(
      {
        customerId: s.id,
        amount: 100,
        currency: 'EGP',
        receivedOn: businessToday(),
      },
      actor,
    )) as { data: { id: string; payment?: { id: string } } };
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: paid.data.payment?.id ?? paid.data.id },
    });
    await prisma.paymentAllocation.deleteMany({
      where: { paymentId: payment.id },
    });
    expect(
      await refusal(
        payments.allocateToOrder(payment.id, left.data.id, 50, actor),
      ),
    ).toBe('SAMPLES_NOT_PAYABLE');
    expect(
      await prisma.paymentAllocation.count({
        where: { saleOrderId: left.data.id },
      }),
    ).toBe(0);
  });

  it('samples have no invoice', async () => {
    const { product } = await stocked([{ qty: 3, cost: 100, daysAgo: 3 }]);
    const s = await shop();
    const left = await leave(s.id, [
      { productId: product.id, quantity: 1, unitPrice: 1 },
    ]);
    expect(await refusal(sales.invoice(left.data.id))).toBe('INVOICE_SAMPLES');
  });

  // ─── Deciding ───────────────────────────────────────────────────────

  it('a partial decision: revenue and COGS only for the bought units (oldest first), dated the decision day; returned units back on their own batch', async () => {
    const { product, batches } = await stocked([
      { qty: 2, cost: 100, daysAgo: 20 },
      { qty: 10, cost: 130, daysAgo: 15 },
    ]);
    const s = await shop();
    const yesterday = addDays(businessToday(), -1);
    const left = await leave(
      s.id,
      [{ productId: product.id, quantity: 5, unitPrice: 250 }],
      { orderedOn: yesterday },
    );
    const before = await figures(s.id);
    const item = await prisma.saleItem.findFirstOrThrow({
      where: { saleOrderId: left.data.id },
    });

    await sales.decideSamples(
      left.data.id,
      {
        lines: [
          { saleItemId: item.id, buyQty: 3, returnQty: 2, unitPrice: 250 },
        ],
      },
      actor,
    );

    const order = await prisma.saleOrder.findUniqueOrThrow({
      where: { id: left.data.id },
      include: { items: { include: { allocations: true } } },
    });
    expect(order.orderNo).toBe(left.data.orderNo); // in place: one ORD number
    expect(order.status).toBe('CONFIRMED');
    expect(businessDay(order.orderedAt)).toBe(businessToday());
    expect(businessDay(order.samplesLeftAt!)).toBe(yesterday);
    expect([Number(order.total), Number(order.outstanding)]).toEqual([
      750, 750,
    ]);
    expect(order.items).toHaveLength(1);
    expect([
      Number(order.items[0].quantity),
      Number(order.items[0].lineTotal),
    ]).toEqual([3, 750]);
    // Bought: the old batch's 2 at 100 and 1 at 130 — what FIFO would charge.
    const cogs = order.items[0].allocations.reduce(
      (t, a) => t + Number(a.cogsEgp),
      0,
    );
    expect(cogs).toBe(330);
    // Returned: 2 back to the newer batch they left.
    expect(await shelf(batches[0].id)).toEqual([0, 0]);
    expect(await shelf(batches[1].id)).toEqual([9, 9]);
    expect(await atShops(product.id)).toBe(0);

    const after = await figures(s.id);
    const delta = (k: keyof typeof before) =>
      (Number(after[k]) - Number(before[k])).toFixed(2);
    expect(delta('revenue')).toBe('750.00');
    expect(delta('cogs')).toBe('330.00');
    expect(delta('receivables')).toBe('750.00');
    expect(delta('owed')).toBe('750.00');
    expect(delta('pnlSales')).toBe('750.00');
    expect(after.statementRows).toBe(before.statementRows + 1);
    const statement = buildStatement(
      { id: s.id, displayName: 'x', phone: null },
      await loadStatementSource(prisma, s.id),
    );
    expect(statement.rows.find((r) => r.kind === 'SALE')?.date).toBe(
      businessToday(),
    );
    await accountedFor(product.id, 12);
  });

  it('the decision is refused when buying + returned is not what is out, or a bought line has no price — and nothing moves', async () => {
    const { product, batches } = await stocked([
      { qty: 5, cost: 100, daysAgo: 3 },
    ]);
    const s = await shop();
    const left = await leave(s.id, [
      { productId: product.id, quantity: 4 } as never,
    ]);
    const item = await prisma.saleItem.findFirstOrThrow({
      where: { saleOrderId: left.data.id },
    });
    const decide = (line: Record<string, unknown>) =>
      sales.decideSamples(
        left.data.id,
        { lines: [{ saleItemId: item.id, ...line } as never] },
        actor,
      );

    expect(
      await refusal(decide({ buyQty: 3, returnQty: 2, unitPrice: 1 })),
    ).toBe('SAMPLES_DECISION_MISMATCH');
    expect(await refusal(decide({ buyQty: 0, returnQty: 0 }))).toBe(
      'SAMPLES_DECISION_MISMATCH',
    );
    expect(
      await refusal(decide({ buyQty: -1, returnQty: 5, unitPrice: 1 })),
    ).toBe('SAMPLES_QTY_NEGATIVE');
    expect(await refusal(decide({ buyQty: 4, returnQty: 0 }))).toBe(
      'SAMPLES_PRICE_REQUIRED',
    );
    expect(
      await refusal(
        sales.decideSamples(
          left.data.id,
          {
            lines: [
              {
                saleItemId: randomUUID(),
                buyQty: 4,
                returnQty: 0,
                unitPrice: 1,
              },
            ],
          },
          actor,
        ),
      ),
    ).toBe('SAMPLES_LINE_NOT_IN_ORDER');

    const order = await prisma.saleOrder.findUniqueOrThrow({
      where: { id: left.data.id },
    });
    expect(order.status).toBe('SAMPLES');
    expect(await shelf(batches[0].id)).toEqual([1, 1]);
  });

  it('all bought, none returned: a normal sale of every unit, nothing back on the shelf', async () => {
    const { product, batches } = await stocked([
      { qty: 5, cost: 100, daysAgo: 3 },
    ]);
    const s = await shop();
    const left = await leave(s.id, [
      { productId: product.id, quantity: 5, unitPrice: 200 },
    ]);
    const item = await prisma.saleItem.findFirstOrThrow({
      where: { saleOrderId: left.data.id },
    });
    await sales.decideSamples(
      left.data.id,
      {
        lines: [
          { saleItemId: item.id, buyQty: 5, returnQty: 0, unitPrice: 180 },
        ],
      },
      actor,
    );
    const order = await prisma.saleOrder.findUniqueOrThrow({
      where: { id: left.data.id },
    });
    expect([order.status, Number(order.total)]).toEqual(['CONFIRMED', 900]);
    expect(await shelf(batches[0].id)).toEqual([0, 0]);
    await accountedFor(product.id, 5);
  });

  it('all returned through the decision (nothing bought): returned samples, every unit back on its batch, nothing sold', async () => {
    const { product, batches } = await stocked([
      { qty: 1, cost: 100, daysAgo: 9 },
      { qty: 4, cost: 120, daysAgo: 3 },
    ]);
    const s = await shop();
    const before = await figures(s.id);
    const left = await leave(s.id, [
      { productId: product.id, quantity: 3, unitPrice: 200 },
    ]);
    const item = await prisma.saleItem.findFirstOrThrow({
      where: { saleOrderId: left.data.id },
    });
    await sales.decideSamples(
      left.data.id,
      { lines: [{ saleItemId: item.id, buyQty: 0, returnQty: 3 }] },
      actor,
    );
    const order = await prisma.saleOrder.findUniqueOrThrow({
      where: { id: left.data.id },
    });
    expect(order.status).toBe('SAMPLES_RETURNED');
    expect(await shelf(batches[0].id)).toEqual([1, 1]);
    expect(await shelf(batches[1].id)).toEqual([4, 4]);
    expect(await figures(s.id)).toEqual(before);
    await accountedFor(product.id, 5);
  });

  it('"Returned" and Cancel on samples both put everything back and end as returned samples, never a cancelled sale', async () => {
    const { product, batches } = await stocked([
      { qty: 5, cost: 100, daysAgo: 3 },
    ]);
    const s = await shop();
    const a = await leave(s.id, [
      { productId: product.id, quantity: 2, unitPrice: 1 },
    ]);
    const b = await leave(s.id, [
      { productId: product.id, quantity: 1, unitPrice: 1 },
    ]);
    await sales.returnSamples(a.data.id, actor);
    await sales.cancelOrder(b.data.id, actor);
    const statuses = await prisma.saleOrder.findMany({
      where: { id: { in: [a.data.id, b.data.id] } },
      select: { status: true },
    });
    expect(statuses.map((o) => o.status)).toEqual([
      'SAMPLES_RETURNED',
      'SAMPLES_RETURNED',
    ]);
    expect(await shelf(batches[0].id)).toEqual([5, 5]);
  });

  it('the second time is refused: deciding twice, returning after deciding, writing off after returning, cancelling after writing off', async () => {
    const { product, batches } = await stocked([
      { qty: 9, cost: 100, daysAgo: 3 },
    ]);
    const s = await shop();
    const bought = await leave(s.id, [
      { productId: product.id, quantity: 2, unitPrice: 50 },
    ]);
    const item = await prisma.saleItem.findFirstOrThrow({
      where: { saleOrderId: bought.data.id },
    });
    const decision = {
      lines: [{ saleItemId: item.id, buyQty: 2, returnQty: 0, unitPrice: 50 }],
    };
    await sales.decideSamples(bought.data.id, decision, actor);
    expect(
      await refusal(sales.decideSamples(bought.data.id, decision, actor)),
    ).toBe('SAMPLES_ALREADY_DECIDED');
    expect(await refusal(sales.returnSamples(bought.data.id, actor))).toBe(
      'SAMPLES_ALREADY_DECIDED',
    );
    expect(
      await refusal(sales.writeOffSamples(bought.data.id, {}, actor)),
    ).toBe('SAMPLES_ALREADY_DECIDED');

    const returned = await leave(s.id, [
      { productId: product.id, quantity: 2, unitPrice: 1 },
    ]);
    await sales.returnSamples(returned.data.id, actor);
    expect(await refusal(sales.returnSamples(returned.data.id, actor))).toBe(
      'SAMPLES_ALREADY_DECIDED',
    );
    expect(
      await refusal(sales.writeOffSamples(returned.data.id, {}, actor)),
    ).toBe('SAMPLES_ALREADY_DECIDED');
    expect(await refusal(sales.cancelOrder(returned.data.id, actor))).toBe(
      'SAMPLES_ALREADY_DECIDED',
    );

    const gone = await leave(s.id, [
      { productId: product.id, quantity: 1, unitPrice: 1 },
    ]);
    await sales.writeOffSamples(gone.data.id, {}, actor);
    expect(await refusal(sales.cancelOrder(gone.data.id, actor))).toBe(
      'SAMPLES_ALREADY_DECIDED',
    );
    expect(await refusal(sales.returnSamples(gone.data.id, actor))).toBe(
      'SAMPLES_ALREADY_DECIDED',
    );

    // Two at once: exactly one wins, and the stock moved once.
    const race = await leave(s.id, [
      { productId: product.id, quantity: 2, unitPrice: 1 },
    ]);
    const results = await Promise.allSettled([
      sales.returnSamples(race.data.id, actor),
      sales.returnSamples(race.data.id, actor),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    // 9 − 2 bought − 1 written off = 6 on the shelf; the raced 2 back once.
    expect(await shelf(batches[0].id)).toEqual([6, 6]);
    // Not samples at all: an ordinary draft.
    const draft = (await sales.create(
      {
        customerId: s.id,
        channel: 'B2B',
        currency: 'EGP',
        items: [{ productId: product.id, quantity: 1, unitPrice: 1 }],
      },
      actor,
    )) as { data: { id: string } };
    expect(await refusal(sales.returnSamples(draft.data.id, actor))).toBe(
      'NOT_SAMPLES',
    );
    expect(await refusal(sales.returnSamples(randomUUID(), actor))).toBe(
      'NOT_FOUND',
    );
  });

  // ─── Writing off ────────────────────────────────────────────────────

  it('write-off: the cost lands on the cycle each unit came from and in the P&L as its own line; the stock is gone for good', async () => {
    const cycleA = await cycleFor('A');
    const cycleB = await cycleFor('B');
    const { product, batches } = await stocked([
      { qty: 2, cost: 100, daysAgo: 9, cycleId: cycleA.id },
      { qty: 5, cost: 130, daysAgo: 3, cycleId: cycleB.id },
    ]);
    const s = await shop();
    const left = await leave(s.id, [
      { productId: product.id, quantity: 4, unitPrice: 300 },
    ]);
    const before = await figures(s.id);
    const pnlBefore =
      (await analytics.getProfitAndLoss()).data.expensesByCategory.find(
        (c) => c.category === 'samples_written_off',
      )?.amountEgp ?? 0;

    await sales.writeOffSamples(
      left.data.id,
      { reason: 'Shop kept them' },
      actor,
    );

    expect((await samplesWrittenOffEgp(prisma, cycleA.id)).toFixed(2)).toBe(
      '200.00',
    );
    expect((await samplesWrittenOffEgp(prisma, cycleB.id)).toFixed(2)).toBe(
      '260.00',
    );
    const after = await figures(s.id);
    // Not a sale: no revenue, no COGS, nothing owed — an expense, off net profit.
    expect([after.revenue, after.cogs, after.owed, after.receivables]).toEqual([
      before.revenue,
      before.cogs,
      before.owed,
      before.receivables,
    ]);
    expect(
      (Number(before.netProfit) - Number(after.netProfit)).toFixed(2),
    ).toBe('460.00');
    expect((Number(after.expenses) - Number(before.expenses)).toFixed(2)).toBe(
      '460.00',
    );
    const pnlAfter = (
      await analytics.getProfitAndLoss()
    ).data.expensesByCategory.find(
      (c) => c.category === 'samples_written_off',
    )?.amountEgp;
    expect(((pnlAfter ?? 0) - pnlBefore).toFixed(2)).toBe('460.00');

    // The cycle's settlement subtracts it, as its own line.
    const preview = (await settlements.preview(cycleA.id)).data;
    expect(preview.costs).toEqual(
      expect.arrayContaining([
        { kind: 'loss', category: 'samples_written_off', amountEgp: '200.00' },
      ]),
    );
    expect(Number(preview.expensesEgp)).toBeGreaterThanOrEqual(200);

    // Gone: neither on the shelf nor at a shop, never coming back.
    expect(await shelf(batches[0].id)).toEqual([0, 0]);
    expect(await shelf(batches[1].id)).toEqual([3, 3]);
    expect(await atShops(product.id)).toBe(0);
  });

  // ─── Settling ───────────────────────────────────────────────────────

  it('a cycle cannot be settled while its units are out as samples, naming the shop; once they are back it can', async () => {
    const cycle = await cycleFor('S');
    const { product } = await stocked([
      { qty: 6, cost: 100, daysAgo: 5, cycleId: cycle.id },
    ]);
    const s = await shop();
    // Something sold, so the settlement has profit to split.
    await sales.create(
      {
        customerId: s.id,
        channel: 'B2B',
        currency: 'EGP',
        confirm: true,
        items: [{ productId: product.id, quantity: 1, unitPrice: 400 }],
      },
      actor,
    );
    const left = await leave(s.id, [
      { productId: product.id, quantity: 3, unitPrice: 1 },
    ]);

    // Units at the shop are unsold stock, not sold.
    const preview = (await settlements.preview(cycle.id)).data;
    expect(Number(preview.unsoldValueEgp)).toBe(500); // 2 on the shelf + 3 at the shop, at 100

    let body: { code?: string; params?: Record<string, string> } | undefined;
    try {
      await settlements.calculate(cycle.id, actor);
    } catch (e) {
      body = (e as HttpException).getResponse() as typeof body;
    }
    expect(body?.code).toBe('CYCLE_HAS_SAMPLES_OUT');
    expect(body?.params).toMatchObject({
      units: '3',
      shops: `${s.displayName} (3)`,
    });

    await sales.returnSamples(left.data.id, actor);
    const calculated = (await settlements.calculate(cycle.id, actor)) as {
      data: { status: string };
    };
    expect(calculated.data.status).toBe('DRAFT');
  });

  // ─── Low stock and inventory ────────────────────────────────────────

  it('low stock counts the shelf only: samples that take it under the minimum raise the alert; inventory shows them At shops, total = shelf + at shops', async () => {
    const { product } = await stocked([{ qty: 5, cost: 100, daysAgo: 3 }], {
      minStock: 4,
    });
    const s = await shop();
    await leave(s.id, [{ productId: product.id, quantity: 2, unitPrice: 1 }]);
    expect(
      notified.some((n) => n.event.eventType === 'LOW_STOCK_DETECTED'),
    ).toBe(true);

    // The row the Inventory page reads: 3 on the shelf, 2 at the shop, 5 ours.
    const stock = await inventory.getStock({ productId: product.id });
    expect(stock.data[0]).toMatchObject({
      totalStock: 3,
      atShopsStock: 2,
      allStock: 5,
      availableStock: 3,
      batches: [{ atShopsQty: 2 }],
    });
  });

  // ─── The reminder ───────────────────────────────────────────────────

  it('the reminder goes once, 14 days after the samples were left, to every core partner — not before, not twice, not for decided samples', async () => {
    const { product } = await stocked([{ qty: 9, cost: 100, daysAgo: 40 }]);
    const s = await shop();
    const today = businessToday();
    const due = await leave(
      s.id,
      [{ productId: product.id, quantity: 1, unitPrice: 1 }],
      {
        orderedOn: addDays(today, -14),
      },
    );
    const early = await leave(
      s.id,
      [{ productId: product.id, quantity: 1, unitPrice: 1 }],
      {
        orderedOn: addDays(today, -13),
      },
    );
    const decided = await leave(
      s.id,
      [{ productId: product.id, quantity: 1, unitPrice: 1 }],
      {
        orderedOn: addDays(today, -20),
      },
    );
    await sales.returnSamples(decided.data.id, actor);
    notified.length = 0;

    await sales.notifySamplesReminders();
    const about = (id: string) =>
      notified.filter(
        (n) =>
          n.event.eventType === 'SAMPLES_REMINDER' &&
          n.event.payload?.orderId === id,
      );
    expect(about(due.data.id)).toHaveLength(1);
    expect(about(due.data.id)[0].event).toMatchObject({
      code: 'SAMPLES_AT_SHOP_REMINDER',
      params: { shop: s.displayName, days: 14 },
    });
    expect(about(due.data.id)[0].userIds).toContain(actor);
    expect(about(early.data.id)).toHaveLength(0);
    expect(about(decided.data.id)).toHaveLength(0);

    await sales.notifySamplesReminders();
    expect(about(due.data.id)).toHaveLength(1);
  });

  it('the same leave saved twice (a double click) leaves the samples once', async () => {
    const { product, batches } = await stocked([
      { qty: 5, cost: 100, daysAgo: 3 },
    ]);
    const s = await shop();
    const key = randomUUID();
    const body = {
      samples: true,
      customerId: s.id,
      channel: 'B2B',
      currency: 'EGP',
      items: [{ productId: product.id, quantity: 2, unitPrice: 1 }],
    } as CreateSaleOrderInput;
    const [a, b] = (await Promise.all([
      sales.create(body, actor, key),
      sales.create(body, actor, key),
    ])) as { data: { id: string } }[];
    expect(a.data.id).toBe(b.data.id);
    expect(await shelf(batches[0].id)).toEqual([3, 3]);
  });
});
