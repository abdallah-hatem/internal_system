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
import { InventoryService } from '../inventory/inventory.service';
import { PaymentsService } from '../payments/payments.service';
import { SalesService } from '../sales/sales.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { LedgerService } from '../ledger/ledger.service';
import { ProfitDrawsService } from '../profit-draws/profit-draws.service';
import { SettlementsService } from './settlements.service';
import { quietRunningCosts } from '../../common/running-costs-quiet-spec';
import { businessToday } from '../../common/dates';

/**
 * Running costs shared to the selling cycles (BUSINESS_LOGIC §8, owner
 * 2026-11-08: "investor has to pay for everything as well, fuel, packaging
 * etc... its all one process"), against a real Postgres.
 *
 * An expense with no cycle is split equally over the cycles selling when it is
 * recorded, or waits for the next one to start selling; on each it is a cost
 * inside the cycle's profit, so every participant, investors included, bears
 * it by share. Built the way the business builds a cycle (CLAUDE.md §4).
 *
 *   INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/motorcycle_parts_<name> \
 *     npx jest running-cost-allocation.db --runInBand
 */
// eslint-disable-next-line no-restricted-properties -- an opt-in switch for a suite that must never run by default
const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;

const daysAgo = (n: number) =>
  new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

suite('running costs shared to the running cycles (Postgres)', () => {
  jest.setTimeout(60_000);

  let prisma: PrismaClient;
  let deliveries: DeliveriesService;
  let inventory: InventoryService;
  let sales: SalesService;
  let payments: PaymentsService;
  let settlements: SettlementsService;
  let analytics: AnalyticsService;
  let ledger: LedgerService;
  let draws: ProfitDrawsService;
  let cyclesService: CyclesService;
  let actor: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const db = prisma as unknown as PrismaService;
    const audit = { log: jest.fn() } as unknown as AuditService;
    const notifications = {
      createForMultipleUsers: jest.fn(),
      create: jest.fn(),
    } as unknown as NotificationsService;
    const costing = new CostingService(db);
    const cycles = new CyclesService(db, audit, notifications);
    cyclesService = cycles;
    deliveries = new DeliveriesService(
      db,
      audit,
      notifications,
      costing,
      cycles,
    );
    inventory = new InventoryService(db, audit, notifications, costing, cycles);
    payments = new PaymentsService(db, audit);
    sales = new SalesService(db, audit, payments, {
      createForMultipleUsers: () => Promise.resolve({ count: 0 }),
    });
    settlements = new SettlementsService(db, audit, costing);
    analytics = new AnalyticsService(db);
    ledger = new LedgerService(db, audit);
    draws = new ProfitDrawsService(db, audit, settlements);
    actor = (await partner('Actor')).id;
  });
  afterAll(async () => {
    // What these tests left waiting must not land on the next suite's cycles.
    await quietRunningCosts(prisma);
    await prisma.$disconnect();
  });

  // Nothing another test left selling or waiting may land on this one's cycles.
  beforeEach(() => quietRunningCosts(prisma, { closeSelling: true }));

  // ─── Fixtures ───────────────────────────────────────────────────────

  async function partner(name: string) {
    const tag = randomUUID().slice(0, 8);
    return prisma.user.create({
      data: {
        email: `rc-${name.toLowerCase()}-${tag}@example.test`,
        passwordHash: 'x',
        role: 'CORE_PARTNER',
        partner: { create: { displayName: `${name} ${tag}` } },
      },
    });
  }

  /**
   * A cycle with two core partners (1,000 each) and a temporary investor
   * (2,000): 40 ordered at 100, a 400 leg, all delivered (110 a unit
   * landed). `sell()` checks the stock in — the cycle walks to Selling — and
   * sells 10 at 200 (profit 900), paid in full.
   */
  async function cycle() {
    const tag = randomUUID().slice(0, 8);
    const a = await partner('A');
    const b = await partner('B');
    const investor = await prisma.user.create({
      data: {
        email: `rc-inv-${tag}@example.test`,
        passwordHash: 'x',
        role: 'TEMP_INVESTOR',
      },
    });
    const c = await prisma.importCycle.create({
      data: {
        code: `RC-${tag}`,
        originType: 'UAE_DIRECT',
        currency: 'EGP',
        status: 'ARRIVED_EGYPT',
      },
    });
    const joined = Date.now() - 60_000;
    const rows = [
      { participantType: 'CORE_PARTNER', partnerUserId: a.id, amount: 1000 },
      { participantType: 'CORE_PARTNER', partnerUserId: b.id, amount: 1000 },
      {
        participantType: 'TEMP_INVESTOR',
        investorUserId: investor.id,
        amount: 2000,
      },
    ];
    const participants = [];
    for (const [i, r] of rows.entries()) {
      participants.push(
        await prisma.cycleParticipant.create({
          data: {
            cycleId: c.id,
            participantType: r.participantType as never,
            partnerUserId: r.partnerUserId ?? null,
            investorUserId: r.investorUserId ?? null,
            contributionAmount: r.amount,
            createdAt: new Date(joined + i * 1000),
            updatedAt: new Date(joined + i * 1000),
          },
        }),
      );
    }
    const supplier = await prisma.supplier.create({
      data: { name: `RC ${tag}`, country: 'AE' },
    });
    const product = await prisma.product.create({
      data: { sku: `RC-${tag}`, name: `RC part ${tag}` },
    });
    const po = await prisma.purchaseOrder.create({
      data: {
        cycleId: c.id,
        supplierId: supplier.id,
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
        productId: product.id,
        orderedQty: 40,
        unitPrice: 100,
        lineTotal: 4000,
      },
    });
    const leg = await prisma.shippingLeg.create({
      data: {
        cycleId: c.id,
        sequence: 1,
        origin: 'Dubai, UAE',
        destination: 'Cairo, Egypt',
        departedOn: new Date(`${daysAgo(20)}T00:00:00Z`),
        status: 'IN_TRANSIT',
        costBasis: 'FLAT',
        amount: 400,
        amountEgp: 400,
      },
    });
    await prisma.shipmentDeparture.create({
      data: {
        legId: leg.id,
        departedOn: new Date(`${daysAgo(20)}T00:00:00Z`),
        lines: { create: [{ purchaseOrderItemId: item.id, qty: 40 }] },
      },
    });
    const { data: delivery } = await deliveries.recordDelivery(
      leg.id,
      {
        arrivedOn: daysAgo(5),
        lines: [{ purchaseOrderItemId: item.id, qty: 40 }],
      },
      actor,
    );
    const d = delivery as unknown as { id: string; lines: { id: string }[] };
    const sell = async () => {
      await inventory.verifyStock(
        c.id,
        {
          deliveryId: d.id,
          items: [{ deliveryLineId: d.lines[0].id, receivedQty: 40 }],
        },
        actor,
      );
      const shop = await prisma.customer.create({
        data: {
          type: 'B2B',
          displayName: `RC shop ${tag}`,
          verificationStatus: 'VERIFIED',
        },
      });
      await sales.create(
        {
          customerId: shop.id,
          channel: 'B2B',
          currency: 'EGP',
          items: [{ productId: product.id, quantity: 10, unitPrice: 200 }],
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
          amount: 2000,
          currency: 'EGP',
          orderId: order.id,
        },
        actor,
      );
    };
    return { cycle: c, a, b, investor, participants, sell };
  }

  async function sellingCycle() {
    const made = await cycle();
    await made.sell();
    return made;
  }

  const spend = (amount: number, extra: Record<string, unknown> = {}) =>
    ledger.create(
      {
        kind: 'EXPENSE',
        category: 'rent',
        amount,
        currency: 'EGP',
        ...extra,
      },
      actor,
    );

  const partsOf = async (costEntryId: string) =>
    (
      await prisma.runningCostAllocation.findMany({
        where: { costEntryId },
        include: { cycle: { select: { id: true } } },
        orderBy: { createdAt: 'asc' },
      })
    ).map((p) => [p.cycle.id, Number(p.amountEgp).toFixed(2)]);

  const profitOf = async (cycleId: string) =>
    (await settlements.project(cycleId))!.pnl.grossProfit.toFixed(2);

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

  // ─── Where a running cost goes ──────────────────────────────────────

  it('one cycle selling: the whole cost is its own, off its profit', async () => {
    const { cycle: c } = await sellingCycle();
    expect(await profitOf(c.id)).toBe('900.00');
    const { data } = await spend(300);
    expect(await partsOf(data.id)).toEqual([[c.id, '300.00']]);
    expect(await profitOf(c.id)).toBe('600.00');
    const costs = (await settlements.project(c.id))!.costLines;
    expect(costs).toContainEqual({
      kind: 'shared',
      category: 'rent',
      amountEgp: '300.00',
    });
  });

  it('two selling: split equally to the piastre, the odd one on the last; a piastre is one part, not two', async () => {
    const one = await sellingCycle();
    const two = await sellingCycle();
    const { data: even } = await spend(1000);
    expect(await partsOf(even.id)).toEqual([
      [one.cycle.id, '500.00'],
      [two.cycle.id, '500.00'],
    ]);
    const { data: odd } = await spend(100.01);
    expect(await partsOf(odd.id)).toEqual([
      [one.cycle.id, '50.00'],
      [two.cycle.id, '50.01'],
    ]);
    const { data: tiny } = await spend(0.01);
    expect(await partsOf(tiny.id)).toEqual([[two.cycle.id, '0.01']]);
  });

  /** A cycle in `status` with one core partner who put in 1,000 — nothing bought yet. */
  async function bareCycle(status: string) {
    const p = await partner('Bare');
    const c = await prisma.importCycle.create({
      data: {
        code: `RCB-${randomUUID().slice(0, 8)}`,
        originType: 'UAE_DIRECT',
        currency: 'EGP',
        status: status as never,
        startedOn: new Date(`${daysAgo(40)}T00:00:00Z`),
      },
    });
    await prisma.cycleParticipant.create({
      data: {
        cycleId: c.id,
        participantType: 'CORE_PARTNER',
        partnerUserId: p.id,
        contributionAmount: 1000,
        createdAt: new Date(Date.now() - 60_000),
        updatedAt: new Date(Date.now() - 60_000),
      },
    });
    return c;
  }

  it('shared from the moment the goods are paid for: Preparing, in transit, arrived, selling — not before, not once settling', async () => {
    const byStatus: Record<string, { id: string }> = {};
    for (const status of [
      'PLANNING',
      'FUNDING',
      'PURCHASING',
      'PREPARING',
      'IN_TRANSIT',
      'ARRIVED_UAE',
      'IN_TRANSIT_TO_EGYPT',
      'ARRIVED_EGYPT',
      'VERIFICATION',
      'SELLING',
      'SETTLEMENT',
      'CLOSED',
      'CANCELLED',
    ]) {
      byStatus[status] = await bareCycle(status);
    }
    const { data } = await spend(700);
    const parts = await partsOf(data.id);
    const running = [
      'PREPARING',
      'IN_TRANSIT',
      'ARRIVED_UAE',
      'IN_TRANSIT_TO_EGYPT',
      'ARRIVED_EGYPT',
      'VERIFICATION',
      'SELLING',
    ];
    expect(parts.map((p) => p[0]).sort()).toEqual(
      running.map((s) => byStatus[s].id).sort(),
    );
    // 700 in seven: 100 each, nothing lost.
    expect(parts.map((p) => p[1])).toEqual(Array(7).fill('100.00'));
  });

  it('none paid for yet: it waits, then goes whole to the cycle whose order is paid next', async () => {
    const waiting = await bareCycle('PURCHASING');
    // What was ordered: one draft order with a line, as Preparing needs.
    const tag = randomUUID().slice(0, 8);
    const supplier = await prisma.supplier.create({
      data: { name: `RCB ${tag}`, country: 'AE' },
    });
    const product = await prisma.product.create({
      data: { sku: `RCB-${tag}`, name: `RCB part ${tag}` },
    });
    await prisma.purchaseOrder.create({
      data: {
        cycleId: waiting.id,
        supplierId: supplier.id,
        reference: `PO-${tag}`,
        currency: 'EGP',
        fxRateToEgp: 1,
        orderedOn: new Date(`${daysAgo(5)}T00:00:00Z`),
        status: 'DRAFT',
        items: {
          create: [
            {
              productId: product.id,
              orderedQty: 5,
              unitPrice: 100,
              lineTotal: 500,
            },
          ],
        },
      },
    });
    const range = { from: daysAgo(10), to: businessToday() };
    const before = Number(
      (await settlements.runningCosts(range)).data.waitingEgp,
    );
    const { data } = await spend(450, { occurredOn: daysAgo(3) });
    expect(await partsOf(data.id)).toEqual([]);
    const page = await settlements.runningCosts(range);
    // Waiting by exactly this cost; shared to no cycle yet.
    expect(Number(page.data.waitingEgp) - before).toBeCloseTo(450, 2);
    expect(page.data.cycles.map((x) => x.cycleId)).not.toContain(waiting.id);
    // The order is confirmed and paid: the cycle moves to Preparing.
    await cyclesService.transition(waiting.id, 'PREPARING', actor);
    expect(await partsOf(data.id)).toEqual([[waiting.id, '450.00']]);
    expect(await profitOf(waiting.id)).toBe('-450.00');
    const after = await settlements.runningCosts(range);
    expect(Number(after.data.waitingEgp)).toBeCloseTo(before, 2);
    expect(
      after.data.cycles.find((x) => x.cycleId === waiting.id),
    ).toMatchObject({ sharedEgp: '450.00' });
  });

  it('a cycle being settled takes no new cost: it goes to the one still selling, or waits', async () => {
    const settling = await sellingCycle();
    const calc = (await settlements.calculate(settling.cycle.id, actor)).data!;
    await settlements.approve(calc.id, actor);
    const { data: first } = await spend(200);
    expect(await partsOf(first.id)).toEqual([]); // waits
    const other = await sellingCycle();
    expect(await partsOf(first.id)).toEqual([[other.cycle.id, '200.00']]);
    const { data: second } = await spend(80);
    expect(await partsOf(second.id)).toEqual([[other.cycle.id, '80.00']]);
  });

  it('a cost charged to a cycle, and income, are never shared', async () => {
    const { cycle: c } = await sellingCycle();
    const { data: freight } = await ledger.create(
      {
        kind: 'EXPENSE',
        category: 'extra_freight',
        amount: 100,
        currency: 'EGP',
        cycleId: c.id,
      },
      actor,
    );
    const { data: income } = await ledger.create(
      {
        kind: 'OTHER_INCOME',
        category: 'other_income',
        amount: 50,
        currency: 'EGP',
      },
      actor,
    );
    expect(await partsOf(freight.id)).toEqual([]);
    expect(await partsOf(income.id)).toEqual([]);
  });

  // ─── Everyone bears it, by share ────────────────────────────────────

  it('the investor bears his share: every payout lower by its share of the cost, none charged on the side', async () => {
    const before = await sellingCycle();
    const plain = (await settlements.calculate(before.cycle.id, actor)).data!;
    const shareOf = (s: typeof plain, participantId: string) =>
      Number(
        s.lines.find(
          (l) =>
            l.participantId === participantId && l.component === 'PROFIT_SHARE',
        )!.amount,
      );
    // 900 split 1,000 / 1,000 / 2,000 — a quarter, a quarter, a half.
    expect(before.participants.map((p) => shareOf(plain, p.id))).toEqual([
      225, 225, 450,
    ]);
    await spend(400);
    const withRent = (await settlements.calculate(before.cycle.id, actor))
      .data!;
    expect(before.participants.map((p) => shareOf(withRent, p.id))).toEqual([
      125, 125, 250,
    ]);
    await settlements.approve(withRent.id, actor);
    await settlements.markPaid(withRent.id, actor, {
      acceptRemainingStock: true,
    });
    // No partners-only deduction any more.
    const lines = await prisma.settlementLine.findMany({
      where: { settlementId: withRent.id, component: 'RUNNING_COSTS' },
    });
    expect(lines).toHaveLength(0);
    expect(
      await prisma.financialTransaction.count({
        where: { relatedId: withRent.id, category: 'running_cost_share' },
      }),
    ).toBe(0);
    const paid = await prisma.financialTransaction.findMany({
      where: { relatedId: withRent.id, type: 'SETTLEMENT_PAYOUT' },
    });
    // Capital back plus the profit after rent: 1,125 / 1,125 / 2,250.
    expect(paid.map((r) => Number(r.amount)).sort((x, y) => x - y)).toEqual([
      1125, 1125, 2250,
    ]);
  });

  it('every reader agrees: the settlement, the cycle in Analytics, and the profit a partner may take', async () => {
    const { cycle: c, a } = await sellingCycle();
    await spend(300);
    const settled = (await settlements.preview(c.id)).data;
    const cycles = (await analytics.getCycleProfitability()).data;
    const mine = cycles.find((x) => x.cycleId === c.id)!;
    expect(settled.grossProfitEgp).toBe('600.00');
    expect(mine.profit).toBe(600);
    expect(mine.expensesEgp).toBe(300);
    const room = (await draws.forCycle(c.id)).data.partners.find(
      (p) => p.partnerUserId === a.id,
    )!;
    expect(room.shareOfCollectedEgp).toBe('150.00'); // a quarter of 600
  });

  it('the business’s own profit counts the cost once, not once per cycle', async () => {
    await sellingCycle();
    await sellingCycle();
    const before = (await analytics.getProfitAndLoss()).data.expensesEgp;
    await spend(1000);
    const after = (await analytics.getProfitAndLoss()).data.expensesEgp;
    expect(after - before).toBe(1000);
  });

  // ─── Undo, and the second time ──────────────────────────────────────

  it('undoing a cost takes its parts off; once a cycle is being settled it is refused until that is reversed', async () => {
    const { cycle: c } = await sellingCycle();
    const { data: first } = await spend(250);
    await ledger.reverse(first.id, 'wrong month', actor);
    expect(await partsOf(first.id)).toEqual([]);
    expect(await profitOf(c.id)).toBe('900.00');
    // Undone, it is not shared again when another cycle starts selling.
    await sellingCycle();
    expect(await partsOf(first.id)).toEqual([]);

    const { data: second } = await spend(150);
    const calc = (await settlements.calculate(c.id, actor)).data!;
    await settlements.approve(calc.id, actor);
    const r = await refusal(ledger.reverse(second.id, 'wrong month', actor));
    expect(r).toMatchObject({
      code: 'RUNNING_COST_SETTLED',
      params: { cycles: c.code },
    });
    expect(await partsOf(second.id)).not.toEqual([]);
    await settlements.reverse(calc.id, 'recount', actor);
    await ledger.reverse(second.id, 'wrong month', actor);
    expect(await partsOf(second.id)).toEqual([]);
  });

  it('a draft calculated before a cost was shared to it, or before one was undone, is stale', async () => {
    const { cycle: c } = await sellingCycle();
    const draft = (await settlements.calculate(c.id, actor)).data!;
    const { data } = await spend(120);
    expect((await refusal(settlements.approve(draft.id, actor))).code).toBe(
      'SETTLEMENT_STALE_COSTS',
    );
    const redo = (await settlements.calculate(c.id, actor)).data!;
    await ledger.reverse(data.id, 'typo', actor);
    expect((await refusal(settlements.approve(redo.id, actor))).code).toBe(
      'SETTLEMENT_STALE_COSTS',
    );
    const third = (await settlements.calculate(c.id, actor)).data!;
    await settlements.approve(third.id, actor);
  });

  it('a settlement reversed: the cycle sells again and takes what waited meanwhile', async () => {
    const { cycle: c } = await sellingCycle();
    const id = (await settlements.calculate(c.id, actor)).data!.id;
    await settlements.approve(id, actor);
    const { data } = await spend(90);
    expect(await partsOf(data.id)).toEqual([]);
    await settlements.reverse(id, 'recount', actor);
    expect(await partsOf(data.id)).toEqual([[c.id, '90.00']]);
  });

  it('two costs recorded at once over two selling cycles: each shared once, never twice', async () => {
    const one = await sellingCycle();
    const two = await sellingCycle();
    const made = await Promise.all([spend(10), spend(20), spend(30)]);
    for (const m of made) {
      const parts = await partsOf(m.data.id);
      expect(parts.map((p) => p[0])).toEqual([one.cycle.id, two.cycle.id]);
    }
    expect(
      await prisma.runningCostAllocation.count({
        where: { costEntryId: { in: made.map((m) => m.data.id) } },
      }),
    ).toBe(6);
  });

  it('a cost a partner paid from his own pocket is shared like any other', async () => {
    const { cycle: c, a } = await sellingCycle();
    const { data } = await spend(60, { paidByUserId: a.id });
    expect(await partsOf(data.id)).toEqual([[c.id, '60.00']]);
  });

  it('a cost taken from the partners’ payouts the old way is never shared again', async () => {
    const old = await sellingCycle();
    const id = (await settlements.calculate(old.cycle.id, actor)).data!.id;
    await settlements.approve(id, actor); // nothing selling now
    const { data } = await spend(70);
    // As the old Mark paid wrote it: a standing charge on that settlement.
    await prisma.runningCostCharge.create({
      data: {
        costEntryId: data.id,
        settlementId: id,
        participantId: old.participants[0].id,
        partnerUserId: old.a.id,
        amount: 70,
      },
    });
    const next = await sellingCycle();
    expect(await partsOf(data.id)).toEqual([]);
    expect(await profitOf(next.cycle.id)).toBe('900.00');
  });
});
