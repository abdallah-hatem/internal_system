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
import { SettlementsService } from '../settlements/settlements.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { LedgerService } from '../ledger/ledger.service';
import { cashPosition } from '../../common/cash-position';
import { businessToday } from '../../common/dates';
import { ProfitDrawsService } from './profit-draws.service';
import { quietRunningCosts } from '../../common/running-costs-quiet-spec';

/**
 * Profit taken before a cycle is settled (BUSINESS_LOGIC §8, owner
 * 2026-11-08), against a real Postgres: the limit, the locks, the settlement
 * taking draws off payouts, what is owed carried to the next payout, and
 * every undo — only honest there.
 *
 * Built the way the business builds it (CLAUDE.md §4): an order, a leg, a
 * departure, a delivery, a checked-in receipt, a confirmed sale and the
 * shop's payment, through the real services.
 *
 * Runs only against a THROWAWAY database (CLAUDE.md rule 6):
 *
 *   INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/motorcycle_parts_<name> \
 *     npx jest profit-draws.db --runInBand
 */
// eslint-disable-next-line no-restricted-properties -- an opt-in switch for a suite that must never run by default
const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;

const daysAgo = (n: number) =>
  new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const daysAhead = (n: number) =>
  new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

type Person = { id: string };

suite('profit taken before settlement (Postgres)', () => {
  // Analytics reads every cycle in the throwaway database; it grows run by run.
  jest.setTimeout(60_000);

  let prisma: PrismaClient;
  let draws: ProfitDrawsService;
  let deliveries: DeliveriesService;
  let inventory: InventoryService;
  let sales: SalesService;
  let payments: PaymentsService;
  let settlements: SettlementsService;
  let analytics: AnalyticsService;
  let ledger: LedgerService;
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
  afterAll(() => prisma.$disconnect());
  // A running cost another suite left waiting must not land on these cycles
  // (§8, 2026-11-08: shared to whatever is selling).
  beforeEach(() => quietRunningCosts(prisma));

  // ─── Fixtures ───────────────────────────────────────────────────────

  async function partner(name: string) {
    const tag = randomUUID().slice(0, 8);
    return prisma.user.create({
      data: {
        email: `draw-${name.toLowerCase()}-${tag}@example.test`,
        passwordHash: 'x',
        role: 'CORE_PARTNER',
        partner: { create: { displayName: `${name} ${tag}` } },
      },
    });
  }

  const trio = async () => [
    await partner('Abdallah'),
    await partner('Shady'),
    await partner('Fares'),
  ];

  /**
   * A cycle as the business makes it: three partners who put in 1,000 each,
   * 40 ordered at 100, a 400 leg, everything delivered and checked in (110 a
   * unit landed), and 10 sold at 200 to a verified shop — 900 of profit,
   * nothing paid yet. `split`: agreed percentages instead, with nothing put in.
   */
  async function tradedCycle(
    people?: Person[],
    opts: { split?: number[] } = {},
  ) {
    const who = people ?? (await trio());
    const tag = randomUUID().slice(0, 8);
    const cycle = await prisma.importCycle.create({
      data: {
        code: `DRAW-${tag}`,
        originType: 'UAE_DIRECT',
        currency: 'EGP',
        status: 'ARRIVED_EGYPT',
      },
    });
    const joined = Date.now() - 60_000;
    const participants = [];
    for (const [i, p] of who.entries()) {
      participants.push(
        await prisma.cycleParticipant.create({
          data: {
            cycleId: cycle.id,
            participantType: 'CORE_PARTNER',
            partnerUserId: p.id,
            contributionAmount: opts.split ? 0 : 1000,
            customProfitPct: opts.split ? opts.split[i] : null,
            createdAt: new Date(joined + i * 1000),
            updatedAt: new Date(joined + i * 1000),
          },
        }),
      );
    }
    const supplier = await prisma.supplier.create({
      data: { name: `Draw ${tag}`, country: 'AE' },
    });
    const product = await prisma.product.create({
      data: { sku: `DRAW-${tag}`, name: `Draw part ${tag}` },
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
    await inventory.verifyStock(
      cycle.id,
      {
        deliveryId: d.id,
        items: [{ deliveryLineId: d.lines[0].id, receivedQty: 40 }],
      },
      actor,
    );
    const shop = await prisma.customer.create({
      data: {
        type: 'B2B',
        displayName: `Draw shop ${tag}`,
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
    const pay = (amount: number) =>
      payments.create(
        { customerId: shop.id, amount, currency: 'EGP', orderId: order.id },
        actor,
      );
    return { cycle, people: who, participants, shop, order, product, pay };
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

  const take = (
    cycleId: string,
    who: Person,
    amountEgp: number,
    extra: Record<string, unknown> = {},
  ) =>
    draws.create(
      cycleId,
      { partnerUserId: who.id, amountEgp, ...extra },
      actor,
    );

  const roomOf = async (cycleId: string, who: Person) =>
    (await draws.forCycle(cycleId)).data.partners.find(
      (p) => p.partnerUserId === who.id,
    )!;

  const cashOnHand = async () =>
    (await cashPosition(prisma)).cashOnHand.toString();

  /** Every profit figure a reader sees — never moved by a draw. */
  async function profitFigures(cycleId: string) {
    // Cash out is cash, and a draw is cash out: checked on its own.
    const { cashOutEgp: _cash, ...pnl } = (await analytics.getProfitAndLoss())
      .data as Record<string, unknown>;
    void _cash;
    const cycles = (await analytics.getCycleProfitability()) as unknown as {
      data: { cycleId?: string; id?: string }[];
    };
    const projected = await settlements.project(cycleId);
    return JSON.stringify({
      pnl,
      cycle: (cycles.data ?? []).find(
        (c) => c.cycleId === cycleId || c.id === cycleId,
      ),
      profit: projected!.pnl.grossProfit.toFixed(2),
    });
  }

  async function settle(cycleId: string) {
    const calc = (await settlements.calculate(cycleId, actor)).data!;
    await settlements.approve(calc.id, actor);
    await settlements.markPaid(calc.id, actor, { acceptRemainingStock: true });
    return calc.id;
  }

  const payoutsOf = async (settlementId: string) => {
    const rows = await prisma.financialTransaction.findMany({
      where: {
        relatedType: 'SETTLEMENT',
        relatedId: settlementId,
        type: 'SETTLEMENT_PAYOUT',
      },
    });
    return rows
      .map((r) => `${r.direction} ${Number(r.amount).toFixed(2)}`)
      .sort();
  };

  // ─── The limit: his share of the profit already collected ───────────

  it('nothing collected, nothing to take: a confirmed sale the shop has not paid', async () => {
    const { cycle, people } = await tradedCycle();
    const { data } = await draws.forCycle(cycle.id);
    expect(data.profitEgp).toBe('900.00');
    expect(data.uncollectedEgp).toBe('2000.00');
    expect(data.collectedProfitEgp).toBe('0.00');
    expect(data.partners.map((p) => p.availableEgp)).toEqual([
      '0.00',
      '0.00',
      '0.00',
    ]);
    const r = await refusal(take(cycle.id, people[0], 0.01));
    expect(r.code).toBe('PROFIT_DRAW_OVER_AVAILABLE');
    expect(r.params).toMatchObject({ available: '0.00' });
  });

  it('a part payment collects the same share of the profit — the dashboard’s proportional reading', async () => {
    const { cycle, people, pay } = await tradedCycle();
    await pay(1000); // half the sale paid: half its 900 of profit is in
    let { data } = await draws.forCycle(cycle.id);
    expect(data).toMatchObject({
      salesEgp: '2000.00',
      salesPaidEgp: '1000.00',
      uncollectedEgp: '1000.00',
      sharePaidPct: '50.00',
      collectedProfitEgp: '450.00',
    });
    expect(data.partners.map((p) => p.shareOfCollectedEgp)).toEqual([
      '150.00',
      '150.00',
      '150.00',
    ]);
    await pay(500); // three quarters paid
    ({ data } = await draws.forCycle(cycle.id));
    expect(data.collectedProfitEgp).toBe('675.00');
    expect(data.partners.map((p) => p.shareOfCollectedEgp)).toEqual([
      '225.00',
      '225.00',
      '225.00',
    ]);
    expect(await refusal(take(cycle.id, people[0], 225.01))).toMatchObject({
      code: 'PROFIT_DRAW_OVER_AVAILABLE',
    });
    await take(cycle.id, people[0], 225);
    expect((await roomOf(cycle.id, people[0])).availableEgp).toBe('0.00');
  });

  it('an odd part payment: the share collected to the piastre, re-summing across partners', async () => {
    const { cycle, pay } = await tradedCycle();
    await pay(333.33); // 16.6665% of 2,000: 149.9985 of 900, 150.00 to the piastre
    const { data } = await draws.forCycle(cycle.id);
    expect(data.collectedProfitEgp).toBe('150.00');
    const shares = data.partners.map((p) => p.shareOfCollectedEgp);
    expect(shares).toEqual(['50.00', '50.00', '50.00']);
  });

  it('paid in full: each takes up to his share, to the piastre, and not a piastre more', async () => {
    const { cycle, people, pay } = await tradedCycle();
    await pay(2000);
    expect((await roomOf(cycle.id, people[0])).availableEgp).toBe('300.00');
    await take(cycle.id, people[0], 200);
    expect(await roomOf(cycle.id, people[0])).toMatchObject({
      drawnEgp: '200.00',
      availableEgp: '100.00',
    });
    const over = await refusal(take(cycle.id, people[0], 100.01));
    expect(over).toMatchObject({
      status: 400,
      code: 'PROFIT_DRAW_OVER_AVAILABLE',
      params: {
        available: '100.00',
        share: '300.00',
        drawn: '200.00',
        owed: '0.00',
      },
    });
    await take(cycle.id, people[0], 100);
    expect((await refusal(take(cycle.id, people[0], 0.01))).code).toBe(
      'PROFIT_DRAW_OVER_AVAILABLE',
    );
    // The others' room is untouched by his.
    expect((await roomOf(cycle.id, people[1])).availableEgp).toBe('300.00');
  });

  // Production runs one connection per request (prisma.service.ts, connection_limit 1). A read
  // made outside the draw's transaction waits for a connection the transaction holds: it hung
  // until the pool gave up, while this suite's larger pool hid it (CLAUDE LEARNINGS, P2028).
  it('records a draw on a single connection, as production does', async () => {
    const { cycle, people, pay } = await tradedCycle();
    await pay(2000);
    const one = new PrismaClient({
      datasources: {
        db: {
          url: `${url}${url!.includes('?') ? '&' : '?'}connection_limit=1&pool_timeout=5`,
        },
      },
    });
    try {
      const db = one as unknown as PrismaService;
      const audit = { log: jest.fn() } as unknown as AuditService;
      const single = new ProfitDrawsService(
        db,
        audit,
        new SettlementsService(db, audit, new CostingService(db)),
      );
      await expect(
        single.create(
          cycle.id,
          { partnerUserId: people[0].id, amountEgp: 100 },
          actor,
        ),
      ).resolves.toMatchObject({ data: { amountEgp: '100.00' } });
    } finally {
      await one.$disconnect();
    }
  });

  it('follows an agreed split, not equal thirds', async () => {
    const { cycle, people, pay } = await tradedCycle(undefined, {
      split: [50, 30, 20],
    });
    await pay(2000);
    const { data } = await draws.forCycle(cycle.id);
    expect(data.partners.map((p) => [p.sharePct, p.availableEgp])).toEqual([
      ['50.0000', '450.00'],
      ['30.0000', '270.00'],
      ['20.0000', '180.00'],
    ]);
    await take(cycle.id, people[0], 450);
    expect((await refusal(take(cycle.id, people[2], 180.01))).code).toBe(
      'PROFIT_DRAW_OVER_AVAILABLE',
    );
  });

  it('a cycle with no funding entered has no split to take a share of', async () => {
    const { cycle, people, pay } = await tradedCycle();
    await pay(2000);
    await prisma.cycleParticipant.updateMany({
      where: { cycleId: cycle.id },
      data: { contributionAmount: 0 },
    });
    expect((await draws.forCycle(cycle.id)).data.problem).toBe(
      'CYCLE_NOT_FUNDED',
    );
    expect((await refusal(take(cycle.id, people[0], 1))).code).toBe(
      'CYCLE_NOT_FUNDED',
    );
  });

  it('a cycle making a loss gives nothing to take', async () => {
    const { cycle, people, pay } = await tradedCycle();
    await pay(2000);
    await ledger.create(
      {
        kind: 'EXPENSE',
        category: 'extra_freight',
        amount: 1500,
        currency: 'EGP',
        cycleId: cycle.id,
      },
      actor,
    );
    const { data } = await draws.forCycle(cycle.id);
    expect(data.profitEgp).toBe('-600.00');
    expect(data.collectedProfitEgp).toBe('0.00');
    expect((await refusal(take(cycle.id, people[0], 1))).code).toBe(
      'PROFIT_DRAW_OVER_AVAILABLE',
    );
  });

  // ─── The amount, the day, the person ────────────────────────────────

  it('refuses zero, negative, not-a-number, three decimals and absurd amounts', async () => {
    const { cycle, people, pay } = await tradedCycle();
    await pay(2000);
    for (const amount of [0, -1, -0.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect((await refusal(take(cycle.id, people[0], amount))).code).toBe(
        'PROFIT_DRAW_AMOUNT_NOT_POSITIVE',
      );
    }
    expect(
      (await refusal(take(cycle.id, people[0], 'abc' as unknown as number)))
        .code,
    ).toBe('PROFIT_DRAW_AMOUNT_NOT_POSITIVE');
    expect((await refusal(take(cycle.id, people[0], 10.005))).code).toBe(
      'PROFIT_DRAW_AMOUNT_PRECISION',
    );
    expect((await refusal(take(cycle.id, people[0], 1e20))).code).toBe(
      'PROFIT_DRAW_AMOUNT_NOT_POSITIVE',
    );
    expect(
      await prisma.profitDraw.count({ where: { cycleId: cycle.id } }),
    ).toBe(0);
  });

  it('refuses a day that has not come, and keeps a past one', async () => {
    const { cycle, people, pay } = await tradedCycle();
    await pay(2000);
    const r = await refusal(
      take(cycle.id, people[0], 10, { drawnOn: daysAhead(1) }),
    );
    expect(r).toMatchObject({
      code: 'DATE_IN_FUTURE',
      params: { label: 'PROFIT_DRAWN' },
    });
    await take(cycle.id, people[0], 10, { drawnOn: daysAgo(2) });
    const { data } = await draws.forCycle(cycle.id);
    expect(data.draws[0].drawnOn).toBe(daysAgo(2));
    const row = await prisma.financialTransaction.findFirstOrThrow({
      where: { relatedType: 'PROFIT_DRAW', relatedId: data.draws[0].id },
    });
    expect(row.occurredOn!.toISOString().slice(0, 10)).toBe(daysAgo(2));
  });

  it('only a core partner on the cycle: not an outsider, an investor, a stranger or a typo', async () => {
    const { cycle, pay } = await tradedCycle();
    await pay(2000);
    const outsider = await partner('Outsider');
    expect(await refusal(take(cycle.id, outsider, 10))).toMatchObject({
      code: 'PROFIT_DRAW_NOT_ON_CYCLE',
    });
    const investor = await prisma.user.create({
      data: {
        email: `draw-investor-${randomUUID().slice(0, 8)}@example.test`,
        passwordHash: 'x',
        role: 'TEMP_INVESTOR',
      },
    });
    await prisma.cycleParticipant.create({
      data: {
        cycleId: cycle.id,
        participantType: 'TEMP_INVESTOR',
        investorUserId: investor.id,
        contributionAmount: 0,
        createdAt: new Date(Date.now() - 30_000),
        updatedAt: new Date(Date.now() - 30_000),
      },
    });
    expect(await refusal(take(cycle.id, investor, 10))).toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
    expect(
      await refusal(take(cycle.id, { id: randomUUID() }, 10)),
    ).toMatchObject({
      status: 404,
    });
    expect(
      await refusal(take(cycle.id, { id: 'not-a-uuid' }, 10)),
    ).toMatchObject({
      status: 404,
    });
    expect(
      await refusal(
        draws.create(
          'CYC-1',
          { partnerUserId: outsider.id, amountEgp: 1 },
          actor,
        ),
      ),
    ).toMatchObject({ status: 404 });
    expect(
      await refusal(
        draws.create(
          randomUUID(),
          { partnerUserId: outsider.id, amountEgp: 1 },
          actor,
        ),
      ),
    ).toMatchObject({ status: 404 });
  });

  // ─── Money: cash moves, profit does not ─────────────────────────────

  it('a draw takes cash on hand down by exactly its amount and moves no profit figure', async () => {
    const { cycle, people, pay } = await tradedCycle();
    await pay(2000);
    const profitBefore = await profitFigures(cycle.id);
    const cashBefore = Number(await cashOnHand());
    const cashOutBefore = (await analytics.getProfitAndLoss()).data.cashOutEgp;
    const { data } = await take(cycle.id, people[1], 250.5);
    expect(Number(await cashOnHand())).toBeCloseTo(cashBefore - 250.5, 2);
    expect(await profitFigures(cycle.id)).toBe(profitBefore);
    expect((await analytics.getProfitAndLoss()).data.cashOutEgp).toBeCloseTo(
      cashOutBefore + 250.5,
      2,
    );
    const row = await prisma.financialTransaction.findFirstOrThrow({
      where: { relatedType: 'PROFIT_DRAW', relatedId: data.id },
    });
    expect(row).toMatchObject({
      type: 'PROFIT_DRAW',
      category: 'profit_draw',
      direction: 'OUTFLOW',
      currency: 'EGP',
      cycleId: cycle.id,
    });
    expect(Number(row.amount)).toBe(250.5);
  });

  it('the ledger will not undo a draw’s row on its own', async () => {
    const { cycle, people, pay } = await tradedCycle();
    await pay(2000);
    const { data } = await take(cycle.id, people[0], 50);
    const row = await prisma.financialTransaction.findFirstOrThrow({
      where: { relatedType: 'PROFIT_DRAW', relatedId: data.id },
    });
    expect((await refusal(ledger.reverse(row.id, 'oops', actor))).code).toBe(
      'ENTRY_OWNED_ELSEWHERE',
    );
  });

  it('two draws at once cannot both pass the limit', async () => {
    const { cycle, people, pay } = await tradedCycle();
    await pay(2000);
    const results = await Promise.allSettled([
      take(cycle.id, people[0], 200),
      take(cycle.id, people[0], 200),
      take(cycle.id, people[0], 200),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await roomOf(cycle.id, people[0])).drawnEgp).toBe('200.00');
  });

  // ─── Undo ───────────────────────────────────────────────────────────

  it('undo: a reason, once; cash comes back and the room opens again', async () => {
    const { cycle, people, pay } = await tradedCycle();
    await pay(2000);
    const cashBefore = Number(await cashOnHand());
    const { data } = await take(cycle.id, people[0], 300);
    for (const reason of ['', '   ']) {
      expect(
        (await refusal(draws.reverse(data.id, { reason }, actor))).code,
      ).toBe('PROFIT_DRAW_REASON_REQUIRED');
    }
    await draws.reverse(data.id, { reason: 'typed the wrong partner' }, actor);
    expect(Number(await cashOnHand())).toBeCloseTo(cashBefore, 2);
    expect((await roomOf(cycle.id, people[0])).availableEgp).toBe('300.00');
    expect(
      (await refusal(draws.reverse(data.id, { reason: 'again' }, actor))).code,
    ).toBe('PROFIT_DRAW_ALREADY_REVERSED');
    const pair = await prisma.financialTransaction.findMany({
      where: { relatedType: 'PROFIT_DRAW', relatedId: data.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(pair.map((r) => [r.type, r.direction])).toEqual([
      ['PROFIT_DRAW', 'OUTFLOW'],
      ['PROFIT_DRAW_REVERSAL', 'INFLOW'],
    ]);
    expect(pair[1].reversalOfId).toBe(pair[0].id);
    // The undone draw stays listed, marked.
    const listed = (await draws.forCycle(cycle.id)).data.draws;
    expect(listed[0]).toMatchObject({
      id: data.id,
      reversalReason: 'typed the wrong partner',
    });
    expect(listed[0].reversedAt).not.toBeNull();
    expect(
      await refusal(draws.reverse(randomUUID(), { reason: 'x' }, actor)),
    ).toMatchObject({ status: 404 });
    expect(
      await refusal(draws.reverse('nope', { reason: 'x' }, actor)),
    ).toMatchObject({ status: 404 });
  });

  // ─── Settlement ─────────────────────────────────────────────────────

  it('settlement takes his draw off his payout; what the business pays in all is unchanged', async () => {
    const { cycle, people, pay } = await tradedCycle();
    await pay(2000);
    const cashStart = Number(await cashOnHand());
    await take(cycle.id, people[0], 200);
    const id = await settle(cycle.id);
    // 1,000 back + 300 profit each; his 200 already taken.
    expect(await payoutsOf(id)).toEqual([
      'OUTFLOW 1100.00',
      'OUTFLOW 1300.00',
      'OUTFLOW 1300.00',
    ]);
    // Cash out in all: 3,900, the same as had nobody taken anything early.
    expect(Number(await cashOnHand())).toBeCloseTo(cashStart - 3900, 2);
    const { data } = await settlements.findOne(id);
    const mine = data.breakdown!.participants.find(
      (p) =>
        p.participantId ===
        data.lines.find((l) => l.participant.partnerUserId === people[0].id)!
          .participantId,
    )!;
    expect(mine).toMatchObject({
      profitShareEgp: '300.00',
      capitalBackEgp: '1000.00',
      profitDrawnEgp: '-200.00',
      owedEgp: '0.00',
      paidEgp: '1100.00',
    });
    // Settled: the draw is the payout's now.
    const drawRow = await prisma.profitDraw.findFirstOrThrow({
      where: { cycleId: cycle.id },
    });
    expect(drawRow.settledById).toBe(id);
    expect(
      (await refusal(draws.reverse(drawRow.id, { reason: 'x' }, actor))).code,
    ).toBe('PROFIT_DRAW_SETTLED');
    expect((await refusal(take(cycle.id, people[1], 1))).code).toBe(
      'PROFIT_DRAW_CYCLE_LOCKED',
    );
  });

  it('no draw and no undo once the settlement is approved', async () => {
    const { cycle, people, pay } = await tradedCycle();
    await pay(2000);
    const { data: drawn } = await take(cycle.id, people[0], 100);
    const calc = (await settlements.calculate(cycle.id, actor)).data!;
    // A draft does not lock: but it goes stale (below).
    await settlements.approve(calc.id, actor);
    expect(await refusal(take(cycle.id, people[1], 1))).toMatchObject({
      code: 'PROFIT_DRAW_CYCLE_LOCKED',
    });
    expect(
      (await refusal(draws.reverse(drawn.id, { reason: 'x' }, actor))).code,
    ).toBe('PROFIT_DRAW_CYCLE_LOCKED');
    expect((await draws.forCycle(cycle.id)).data.locked).toBe(
      'SETTLEMENT_APPROVED',
    );
  });

  it('a draft calculated before a draw, or before an undo, is stale until calculated again', async () => {
    const { cycle, people, pay } = await tradedCycle();
    await pay(2000);
    const first = (await settlements.calculate(cycle.id, actor)).data!;
    const { data: drawn } = await take(cycle.id, people[2], 150);
    expect((await refusal(settlements.approve(first.id, actor))).code).toBe(
      'SETTLEMENT_STALE_DRAWS',
    );
    const second = (await settlements.calculate(cycle.id, actor)).data!;
    await draws.reverse(drawn.id, { reason: 'changed his mind' }, actor);
    expect((await refusal(settlements.approve(second.id, actor))).code).toBe(
      'SETTLEMENT_STALE_DRAWS',
    );
    const third = (await settlements.calculate(cycle.id, actor)).data!;
    await settlements.approve(third.id, actor);
    await settlements.markPaid(third.id, actor, { acceptRemainingStock: true });
    expect(await payoutsOf(third.id)).toEqual([
      'OUTFLOW 1300.00',
      'OUTFLOW 1300.00',
      'OUTFLOW 1300.00',
    ]);
  });

  it('reversing a paid settlement frees its draws: undoable again, taken off the next settlement', async () => {
    const { cycle, people, pay } = await tradedCycle();
    await pay(2000);
    const { data: drawn } = await take(cycle.id, people[1], 120);
    const id = await settle(cycle.id);
    await settlements.reverse(id, 'recount', actor);
    expect(
      (await prisma.profitDraw.findUniqueOrThrow({ where: { id: drawn.id } }))
        .settledById,
    ).toBeNull();
    // Settled again: taken off once more, not twice and not forgotten.
    const again = await settle(cycle.id);
    expect(await payoutsOf(again)).toEqual([
      'OUTFLOW 1180.00',
      'OUTFLOW 1300.00',
      'OUTFLOW 1300.00',
    ]);
    await settlements.reverse(again, 'recount', actor);
    await draws.reverse(drawn.id, { reason: 'he paid it back' }, actor);
    const third = await settle(cycle.id);
    expect(await payoutsOf(third)).toEqual([
      'OUTFLOW 1300.00',
      'OUTFLOW 1300.00',
      'OUTFLOW 1300.00',
    ]);
  });

  // ─── Taking more than the payout: owed, carried to the next one ─────

  it('took more than his payout came to: no cash in, owed, taken off his next payout on another cycle', async () => {
    // An agreed split and nothing put in: his payout is his profit alone.
    const people = await trio();
    const one = await tradedCycle(people, { split: [50, 25, 25] });
    await one.pay(2000);
    await take(one.cycle.id, people[0], 450); // all of his half of 900
    // Then the cycle's profit is wiped out by a late freight bill.
    await ledger.create(
      {
        kind: 'EXPENSE',
        category: 'extra_freight',
        amount: 900,
        currency: 'EGP',
        cycleId: one.cycle.id,
      },
      actor,
    );
    const cashBefore = Number(await cashOnHand());
    const firstId = await settle(one.cycle.id);
    // Nobody is paid anything, and no cash is pretended in from him.
    expect(await payoutsOf(firstId)).toEqual([]);
    expect(Number(await cashOnHand())).toBeCloseTo(cashBefore, 2);
    const owed = await prisma.profitDraw.findFirstOrThrow({
      where: { carriedFromSettlementId: firstId },
    });
    expect(owed).toMatchObject({
      kind: 'CARRIED',
      cycleId: null,
      partnerUserId: people[0].id,
    });
    expect(Number(owed.amountEgp)).toBe(450);
    expect(
      (await refusal(draws.reverse(owed.id, { reason: 'x' }, actor))).code,
    ).toBe('PROFIT_DRAW_CARRIED_NOT_REVERSIBLE');
    const { data: s1 } = await settlements.findOne(firstId);
    const hisLine = s1.breakdown!.participants.find(
      (p) => p.participantId === one.participants[0].id,
    )!;
    expect(hisLine).toMatchObject({
      profitDrawnEgp: '-450.00',
      owedEgp: '450.00',
      paidEgp: '0.00',
    });

    // On his next cycle what he owes comes first.
    const two = await tradedCycle(people);
    await two.pay(2000);
    expect(await roomOf(two.cycle.id, people[0])).toMatchObject({
      shareOfCollectedEgp: '300.00',
      owedEgp: '450.00',
      availableEgp: '0.00',
    });
    expect((await refusal(take(two.cycle.id, people[0], 1))).code).toBe(
      'PROFIT_DRAW_OVER_AVAILABLE',
    );
    const secondId = await settle(two.cycle.id);
    // 1,000 + 300 − 450 owed = 850 to him; the others 1,300.
    expect(await payoutsOf(secondId)).toEqual([
      'OUTFLOW 1300.00',
      'OUTFLOW 1300.00',
      'OUTFLOW 850.00',
    ]);
    expect(
      (await prisma.profitDraw.findUniqueOrThrow({ where: { id: owed.id } }))
        .settledById,
    ).toBe(secondId);

    // The first settlement cannot be undone while the second holds what it carried.
    expect(
      (await refusal(settlements.reverse(firstId, 'recount', actor))).code,
    ).toBe('SETTLEMENT_OWED_TAKEN_LATER');
    // In order it can: the second first, then the first; what was owed is gone.
    await settlements.reverse(secondId, 'recount', actor);
    await settlements.reverse(firstId, 'recount', actor);
    const gone = await prisma.profitDraw.findUniqueOrThrow({
      where: { id: owed.id },
    });
    expect(gone.reversedAt).not.toBeNull();
    expect(gone.settledById).toBeNull();
    expect((await roomOf(two.cycle.id, people[0])).owedEgp).toBe('0.00');
  });

  it('an owed amount carried or undone after a draft was calculated makes that draft stale', async () => {
    const people = await trio();
    const one = await tradedCycle(people, { split: [50, 25, 25] });
    await one.pay(2000);
    await take(one.cycle.id, people[0], 450);
    await ledger.create(
      {
        kind: 'EXPENSE',
        category: 'extra_freight',
        amount: 900,
        currency: 'EGP',
        cycleId: one.cycle.id,
      },
      actor,
    );
    const two = await tradedCycle(people);
    await two.pay(2000);
    // Calculated before the first cycle settles: nothing owed yet.
    const draft = (await settlements.calculate(two.cycle.id, actor)).data!;
    const firstId = await settle(one.cycle.id);
    expect((await refusal(settlements.approve(draft.id, actor))).code).toBe(
      'SETTLEMENT_STALE_DRAWS',
    );
    // Calculated again it carries the 450, approved; then the first is undone
    // before it is paid — paying would take what is no longer owed.
    const redo = (await settlements.calculate(two.cycle.id, actor)).data!;
    await settlements.approve(redo.id, actor);
    await settlements.reverse(firstId, 'recount', actor);
    expect(
      (
        await refusal(
          settlements.markPaid(redo.id, actor, { acceptRemainingStock: true }),
        )
      ).code,
    ).toBe('SETTLEMENT_STALE_DRAWS');
  });

  it('a payout that only partly covers his draws: he is paid nothing and owes the rest, not more', async () => {
    const people = await trio();
    const one = await tradedCycle(people, { split: [50, 25, 25] });
    await one.pay(2000);
    await take(one.cycle.id, people[0], 400);
    // Profit falls from 900 to 600: his half is 300, so he owes 100.
    await ledger.create(
      {
        kind: 'EXPENSE',
        category: 'extra_freight',
        amount: 300,
        currency: 'EGP',
        cycleId: one.cycle.id,
      },
      actor,
    );
    const id = await settle(one.cycle.id);
    expect(await payoutsOf(id)).toEqual(['OUTFLOW 150.00', 'OUTFLOW 150.00']);
    const owed = await prisma.profitDraw.findFirstOrThrow({
      where: { carriedFromSettlementId: id },
    });
    expect(Number(owed.amountEgp)).toBe(100);
  });

  it('every draw row keeps its shape: a check constraint refuses a draw with no cycle or a non-positive amount', async () => {
    const people = await trio();
    await expect(
      prisma.profitDraw.create({
        data: {
          kind: 'DRAW',
          partnerUserId: people[0].id,
          amountEgp: 10,
          drawnOn: new Date(`${businessToday()}T00:00:00Z`),
        },
      }),
    ).rejects.toThrow();
    const { cycle } = await tradedCycle(people);
    await expect(
      prisma.profitDraw.create({
        data: {
          kind: 'DRAW',
          cycleId: cycle.id,
          partnerUserId: people[0].id,
          amountEgp: 0,
          drawnOn: new Date(`${businessToday()}T00:00:00Z`),
        },
      }),
    ).rejects.toThrow();
  });
});
