import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- this suite talks to a real, throwaway Postgres; that is its point
import { Prisma, PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { businessToday } from '../../common/dates';
import { cashPosition } from '../../common/cash-position';
import { cycleWriteOffsEgp } from '../../common/cycle-losses';
import { quietRunningCosts } from '../../common/running-costs-quiet-spec';
import { CostingService } from '../costing/costing.service';
import { CyclesService } from '../cycles/cycles.service';
import { DeliveriesService } from '../shipping/deliveries.service';
import { ShippingService } from '../shipping/shipping.service';
import { PaymentsService } from '../payments/payments.service';
import { SalesService } from '../sales/sales.service';
import { SettlementsService } from '../settlements/settlements.service';
import { ProfitDrawsService } from '../profit-draws/profit-draws.service';
import { StockTransfersService } from '../stock-transfers/stock-transfers.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { InventoryService } from './inventory.service';
import { StockDamagesService } from './stock-damages.service';

/**
 * Goods damaged in storage, written off (BUSINESS_LOGIC §3, §8 — owner
 * 2026-11-28), against a real Postgres.
 *
 * The fixture is the blind scenarios' CYC-T1, built as the business makes a
 * cycle (CLAUDE.md §4): an order of 100 headsets at 1,250 and 500 brake pads
 * at 350, a leg, a delivery, a checked-in receipt, 40 headsets sold at 2,000
 * to a verified shop and half of it paid. Abdallah 90,000, Shady 90,000, Fares
 * 60,000 and the investor Ihab 60,000: a profit of 30,000 split 9,000 / 9,000
 * / 6,000 / 6,000. Tests named TC-DMG-NN are the scenario of that number in
 * the blind agent's list (written from the docs only).
 *
 *   INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/motorcycle_parts_<name> \
 *     npx jest stock-damages.db --runInBand
 */
// eslint-disable-next-line no-restricted-properties -- an opt-in switch for a suite that must never run by default
const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const daysAgo = (n: number) =>
  businessToday(new Date(Date.now() - n * 86_400_000));
const daysAhead = (n: number) =>
  businessToday(new Date(Date.now() + n * 86_400_000));

suite('goods damaged in storage (Postgres)', () => {
  jest.setTimeout(120_000);

  let prisma: PrismaClient;
  let damages: StockDamagesService;
  let deliveries: DeliveriesService;
  let inventory: InventoryService;
  let shipping: ShippingService;
  let sales: SalesService;
  let payments: PaymentsService;
  let settlements: SettlementsService;
  let draws: ProfitDrawsService;
  let transfers: StockTransfersService;
  let analytics: AnalyticsService;
  let notify: jest.Mock;
  let actor: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const db = prisma as unknown as PrismaService;
    const audit = { log: jest.fn() } as unknown as AuditService;
    notify = jest.fn().mockResolvedValue({ count: 0 });
    const notifications = {
      createForMultipleUsers: notify,
      create: jest.fn(),
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
    shipping = new ShippingService(db, audit, costing, deliveries);
    payments = new PaymentsService(db, audit);
    sales = new SalesService(db, audit, payments, {
      createForMultipleUsers: () => Promise.resolve({ count: 0 }),
    });
    settlements = new SettlementsService(db, audit, costing);
    draws = new ProfitDrawsService(db, audit, settlements, costing);
    transfers = new StockTransfersService(db, audit);
    analytics = new AnalyticsService(db);
    damages = new StockDamagesService(db, audit, notifications);
    actor = (await person('Actor')).id;
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => quietRunningCosts(prisma));

  // ─── Fixtures ───────────────────────────────────────────────────────

  async function person(
    name: string,
    role: 'CORE_PARTNER' | 'TEMP_INVESTOR' = 'CORE_PARTNER',
  ) {
    const tag = randomUUID().slice(0, 8);
    return prisma.user.create({
      data: {
        email: `dmg-${name.toLowerCase()}-${tag}@example.test`,
        passwordHash: 'x',
        role,
        partner: { create: { displayName: `${name} ${tag}` } },
      },
    });
  }

  /** CYC-T1 as the scenarios have it. `sell` headsets sold, half paid. */
  async function cycleT1(opts: { fee?: number; sell?: number } = {}) {
    const tag = randomUUID().slice(0, 8);
    const who = [
      { u: await person('Abdallah'), type: 'CORE_PARTNER', put: 90000 },
      { u: await person('Shady'), type: 'CORE_PARTNER', put: 90000 },
      { u: await person('Fares'), type: 'CORE_PARTNER', put: 60000 },
      {
        u: await person('Ihab', 'TEMP_INVESTOR'),
        type: 'TEMP_INVESTOR',
        put: 60000,
      },
    ] as const;
    const cycle = await prisma.importCycle.create({
      data: {
        code: `DMG-${tag}`,
        originType: 'UAE_DIRECT',
        currency: 'EGP',
        status: 'ARRIVED_EGYPT',
      },
    });
    const joined = Date.now() - 600_000;
    const participants = [];
    for (const [i, s] of who.entries()) {
      participants.push(
        await prisma.cycleParticipant.create({
          data: {
            cycleId: cycle.id,
            participantType: s.type,
            partnerUserId: s.type === 'CORE_PARTNER' ? s.u.id : null,
            investorUserId: s.type === 'TEMP_INVESTOR' ? s.u.id : null,
            contributionAmount: s.put,
            investorFeePct:
              s.type === 'TEMP_INVESTOR' ? (opts.fee ?? null) : null,
            createdAt: new Date(joined + i * 1000),
            updatedAt: new Date(joined + i * 1000),
          },
        }),
      );
    }
    const supplier = await prisma.supplier.create({
      data: { name: `Damage ${tag}`, country: 'AE' },
    });
    const headset = await prisma.product.create({
      data: { sku: `HDS-${tag}`, name: `Helmet headset ${tag}` },
    });
    const pads = await prisma.product.create({
      data: { sku: `PAD-${tag}`, name: `Brake pads ${tag}` },
    });
    const po = await prisma.purchaseOrder.create({
      data: {
        cycleId: cycle.id,
        supplierId: supplier.id,
        reference: `PO-${tag}`,
        currency: 'EGP',
        fxRateToEgp: 1,
        orderedOn: new Date(`${daysAgo(30)}T00:00:00Z`),
        status: 'CONFIRMED',
      },
    });
    const items = [
      await prisma.purchaseOrderItem.create({
        data: {
          purchaseOrderId: po.id,
          productId: headset.id,
          orderedQty: 100,
          unitPrice: 1250,
          lineTotal: 125000,
        },
      }),
      await prisma.purchaseOrderItem.create({
        data: {
          purchaseOrderId: po.id,
          productId: pads.id,
          orderedQty: 500,
          unitPrice: 350,
          lineTotal: 175000,
        },
      }),
    ];
    const leg = await prisma.shippingLeg.create({
      data: {
        cycleId: cycle.id,
        sequence: 1,
        origin: 'Dubai, UAE',
        destination: 'Cairo, Egypt',
        departedOn: new Date(`${daysAgo(20)}T00:00:00Z`),
        status: 'IN_TRANSIT',
        costBasis: 'FLAT',
        amount: '0',
        amountEgp: '0',
      },
    });
    await prisma.shipmentDeparture.create({
      data: {
        legId: leg.id,
        departedOn: new Date(`${daysAgo(20)}T00:00:00Z`),
        lines: {
          create: items.map((i) => ({
            purchaseOrderItemId: i.id,
            qty: i.orderedQty,
          })),
        },
      },
    });
    const { data: delivery } = await deliveries.recordDelivery(
      leg.id,
      {
        arrivedOn: daysAgo(12),
        lines: items.map((i) => ({
          purchaseOrderItemId: i.id,
          qty: Number(i.orderedQty),
        })),
      },
      actor,
    );
    const d = delivery as unknown as {
      id: string;
      lines: { id: string; purchaseOrderItemId: string; qty: unknown }[];
    };
    await inventory.verifyStock(
      cycle.id,
      {
        deliveryId: d.id,
        receivedOn: daysAgo(10),
        items: d.lines.map((l) => ({
          deliveryLineId: l.id,
          receivedQty: Number(l.qty),
        })),
      },
      actor,
    );
    const b1 = await prisma.inventoryBatch.findFirstOrThrow({
      where: { cycleId: cycle.id, productId: headset.id },
    });
    const shop = await prisma.customer.create({
      data: {
        type: 'B2B',
        displayName: `Damage shop ${tag}`,
        verificationStatus: 'VERIFIED',
      },
    });
    const sell = opts.sell ?? 40;
    if (sell > 0) {
      await sales.create(
        {
          customerId: shop.id,
          channel: 'B2B',
          currency: 'EGP',
          items: [{ productId: headset.id, quantity: sell, unitPrice: 2000 }],
          confirm: true,
        },
        actor,
      );
      const order = await prisma.saleOrder.findFirstOrThrow({
        where: { customerId: shop.id },
      });
      await payments.create(
        {
          customerId: shop.id,
          amount: sell * 1000,
          currency: 'EGP',
          orderId: order.id,
        },
        actor,
      );
    }
    return {
      cycle,
      who,
      participants,
      headset,
      pads,
      b1,
      shop,
      leg,
      items,
    };
  }

  async function refusal(p: Promise<unknown>) {
    try {
      await p;
    } catch (e) {
      if (!(e instanceof HttpException)) throw e;
      const body = e.getResponse() as {
        code: string;
        params?: Record<string, unknown>;
      };
      return { status: e.getStatus(), code: body.code, params: body.params };
    }
    throw new Error('expected a refusal');
  }

  const mark = (
    batchId: string,
    qty: unknown,
    extra: { damagedOn?: string; note?: string } = {},
  ) =>
    damages.mark(
      batchId,
      { qty: qty as number, note: 'dropped from shelf', ...extra },
      actor,
    );
  const undo = (id: string, reason = 'found it was fine') =>
    damages.undo(id, reason, actor);

  const batch = (id: string) =>
    prisma.inventoryBatch.findUniqueOrThrow({ where: { id } });
  const shelf = async (id: string) => {
    const b = await batch(id);
    return [
      D(b.remainingQty).toFixed(0),
      D(b.saleableQty).toFixed(0),
      D(b.receivedQty).toFixed(0),
    ];
  };
  const profitOf = async (cycleId: string) =>
    (await settlements.project(cycleId))!.pnl.grossProfit.toFixed(2);
  const sharesOf = async (cycleId: string) =>
    (await settlements.project(cycleId))!.distribution.lines.map((l) =>
      l.grossProfit.toFixed(2),
    );
  const roomOf = async (cycleId: string, userId: string) =>
    (await draws.takeForCycle(cycleId)).data.people.find(
      (p) => p.userId === userId,
    )!;

  // ─── A. Happy path ──────────────────────────────────────────────────

  it('TC-DMG-01 Marking 4 units damaged — stock, loss, profit, shares; no ledger row, no cash moves', async () => {
    const k = await cycleT1();
    expect(await profitOf(k.cycle.id)).toBe('30000.00');
    expect(await sharesOf(k.cycle.id)).toEqual([
      '9000.00',
      '9000.00',
      '6000.00',
      '6000.00',
    ]);
    const ledgerBefore = await prisma.financialTransaction.count();
    const cash = (await cashPosition(prisma)).cashOnHand;
    const today = businessToday();
    const pnlBefore = (await analytics.getProfitAndLoss(today, today)).data;

    const { data } = await mark(k.b1.id, 4);
    expect(data).toMatchObject({
      qty: '4',
      unitCostEgp: '1250.0000',
      costEgp: '5000.00',
      damagedOn: today,
      note: 'dropped from shelf',
    });

    expect(await shelf(k.b1.id)).toEqual(['56', '56', '100']);
    // Never re-pricing the batch, never touching the 40 sold.
    expect(D((await batch(k.b1.id)).landedUnitCostEgp).toFixed(4)).toBe(
      '1250.0000',
    );
    const pads = await prisma.inventoryBatch.findFirstOrThrow({
      where: { cycleId: k.cycle.id, productId: k.pads.id },
    });
    expect(D(pads.remainingQty).toFixed(0)).toBe('500');

    const writeOffs = await cycleWriteOffsEgp(prisma, k.cycle.id);
    expect(writeOffs.damagedInStorage.toFixed(2)).toBe('5000.00');
    expect(writeOffs.total.toFixed(2)).toBe('5000.00');
    expect(await profitOf(k.cycle.id)).toBe('25000.00');
    expect(await sharesOf(k.cycle.id)).toEqual([
      '7500.00',
      '7500.00',
      '5000.00',
      '5000.00',
    ]);
    // Its own line in the payout's costs.
    const projected = (await settlements.project(k.cycle.id))!;
    expect(projected.costLines).toContainEqual({
      kind: 'loss',
      category: 'damaged_in_storage',
      amountEgp: '5000.00',
    });

    // No money moved.
    expect(await prisma.financialTransaction.count()).toBe(ledgerBefore);
    expect((await cashPosition(prisma)).cashOnHand.toFixed(2)).toBe(
      cash.toFixed(2),
    );

    // The movement history: a WRITE_OFF of 4 at cost, no customer.
    const { data: moves } = await inventory.getMovements(k.b1.id);
    const off = moves.find((m) => m.movementType === 'WRITE_OFF')!;
    expect(D(off.qtyDelta).toFixed(0)).toBe('-4');
    expect(off).toMatchObject({
      referenceType: 'STOCK_DAMAGE',
      referenceId: data.id,
      customerName: null,
      priceKind: 'cost',
      unitPrice: '1250.00',
    });

    // Analytics: today's net profit 5,000 lower, its own expense line, and a
    // row in What made a bar.
    const pnl = (await analytics.getProfitAndLoss(today, today)).data;
    expect(D(pnlBefore.netProfitEgp).sub(pnl.netProfitEgp).toFixed(2)).toBe(
      '5000.00',
    );
    const line = pnl.expensesByCategory.find(
      (c) => c.category === 'damaged_in_storage',
    );
    expect(line && line.amountEgp >= 5000).toBe(true);
    const bar = (await analytics.getProfitBreakdown({ from: today, to: today }))
      .data as unknown as {
      sections: {
        expenses: {
          rows: {
            kind: string;
            id: string;
            amountEgp: number;
            damage: { qty: number; product: string; cycle: { code: string } };
          }[];
        };
      };
    };
    const row = bar.sections.expenses.rows.find((r) => r.id === data.id);
    // Paged largest first; with a busy test database it may be on a later
    // page, so ask that section for every row when it is not on the first.
    const found =
      row ??
      (
        (
          await analytics.getProfitBreakdown({
            from: today,
            to: today,
            section: 'expenses',
            pageSize: 200,
          })
        ).data as unknown as typeof bar
      ).sections.expenses.rows.find((r) => r.id === data.id);
    expect(found).toMatchObject({
      kind: 'damaged',
      amountEgp: 5000,
      damage: {
        qty: 4,
        product: k.headset.name,
        cycle: { code: k.cycle.code },
      },
    });

    // The cycle's profitability line (cycle page, Cycles list) reads it too.
    const { data: prof } = await analytics.getCycleProfitability();
    const mine = prof.find((c) => c.cycleCode === k.cycle.code);
    expect(mine?.lossesEgp).toBe(5000);
  });

  it('TC-DMG-01 the cycle page lists it, and its batch says how many stand damaged', async () => {
    const k = await cycleT1();
    const { data: d } = await mark(k.b1.id, 4);
    const { data } = await damages.forCycle(k.cycle.id);
    expect(data.locked).toBeNull();
    expect(data.damages).toHaveLength(1);
    expect(data.damages[0]).toMatchObject({
      id: d.id,
      qty: '4',
      costEgp: '5000.00',
      note: 'dropped from shelf',
      undoneAt: null,
      undo: { allowed: true },
    });
    expect(data.damages[0].createdBy?.id).toBe(actor);
  });

  it('TC-DMG-03 Investor fee recalculated on the smaller profit', async () => {
    const k = await cycleT1({ fee: 15 });
    await mark(k.b1.id, 4);
    const ihab = (await settlements.project(k.cycle.id))!.distribution.lines[3];
    expect(
      [ihab.grossProfit, ihab.investorFee, ihab.netProfit].map((v) =>
        v.toFixed(2),
      ),
    ).toEqual(['5000.00', '750.00', '4250.00']);
  });

  // ─── B. Limits ──────────────────────────────────────────────────────

  it('TC-DMG-04 Zero, negative and fractional units are refused; nothing is recorded, the shelf and the profit stay', async () => {
    const k = await cycleT1();
    for (const [qty, code] of [
      [0, 'STOCK_DAMAGE_QTY_NOT_POSITIVE'],
      [-3, 'STOCK_DAMAGE_QTY_NOT_POSITIVE'],
      [1.5, 'STOCK_DAMAGE_QTY_NOT_WHOLE'],
      ['four', 'STOCK_DAMAGE_QTY_NOT_POSITIVE'],
    ] as const) {
      const r = await refusal(mark(k.b1.id, qty));
      expect([r.status, r.code]).toEqual([400, code]);
    }
    expect(await shelf(k.b1.id)).toEqual(['60', '60', '100']);
    expect(await profitOf(k.cycle.id)).toBe('30000.00');
    expect(
      await prisma.stockDamage.count({ where: { batchId: k.b1.id } }),
    ).toBe(0);
  });

  it('TC-DMG-05 More than is on the shelf: 61 refused with available 60; exactly 60 allowed and the cycle goes into a loss', async () => {
    const k = await cycleT1();
    const r = await refusal(mark(k.b1.id, 61));
    expect(r.code).toBe('STOCK_DAMAGE_MORE_THAN_ON_SHELF');
    expect(r.params).toMatchObject({ available: '60', requested: '61' });
    await mark(k.b1.id, 60);
    expect(await shelf(k.b1.id)).toEqual(['0', '0', '100']);
    expect(await profitOf(k.cycle.id)).toBe('-45000.00');
    expect(await sharesOf(k.cycle.id)).toEqual([
      '-13500.00',
      '-13500.00',
      '-9000.00',
      '-9000.00',
    ]);
  });

  it('TC-DMG-06 Units already out on a confirmed order cannot be marked: 51 refused, available 50', async () => {
    const k = await cycleT1({ sell: 50 });
    const r = await refusal(mark(k.b1.id, 51));
    expect(r.code).toBe('STOCK_DAMAGE_MORE_THAN_ON_SHELF');
    expect(r.params).toMatchObject({ available: '50' });
  });

  it('TC-DMG-07 A draft order holds nothing: 4 marked; confirming a draft of 58 is then refused NOT_ENOUGH_STOCK', async () => {
    const k = await cycleT1();
    await sales.create(
      {
        customerId: k.shop.id,
        channel: 'B2B',
        currency: 'EGP',
        items: [{ productId: k.headset.id, quantity: 58, unitPrice: 2000 }],
      },
      actor,
    );
    const draft = await prisma.saleOrder.findFirstOrThrow({
      where: { customerId: k.shop.id, status: 'DRAFT' },
    });
    await mark(k.b1.id, 4);
    expect(await shelf(k.b1.id)).toEqual(['56', '56', '100']);
    const r = await refusal(sales.confirmOrder(draft.id, actor, draft.version));
    expect(r.code).toBe('NOT_ENOUGH_STOCK');
  });

  it('TC-DMG-08 Units held by a storefront order request are not on offer: 5 held of 60 → 55 refused at 56', async () => {
    const k = await cycleT1();
    await prisma.inventoryReservation.create({
      data: {
        batchId: k.b1.id,
        qty: 5,
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() + 48 * 3_600_000),
      },
    });
    const r = await refusal(mark(k.b1.id, 56));
    expect(r.code).toBe('STOCK_DAMAGE_MORE_THAN_ON_SHELF');
    expect(r.params).toMatchObject({ available: '55' });
    // A hold whose clock ran out is not a promise any more.
    await prisma.inventoryReservation.updateMany({
      where: { batchId: k.b1.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await mark(k.b1.id, 56);
    expect(await shelf(k.b1.id)).toEqual(['4', '4', '100']);
  });

  it('TC-DMG-09 A date in the future is refused; a date before the batch was received is refused; an earlier day puts the loss on that day', async () => {
    const k = await cycleT1();
    const r = await refusal(mark(k.b1.id, 4, { damagedOn: daysAhead(1) }));
    expect([r.code, r.params?.label]).toEqual([
      'DATE_IN_FUTURE',
      'STOCK_DAMAGED',
    ]);
    const before = await refusal(mark(k.b1.id, 4, { damagedOn: daysAgo(11) }));
    expect(before.code).toBe('STOCK_DAMAGE_BEFORE_RECEIVED');
    const bad = await refusal(mark(k.b1.id, 4, { damagedOn: '2026-02-30' }));
    expect(bad.status).toBe(400);
    expect(await shelf(k.b1.id)).toEqual(['60', '60', '100']);

    const day = daysAgo(5);
    const today = businessToday();
    const onDay = async () =>
      (await analytics.getProfitAndLoss(day, day)).data.netProfitEgp;
    const onToday = async () =>
      (await analytics.getProfitAndLoss(today, today)).data.netProfitEgp;
    const [dayBefore, todayBefore] = [await onDay(), await onToday()];
    const { data } = await mark(k.b1.id, 4, { damagedOn: day });
    expect(data.damagedOn).toBe(day);
    expect(
      D(dayBefore)
        .sub(await onDay())
        .toFixed(2),
    ).toBe('5000.00');
    expect(
      D(todayBefore)
        .sub(await onToday())
        .toFixed(2),
    ).toBe('0.00');
  });

  // ─── C. Wrong context ───────────────────────────────────────────────

  it('TC-DMG-10 A settlement approved or paid refuses; a draft goes stale and cannot be approved until calculated again; reversed, marking is allowed', async () => {
    const k = await cycleT1();
    // A draft calculated at 30,000.
    const draft = (await settlements.calculate(k.cycle.id, actor)).data!;
    await mark(k.b1.id, 4);
    const stale = await refusal(settlements.approve(draft.id, actor));
    expect(stale.code).toBe('SETTLEMENT_STALE_WRITE_OFFS');
    // Calculated again, at 25,000, it approves.
    const again = (await settlements.calculate(k.cycle.id, actor)).data!;
    await settlements.approve(again.id, actor);
    const approved = await refusal(mark(k.b1.id, 1));
    expect(approved.code).toBe('CYCLE_SETTLING');
    await settlements.markPaid(again.id, actor, {
      acceptRemainingStock: true,
    });
    expect((await refusal(mark(k.b1.id, 1))).code).toBe('CYCLE_SETTLING');
    await settlements.reverse(again.id, 'recount', actor);
    await mark(k.b1.id, 1);
    expect(await shelf(k.b1.id)).toEqual(['55', '55', '100']);
  });

  it('TC-DMG-10 a draft calculated before an undo is stale too', async () => {
    const k = await cycleT1();
    const { data: d } = await mark(k.b1.id, 4);
    const draft = (await settlements.calculate(k.cycle.id, actor)).data!;
    await undo(d.id);
    expect((await refusal(settlements.approve(draft.id, actor))).code).toBe(
      'SETTLEMENT_STALE_WRITE_OFFS',
    );
  });

  it('TC-DMG-11 A batch that does not exist is a 404 with a code, never a 500; so is a damage that does not exist', async () => {
    for (const id of [randomUUID(), 'does-not-exist']) {
      const r = await refusal(mark(id, 1));
      expect([r.status, r.code, r.params?.entity]).toEqual([
        404,
        'NOT_FOUND',
        'inventoryBatch',
      ]);
      const u = await refusal(undo(id));
      expect([u.status, u.code, u.params?.entity]).toEqual([
        404,
        'NOT_FOUND',
        'stockDamage',
      ]);
    }
    expect((await refusal(damages.forCycle(randomUUID()))).status).toBe(404);
  });

  it('TC-DMG-11 an investor reads only his own cycles’ damages', async () => {
    const k = await cycleT1();
    const other = await cycleT1({ sell: 0 });
    const ihab = { id: k.who[3].u.id, role: 'TEMP_INVESTOR' };
    expect((await damages.forCycle(k.cycle.id, ihab)).data.cycleId).toBe(
      k.cycle.id,
    );
    expect((await refusal(damages.forCycle(other.cycle.id, ihab))).status).toBe(
      404,
    );
  });

  it('TC-DMG-12 A batch with nothing on the shelf: refused, available 0', async () => {
    const k = await cycleT1({ sell: 100 });
    const r = await refusal(mark(k.b1.id, 1));
    expect(r.code).toBe('STOCK_DAMAGE_MORE_THAN_ON_SHELF');
    expect(r.params).toMatchObject({ available: '0' });
  });

  it('a cancelled cycle refuses with CYCLE_CLOSED', async () => {
    const k = await cycleT1({ sell: 0 });
    await prisma.importCycle.update({
      where: { id: k.cycle.id },
      data: { status: 'CANCELLED' },
    });
    expect((await refusal(mark(k.b1.id, 1))).code).toBe('CYCLE_CLOSED');
  });

  // ─── D. The second time ─────────────────────────────────────────────

  it('TC-DMG-13 Mark the same batch twice: two records, 60 → 56 → 53, profit 21,250', async () => {
    const k = await cycleT1();
    await mark(k.b1.id, 4, { damagedOn: daysAgo(2) });
    await mark(k.b1.id, 3);
    expect(await shelf(k.b1.id)).toEqual(['53', '53', '100']);
    expect(await profitOf(k.cycle.id)).toBe('21250.00');
    expect(await sharesOf(k.cycle.id)).toEqual([
      '6375.00',
      '6375.00',
      '4250.00',
      '4250.00',
    ]);
    expect(
      await prisma.stockDamage.count({ where: { batchId: k.b1.id } }),
    ).toBe(2);
  });

  it('TC-DMG-14 Two submissions at once: one succeeds, the other is refused; never below zero, never a double loss', async () => {
    const k = await cycleT1();
    const results = await Promise.allSettled([
      mark(k.b1.id, 40),
      mark(k.b1.id, 40),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const no = results.filter((r) => r.status === 'rejected');
    expect([ok.length, no.length]).toEqual([1, 1]);
    const err = no[0].reason as HttpException;
    expect((err.getResponse() as { code: string }).code).toBe(
      'STOCK_DAMAGE_MORE_THAN_ON_SHELF',
    );
    expect(await shelf(k.b1.id)).toEqual(['20', '20', '100']);
    expect(
      (await cycleWriteOffsEgp(prisma, k.cycle.id)).damagedInStorage.toFixed(2),
    ).toBe('50000.00');
  });

  it('TC-DMG-15 Undo, then undo again: back to 60 and 30,000, the record kept with who, when and why; the second undo refused', async () => {
    const k = await cycleT1();
    const { data: d } = await mark(k.b1.id, 4);
    const today = businessToday();
    const pnlMarked = (await analytics.getProfitAndLoss(today, today)).data
      .netProfitEgp;
    const ledgerBefore = await prisma.financialTransaction.count();

    expect((await refusal(damages.undo(d.id, '  ', actor))).code).toBe(
      'STOCK_DAMAGE_REASON_REQUIRED',
    );
    await undo(d.id, 'counted again: fine');
    expect(await shelf(k.b1.id)).toEqual(['60', '60', '100']);
    expect(D((await batch(k.b1.id)).landedUnitCostEgp).toFixed(4)).toBe(
      '1250.0000',
    );
    expect(await profitOf(k.cycle.id)).toBe('30000.00');
    expect(await sharesOf(k.cycle.id)).toEqual([
      '9000.00',
      '9000.00',
      '6000.00',
      '6000.00',
    ]);
    expect(await prisma.financialTransaction.count()).toBe(ledgerBefore);
    const row = await prisma.stockDamage.findUniqueOrThrow({
      where: { id: d.id },
    });
    expect(row.undoneAt).not.toBeNull();
    expect([row.undoneBy, row.undoReason]).toEqual([
      actor,
      'counted again: fine',
    ]);
    // In no period: today's profit is back where it was before the mark.
    const pnlUndone = (await analytics.getProfitAndLoss(today, today)).data
      .netProfitEgp;
    expect(D(pnlUndone).sub(pnlMarked).toFixed(2)).toBe('5000.00');

    const again = await refusal(undo(d.id));
    expect(again.code).toBe('STOCK_DAMAGE_ALREADY_UNDONE');
    expect(await shelf(k.b1.id)).toEqual(['60', '60', '100']);
    expect(await profitOf(k.cycle.id)).toBe('30000.00');
    // The list says so and offers no undo.
    const listed = (await damages.forCycle(k.cycle.id)).data.damages[0];
    expect(listed.undo).toMatchObject({
      allowed: false,
      code: 'STOCK_DAMAGE_ALREADY_UNDONE',
    });
    expect(listed.undoReason).toBe('counted again: fine');
    // The movement that put them back.
    const { data: moves } = await inventory.getMovements(k.b1.id);
    expect(
      moves
        .filter((m) => m.referenceType === 'STOCK_DAMAGE')
        .map((m) => [m.movementType, D(m.qtyDelta).toFixed(0)]),
    ).toEqual(
      expect.arrayContaining([
        ['WRITE_OFF', '-4'],
        ['ADJUSTMENT', '4'],
      ]),
    );
  });

  it('TC-DMG-15 two undos at once put the units back once', async () => {
    const k = await cycleT1();
    const { data: d } = await mark(k.b1.id, 4);
    const results = await Promise.allSettled([undo(d.id), undo(d.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await shelf(k.b1.id)).toEqual(['60', '60', '100']);
  });

  it('TC-DMG-16 Mark again after an undo: a new record; undoing the new one does not revive the old', async () => {
    const k = await cycleT1();
    const { data: first } = await mark(k.b1.id, 4);
    await undo(first.id);
    const { data: second } = await mark(k.b1.id, 4);
    expect(second.id).not.toBe(first.id);
    expect(await shelf(k.b1.id)).toEqual(['56', '56', '100']);
    expect(await profitOf(k.cycle.id)).toBe('25000.00');
    await undo(second.id);
    expect(await shelf(k.b1.id)).toEqual(['60', '60', '100']);
    expect(await profitOf(k.cycle.id)).toBe('30000.00');
    const rows = await prisma.stockDamage.findMany({
      where: { batchId: k.b1.id },
    });
    expect(rows.every((r) => r.undoneAt !== null)).toBe(true);
  });

  it('TC-DMG-17 Undo after the rest of the stock sold: allowed, 4 back on the shelf, profit +5,000', async () => {
    const k = await cycleT1();
    const { data: d } = await mark(k.b1.id, 4);
    await sales.create(
      {
        customerId: k.shop.id,
        channel: 'B2B',
        currency: 'EGP',
        items: [{ productId: k.headset.id, quantity: 56, unitPrice: 2000 }],
        confirm: true,
      },
      actor,
    );
    expect(await shelf(k.b1.id)).toEqual(['0', '0', '100']);
    const before = D(await profitOf(k.cycle.id));
    await undo(d.id);
    expect(await shelf(k.b1.id)).toEqual(['4', '4', '100']);
    expect(
      D(await profitOf(k.cycle.id))
        .sub(before)
        .toFixed(2),
    ).toBe('5000.00');
  });

  // ─── E. Life over time ──────────────────────────────────────────────

  it('TC-DMG-18 Marked → calculated → approved → paid → undo refused → reversed → undone → calculated again at 30,000', async () => {
    const k = await cycleT1();
    const { data: d } = await mark(k.b1.id, 4);
    const calc = (await settlements.calculate(k.cycle.id, actor)).data!;
    expect(D(calc.grossProfitEgp ?? 0).toFixed(2)).toBe('25000.00');
    await settlements.approve(calc.id, actor);
    expect((await refusal(undo(d.id))).code).toBe('CYCLE_SETTLING');
    const listed = (await damages.forCycle(k.cycle.id)).data;
    expect(listed.locked?.code).toBe('CYCLE_SETTLING');
    expect(listed.damages[0].undo.allowed).toBe(false);
    await settlements.markPaid(calc.id, actor, { acceptRemainingStock: true });
    expect((await refusal(undo(d.id))).code).toBe('CYCLE_SETTLING');
    await settlements.reverse(calc.id, 'the headsets were fine', actor);
    await undo(d.id);
    const again = (await settlements.calculate(k.cycle.id, actor)).data!;
    expect(D(again.grossProfitEgp ?? 0).toFixed(2)).toBe('30000.00');
    const lines = await prisma.settlementLine.findMany({
      where: { settlementId: again.id },
    });
    const payout = (pid: string) =>
      lines
        .filter(
          (l) =>
            l.participantId === pid &&
            ['CAPITAL_RETURN', 'PROFIT_SHARE'].includes(l.component),
        )
        .reduce((s, l) => s.add(l.amount), D(0))
        .toFixed(2);
    expect(k.participants.map((p) => payout(p.id))).toEqual([
      '99000.00',
      '99000.00',
      '66000.00',
      '66000.00',
    ]);
  });

  it('TC-DMG-19 Take money before and after a damage: Abdallah 4,500 → 3,750; capital rooms unchanged', async () => {
    const k = await cycleT1();
    const abdallah = k.who[0].u.id;
    const before = await roomOf(k.cycle.id, abdallah);
    expect(before.profit?.availableEgp).toBe('4500.00');
    await mark(k.b1.id, 4);
    const after = await roomOf(k.cycle.id, abdallah);
    expect(after.profit?.availableEgp).toBe('3750.00');
    expect(after.capital.availableEgp).toBe(before.capital.availableEgp);
  });

  it('TC-DMG-19 he already took 4,500: his room floors at 0, the damage is not refused, settlement pays 90,000 + 7,500 − 4,500', async () => {
    const k = await cycleT1();
    const abdallah = k.who[0].u.id;
    await draws.take(k.cycle.id, { userId: abdallah, amountEgp: 4500 }, actor);
    await mark(k.b1.id, 4);
    const room = await roomOf(k.cycle.id, abdallah);
    expect(room.profit?.availableEgp).toBe('0.00');
    const id = (await settlements.calculate(k.cycle.id, actor)).data!.id;
    const lines = await prisma.settlementLine.findMany({
      where: { settlementId: id, participantId: k.participants[0].id },
    });
    const sum = lines
      .filter((l) => !l.component.startsWith('INVESTOR_FEE'))
      .reduce((s, l) => s.add(l.amount), D(0));
    expect(sum.toFixed(2)).toBe('93000.00');
  });

  it('TC-DMG-20 Damage after an investor exited falls only on those still on the cycle: Ihab stays 6,000; the rest 7,125 / 7,125 / 4,750', async () => {
    const k = await cycleT1();
    const { data: exited } = await draws.exit(
      k.cycle.id,
      k.participants[3].id,
      {},
      actor,
    );
    expect(exited.profitEgp).toBe('6000.00');
    expect(exited.payoutEgp).toBe('66000.00');
    await mark(k.b1.id, 4);
    expect(await profitOf(k.cycle.id)).toBe('25000.00');
    expect(await sharesOf(k.cycle.id)).toEqual([
      '7125.00',
      '7125.00',
      '4750.00',
      '6000.00',
    ]);
    const frozen = await prisma.cycleParticipant.findUniqueOrThrow({
      where: { id: k.participants[3].id },
    });
    expect([
      frozen.exitProfitEgp?.toFixed(2),
      frozen.exitPaidEgp?.toFixed(2),
      frozen.exitCycleProfitEgp?.toFixed(2),
    ]).toEqual(['6000.00', '66000.00', '30000.00']);
  });

  it('TC-DMG-21 Damage before the exit, undone after it: allowed; Ihab stays 5,000 / 65,000, the remaining 9,375 / 9,375 / 6,250', async () => {
    const k = await cycleT1();
    const { data: d } = await mark(k.b1.id, 4);
    const { data: exited } = await draws.exit(
      k.cycle.id,
      k.participants[3].id,
      {},
      actor,
    );
    expect([exited.profitEgp, exited.payoutEgp]).toEqual([
      '5000.00',
      '65000.00',
    ]);
    await undo(d.id);
    expect(await sharesOf(k.cycle.id)).toEqual([
      '9375.00',
      '9375.00',
      '6250.00',
      '5000.00',
    ]);
    const frozen = await prisma.cycleParticipant.findUniqueOrThrow({
      where: { id: k.participants[3].id },
    });
    expect(frozen.exitPaidEgp?.toFixed(2)).toBe('65000.00');
  });

  // ─── F. Leftovers moved to another cycle ────────────────────────────

  it('TC-DMG-23 Damage on a batch moved in is the receiving cycle’s loss, and the move can no longer be undone', async () => {
    const k = await cycleT1();
    const t4 = await prisma.importCycle.create({
      data: {
        code: `DMG4-${randomUUID().slice(0, 8)}`,
        originType: 'UAE_DIRECT',
        currency: 'EGP',
        status: 'SELLING',
      },
    });
    // The cycle has to be selling to give leftovers.
    await prisma.importCycle.update({
      where: { id: k.cycle.id },
      data: { status: 'SELLING' },
    });
    const { data: moved } = await transfers.create(
      k.cycle.id,
      {
        toCycleId: t4.id,
        reason: 'next cycle',
        lines: [{ productId: k.headset.id, qty: 20 }],
      },
      actor,
    );
    const dest = await prisma.inventoryBatch.findFirstOrThrow({
      where: { cycleId: t4.id },
    });
    const { data: d } = await mark(dest.id, 2);
    expect(d.costEgp).toBe('2500.00');
    expect(
      (await cycleWriteOffsEgp(prisma, t4.id)).damagedInStorage.toFixed(2),
    ).toBe('2500.00');
    expect(
      (await cycleWriteOffsEgp(prisma, k.cycle.id)).damagedInStorage.toFixed(2),
    ).toBe('0.00');
    expect(await profitOf(k.cycle.id)).toBe('30000.00');
    expect(await shelf(dest.id)).toEqual(['18', '18', '20']);
    expect(
      (await refusal(transfers.undo(moved.id, 'changed my mind', actor))).code,
    ).toBe('TRANSFER_UNITS_SOLD');
    // Even after the damage is undone: the batch has history of its own.
    await undo(d.id);
    expect(
      (await refusal(transfers.undo(moved.id, 'changed my mind', actor))).code,
    ).toBe('TRANSFER_UNITS_SOLD');

    // On the giving cycle, a damage of its own batch is its own loss.
    await mark(k.b1.id, 2);
    expect(await profitOf(k.cycle.id)).toBe('27500.00');
    expect(await shelf(k.b1.id)).toEqual(['38', '38', '100']);
  });

  // ─── G. Other interactions ──────────────────────────────────────────

  it('TC-DMG-24 A leg cost correction after a damage is refused LEG_COST_LOCKED_DAMAGED; once undone it is not locked by it', async () => {
    const k = await cycleT1({ sell: 0 });
    const { data: d } = await mark(k.b1.id, 4);
    const r = await refusal(
      shipping.updateLeg(k.leg.id, { costBasis: 'FLAT', amount: 5000 }, actor),
    );
    expect(r.code).toBe('LEG_COST_LOCKED_DAMAGED');
    expect(D((await batch(k.b1.id)).landedUnitCostEgp).toFixed(4)).toBe(
      '1250.0000',
    );
    await undo(d.id);
    await shipping.updateLeg(
      k.leg.id,
      { costBasis: 'FLAT', amount: 6000 },
      actor,
    );
    // Re-costed with the leg: the headset now costs more than 1,250.
    expect(D((await batch(k.b1.id)).landedUnitCostEgp).gt(1250)).toBe(true);
  });

  it('TC-DMG-25 Low stock: a damage that takes the shelf under the minimum alerts the partners', async () => {
    const k = await cycleT1();
    await prisma.product.update({
      where: { id: k.headset.id },
      data: { minStock: 58 },
    });
    notify.mockClear();
    await mark(k.b1.id, 1); // 59: not low.
    expect(notify).not.toHaveBeenCalled();
    await mark(k.b1.id, 3); // 56: low.
    expect(notify).toHaveBeenCalled();
  });

  it('TC-DMG-02 the damage that takes a line’s last units takes the rounding residual: sold cost + damages = the line’s cost exactly', async () => {
    const k = await cycleT1({ sell: 0 });
    // 1,000 a line of 3 pieces at 333.3333: make a line that does not divide.
    const tag = randomUUID().slice(0, 8);
    const odd = await prisma.product.create({
      data: { sku: `ODD-${tag}`, name: `Odd part ${tag}` },
    });
    const cycle = await prisma.importCycle.create({
      data: {
        code: `DMGR-${tag}`,
        originType: 'UAE_DIRECT',
        currency: 'EGP',
        status: 'ARRIVED_EGYPT',
      },
    });
    await prisma.cycleParticipant.create({
      data: {
        cycleId: cycle.id,
        participantType: 'CORE_PARTNER',
        partnerUserId: k.who[0].u.id,
        contributionAmount: 1000,
      },
    });
    const po = await prisma.purchaseOrder.create({
      data: {
        cycleId: cycle.id,
        supplierId: (await prisma.supplier.findFirstOrThrow()).id,
        reference: `PO-${tag}`,
        currency: 'EGP',
        fxRateToEgp: 1,
        orderedOn: new Date(`${daysAgo(30)}T00:00:00Z`),
        status: 'CONFIRMED',
      },
    });
    const item = await prisma.purchaseOrderItem.create({
      data: {
        purchaseOrderId: po.id,
        productId: odd.id,
        orderedQty: 3,
        unitPrice: '333.3333',
        lineTotal: 1000,
      },
    });
    const leg = await prisma.shippingLeg.create({
      data: {
        cycleId: cycle.id,
        sequence: 1,
        origin: 'Dubai, UAE',
        destination: 'Cairo, Egypt',
        departedOn: new Date(`${daysAgo(20)}T00:00:00Z`),
        status: 'IN_TRANSIT',
        costBasis: 'FLAT',
        amount: '0',
        amountEgp: '0',
      },
    });
    await prisma.shipmentDeparture.create({
      data: {
        legId: leg.id,
        departedOn: new Date(`${daysAgo(20)}T00:00:00Z`),
        lines: { create: [{ purchaseOrderItemId: item.id, qty: 3 }] },
      },
    });
    const { data: delivery } = await deliveries.recordDelivery(
      leg.id,
      {
        arrivedOn: daysAgo(12),
        lines: [{ purchaseOrderItemId: item.id, qty: 3 }],
      },
      actor,
    );
    const dl = delivery as unknown as { id: string; lines: { id: string }[] };
    await inventory.verifyStock(
      cycle.id,
      {
        deliveryId: dl.id,
        receivedOn: daysAgo(10),
        items: [{ deliveryLineId: dl.lines[0].id, receivedQty: 3 }],
      },
      actor,
    );
    const b = await prisma.inventoryBatch.findFirstOrThrow({
      where: { cycleId: cycle.id },
    });
    const booked = await prisma.financialTransaction.aggregate({
      where: { relatedType: 'PURCHASE_ORDER_ITEM', relatedId: item.id },
      _sum: { amount: true },
    });
    const first = (await mark(b.id, 1)).data;
    const second = (await mark(b.id, 1)).data;
    const last = (await mark(b.id, 1)).data;
    const total = D(first.costEgp).add(second.costEgp).add(last.costEgp);
    expect(total.toFixed(2)).toBe(D(booked._sum.amount ?? 0).toFixed(2));
  });
});
