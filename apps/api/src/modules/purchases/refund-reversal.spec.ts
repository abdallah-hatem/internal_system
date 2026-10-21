/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- the fake database's rows are untyped records, as Prisma's argument objects are */
import { randomUUID } from 'crypto';
import { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { CostingService } from '../costing/costing.service';
import { CyclesService } from '../cycles/cycles.service';
import { InventoryService } from '../inventory/inventory.service';
import { LedgerService } from '../ledger/ledger.service';
import { SalesService } from '../sales/sales.service';
import { PaymentsService } from '../payments/payments.service';
import { SettlementsService } from '../settlements/settlements.service';
import { DeliveriesService } from '../shipping/deliveries.service';
import {
  addLeg,
  cycleWithOrder,
  D,
  emptyStore,
  fakePrisma,
  type Row,
  type Store,
} from '../shipping/shipment-fake-spec';
import { PurchasesController } from './purchases.controller';
import { PurchasesService } from './purchases.service';

/**
 * B5b — undo a refund (BUSINESS_LOGIC §6 "the refund is undone first — money
 * handed back is a ledger correction", §9 the ledger). One test per edge case
 * in the plan, named after it, on B2's in-memory fake (it models the cycle
 * lock and rolls a failed transaction back) with the real services, costing,
 * settlement maths and analytics. e2e: apps/web/tests/88-undo-refund.spec.ts.
 */

const NOW = new Date('2026-10-10T09:00:00Z');
beforeEach(() => {
  jest.useFakeTimers({
    doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    now: NOW,
  });
});
afterEach(() => jest.useRealTimers());

const ACTOR = randomUUID();

let db: Store;
let prisma: any;
let purchases: PurchasesService;
let deliveries: DeliveriesService;
let inventory: InventoryService;
let cycles: CyclesService;
let settlements: SettlementsService;
let analytics: AnalyticsService;
let sales: SalesService;
let ledger: LedgerService;

beforeEach(() => {
  db = emptyStore();
  prisma = fakePrisma(db);
  const audit = { log: jest.fn() } as unknown as AuditService;
  const notifications = {
    createForMultipleUsers: jest.fn(),
  } as unknown as NotificationsService;
  const costing = new CostingService(prisma);
  cycles = new CyclesService(prisma, audit, notifications);
  deliveries = new DeliveriesService(
    prisma,
    audit,
    notifications,
    costing,
    cycles,
  );
  inventory = new InventoryService(
    prisma,
    audit,
    notifications,
    costing,
    cycles,
  );
  purchases = new PurchasesService(prisma, audit, notifications);
  settlements = new SettlementsService(prisma, audit);
  analytics = new AnalyticsService(prisma);
  sales = new SalesService(prisma, audit, new PaymentsService(prisma, audit), {
    createForMultipleUsers: () => Promise.resolve({ count: 0 }),
  });
  ledger = new LedgerService(prisma, audit);
});

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

// ─── Building states the business recognises (CLAUDE.md rule 4) ──────────

/** UAE-direct, arrived: 40 brake pads at 100 and a 400 leg — 110 a unit. */
function oneLeg(opts: { lines?: [string, number, number][] } = {}) {
  const { cycle, items, po, supplier } = cycleWithOrder(db, {
    status: 'ARRIVED_EGYPT',
    lines: opts.lines,
  });
  const leg = addLeg(db, cycle, 1, {
    departedOn: '2026-09-01',
    amountEgp: 400,
  });
  const provider = db.providers.find((p) => p.id === leg.providerId)!;
  return { cycle, item: items[0], leg, po, supplier, provider };
}

async function lose(leg: Row, item: Row, qty: number) {
  const { data } = await deliveries.recordLoss(
    leg.id,
    { lines: [{ purchaseOrderItemId: item.id, qty }] },
    ACTOR,
  );
  return (data as Row[])[0];
}

/**
 * 35 of 40 received, 10 sold at 200 (900 of profit), 5 lost on the way at
 * 110 (a 550 loss): 350 of profit before any refund. Non-zero everywhere, so
 * a sign slip shows (rule 10).
 */
async function soldWithALoss() {
  const s = oneLeg();
  db.participants.push({
    id: randomUUID(),
    cycleId: s.cycle.id,
    participantType: 'CORE_PARTNER',
    partnerUserId: ACTOR,
    contributionAmount: D(4400),
    customProfitPct: null,
    investorFeePct: null,
    createdAt: new Date(),
  });
  const { data: delivery } = await deliveries.recordDelivery(
    s.leg.id,
    {
      arrivedOn: '2026-09-20',
      lines: [{ purchaseOrderItemId: s.item.id, qty: 35 }],
    },
    ACTOR,
  );
  await inventory.verifyStock(
    s.cycle.id,
    {
      deliveryId: (delivery as Row).id,
      items: [
        { deliveryLineId: (delivery as Row).lines[0].id, receivedQty: 35 },
      ],
    },
    ACTOR,
  );
  db.customers.push({
    id: randomUUID(),
    displayName: 'Nile Motors',
    type: 'B2B',
    verificationStatus: 'VERIFIED',
  });
  await sales.create(
    {
      customerId: db.customers[0].id,
      channel: 'B2B',
      currency: 'EGP',
      items: [
        {
          productId: s.item.productId,
          quantity: 10,
          unitPrice: 200,
          discount: 0,
        },
      ],
      confirm: true,
    },
    ACTOR,
  );
  const loss = await lose(s.leg, s.item, 5);
  return { ...s, loss };
}

const fromProvider = (p: Row) => ({
  type: 'SHIPPING_PROVIDER' as const,
  id: p.id,
});
const fromSupplier = (s: Row) => ({ type: 'SUPPLIER' as const, id: s.id });

async function refund(
  loss: Row,
  payer: { type: 'SHIPPING_PROVIDER' | 'SUPPLIER'; id: string },
  amount: number,
  extra: Record<string, unknown> = {},
) {
  const { data } = await purchases.recordLossRefund(
    loss.id,
    {
      amount,
      currency: 'EGP',
      fxRateToEgp: 1,
      recordedOn: '2026-10-10',
      payer,
      ...(extra as object),
    },
    ACTOR,
  );
  return data as Row;
}

const undo = (r: Row | string, reason: unknown = 'The goods turned up') =>
  purchases.reverseRefund(typeof r === 'string' ? r : r.id, { reason }, ACTOR);

/** Only what `getDashboardKPIs` reads, from the same rows. */
function teachDashboard() {
  const realised = (o: Row) =>
    ['CONFIRMED', 'PARTIALLY_PAID', 'PAID'].includes(o.status);
  const sum = (rows: Row[], k: string) =>
    rows.reduce((s, r) => s.add(r[k] ?? 0), D(0));
  const answer = (v: unknown) => () => Promise.resolve(v);
  prisma.saleOrder.aggregate = () =>
    Promise.resolve({
      _sum: { total: sum(db.saleOrders.filter(realised), 'total') },
    });
  prisma.saleOrder.findMany = answer([]);
  prisma.saleReturn = {
    aggregate: answer({ _sum: { refundEgp: null, cogsReversedEgp: null } }),
  };
  // No price is lowered after a sale here (§4, 2026-10-22).
  prisma.salePriceAdjustment = {
    aggregate: answer({ _sum: { amountEgp: null } }),
  };
  // COGS of what sold; nothing here is ever samples written off (§4), so
  // that question — the only other one asked of this aggregate — finds none.
  prisma.saleItemAllocation.aggregate = ({ where }: Row = {}) =>
    Promise.resolve({
      _sum: {
        cogsEgp:
          where?.saleItem?.saleOrder?.status === 'SAMPLES_WRITTEN_OFF'
            ? null
            : sum(db.allocations, 'cogsEgp'),
      },
    });
  prisma.importCycle.count = () => Promise.resolve(db.cycles.length);
  prisma.product.findMany = answer([]);
  prisma.product.count = answer(0);
  prisma.customer.count = answer(0);
  prisma.payment = { aggregate: answer({ _sum: { amount: null } }) };
  prisma.financialTransaction.groupBy = answer([]);
}

/** Profit as every screen reads it: settlement, the cycle row, the dashboard. */
async function profitEverywhere(cycle: Row) {
  const settled = await settlements.calculate(cycle.id);
  const { data } = await analytics.getCycleProfitability();
  const row = (data as Row[]).find((c) => c.cycleCode === cycle.code)!;
  const dash = (await analytics.getDashboardKPIs()).data;
  return {
    settlement: settled.summary.grossProfitEgp,
    cycle: row.profit,
    cycleRefunds: row.supplierRefundsEgp,
    investment: row.investment,
    dashboard: dash.netProfit,
    recovered: dash.totalRecoveredEgp,
    expenses: dash.totalExpenses,
  };
}

// ─── The plan's edge cases ───────────────────────────────────────────────

describe('POST /purchases/refunds/:id/reverse', () => {
  it('Reverse a loss refund → a balancing OUTFLOW pointing at the original; the loss is unrecovered again; profit falls by it in settlement and analytics alike', async () => {
    const { cycle, loss, provider } = await soldWithALoss();
    teachDashboard();
    const before = await profitEverywhere(cycle);
    expect(before).toMatchObject({
      settlement: '350.00',
      cycle: 350,
      dashboard: 350,
      recovered: 0,
    });

    const r = await refund(loss, fromProvider(provider), 4, {
      currency: 'USD',
      fxRateToEgp: 50,
    }); // 200 EGP
    expect(await profitEverywhere(cycle)).toMatchObject({
      settlement: '550.00',
      cycle: 550,
      cycleRefunds: 200,
      dashboard: 550,
      recovered: 200,
    });

    const { data } = await undo(r, '  The goods turned up  ');

    const original = db.ledger.find(
      (t) => t.relatedId === r.id && t.reversalOfId == null,
    )!;
    const reversal = db.ledger.find((t) => t.reversalOfId === original.id)!;
    expect(reversal).toMatchObject({
      direction: 'OUTFLOW',
      category: 'loss_refund',
      type: 'SUPPLIER_REFUND',
      currency: 'EGP',
      cycleId: cycle.id,
      relatedType: 'SUPPLIER_REFUND',
      relatedId: r.id,
      createdBy: ACTOR,
    });
    expect(reversal.amount.toFixed(2)).toBe('200.00');
    expect(reversal.reason).toContain('The goods turned up');
    // Nothing edited away: the original inflow and the refund row are there.
    expect(original.direction).toBe('INFLOW');
    expect(db.refunds).toHaveLength(1);
    expect(db.refunds[0]).toMatchObject({
      reversedBy: ACTOR,
      reversalReason: 'The goods turned up',
      reversalTransactionId: reversal.id,
    });
    expect(db.refunds[0].reversedAt).toBeInstanceOf(Date);
    expect(data).toEqual({
      id: r.id,
      reversed: true,
      reversalTransactionId: reversal.id,
    });

    // The loss is unrecovered again; the refund is listed, marked.
    const shipment = (await cycles.getShipment(cycle.id)).data as Row;
    expect(shipment.losses[0]).toMatchObject({
      refundedEgp: '0.00',
      unrecoveredEgp: '550.00',
    });
    expect(shipment.losses[0].refunds).toHaveLength(1);
    expect(shipment.losses[0].refunds[0]).toMatchObject({
      id: r.id,
      reversalReason: 'The goods turned up',
    });
    expect(shipment.losses[0].refunds[0].reversedAt).toBeInstanceOf(Date);

    // Profit falls back by the 200 on every screen, and the dashboard does
    // not show the undo as an operating expense.
    const after = await profitEverywhere(cycle);
    expect(after).toMatchObject({
      settlement: '350.00',
      cycle: 350,
      cycleRefunds: 0,
      dashboard: 350,
      recovered: 0,
      expenses: before.expenses,
      investment: before.investment,
    });
  });

  it('A plain supplier refund can be undone too, and profit falls by it everywhere', async () => {
    const { cycle, po } = await soldWithALoss();
    teachDashboard();
    const { data } = await purchases.recordRefund(
      po.id,
      {
        amount: 100,
        currency: 'EGP',
        fxRateToEgp: 1,
        recordedOn: '2026-10-10',
      },
      ACTOR,
    );
    expect((await profitEverywhere(cycle)).settlement).toBe('450.00');

    await undo(data, 'Supplier took it back');
    const reversal = db.ledger.find((t) => t.reversalOfId != null)!;
    expect(reversal).toMatchObject({
      direction: 'OUTFLOW',
      category: 'supplier_refund',
      relatedId: (data as Row).id,
    });
    expect(await profitEverywhere(cycle)).toMatchObject({
      settlement: '350.00',
      cycle: 350,
      dashboard: 350,
      recovered: 0,
    });
  });

  it('After every refund on a loss is reversed → the loss can be taken back', async () => {
    const { cycle, leg, item, provider, supplier } = oneLeg();
    const loss = await lose(leg, item, 5);
    const first = await refund(loss, fromProvider(provider), 100);
    const second = await refund(loss, fromSupplier(supplier), 50);

    // One undone, one still standing: still refused, and it says one.
    await undo(first);
    expect(
      await refusal(deliveries.takeBackLoss(loss.id, ACTOR)),
    ).toMatchObject({ code: 'LOSS_REFUNDED', params: { refunds: 1 } });
    expect(db.losses).toHaveLength(1);

    await undo(second);
    await deliveries.takeBackLoss(loss.id, ACTOR);
    expect(db.losses).toHaveLength(0);
    // The units are on the way again.
    const shipment = (await cycles.getShipment(cycle.id)).data as Row;
    expect(shipment.losses).toEqual([]);
    // The refunds and both ledger pairs survive: history is not rewritten.
    expect(db.refunds).toHaveLength(2);
    expect(db.refunds.every((r) => r.reversedAt != null)).toBe(true);
    expect(db.refunds.every((r) => r.shipmentLossId == null)).toBe(true);
    expect(db.ledger.filter((t) => t.category === 'loss_refund')).toHaveLength(
      4,
    );
  });

  it('Reverse twice → refused', async () => {
    const { loss, provider } = await soldWithALoss();
    const r = await refund(loss, fromProvider(provider), 100);
    await undo(r);

    expect(await refusal(undo(r, 'again'))).toMatchObject({
      status: 400,
      code: 'ENTRY_ALREADY_REVERSED',
      params: { date: '2026-10-10' },
    });
    expect(db.ledger.filter((t) => t.reversalOfId != null)).toHaveLength(1);
    expect(db.refunds[0].reversalReason).toBe('The goods turned up');
  });

  it('Reverse twice at once (a double click) → one balancing entry, the other refused', async () => {
    const { loss, provider } = await soldWithALoss();
    const r = await refund(loss, fromProvider(provider), 100);
    const results = await Promise.allSettled([undo(r), undo(r)]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((x) => x.status === 'rejected');
    expect((failed?.reason as HttpException).getResponse()).toMatchObject({
      code: 'ENTRY_ALREADY_REVERSED',
    });
    expect(db.ledger.filter((t) => t.reversalOfId != null)).toHaveLength(1);
  });

  it('Reverse without a reason → refused', async () => {
    const { loss, provider } = await soldWithALoss();
    const r = await refund(loss, fromProvider(provider), 100);
    // Called directly: `undo`'s default reason would fill in `undefined`.
    for (const body of [
      undefined,
      {},
      { reason: '' },
      { reason: '   ' },
      { reason: 42 },
      { reason: 'x'.repeat(501) },
    ]) {
      expect(
        await refusal(purchases.reverseRefund(r.id, body, ACTOR)),
      ).toMatchObject({
        status: 400,
        code: 'VALIDATION_FAILED',
        params: { fields: 'reason' },
      });
    }
    expect(db.refunds[0].reversedAt).toBeUndefined();
    expect(db.ledger.filter((t) => t.reversalOfId != null)).toHaveLength(0);
  });

  it('A reversed refund no longer counts toward the loss cap or the order cap', async () => {
    // 10 at 100 — an order of 1,000 — and a 400 leg: 140 a unit, so 5 lost
    // cost 700.
    const { leg, item, po, provider } = oneLeg({
      lines: [['Brake pad', 10, 100]],
    });
    const loss = await lose(leg, item, 5);
    const full = await refund(loss, fromProvider(provider), 700);
    expect(
      await refusal(refund(loss, fromProvider(provider), 1)),
    ).toMatchObject({ code: 'REFUND_EXCEEDS_LOSS' });

    await undo(full);
    // The loss cap is free again: the whole 700 fits.
    await refund(loss, fromProvider(provider), 700);
    expect(db.refunds).toHaveLength(2);

    // Order cap: 700 standing of 1,000. A plain 300 fits; undo it, and 300
    // fits again — the undone one counts for nothing.
    const { data: plain } = await purchases.recordRefund(
      po.id,
      { amount: 300, currency: 'EGP', fxRateToEgp: 1 },
      ACTOR,
    );
    expect(
      await refusal(
        purchases.recordRefund(
          po.id,
          { amount: 1, currency: 'EGP', fxRateToEgp: 1 },
          ACTOR,
        ),
      ),
    ).toMatchObject({
      code: 'REFUND_EXCEEDS_ORDER',
      params: { refunded: '1,000.00' },
    });
    await undo(plain);
    await purchases.recordRefund(
      po.id,
      { amount: 300, currency: 'EGP', fxRateToEgp: 1 },
      ACTOR,
    );
  });

  it('The refund’s own ledger row cannot be reversed alone through the ledger endpoint', async () => {
    const { loss, provider } = await soldWithALoss();
    const r = await refund(loss, fromProvider(provider), 100);
    const original = db.ledger.find((t) => t.relatedId === r.id)!;

    expect(
      await refusal(ledger.reverse(original.id, 'trying the back door', ACTOR)),
    ).toMatchObject({ code: 'ENTRY_OWNED_ELSEWHERE' });
    expect(db.ledger.filter((t) => t.reversalOfId != null)).toHaveLength(0);
    expect(db.refunds[0].reversedAt).toBeUndefined();

    // And the balancing row the undo writes cannot be reversed either.
    await undo(r);
    const reversal = db.ledger.find((t) => t.reversalOfId === original.id)!;
    expect(
      await refusal(ledger.reverse(reversal.id, 'undo the undo', ACTOR)),
    ).toMatchObject({ code: 'ENTRY_IS_A_REVERSAL' });
  });

  it('Unknown refund → 404', async () => {
    for (const id of [randomUUID(), 'not-a-uuid']) {
      expect(await refusal(undo(id))).toMatchObject({
        status: 404,
        code: 'NOT_FOUND',
        params: { entity: 'supplierRefund' },
      });
    }
  });

  it('A refund on a CLOSED cycle can still be undone (money moves when it moves)', async () => {
    const { cycle, loss, provider } = await soldWithALoss();
    const r = await refund(loss, fromProvider(provider), 100);
    db.cycles.find((c) => c.id === cycle.id)!.status = 'CLOSED';
    await undo(r);
    expect(db.refunds[0].reversedAt).toBeInstanceOf(Date);
  });

  it('A refund that never reached the ledger (recorded before the ledger write) is marked undone with no balancing row', async () => {
    const { loss, provider } = await soldWithALoss();
    const r = await refund(loss, fromProvider(provider), 100);
    // As refunds were before they wrote a ledger row.
    db.ledger.splice(
      db.ledger.findIndex((t) => t.relatedId === r.id),
      1,
    );
    const { data } = await undo(r);
    expect(data.reversalTransactionId).toBeNull();
    expect(db.refunds[0].reversedAt).toBeInstanceOf(Date);
    expect(db.ledger.filter((t) => t.relatedId === r.id)).toHaveLength(0);
  });
});

// ─── Roles (CLAUDE.md rule 12) ────────────────────────────────────────────

describe('roles', () => {
  const contextFor = (role: string) =>
    ({
      getHandler: () =>
        Object.getOwnPropertyDescriptor(
          PurchasesController.prototype,
          'reverseRefund',
        )!.value as unknown,
      getClass: () => PurchasesController,
      switchToHttp: () => ({
        getRequest: () => ({ user: { id: 'u', role } }),
      }),
    }) as unknown as ExecutionContext;

  it('Investor or shop → refused with a code', () => {
    const guard = new RolesGuard(new Reflector());
    for (const role of [
      'TEMP_INVESTOR',
      'ADMIN_SUPPORT',
      'SHOP_OWNER_PORTAL',
    ]) {
      let thrown: HttpException | undefined;
      try {
        guard.canActivate(contextFor(role));
      } catch (e) {
        thrown = e as HttpException;
      }
      expect(thrown?.getStatus()).toBe(403);
      expect(thrown?.getResponse()).toEqual(
        expect.objectContaining({ code: 'ROLE_NOT_ALLOWED' }),
      );
    }
    expect(guard.canActivate(contextFor('CORE_PARTNER'))).toBe(true);
  });
});
