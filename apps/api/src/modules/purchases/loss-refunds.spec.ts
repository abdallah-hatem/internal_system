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
import { SalesService } from '../sales/sales.service';
import { PaymentsService } from '../payments/payments.service';
import { SettlementsService } from '../settlements/settlements.service';
import { DeliveriesService } from '../shipping/deliveries.service';
import { ShippingController } from '../shipping/shipping.controller';
import {
  addLeg,
  cycleWithOrder,
  D,
  emptyStore,
  fakePrisma,
  type Row,
  type Store,
} from '../shipping/shipment-fake-spec';
import { PurchasesService } from './purchases.service';

/**
 * B5 — refunds for goods lost on the way (spec amendment 13; BUSINESS_LOGIC
 * §1 §6 §8 §9). One test per edge case in the plan, named after it. The
 * database is the in-memory fake B2 built (`shipment-fake-spec.ts`: it models
 * the cycle lock and rolls a failed transaction back); the services, the
 * costing, the settlement maths and analytics are the real ones. e2e for the
 * same cases: apps/web/tests/84-loss-refunds.spec.ts.
 */

// 12:00 in Cairo on 2026-10-10 (UTC+3). Only the clock is faked: the fake
// database yields with setImmediate, which must keep running.
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

/**
 * A UAE-direct cycle, arrived in Egypt, with one departed leg. By default 40
 * brake pads at 100 (goods 4,000) and a 400 leg: 110.00 a unit landed.
 */
function oneLeg(
  opts: { lines?: [string, number, number][]; legCost?: number } = {},
) {
  const { cycle, items, po, supplier } = cycleWithOrder(db, {
    status: 'ARRIVED_EGYPT',
    lines: opts.lines,
  });
  const leg = addLeg(db, cycle, 1, {
    departedOn: '2026-09-01',
    amountEgp: opts.legCost ?? 400,
  });
  const provider = db.providers.find((p) => p.id === leg.providerId)!;
  return { cycle, item: items[0], leg, po, supplier, provider };
}

async function deliver(leg: Row, item: Row, qty: number) {
  const { data } = await deliveries.recordDelivery(
    leg.id,
    { arrivedOn: '2026-09-20', lines: [{ purchaseOrderItemId: item.id, qty }] },
    ACTOR,
  );
  return data as Row;
}

async function lose(leg: Row, item: Row, qty: number) {
  const { data } = await deliveries.recordLoss(
    leg.id,
    { lines: [{ purchaseOrderItemId: item.id, qty }] },
    ACTOR,
  );
  return (data as Row[])[0];
}

const receive = (cycle: Row, delivery: Row, qty: number) =>
  inventory.verifyStock(
    cycle.id,
    {
      deliveryId: delivery.id,
      items: [{ deliveryLineId: delivery.lines[0].id, receivedQty: qty }],
    },
    ACTOR,
  );

function participant(cycle: Row) {
  db.participants.push({
    id: randomUUID(),
    cycleId: cycle.id,
    participantType: 'CORE_PARTNER',
    partnerUserId: ACTOR,
    contributionAmount: D(4400),
    customProfitPct: null,
    investorFeePct: null,
    createdAt: new Date(),
  });
}

async function sell(productId: string, qty: number, price = 200) {
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
      items: [{ productId, quantity: qty, unitPrice: price, discount: 0 }],
      confirm: true,
    },
    ACTOR,
  );
}

/**
 * 35 of 40 received, 10 sold at 200 (900 of profit), 5 lost on the way at
 * 110 (a 550 loss). Not a zero anywhere, so a share or sign slip shows
 * (rule 10).
 */
async function soldWithALoss() {
  const s = oneLeg();
  participant(s.cycle);
  await receive(s.cycle, await deliver(s.leg, s.item, 35), 35);
  await sell(s.item.productId, 10, 200);
  const loss = await lose(s.leg, s.item, 5);
  return { ...s, loss };
}

const refund = (
  loss: Row,
  payer: { type: 'SHIPPING_PROVIDER' | 'SUPPLIER'; id: string },
  amount: number,
  extra: Record<string, unknown> = {},
) =>
  purchases.recordLossRefund(
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

const fromProvider = (p: Row) => ({
  type: 'SHIPPING_PROVIDER' as const,
  id: p.id,
});
const fromSupplier = (s: Row) => ({ type: 'SUPPLIER' as const, id: s.id });

/**
 * The dashboard's read of a one-cycle world, from the same rows: realised
 * sales, their allocations' COGS, the ledger. Only what `getDashboardKPIs`
 * asks; the figures that are not money are zero.
 */
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
  // Nor is any order edited (§4, 2026-10-25): no line was added by one.
  prisma.saleItem = {
    ...prisma.saleItem,
    aggregate: answer({ _sum: { lineTotal: null } }),
  };
  // COGS of what sold; nothing here is ever samples written off (§4), so
  // that question — the only other one asked of this aggregate — finds none.
  prisma.saleItemAllocation.aggregate = ({ where }: Row = {}) =>
    Promise.resolve({
      _sum: {
        cogsEgp:
          where?.saleItem?.saleOrder?.status === 'SAMPLES_WRITTEN_OFF' ||
          // The cost of lines an order edit added: none here.
          where?.saleItem?.editId?.not === null
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

// ─── The loss cap ─────────────────────────────────────────────────────────

describe('POST /shipping/losses/:id/refunds — the cap', () => {
  it('A loss of 550 refunded 300 then 250 → both accepted; then 1 more → `REFUND_EXCEEDS_LOSS`', async () => {
    const { loss, provider, supplier } = await soldWithALoss();
    expect(loss.costEgp.toFixed(2)).toBe('550.00');

    await refund(loss, fromProvider(provider), 300);
    await refund(loss, fromSupplier(supplier), 250);

    const r = await refusal(refund(loss, fromProvider(provider), 1));
    expect(r).toMatchObject({
      status: 400,
      code: 'REFUND_EXCEEDS_LOSS',
      params: { cost: '550.00', refunded: '550.00', asked: '1.00' },
    });
    expect(db.refunds).toHaveLength(2);
  });

  it('A refund in USD at FX 50 of 12 → 600 EGP against a 550 loss → refused', async () => {
    const { loss, provider } = await soldWithALoss();
    const r = await refusal(
      refund(loss, fromProvider(provider), 12, {
        currency: 'USD',
        fxRateToEgp: 50,
      }),
    );
    // The cap is in EGP: 12 is far below 550, 600 is not.
    expect(r).toMatchObject({
      code: 'REFUND_EXCEEDS_LOSS',
      params: { cost: '550.00', refunded: '0.00', asked: '600.00' },
    });
    expect(db.refunds).toHaveLength(0);

    // 11 USD is 550 EGP — exactly the loss — and is accepted.
    await refund(loss, fromProvider(provider), 11, {
      currency: 'USD',
      fxRateToEgp: 50,
    });
    const row = db.ledger.find((t) => t.category === 'loss_refund')!;
    expect(row.amount.toFixed(2)).toBe('550.00');
    expect(row.currency).toBe('EGP');
  });

  it('Earlier refunds in another currency count at their own EGP', async () => {
    const { loss, provider, supplier } = await soldWithALoss();
    await refund(loss, fromProvider(provider), 5, {
      currency: 'USD',
      fxRateToEgp: 50,
    }); // 250
    const r = await refusal(refund(loss, fromSupplier(supplier), 300.01));
    expect(r).toMatchObject({
      code: 'REFUND_EXCEEDS_LOSS',
      params: { refunded: '250.00', asked: '300.01' },
    });
    await refund(loss, fromSupplier(supplier), 300);
  });

  it('Two refunds of 300 against a 550 loss at once → one succeeds, the other gets `REFUND_EXCEEDS_LOSS`, not a 500 (the race on the cap)', async () => {
    const { loss, provider } = await soldWithALoss();
    const results = await Promise.allSettled([
      refund(loss, fromProvider(provider), 300),
      refund(loss, fromProvider(provider), 300),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected')!;
    const body = (failed.reason as HttpException).getResponse() as Row;
    expect(body.code).toBe('REFUND_EXCEEDS_LOSS');
    expect(db.refunds).toHaveLength(1);
    expect(db.ledger.filter((t) => t.category === 'loss_refund')).toHaveLength(
      1,
    );
  });

  it('Double submit → one refund per send, up to the cap (the server accepts duplicates only up to the cap)', async () => {
    const { loss, provider } = await soldWithALoss();
    // Two identical sends of 200: both fit, both are kept — the dialog's
    // disabled button is what stops a double click; the server's promise is
    // the cap. A third identical send no longer fits.
    await Promise.all([
      refund(loss, fromProvider(provider), 200),
      refund(loss, fromProvider(provider), 200),
    ]);
    const r = await refusal(refund(loss, fromProvider(provider), 200));
    expect(r.code).toBe('REFUND_EXCEEDS_LOSS');
    expect(db.refunds).toHaveLength(2);
  });
});

// ─── Money in the ledger and in profit ────────────────────────────────────

describe('a loss refund in profit (§6, §9, rule 11)', () => {
  it('A refund raises cycle profit by its EGP in settlement and analytics alike, and appears as an INFLOW `loss_refund` with the cycle id', async () => {
    const { cycle, loss, provider } = await soldWithALoss();
    teachDashboard();

    const before = await settlements.calculate(cycle.id);
    // 900 of profit, less the 550 loss.
    expect(before.summary.grossProfitEgp).toBe('350.00');
    const dashBefore = (await analytics.getDashboardKPIs()).data;
    expect(dashBefore.netProfit).toBe(350);

    await refund(loss, fromProvider(provider), 4, {
      currency: 'USD',
      fxRateToEgp: 50,
    }); // 200 EGP

    const ledger = db.ledger.filter((t) => t.category === 'loss_refund');
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      direction: 'INFLOW',
      cycleId: cycle.id,
      currency: 'EGP',
      relatedType: 'SUPPLIER_REFUND',
      relatedId: db.refunds[0].id,
    });
    expect(ledger[0].amount.toFixed(2)).toBe('200.00');

    const after = await settlements.calculate(cycle.id);
    expect(after.summary.grossProfitEgp).toBe('550.00');

    const { data } = await analytics.getCycleProfitability();
    const row = (data as Row[]).find((c) => c.cycleCode === cycle.code)!;
    expect(row.profit).toBe(550);
    expect(row.profit.toFixed(2)).toBe(after.summary.grossProfitEgp);

    // The dashboard's net profit agrees: the same 200 raises it.
    const dash = (await analytics.getDashboardKPIs()).data;
    expect(dash.netProfit).toBe(550);
    expect(dash.totalRecoveredEgp).toBe(200);
  });

  it('A plain supplier refund raises profit on the dashboard as it does in settlement (the dashboard used to leave it out)', async () => {
    const { cycle, po } = await soldWithALoss();
    teachDashboard();
    await purchases.recordRefund(
      po.id,
      {
        amount: 100,
        currency: 'EGP',
        fxRateToEgp: 1,
        recordedOn: '2026-10-10',
      },
      ACTOR,
    );
    const settled = await settlements.calculate(cycle.id);
    expect(settled.summary.grossProfitEgp).toBe('450.00');
    const dash = (await analytics.getDashboardKPIs()).data;
    expect(dash.netProfit).toBe(450);
  });
});

// ─── Any cycle status ─────────────────────────────────────────────────────

describe('cycle status', () => {
  it('A refund on a CLOSED cycle → accepted (money arriving)', async () => {
    const { cycle, loss, provider } = await soldWithALoss();
    // The settlement flow that closes a cycle is covered in receipts.spec;
    // here the cycle is simply where that flow leaves it.
    db.cycles.find((c) => c.id === cycle.id)!.status = 'CLOSED';
    await refund(loss, fromProvider(provider), 100);
    expect(db.refunds).toHaveLength(1);
    expect(db.ledger.find((t) => t.category === 'loss_refund')!.cycleId).toBe(
      cycle.id,
    );
  });

  it('A refund on a cycle in SETTLEMENT → accepted', async () => {
    const { cycle, loss, supplier } = await soldWithALoss();
    db.cycles.find((c) => c.id === cycle.id)!.status = 'SETTLEMENT';
    await refund(loss, fromSupplier(supplier), 100);
    expect(db.refunds).toHaveLength(1);
  });
});

// ─── Dates (rule 1) ───────────────────────────────────────────────────────

describe('dates', () => {
  it('Dated tomorrow (Cairo) → `DATE_IN_FUTURE`; the same now applies to a plain supplier refund', async () => {
    const { loss, provider, po } = await soldWithALoss();
    const r = await refusal(
      refund(loss, fromProvider(provider), 100, { recordedOn: '2026-10-11' }),
    );
    expect(r).toMatchObject({
      code: 'DATE_IN_FUTURE',
      params: { day: '2026-10-11' },
    });

    const plain = await refusal(
      purchases.recordRefund(
        po.id,
        {
          amount: 100,
          currency: 'EGP',
          fxRateToEgp: 1,
          recordedOn: '2026-10-11',
        },
        ACTOR,
      ),
    );
    expect(plain.code).toBe('DATE_IN_FUTURE');
    expect(db.refunds).toHaveLength(0);
    expect(db.ledger.filter((t) => t.direction === 'INFLOW')).toHaveLength(0);
  });

  it('Just after midnight in Cairo (still yesterday in UTC), today’s Cairo date is accepted', async () => {
    const { loss, provider } = await soldWithALoss();
    jest.setSystemTime(new Date('2026-10-10T22:30:00Z')); // 01:30 on the 11th in Cairo
    await refund(loss, fromProvider(provider), 100, {
      recordedOn: '2026-10-11',
    });
    expect(db.refunds[0].recordedOn.toISOString().slice(0, 10)).toBe(
      '2026-10-11',
    );
  });

  it('No date → recorded on today in Cairo', async () => {
    const { loss, provider } = await soldWithALoss();
    await refund(loss, fromProvider(provider), 100, { recordedOn: undefined });
    expect(db.refunds[0].recordedOn.toISOString().slice(0, 10)).toBe(
      '2026-10-10',
    );
  });
});

// ─── Amounts (rule 1) ─────────────────────────────────────────────────────

describe('amounts', () => {
  it('Amount 0 or negative → refused', async () => {
    const { loss, provider } = await soldWithALoss();
    for (const amount of [0, -50]) {
      const r = await refusal(refund(loss, fromProvider(provider), amount));
      expect(r).toMatchObject({
        status: 400,
        code: 'VALIDATION_FAILED',
        params: { fields: 'amount' },
      });
    }
    expect(db.refunds).toHaveLength(0);
  });

  it('A zero or negative exchange rate, or fractions of a cent → refused', async () => {
    const { loss, provider } = await soldWithALoss();
    for (const fxRateToEgp of [0, -2]) {
      const r = await refusal(
        refund(loss, fromProvider(provider), 10, { fxRateToEgp }),
      );
      expect(r.params).toEqual({ fields: 'fxRateToEgp' });
    }
    const cents = await refusal(refund(loss, fromProvider(provider), 10.005));
    expect(cents.params).toEqual({ fields: 'amount' });
    expect(db.refunds).toHaveLength(0);
  });

  it('A plain supplier refund of zero → refused by the service too', async () => {
    const { po } = await soldWithALoss();
    const r = await refusal(
      purchases.recordRefund(
        po.id,
        { amount: 0, currency: 'EGP', fxRateToEgp: 1 },
        ACTOR,
      ),
    );
    expect(r.code).toBe('VALIDATION_FAILED');
  });
});

// ─── The wrong owner ──────────────────────────────────────────────────────

describe('who can pay', () => {
  it('An unknown loss id → 404; a payer that is neither the leg’s provider nor the order’s supplier → 404', async () => {
    const { loss, provider, supplier } = await soldWithALoss();
    const other = oneLeg(); // another cycle, its own supplier and company

    const unknown = await refusal(
      purchases.recordLossRefund(
        randomUUID(),
        {
          amount: 10,
          currency: 'EGP',
          fxRateToEgp: 1,
          payer: fromProvider(provider),
        },
        ACTOR,
      ),
    );
    expect(unknown).toMatchObject({
      status: 404,
      params: { entity: 'shipmentLoss' },
    });
    const garbage = await refusal(
      purchases.recordLossRefund(
        'not-a-uuid',
        {
          amount: 10,
          currency: 'EGP',
          fxRateToEgp: 1,
          payer: fromProvider(provider),
        },
        ACTOR,
      ),
    );
    expect(garbage.status).toBe(404);

    const otherCompany = await refusal(
      refund(loss, fromProvider(other.provider), 10),
    );
    expect(otherCompany).toMatchObject({
      status: 404,
      params: { entity: 'provider' },
    });
    const otherSupplier = await refusal(
      refund(loss, fromSupplier(other.supplier), 10),
    );
    expect(otherSupplier).toMatchObject({
      status: 404,
      params: { entity: 'supplier' },
    });
    // The right id under the wrong kind is still the wrong payer.
    const crossed = await refusal(
      refund(loss, { type: 'SUPPLIER', id: provider.id }, 10),
    );
    expect(crossed.status).toBe(404);
    const crossed2 = await refusal(
      refund(loss, { type: 'SHIPPING_PROVIDER', id: supplier.id }, 10),
    );
    expect(crossed2.status).toBe(404);
    expect(db.refunds).toHaveLength(0);
  });

  it('On a China cycle, the first leg’s company cannot pay for a loss on the second leg', async () => {
    const { cycle, items, supplier } = cycleWithOrder(db, {
      status: 'IN_TRANSIT_TO_EGYPT',
      originType: 'CHINA',
    });
    const leg1 = addLeg(db, cycle, 1, { departedOn: '2026-09-01' });
    await deliver(leg1, items[0], 40);
    // Leg 2 leaves Dubai once the goods are there (L8).
    const leg2 = addLeg(db, cycle, 2, { departedOn: '2026-09-25' });
    const loss = await lose(leg2, items[0], 5);
    const p1 = db.providers.find((p) => p.id === leg1.providerId)!;
    const p2 = db.providers.find((p) => p.id === leg2.providerId)!;

    expect((await refusal(refund(loss, fromProvider(p1), 10))).status).toBe(
      404,
    );
    await refund(loss, fromProvider(p2), 10);
    await refund(loss, fromSupplier(supplier), 10);
    expect(db.refunds.map((r) => r.payerShippingProviderId)).toEqual([
      p2.id,
      null,
    ]);
  });

  it('A leg with no company on record → a shipping-company payer is refused (404)', async () => {
    const { leg, item, provider } = oneLeg();
    (leg as Row).providerId = null;
    const loss = await lose(leg, item, 5);
    expect(
      (await refusal(refund(loss, fromProvider(provider), 10))).status,
    ).toBe(404);
  });

  it('An unknown payer kind → `VALIDATION_FAILED`', async () => {
    const { loss, provider } = await soldWithALoss();
    const r = await refusal(
      refund(loss, { type: 'CUSTOMER' as any, id: provider.id }, 10),
    );
    expect(r).toMatchObject({
      code: 'VALIDATION_FAILED',
      params: { fields: 'payer.type' },
    });
  });
});

// ─── The order-level cap (§6) ─────────────────────────────────────────────

describe('the order-level cap', () => {
  it('The order-level cap (§6) counts loss refunds too: order 1,000, loss refunds 600, plain refund 500 → refused', async () => {
    // 10 at 100 (an order of 1,000), a 400 leg: 140 a unit landed. 5 lost on
    // the way cost 700, so a 600 loss refund fits its own cap.
    const { leg, item, po, provider } = oneLeg({
      lines: [['Brake pad', 10, 100]],
    });
    const loss = await lose(leg, item, 5);
    expect(loss.costEgp.toFixed(2)).toBe('700.00');
    await refund(loss, fromProvider(provider), 600);

    const r = await refusal(
      purchases.recordRefund(
        po.id,
        { amount: 500, currency: 'EGP', fxRateToEgp: 1 },
        ACTOR,
      ),
    );
    expect(r).toMatchObject({
      code: 'REFUND_EXCEEDS_ORDER',
      params: { order: '1,000.00', refunded: '600.00', refund: '500.00' },
    });
    // 400 is what is left, and fits.
    await purchases.recordRefund(
      po.id,
      { amount: 400, currency: 'EGP', fxRateToEgp: 1 },
      ACTOR,
    );
  });

  it('A loss refund under its own cap is still refused when the order is used up', async () => {
    const { leg, item, po, provider } = oneLeg({
      lines: [['Brake pad', 10, 100]],
    });
    const loss = await lose(leg, item, 5);
    await purchases.recordRefund(
      po.id,
      { amount: 900, currency: 'EGP', fxRateToEgp: 1 },
      ACTOR,
    );
    const r = await refusal(refund(loss, fromProvider(provider), 200));
    expect(r.code).toBe('REFUND_EXCEEDS_ORDER');
    expect(db.refunds).toHaveLength(1);
  });

  it('A plain refund and a loss refund at once over the order cap → one is refused (both take the cycle lock)', async () => {
    const { leg, item, po, provider } = oneLeg({
      lines: [['Brake pad', 10, 100]],
    });
    const loss = await lose(leg, item, 5);
    const results = await Promise.allSettled([
      refund(loss, fromProvider(provider), 600),
      purchases.recordRefund(
        po.id,
        { amount: 600, currency: 'EGP', fxRateToEgp: 1 },
        ACTOR,
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(db.refunds).toHaveLength(1);
  });
});

// ─── Taking a refunded loss back ──────────────────────────────────────────

describe('DELETE /shipping/losses/:id', () => {
  it('Taking back a refunded loss → `LOSS_REFUNDED`', async () => {
    const { leg, item, provider } = oneLeg();
    const loss = await lose(leg, item, 5);
    await refund(loss, fromProvider(provider), 100);

    const r = await refusal(deliveries.takeBackLoss(loss.id, ACTOR));
    expect(r).toMatchObject({ code: 'LOSS_REFUNDED', params: { refunds: 1 } });
    expect(db.losses).toHaveLength(1);
  });

  it('A loss with no refund can still be taken back', async () => {
    const { leg, item } = oneLeg();
    const loss = await lose(leg, item, 5);
    await deliveries.takeBackLoss(loss.id, ACTOR);
    expect(db.losses).toHaveLength(0);
  });
});

// ─── The cycle page's read ────────────────────────────────────────────────

describe('GET /cycles/:id/shipment — losses with their refunds', () => {
  it('each loss carries its cost, refunded so far, unrecovered, and its refunds with the payer', async () => {
    const { cycle, leg, loss, provider, supplier } = await soldWithALoss();
    await refund(loss, fromProvider(provider), 3, {
      currency: 'USD',
      fxRateToEgp: 50,
    }); // 150
    await refund(loss, fromSupplier(supplier), 100);

    const { data } = await cycles.getShipment(cycle.id);
    const expected = {
      id: loss.id,
      legId: leg.id,
      purchaseOrderItemId: loss.purchaseOrderItemId,
      qty: 5,
      unitCostEgp: '110.0000',
      costEgp: '550.00',
      reason: null,
      createdAt: expect.any(Date),
      refundedEgp: '250.00',
      unrecoveredEgp: '300.00',
      refunds: [
        {
          id: db.refunds[0].id,
          amountEgp: '150.00',
          currency: 'USD',
          amount: '3.00',
          recordedOn: '2026-10-10',
          payerType: 'SHIPPING_PROVIDER',
          payerName: provider.name,
          reversedAt: null,
          reversalReason: null,
        },
        {
          id: db.refunds[1].id,
          amountEgp: '100.00',
          currency: 'EGP',
          amount: '100.00',
          recordedOn: '2026-10-10',
          payerType: 'SUPPLIER',
          payerName: supplier.name,
          reversedAt: null,
          reversalReason: null,
        },
      ],
    };
    expect((data as Row).losses).toEqual([expected]);
    expect((data as Row).legs[0].losses).toEqual([expected]);
  });

  it('a loss with no refunds reads refunded 0.00 and all of it unrecovered', async () => {
    const { cycle } = await soldWithALoss();
    const { data } = await cycles.getShipment(cycle.id);
    expect((data as Row).losses[0]).toMatchObject({
      refundedEgp: '0.00',
      unrecoveredEgp: '550.00',
      refunds: [],
    });
  });
});

// ─── Roles (CLAUDE.md rule 12) ────────────────────────────────────────────

describe('roles', () => {
  const contextFor = (role: string) =>
    ({
      getHandler: () =>
        Object.getOwnPropertyDescriptor(
          ShippingController.prototype,
          'recordLossRefund',
        )!.value as unknown,
      getClass: () => ShippingController,
      switchToHttp: () => ({
        getRequest: () => ({ user: { id: 'u', role } }),
      }),
    }) as unknown as ExecutionContext;

  it('Investor or shop token → refused with a code', () => {
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
