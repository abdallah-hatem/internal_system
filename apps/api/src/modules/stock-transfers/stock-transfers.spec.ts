/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- the fake database's rows are untyped records, as Prisma's argument objects are */
import { randomUUID } from 'crypto';
import { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../../common/guards/roles.guard';
import { cashPosition } from '../../common/cash-position';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { CostingService } from '../costing/costing.service';
import { CyclesService } from '../cycles/cycles.service';
import { SalesService } from '../sales/sales.service';
import { PaymentsService } from '../payments/payments.service';
import { SettlementsService } from '../settlements/settlements.service';
import { DeliveriesService } from '../shipping/deliveries.service';
import { InventoryService } from '../inventory/inventory.service';
import { LedgerService } from '../ledger/ledger.service';
import {
  addLeg,
  cycleWithOrder,
  D,
  emptyStore,
  fakePrisma,
  type Row,
  type Store,
} from '../shipping/shipment-fake-spec';
import {
  CycleTransfersController,
  StockTransfersController,
} from './stock-transfers.controller';
import { StockTransfersService } from './stock-transfers.service';

/**
 * L5 — leftover stock moves to another cycle at its cost (BUSINESS_LOGIC §8,
 * owner 2026-10-11). Every state is built the way the business builds it
 * (CLAUDE.md §4): an order, a leg, a delivery, a receipt, a confirmed sale —
 * through the real services over the in-memory database
 * (`shipment-fake-spec.ts`), with the real costing, FIFO and settlement maths.
 * e2e for the same cases is phase 2.
 */

const ACTOR = randomUUID();
let db: Store;
let prisma: ReturnType<typeof fakePrisma>;
let transfers: StockTransfersService;
let deliveries: DeliveriesService;
let inventory: InventoryService;
let cycles: CyclesService;
let settlements: SettlementsService;
let costing: CostingService;
let analytics: AnalyticsService;
let sales: SalesService;
let ledger: LedgerService;

const at = (iso: string) => jest.setSystemTime(new Date(iso));
beforeEach(() => {
  jest.useFakeTimers({
    doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    now: new Date('2026-09-21T09:00:00Z'),
  });
  db = emptyStore();
  prisma = fakePrisma(db);
  const audit = { log: jest.fn() } as unknown as AuditService;
  const notifications = {
    createForMultipleUsers: jest.fn(),
  } as unknown as NotificationsService;
  costing = new CostingService(prisma);
  cycles = new CyclesService(prisma, audit, notifications);
  deliveries = new DeliveriesService(prisma, audit, notifications, costing);
  inventory = new InventoryService(
    prisma,
    audit,
    notifications,
    costing,
    cycles,
  );
  settlements = new SettlementsService(prisma, audit, costing);
  analytics = new AnalyticsService(prisma);
  sales = new SalesService(prisma, audit, new PaymentsService(prisma, audit), {
    createForMultipleUsers: () => Promise.resolve({ count: 0 }),
  });
  transfers = new StockTransfersService(prisma, audit);
  ledger = new LedgerService(prisma, audit);
});
afterEach(() => jest.useRealTimers());

async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof HttpException)) throw e;
    const body = e.getResponse() as Record<string, any>;
    return { status: e.getStatus(), code: body.code, params: body.params };
  }
  throw new Error('expected a refusal');
}

// ─── Building states the business recognises (CLAUDE.md §4) ──────────────

/**
 * A UAE-direct cycle that ordered `qty` of `productId` at 100 with a 400 leg,
 * had it all delivered on `day` and checked in — selling, every unit
 * accounted for. 40 at 100 + 400 is 110.00 a unit landed.
 */
async function sellingCycle(
  opts: {
    productId?: string;
    qty?: number;
    day?: string;
    legCost?: number;
  } = {},
) {
  const qty = opts.qty ?? 40;
  const { cycle, items } = cycleWithOrder(db, {
    status: 'ARRIVED_EGYPT',
    lines: [['Brake pad', qty, 100]],
  });
  const item = items[0];
  if (opts.productId) {
    // The same product another cycle bought — what makes leftovers leftovers.
    db.products.splice(
      db.products.findIndex((p) => p.id === item.productId),
      1,
    );
    (item as Row).productId = opts.productId;
  }
  const leg = addLeg(db, cycle, 1, {
    departedOn: '2026-09-01',
    amountEgp: opts.legCost ?? 400,
  });
  const { data: delivery } = await deliveries.recordDelivery(
    leg.id,
    {
      arrivedOn: opts.day ?? '2026-09-20',
      lines: [{ purchaseOrderItemId: item.id, qty }],
    },
    ACTOR,
  );
  await inventory.verifyStock(
    cycle.id,
    {
      deliveryId: (delivery as Row).id,
      items: [
        { deliveryLineId: (delivery as Row).lines[0].id, receivedQty: qty },
      ],
    },
    ACTOR,
  );
  participant(cycle, qty * 110);
  return { cycle, item, productId: item.productId as string };
}

/** A cycle still being set up: planning, nothing ordered yet. */
function planningCycle(status = 'PLANNING') {
  const { cycle } = cycleWithOrder(db, { status, lines: [] });
  return cycle;
}

function participant(cycle: Row, contribution: number) {
  db.participants.push({
    id: randomUUID(),
    cycleId: cycle.id,
    participantType: 'CORE_PARTNER',
    partnerUserId: ACTOR,
    contributionAmount: D(contribution),
    customProfitPct: null,
    investorFeePct: null,
    createdAt: new Date(),
  });
}

async function sell(productId: string, qty: number, price = 200) {
  if (db.customers.length === 0) {
    db.customers.push({
      id: randomUUID(),
      displayName: 'Nile Motors',
      type: 'B2B',
      verificationStatus: 'VERIFIED',
    });
  }
  const { data } = await sales.create(
    {
      customerId: db.customers[0].id,
      channel: 'B2B',
      currency: 'EGP',
      items: [{ productId, quantity: qty, unitPrice: price, discount: 0 }],
      confirm: true,
    },
    ACTOR,
  );
  return data as Row;
}

const move = (
  from: Row,
  to: Row,
  lines: [string, number][],
  extra: Record<string, unknown> = {},
) =>
  transfers.create(
    from.id,
    {
      toCycleId: to.id,
      reason: 'Leftovers after the season',
      lines: lines.map(([productId, qty]) => ({ productId, qty })),
      ...extra,
    },
    ACTOR,
  );

const batchesOf = (cycle: Row) =>
  db.batches.filter((b) => b.cycleId === cycle.id);
const onShelf = (cycle: Row) =>
  batchesOf(cycle).reduce((s, b) => s + b.remainingQty.toNumber(), 0);
const ledgerOf = (cycle: Row) =>
  db.ledger.filter(
    (t) => t.cycleId === cycle.id && t.category === 'cycle_transfer',
  );

/** A: 40 pads in at 110.00, 10 sold at 200 — 30 left on the shelf. B: still being set up. */
async function world() {
  const a = await sellingCycle();
  await sell(a.productId, 10);
  at('2026-10-10T09:00:00Z');
  const b = planningCycle();
  return { a: a.cycle, b, pad: a.productId };
}

// ─── Moving ──────────────────────────────────────────────────────────────

describe('POST /cycles/:id/transfers', () => {
  it('a partial move: 20 of 30 leave A, a batch of 20 on B at the same cost and check-in, pointing back', async () => {
    const { a, b, pad } = await world();
    const source = batchesOf(a)[0];
    const { data } = await move(a, b, [[pad, 20]]);

    expect(source.remainingQty.toNumber()).toBe(10);
    expect(source.saleableQty.toNumber()).toBe(10);
    const [dest] = batchesOf(b);
    expect(dest).toMatchObject({
      productId: pad,
      transferredFromBatchId: source.id,
      verificationStatus: 'VERIFIED',
    });
    expect(dest.remainingQty.toNumber()).toBe(20);
    expect(dest.landedUnitCostEgp.toFixed(4)).toBe(
      source.landedUnitCostEgp.toFixed(4),
    );
    expect(dest.createdAt.getTime()).toBe(source.createdAt.getTime());
    expect(dest.arrivedOn).toEqual(source.arrivedOn);
    expect(data.totalCostEgp).toBe('2200.00');

    // The record: who, when, why, and the line.
    const [t] = db.transfers;
    expect(t).toMatchObject({
      fromCycleId: a.id,
      toCycleId: b.id,
      createdBy: ACTOR,
      reason: 'Leftovers after the season',
      status: 'ACTIVE',
    });
    expect(
      db.transferLines.map((l) => [
        l.sourceBatchId,
        l.destBatchId,
        l.qty.toNumber(),
        l.costEgp.toFixed(2),
      ]),
    ).toEqual([[source.id, dest.id, 20, '2200.00']]);
    // Movements: out of A's batch, into B's.
    expect(
      db.movements
        .filter((m) => m.referenceType === 'STOCK_TRANSFER')
        .map((m) => [m.batchId, m.movementType, Number(m.qtyDelta)]),
    ).toEqual([
      [source.id, 'TRANSFER_OUT', -20],
      [dest.id, 'TRANSFER_IN', 20],
    ]);
    // The ledger pair: A recovers, B takes on — same amount, the transfer behind both.
    expect(
      ledgerOf(a).map((r) => [
        r.direction,
        r.amount.toFixed(2),
        r.relatedId,
        r.accountId ?? null,
      ]),
    ).toEqual([['INFLOW', '2200.00', t.id, null]]);
    expect(
      ledgerOf(b).map((r) => [
        r.direction,
        r.amount.toFixed(2),
        r.relatedId,
        r.accountId ?? null,
      ]),
    ).toEqual([['OUTFLOW', '2200.00', t.id, null]]);
  });

  it('moving everything leaves A with nothing on the shelf and nothing to write off', async () => {
    const { a, b, pad } = await world();
    await move(a, b, [[pad, 30]]);
    expect(onShelf(a)).toBe(0);
    const projected = await settlements.project(a.id);
    expect(projected!.pnl.unitsRemaining.toNumber()).toBe(0);
    expect(projected!.pnl.unsoldValue.toNumber()).toBe(0);
  });

  it('more than is on the shelf is refused, and nothing is written', async () => {
    const { a, b, pad } = await world();
    const r = await refusal(move(a, b, [[pad, 31]]));
    expect(r).toMatchObject({
      status: 400,
      code: 'TRANSFER_MORE_THAN_ON_SHELF',
      params: { available: '30', requested: '31' },
    });
    expect(onShelf(a)).toBe(30);
    expect(batchesOf(b)).toHaveLength(0);
    expect(db.transfers).toHaveLength(0);
    expect(
      db.ledger.filter((t) => t.category === 'cycle_transfer'),
    ).toHaveLength(0);
  });

  it('units held for a shop’s request stay where they are', async () => {
    const { a, b, pad } = await world();
    db.holds.push({
      id: randomUUID(),
      batchId: batchesOf(a)[0].id,
      status: 'ACTIVE',
      qty: D(8),
      expiresAt: null,
    });
    expect((await refusal(move(a, b, [[pad, 23]]))).code).toBe(
      'TRANSFER_MORE_THAN_ON_SHELF',
    );
    await move(a, b, [[pad, 22]]);
    expect(onShelf(a)).toBe(8);
  });

  it('zero, negative and a product A never had are refused', async () => {
    const { a, b, pad } = await world();
    expect((await refusal(move(a, b, [[pad, 0]]))).code).toBe(
      'TRANSFER_QTY_NOT_POSITIVE',
    );
    expect((await refusal(move(a, b, [[pad, -5]]))).code).toBe(
      'TRANSFER_QTY_NOT_POSITIVE',
    );
    const other = randomUUID();
    db.products.push({ id: other, name: 'Chain kit', unitWeightKg: null });
    expect(await refusal(move(a, b, [[other, 1]]))).toMatchObject({
      code: 'TRANSFER_MORE_THAN_ON_SHELF',
      params: { product: 'Chain kit', available: '0' },
    });
    expect((await refusal(move(a, b, [[randomUUID(), 1]]))).code).toBe(
      'NOT_FOUND',
    );
    expect((await refusal(move(a, b, []))).code).toBe('TRANSFER_NO_LINES');
  });

  it('never to itself', async () => {
    const { a, pad } = await world();
    expect((await refusal(move(a, a, [[pad, 1]]))).code).toBe(
      'TRANSFER_SAME_CYCLE',
    );
  });

  it.each(['SETTLEMENT', 'CLOSED', 'CANCELLED'])(
    'never to a cycle in %s',
    async (status) => {
      const { a, pad } = await world();
      const b = planningCycle(status);
      expect(await refusal(move(a, b, [[pad, 1]]))).toMatchObject({
        code: 'TRANSFER_TARGET_CLOSED',
        params: { status },
      });
      expect(onShelf(a)).toBe(30);
    },
  );

  it('a cycle that does not exist is a 404, not a 500', async () => {
    const { a, pad } = await world();
    const r = await refusal(
      transfers.create(
        a.id,
        {
          toCycleId: randomUUID(),
          reason: 'x',
          lines: [{ productId: pad, qty: 1 }],
        },
        ACTOR,
      ),
    );
    expect(r).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('only from a cycle selling or settling, with every unit accounted for, not paid out', async () => {
    const { a, b, pad } = await world();
    // Still on the way: a second order line, delivered short.
    const c = await sellingCycle({ productId: pad, qty: 10 });
    db.items.push({
      id: randomUUID(),
      purchaseOrderId: db.orders.find((o) => o.cycleId === c.cycle.id)!.id,
      productId: pad,
      orderedQty: D(5),
      receivedQty: null,
      unitPrice: D(100),
      lineTotal: D(500),
    });
    expect((await refusal(move(c.cycle, b, [[pad, 1]]))).code).toBe(
      'TRANSFER_SOURCE_NOT_ACCOUNTED',
    );

    for (const status of ['ARRIVED_EGYPT', 'VERIFICATION', 'CLOSED']) {
      a.status = status;
      expect((await refusal(move(a, b, [[pad, 1]]))).code).toBe(
        'TRANSFER_SOURCE_NOT_SELLING',
      );
    }
    a.status = 'SETTLEMENT';
    db.settlements.push({ id: randomUUID(), cycleId: a.id, status: 'PAID' });
    expect((await refusal(move(a, b, [[pad, 1]]))).code).toBe(
      'TRANSFER_SOURCE_PAID',
    );
  });

  it('a reason, and no date that has not come', async () => {
    const { a, b, pad } = await world();
    expect(
      (await refusal(move(a, b, [[pad, 1]], { reason: '   ' }))).code,
    ).toBe('TRANSFER_REASON_REQUIRED');
    expect(
      (await refusal(move(a, b, [[pad, 1]], { movedOn: '2026-10-11' }))).code,
    ).toBe('DATE_IN_FUTURE');
    await move(a, b, [[pad, 1]], { movedOn: '2026-10-10' });
  });
});

// ─── Money ───────────────────────────────────────────────────────────────

describe('the money (§8)', () => {
  it("A's profit is unchanged by the move; its unsold value drops by exactly the cost", async () => {
    const { a, b, pad } = await world();
    const before = (await settlements.project(a.id))!.pnl;
    expect(before.grossProfit.toFixed(2)).toBe('900.00'); // 10 × (200 − 110): not zero (§10)

    await move(a, b, [[pad, 20]]);
    const after = (await settlements.project(a.id))!.pnl;
    expect(after.grossProfit.toFixed(2)).toBe(before.grossProfit.toFixed(2));
    expect(after.revenue.toFixed(2)).toBe(before.revenue.toFixed(2));
    expect(after.cogs.toFixed(2)).toBe(before.cogs.toFixed(2));
    expect(after.expenses.toFixed(2)).toBe(before.expenses.toFixed(2));
    expect(before.unsoldValue.sub(after.unsoldValue).toFixed(2)).toBe(
      '2200.00',
    );

    const { data } = await analytics.getCycleProfitability();
    expect(data.find((r) => r.cycleId === a.id)!.profit).toBe(900);
  });

  it("B's cost to fund rises by exactly the cost moved; undoing takes it back off", async () => {
    const { a, b, pad } = await world();
    const before = await costing.fundingFor(b.id);
    const { data } = await move(a, b, [[pad, 20]]);
    const after = await costing.fundingFor(b.id);
    expect(after.toFund.sub(before.toFund).toFixed(2)).toBe('2200.00');
    expect(after.transferredIn.toFixed(2)).toBe(data.totalCostEgp);
    // A's own cost to fund does not change: its partners did fund those goods.
    expect((await costing.fundingFor(a.id)).toFund.toFixed(2)).toBe('4400.00');

    await transfers.undo(data.id, 'wrong cycle', ACTOR);
    expect((await costing.fundingFor(b.id)).toFund.toFixed(2)).toBe(
      before.toFund.toFixed(2),
    );
  });

  it("B's settlement treats the moved units as its own, and they sell before B's own (oldest check-in)", async () => {
    const { a, b, pad } = await world();
    // B gets stock of its own, checked in after A's.
    at('2026-10-05T09:00:00Z');
    const own = await sellingCycle({
      productId: pad,
      qty: 10,
      day: '2026-10-04',
      legCost: 0,
    });
    at('2026-10-10T09:00:00Z');
    // Everything A had left, so no batch anywhere is older than the moved one.
    await move(a, own.cycle, [[pad, 30]]);
    const moved = batchesOf(own.cycle).find((x) => x.transferredFromBatchId);
    const ownBatch = batchesOf(own.cycle).find(
      (x) => !x.transferredFromBatchId,
    );

    await sell(pad, 5, 300);
    expect(moved!.remainingQty.toNumber()).toBe(25);
    expect(ownBatch!.remainingQty.toNumber()).toBe(10);

    const pnl = (await settlements.project(own.cycle.id))!.pnl;
    expect(pnl.revenue.toFixed(2)).toBe('1500.00');
    expect(pnl.cogs.toFixed(2)).toBe('550.00'); // 5 × 110.00, A's cost, never re-priced
    expect(pnl.unitsRemaining.toNumber()).toBe(35);
    // Taking the stock on is not an expense of B's: its profit is the sale's.
    expect(pnl.expenses.toFixed(2)).toBe('0.00');
    expect(pnl.grossProfit.toFixed(2)).toBe('950.00');
    void b;
  });

  it('cash on hand, cash in and cash out are unchanged by a move and its undo', async () => {
    const { a, b, pad } = await world();
    const before = await cashPosition(prisma);
    const { data } = await move(a, b, [[pad, 20]]);
    const after = await cashPosition(prisma);
    expect([
      after.cashIn.toFixed(2),
      after.cashOut.toFixed(2),
      after.cashOnHand.toFixed(2),
    ]).toEqual([
      before.cashIn.toFixed(2),
      before.cashOut.toFixed(2),
      before.cashOnHand.toFixed(2),
    ]);
    await transfers.undo(data.id, 'wrong cycle', ACTOR);
    expect((await cashPosition(prisma)).cashOut.toFixed(2)).toBe(
      before.cashOut.toFixed(2),
    );
  });

  it('cycle profitability: A’s investment drops by the cost, B’s rises by it', async () => {
    const { a, b, pad } = await world();
    const inv = async (c: Row) =>
      (await analytics.getCycleProfitability()).data.find(
        (r) => r.cycleId === c.id,
      )?.investment ?? 0;
    const aBefore = await inv(a);
    await move(a, b, [[pad, 20]]);
    expect(aBefore - (await inv(a))).toBe(2200);
    expect(await inv(b)).toBe(2200);
  });

  it('an open settlement on A is told the stock left; paying out no longer asks to write it off', async () => {
    const { a, b, pad } = await world();
    a.status = 'SETTLEMENT';
    const approved = {
      id: randomUUID(),
      cycleId: a.id,
      status: 'APPROVED',
      unitsRemaining: D(30),
      unsoldValueEgp: D(3300),
    };
    db.settlements.push(approved);
    await move(a, b, [[pad, 30]]);
    expect(approved.unitsRemaining.toNumber()).toBe(0);
    expect(approved.unsoldValueEgp.toFixed(2)).toBe('0.00');
  });

  it('paying out reads what A holds now: with everything moved, no write-off is asked for', async () => {
    const { a, b, pad } = await world();
    a.status = 'SETTLEMENT';
    // The figures as approved, before the move: 30 units on the shelf.
    const approved = {
      id: randomUUID(),
      cycleId: a.id,
      status: 'APPROVED',
      unitsRemaining: D(30),
      unsoldValueEgp: D(3300),
    };
    db.settlements.push(approved);
    expect(
      await refusal(settlements.markPaid(approved.id, ACTOR)),
    ).toMatchObject({
      code: 'CYCLE_HAS_UNSOLD_STOCK',
      params: { units: '30', cycleId: a.id },
    });

    await move(a, b, [[pad, 30]]);
    // Even a snapshot left stale is not what decides it.
    approved.unitsRemaining = D(30);
    await settlements.markPaid(approved.id, ACTOR);
    expect(a.status).toBe('CLOSED');
    expect(approved.status).toBe('PAID');
  });

  it('the ledger pair cannot be typed by hand, nor reversed on its own', async () => {
    const r = await refusal(
      ledger.create(
        {
          type: 'X',
          category: 'cycle_transfer',
          direction: 'OUTFLOW',
          amount: 100,
          currency: 'EGP',
        },
        ACTOR,
      ),
    );
    expect(r.code).toBe('LEDGER_CATEGORY_RESERVED');

    const { a, b, pad } = await world();
    await move(a, b, [[pad, 5]]);
    for (const row of [...ledgerOf(a), ...ledgerOf(b)]) {
      expect(
        await refusal(ledger.reverse(row.id, 'by hand', ACTOR)),
      ).toMatchObject({
        code: 'ENTRY_OWNED_ELSEWHERE',
        params: { owner: 'STOCK_TRANSFER' },
      });
    }
  });
});

// ─── Undo ────────────────────────────────────────────────────────────────

describe('POST /stock-transfers/:id/undo', () => {
  it('untouched: the units go back to A, B’s batch goes, the ledger is balanced, the record says so', async () => {
    const { a, b, pad } = await world();
    const { data } = await move(a, b, [[pad, 20]]);
    await transfers.undo(data.id, 'Wrong cycle chosen', ACTOR);

    expect(onShelf(a)).toBe(30);
    expect(batchesOf(b)).toHaveLength(0);
    const t = db.transfers[0];
    expect(t).toMatchObject({
      status: 'REVERSED',
      reversedBy: ACTOR,
      reversalReason: 'Wrong cycle chosen',
    });
    expect(db.transferLines[0].destBatchId).toBeNull();
    // Four rows, each original mirrored and pointed at; nothing edited.
    const rows = db.ledger.filter((r) => r.relatedId === t.id);
    expect(rows).toHaveLength(4);
    for (const r of rows.filter((x) => x.reversalOfId)) {
      const o = rows.find((x) => x.id === r.reversalOfId)!;
      expect([r.cycleId, r.amount.toFixed(2), r.direction]).toEqual([
        o.cycleId,
        o.amount.toFixed(2),
        o.direction === 'INFLOW' ? 'OUTFLOW' : 'INFLOW',
      ]);
    }
  });

  it('after a sale in B: refused, and nothing changes', async () => {
    const { a, b, pad } = await world();
    const { data } = await move(a, b, [[pad, 30]]);
    await sell(pad, 1);
    const r = await refusal(transfers.undo(data.id, 'oops', ACTOR));
    expect(r).toMatchObject({
      code: 'TRANSFER_UNITS_SOLD',
      params: { cycle: b.code },
    });
    expect(db.transfers[0].status).toBe('ACTIVE');
    expect(onShelf(b)).toBe(29);
  });

  it('after a sale in B that was then cancelled: still refused — the batch has a history', async () => {
    const { a, b, pad } = await world();
    const { data } = await move(a, b, [[pad, 30]]);
    const order = await sell(pad, 1);
    await sales.cancelOrder(order.id, ACTOR);
    expect(onShelf(b)).toBe(30);
    expect((await refusal(transfers.undo(data.id, 'oops', ACTOR))).code).toBe(
      'TRANSFER_UNITS_SOLD',
    );
  });

  it('after A is paid out: refused', async () => {
    const { a, b, pad } = await world();
    const { data } = await move(a, b, [[pad, 20]]);
    a.status = 'CLOSED';
    db.settlements.push({ id: randomUUID(), cycleId: a.id, status: 'PAID' });
    expect((await refusal(transfers.undo(data.id, 'oops', ACTOR))).code).toBe(
      'TRANSFER_SOURCE_PAID',
    );
  });

  it('twice: refused; with no reason: refused; an id that is no transfer: 404', async () => {
    const { a, b, pad } = await world();
    const { data } = await move(a, b, [[pad, 20]]);
    expect((await refusal(transfers.undo(data.id, ' ', ACTOR))).code).toBe(
      'TRANSFER_REASON_REQUIRED',
    );
    await transfers.undo(data.id, 'once', ACTOR);
    expect((await refusal(transfers.undo(data.id, 'twice', ACTOR))).code).toBe(
      'TRANSFER_ALREADY_UNDONE',
    );
    expect(
      (await refusal(transfers.undo(randomUUID(), 'x', ACTOR))).status,
    ).toBe(404);
  });

  it('the list says when undo is allowed, by the same rule', async () => {
    const { a, b, pad } = await world();
    const { data } = await move(a, b, [[pad, 30]]);
    let list = (await transfers.forCycle(a.id)).data;
    expect(list.out.map((t) => t.undo)).toEqual([{ allowed: true }]);
    expect(list.in).toEqual([]);
    await sell(pad, 1);
    list = (await transfers.forCycle(b.id)).data;
    expect(
      list.in.map((t) => [t.id, t.undo.allowed, (t.undo as any).code]),
    ).toEqual([[data.id, false, 'TRANSFER_UNITS_SOLD']]);
  });
});

// ─── Elsewhere ───────────────────────────────────────────────────────────

describe('around it', () => {
  it('B cannot be cancelled while it holds stock moved in; once undone it can', async () => {
    const { a, b, pad } = await world();
    const { data } = await move(a, b, [[pad, 5]]);
    expect(
      (await refusal(cycles.transition(b.id, 'CANCELLED', ACTOR))).code,
    ).toBe('CYCLE_HAS_TRANSFERS_IN');
    await transfers.undo(data.id, 'not needed', ACTOR);
    await cycles.transition(b.id, 'CANCELLED', ACTOR);
    expect(b.status).toBe('CANCELLED');
  });

  it('what A can move: per product, and why not when it cannot', async () => {
    const { a, b, pad } = await world();
    const { data } = await transfers.movable(a.id);
    expect(data.refusal).toBeNull();
    expect(data.products.map((p) => [p.productId, p.available])).toEqual([
      [pad, '30.000'],
    ]);
    expect((await transfers.movable(b.id)).data.refusal).toMatchObject({
      code: 'TRANSFER_SOURCE_NOT_SELLING',
    });
  });
});

describe('roles', () => {
  const contextFor = (cls: any, method: string, role: string) =>
    ({
      getHandler: () =>
        Object.getOwnPropertyDescriptor(cls.prototype, method)!
          .value as unknown,
      getClass: () => cls,
      switchToHttp: () => ({ getRequest: () => ({ user: { id: 'u', role } }) }),
    }) as unknown as ExecutionContext;

  it.each([
    [CycleTransfersController, 'create'],
    [StockTransfersController, 'undo'],
  ])('%p.%s: core partners only, refused with a code', (cls, method) => {
    const guard = new RolesGuard(new Reflector());
    for (const role of [
      'TEMP_INVESTOR',
      'ADMIN_SUPPORT',
      'SHOP_OWNER_PORTAL',
    ]) {
      let thrown: HttpException | undefined;
      try {
        guard.canActivate(contextFor(cls, method, role));
      } catch (e) {
        thrown = e as HttpException;
      }
      expect(thrown?.getStatus()).toBe(403);
      expect(thrown?.getResponse()).toEqual(
        expect.objectContaining({ code: 'ROLE_NOT_ALLOWED' }),
      );
    }
    expect(guard.canActivate(contextFor(cls, method, 'CORE_PARTNER'))).toBe(
      true,
    );
  });
});
