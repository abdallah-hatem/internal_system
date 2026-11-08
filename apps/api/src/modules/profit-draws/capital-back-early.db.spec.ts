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
import { ReturnsService } from '../returns/returns.service';
import { cashPosition } from '../../common/cash-position';
import { ProfitDrawsService } from './profit-draws.service';
import { quietRunningCosts } from '../../common/running-costs-quiet-spec';

/**
 * Capital taken back before a cycle is settled (BUSINESS_LOGIC §8, owner
 * 2026-11-08), against a real Postgres: each participant's room — core
 * partners and investors — out of what paid sales recovered, the locks, the
 * settlement paying the rest of his capital with the split untouched, a loss
 * leaving him owing, and every undo.
 *
 * Built the way the business builds it (CLAUDE.md §4): an order, a leg, a
 * departure, a delivery, a checked-in receipt, confirmed sales and the shop's
 * payments, through the real services.
 *
 *   INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/motorcycle_parts_<name> \
 *     npx jest capital-back-early.db --runInBand
 */
// eslint-disable-next-line no-restricted-properties -- an opt-in switch for a suite that must never run by default
const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;

const daysAgo = (n: number) =>
  new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const daysAhead = (n: number) =>
  new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

type Person = { id: string };
type Seat = {
  who: Person;
  type: 'CORE_PARTNER' | 'TEMP_INVESTOR';
  put: number;
};

suite('capital taken back before settlement (Postgres)', () => {
  jest.setTimeout(60_000);

  let prisma: PrismaClient;
  let draws: ProfitDrawsService;
  let deliveries: DeliveriesService;
  let inventory: InventoryService;
  let sales: SalesService;
  let payments: PaymentsService;
  let settlements: SettlementsService;
  let cycles: CyclesService;
  let analytics: AnalyticsService;
  let ledger: LedgerService;
  let returns: ReturnsService;
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
    cycles = new CyclesService(db, audit, notifications);
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
    returns = new ReturnsService(db, audit);
    draws = new ProfitDrawsService(db, audit, settlements, costing);
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
        email: `cap-${name.toLowerCase()}-${tag}@example.test`,
        passwordHash: 'x',
        role,
        partner: { create: { displayName: `${name} ${tag}` } },
      },
    });
  }

  /** Two partners who put in 1,000 each and an investor who put in 2,000. */
  const usual = async (): Promise<Seat[]> => [
    { who: await person('Abdallah'), type: 'CORE_PARTNER', put: 1000 },
    { who: await person('Shady'), type: 'CORE_PARTNER', put: 1000 },
    {
      who: await person('Setta', 'TEMP_INVESTOR'),
      type: 'TEMP_INVESTOR',
      put: 2000,
    },
  ];

  /**
   * A cycle as the business makes it: 40 ordered at 100, a 400 leg (110 a
   * unit landed, 4,400 to fund), everything delivered and checked in, and 10
   * sold at 200 to a verified shop — nothing paid yet. `sell` sells more.
   */
  async function tradedCycle(seats?: Seat[]) {
    const who = seats ?? (await usual());
    const tag = randomUUID().slice(0, 8);
    const cycle = await prisma.importCycle.create({
      data: {
        code: `CAP-${tag}`,
        originType: 'UAE_DIRECT',
        currency: 'EGP',
        status: 'ARRIVED_EGYPT',
      },
    });
    const joined = Date.now() - 60_000;
    const participants = [];
    for (const [i, s] of who.entries()) {
      participants.push(
        await prisma.cycleParticipant.create({
          data: {
            cycleId: cycle.id,
            participantType: s.type,
            partnerUserId: s.type === 'CORE_PARTNER' ? s.who.id : null,
            investorUserId: s.type === 'TEMP_INVESTOR' ? s.who.id : null,
            contributionAmount: s.put,
            createdAt: new Date(joined + i * 1000),
            updatedAt: new Date(joined + i * 1000),
          },
        }),
      );
    }
    const supplier = await prisma.supplier.create({
      data: { name: `Cap ${tag}`, country: 'AE' },
    });
    const product = await prisma.product.create({
      data: { sku: `CAP-${tag}`, name: `Cap part ${tag}` },
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
        displayName: `Cap shop ${tag}`,
        verificationStatus: 'VERIFIED',
      },
    });

    /** Sell `qty` at `price`; returns a way to pay that order. */
    const sell = async (qty: number, price = 200) => {
      const before = await prisma.saleOrder.findMany({
        where: { customerId: shop.id },
        select: { id: true },
      });
      await sales.create(
        {
          customerId: shop.id,
          channel: 'B2B',
          currency: 'EGP',
          items: [{ productId: product.id, quantity: qty, unitPrice: price }],
          confirm: true,
        },
        actor,
      );
      const order = await prisma.saleOrder.findFirstOrThrow({
        where: {
          customerId: shop.id,
          id: { notIn: before.map((o) => o.id) },
        },
      });
      return {
        order,
        pay: (amount: number) =>
          payments.create(
            {
              customerId: shop.id,
              amount,
              currency: 'EGP',
              orderId: order.id,
            },
            actor,
          ),
      };
    };
    const first = await sell(10);
    return {
      cycle,
      seats: who,
      participants,
      shop,
      order: first.order,
      pay: first.pay,
      sell,
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

  const takeBack = (
    cycleId: string,
    who: Person,
    amountEgp: number,
    extra: Record<string, unknown> = {},
  ) =>
    draws.takeCapital(cycleId, { userId: who.id, amountEgp, ...extra }, actor);

  const roomOf = async (cycleId: string, who: Person) =>
    (await draws.capitalForCycle(cycleId)).data.people.find(
      (p) => p.userId === who.id,
    )!;

  const rooms = async (cycleId: string) =>
    (await draws.capitalForCycle(cycleId)).data.people.map(
      (p) => p.availableEgp,
    );

  const cashOnHand = async () =>
    (await cashPosition(prisma)).cashOnHand.toString();

  /** Every profit figure a reader sees, and the split — never moved by capital back. */
  async function profitFigures(cycleId: string) {
    const { cashOutEgp: _cash, ...pnl } = (await analytics.getProfitAndLoss())
      .data as Record<string, unknown>;
    void _cash;
    const all = (await analytics.getCycleProfitability()) as unknown as {
      data: { cycleId?: string; id?: string }[];
    };
    const projected = await settlements.project(cycleId);
    return JSON.stringify({
      pnl,
      cycle: (all.data ?? []).find(
        (c) => c.cycleId === cycleId || c.id === cycleId,
      ),
      profit: projected!.pnl.grossProfit.toFixed(2),
      split: projected!.distribution.lines.map((l) => [
        l.sharePct.toString(),
        l.capitalReturn.toFixed(2),
        l.netProfit.toFixed(2),
      ]),
    });
  }

  const linesOf = async (settlementId: string) =>
    (
      await prisma.settlementLine.findMany({
        where: { settlementId },
        include: { participant: true },
      })
    )
      .map(
        (l) =>
          `${l.participant.partnerUserId ?? l.participant.investorUserId} ${l.component} ${Number(l.amount).toFixed(2)}`,
      )
      .sort();

  const payoutsOf = async (settlementId: string) =>
    (
      await prisma.financialTransaction.findMany({
        where: {
          relatedType: 'SETTLEMENT',
          relatedId: settlementId,
          type: 'SETTLEMENT_PAYOUT',
        },
      })
    )
      .map((r) => `${r.direction} ${Number(r.amount).toFixed(2)}`)
      .sort();

  async function settle(cycleId: string) {
    const calc = (await settlements.calculate(cycleId, actor)).data!;
    await settlements.approve(calc.id, actor);
    await settlements.markPaid(calc.id, actor, { acceptRemainingStock: true });
    return calc.id;
  }

  // ─── The room: his part of what paid sales recovered ────────────────

  it('nothing paid, nothing recovered: no one can take a piastre back', async () => {
    const { cycle, seats } = await tradedCycle();
    const { data } = await draws.capitalForCycle(cycle.id);
    expect(data.toFundEgp).toBe('4400.00');
    expect(data.recoveredEgp).toBe('0.00');
    expect(data.recoveredPct).toBe('0.00');
    expect(data.people.map((p) => [p.contributionEgp, p.availableEgp])).toEqual(
      [
        ['1000.00', '0.00'],
        ['1000.00', '0.00'],
        ['2000.00', '0.00'],
      ],
    );
    const r = await refusal(takeBack(cycle.id, seats[2].who, 0.01));
    expect(r).toMatchObject({
      status: 400,
      code: 'CAPITAL_BACK_OVER_AVAILABLE',
    });
    expect(r.params).toMatchObject({ available: '0.00', pct: '0.00' });
  });

  it('recovered rises with each payment: half paid is half the goods’ cost back', async () => {
    const { cycle, pay } = await tradedCycle();
    await pay(1000); // half of 2,000: half of 1,100 of cost = 550 of 4,400
    let data = (await draws.capitalForCycle(cycle.id)).data;
    expect(data.recoveredEgp).toBe('550.00');
    expect(data.recoveredPct).toBe('12.50');
    expect(await rooms(cycle.id)).toEqual(['125.00', '125.00', '250.00']);
    await pay(1000);
    data = (await draws.capitalForCycle(cycle.id)).data;
    expect(data.recoveredEgp).toBe('1100.00');
    expect(await rooms(cycle.id)).toEqual(['250.00', '250.00', '500.00']);
  });

  it('everything sold and paid: never more than he put in', async () => {
    const { cycle, pay, sell } = await tradedCycle();
    await pay(2000);
    const rest = await sell(30);
    await rest.pay(6000);
    const data = (await draws.capitalForCycle(cycle.id)).data;
    // 40 × 110 = 4,400 of cost, all of it paid for.
    expect(data.recoveredEgp).toBe('4400.00');
    expect(data.recoveredPct).toBe('100.00');
    expect(await rooms(cycle.id)).toEqual(['1000.00', '1000.00', '2000.00']);
    // Even with every unit paid, more than recovered stays out of reach.
    await expect(
      takeBack(cycle.id, (await usualOf(cycle.id))[2], 2000.01),
    ).rejects.toMatchObject({
      response: { code: 'CAPITAL_BACK_OVER_AVAILABLE' },
    });
  });

  /** The participants' users, in joining order. */
  const usualOf = async (cycleId: string) =>
    (
      await prisma.cycleParticipant.findMany({
        where: { cycleId },
        orderBy: { createdAt: 'asc' },
      })
    ).map((p) => ({ id: (p.partnerUserId ?? p.investorUserId)! }));

  it('an investor takes his own part, partners theirs — and one’s taking does not shrink another’s', async () => {
    const { cycle, seats, pay } = await tradedCycle();
    await pay(2000);
    const cash = await cashOnHand();
    await takeBack(cycle.id, seats[2].who, 500);
    expect(await rooms(cycle.id)).toEqual(['250.00', '250.00', '0.00']);
    await takeBack(cycle.id, seats[0].who, 250);
    expect(await rooms(cycle.id)).toEqual(['0.00', '250.00', '0.00']);
    expect(Number(await cashOnHand())).toBeCloseTo(Number(cash) - 750, 2);
    const inv = await roomOf(cycle.id, seats[2].who);
    expect(inv).toMatchObject({
      participantType: 'TEMP_INVESTOR',
      recoveredEgp: '500.00',
      takenEgp: '500.00',
      availableEgp: '0.00',
    });
  });

  it('taking twice adds up; a piastre beyond refuses with what is left', async () => {
    const { cycle, seats, pay } = await tradedCycle();
    await pay(2000);
    await takeBack(cycle.id, seats[0].who, 100);
    await takeBack(cycle.id, seats[0].who, 150);
    const r = await refusal(takeBack(cycle.id, seats[0].who, 0.01));
    expect(r.code).toBe('CAPITAL_BACK_OVER_AVAILABLE');
    expect(r.params).toMatchObject({ available: '0.00', taken: '250.00' });
  });

  it('two at once for the whole room: one is taken, the other refused', async () => {
    const { cycle, seats, pay } = await tradedCycle();
    await pay(2000);
    const results = await Promise.allSettled([
      takeBack(cycle.id, seats[2].who, 500),
      takeBack(cycle.id, seats[2].who, 500),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const taken = await prisma.profitDraw.findMany({
      where: { cycleId: cycle.id, kind: 'CAPITAL' },
    });
    expect(taken).toHaveLength(1);
  });

  it('goods that came back are no cost recovered: two of ten returned, the rest paid', async () => {
    const { cycle, order, pay } = await tradedCycle();
    const item = await prisma.saleItem.findFirstOrThrow({
      where: { saleOrderId: order.id },
    });
    await returns.create(
      {
        saleOrderId: order.id,
        reason: 'Two came back',
        returnedOn: daysAgo(1),
        refundMethod: 'CREDIT_NOTE',
        items: [{ saleItemId: item.id, qty: 2 }],
      } as never,
      actor,
    );
    await pay(1600);
    // 8 kept and paid for: 880 of the 4,400 — not the 1,100 of all ten.
    const data = (await draws.capitalForCycle(cycle.id)).data;
    expect(data.recoveredEgp).toBe('880.00');
    expect(await rooms(cycle.id)).toEqual(['200.00', '200.00', '400.00']);
  });

  it('a payment undone after he took back: the room is zero, never negative', async () => {
    const { cycle, seats, pay } = await tradedCycle();
    const paid = await pay(2000);
    await takeBack(cycle.id, seats[0].who, 250);
    const paymentId = (paid as { data: { id: string } }).data.id;
    await payments.reverse(paymentId, 'bounced', actor);
    const mine = await roomOf(cycle.id, seats[0].who);
    expect(mine).toMatchObject({
      recoveredEgp: '0.00',
      takenEgp: '250.00',
      availableEgp: '0.00',
    });
  });

  // ─── What it must not move ─────────────────────────────────────────

  it('profit, the split and every profit figure stay as they were; profit draws too', async () => {
    const { cycle, seats, pay } = await tradedCycle();
    await pay(2000);
    const before = await profitFigures(cycle.id);
    const drawsBefore = JSON.stringify(
      (await draws.forCycle(cycle.id)).data.partners,
    );
    await takeBack(cycle.id, seats[2].who, 500);
    await takeBack(cycle.id, seats[1].who, 200);
    expect(await profitFigures(cycle.id)).toBe(before);
    // And the other way: profit drawn is not capital taken back.
    const capitalBefore = await rooms(cycle.id);
    await draws.create(
      cycle.id,
      { partnerUserId: seats[0].who.id, amountEgp: 100 },
      actor,
    );
    expect(await rooms(cycle.id)).toEqual(capitalBefore);
    await draws.reverse(
      (
        await prisma.profitDraw.findFirstOrThrow({
          where: { cycleId: cycle.id, kind: 'DRAW' },
        })
      ).id,
      { reason: 'checking' },
      actor,
    );
    expect(JSON.stringify((await draws.forCycle(cycle.id)).data.partners)).toBe(
      drawsBefore,
    );
    // The contribution rows still sum to what each put in (check-data 14.1).
    const contributions = await prisma.cycleParticipant.findMany({
      where: { cycleId: cycle.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(contributions.map((c) => Number(c.contributionAmount))).toEqual([
      1000, 1000, 2000,
    ]);
  });

  it('its cash row: out of cash, on the cycle, in its own category, owned by the capital row', async () => {
    const { cycle, seats, pay } = await tradedCycle();
    await pay(2000);
    const { data } = await takeBack(cycle.id, seats[2].who, 300, {
      takenOn: daysAgo(1),
      note: 'school fees',
    });
    const row = await prisma.profitDraw.findUniqueOrThrow({
      where: { id: data.id },
    });
    expect(row).toMatchObject({
      kind: 'CAPITAL',
      partnerUserId: seats[2].who.id,
    });
    const cash = await prisma.financialTransaction.findUniqueOrThrow({
      where: { id: row.ledgerEntryId! },
    });
    expect(cash).toMatchObject({
      category: 'capital_back_early',
      direction: 'OUTFLOW',
      cycleId: cycle.id,
      relatedType: 'PROFIT_DRAW',
      relatedId: row.id,
    });
    expect(Number(cash.amount)).toBe(300);
    expect(cash.occurredOn!.toISOString().slice(0, 10)).toBe(daysAgo(1));
    // Not undone from the ledger: only from where it was taken.
    const r = await refusal(ledger.reverse(cash.id, 'oops', actor));
    expect(r.status).toBe(400);
  });

  // ─── The limits and the wrong context ──────────────────────────────

  it('zero, negative, three decimals, not a number, too big: refused before anything moves', async () => {
    const { cycle, seats, pay } = await tradedCycle();
    await pay(2000);
    for (const amount of [0, -1, Number.NaN, 1e20]) {
      expect(
        (await refusal(takeBack(cycle.id, seats[0].who, amount))).code,
      ).toBe('PROFIT_DRAW_AMOUNT_NOT_POSITIVE');
    }
    expect((await refusal(takeBack(cycle.id, seats[0].who, 1.005))).code).toBe(
      'PROFIT_DRAW_AMOUNT_PRECISION',
    );
    expect(
      await prisma.profitDraw.count({ where: { cycleId: cycle.id } }),
    ).toBe(0);
  });

  it('dated tomorrow: refused, with the field named', async () => {
    const { cycle, seats, pay } = await tradedCycle();
    await pay(2000);
    const r = await refusal(
      takeBack(cycle.id, seats[0].who, 10, { takenOn: daysAhead(1) }),
    );
    expect(r).toMatchObject({ code: 'DATE_IN_FUTURE' });
    expect(r.params).toMatchObject({ label: 'CAPITAL_TAKEN_BACK' });
  });

  it('someone not on the cycle, a user that does not exist, a bad id, a cycle that does not exist', async () => {
    const { cycle, pay } = await tradedCycle();
    await pay(2000);
    const outsider = await person('Outsider');
    expect((await refusal(takeBack(cycle.id, outsider, 10))).code).toBe(
      'CAPITAL_BACK_NOT_ON_CYCLE',
    );
    expect(
      await refusal(takeBack(cycle.id, { id: randomUUID() }, 10)),
    ).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(await refusal(takeBack(cycle.id, { id: 'nope' }, 10))).toMatchObject(
      {
        status: 404,
      },
    );
    expect(await refusal(takeBack(randomUUID(), outsider, 10))).toMatchObject({
      status: 404,
    });
    expect(await refusal(draws.capitalForCycle('nope'))).toMatchObject({
      status: 404,
    });
  });

  it('someone on another cycle only: his room there is not his room here', async () => {
    const a = await tradedCycle();
    const b = await tradedCycle();
    await a.pay(2000);
    await b.pay(2000);
    await takeBack(a.cycle.id, a.seats[2].who, 500);
    expect((await refusal(takeBack(b.cycle.id, a.seats[2].who, 1))).code).toBe(
      'CAPITAL_BACK_NOT_ON_CYCLE',
    );
    expect(await rooms(b.cycle.id)).toEqual(['250.00', '250.00', '500.00']);
  });

  // ─── Undo ──────────────────────────────────────────────────────────

  it('undo puts the cash back and frees the room — once, and only with a reason', async () => {
    const { cycle, seats, pay } = await tradedCycle();
    await pay(2000);
    const cash = await cashOnHand();
    const { data } = await takeBack(cycle.id, seats[2].who, 500);
    expect(
      (await refusal(draws.reverse(data.id, { reason: '  ' }, actor))).code,
    ).toBe('PROFIT_DRAW_REASON_REQUIRED');
    await draws.reverse(data.id, { reason: 'typed twice' }, actor);
    expect(await cashOnHand()).toBe(cash);
    expect((await roomOf(cycle.id, seats[2].who)).availableEgp).toBe('500.00');
    expect(
      (await refusal(draws.reverse(data.id, { reason: 'again' }, actor))).code,
    ).toBe('PROFIT_DRAW_ALREADY_REVERSED');
    const back = await prisma.financialTransaction.findFirstOrThrow({
      where: { relatedId: data.id, direction: 'INFLOW' },
    });
    expect(back).toMatchObject({
      type: 'CAPITAL_RETURN_EARLY_REVERSAL',
      category: 'capital_back_early',
    });
  });

  // ─── The contribution under it ─────────────────────────────────────

  it('a contribution cannot go below what was taken back of it; to exactly that is fine', async () => {
    const { cycle, seats, participants, pay } = await tradedCycle();
    await pay(2000);
    await takeBack(cycle.id, seats[0].who, 250);
    const r = await refusal(
      cycles.updateParticipant(
        participants[0].id,
        { contributionAmount: 249.99 },
        actor,
      ),
    );
    expect(r).toMatchObject({ code: 'CONTRIBUTION_BELOW_CAPITAL_TAKEN_BACK' });
    expect(r.params).toMatchObject({ taken: '250.00' });
    await cycles.updateParticipant(
      participants[0].id,
      { contributionAmount: 250 },
      actor,
    );
    // Raising it is always fine.
    await cycles.updateParticipant(
      participants[0].id,
      { contributionAmount: 1500 },
      actor,
    );
  });

  // ─── Settlement ────────────────────────────────────────────────────

  it('settlement pays the rest of his capital; split, profit and what each gets in all stay the same', async () => {
    // The same cycle twice: once with capital taken early, once without.
    const plain = await tradedCycle();
    const early = await tradedCycle();
    for (const c of [plain, early]) await c.pay(2000);
    await takeBack(early.cycle.id, early.seats[2].who, 500);
    await takeBack(early.cycle.id, early.seats[0].who, 100);

    const plainId = await settle(plain.cycle.id);
    const earlyId = await settle(early.cycle.id);

    const strip = (lines: string[], seats: Seat[]) =>
      lines
        .map((l) =>
          seats.reduce((s, seat, i) => s.replace(seat.who.id, `P${i}`), l),
        )
        .sort();
    expect(strip(await linesOf(earlyId), early.seats)).toEqual(
      [
        ...strip(await linesOf(plainId), plain.seats),
        'P0 CAPITAL_TAKEN_EARLY -100.00',
        'P2 CAPITAL_TAKEN_EARLY -500.00',
      ].sort(),
    );
    // CAPITAL_RETURN is still what each put in.
    expect(
      (await linesOf(earlyId)).filter((l) => l.includes('CAPITAL_RETURN')),
    ).toHaveLength(3);

    // Cash early + payout = what the plain cycle paid, person by person.
    const plainPay = await payoutsOf(plainId);
    const earlyPay = await payoutsOf(earlyId);
    const sum = (xs: string[]) =>
      xs.reduce((s, x) => s + Number(x.split(' ')[1]), 0);
    expect(sum(earlyPay) + 600).toBeCloseTo(sum(plainPay), 2);

    // Settled: no longer undone on its own.
    const row = await prisma.profitDraw.findFirstOrThrow({
      where: {
        cycleId: early.cycle.id,
        kind: 'CAPITAL',
        partnerUserId: early.seats[2].who.id,
      },
    });
    expect(row.settledById).toBe(earlyId);
    expect(
      (await refusal(draws.reverse(row.id, { reason: 'x' }, actor))).code,
    ).toBe('PROFIT_DRAW_SETTLED');

    // Reversing the settlement frees it: undone on its own again.
    await settlements.reverse(earlyId, 'recount', actor);
    const freed = await prisma.profitDraw.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(freed.settledById).toBeNull();
    await draws.reverse(row.id, { reason: 'handed back' }, actor);
  });

  it('taken after the figures were worked out: approval refuses until calculated again', async () => {
    const { cycle, seats, pay } = await tradedCycle();
    await pay(2000);
    const calc = (await settlements.calculate(cycle.id, actor)).data!;
    await takeBack(cycle.id, seats[1].who, 50);
    expect((await refusal(settlements.approve(calc.id, actor))).code).toBe(
      'SETTLEMENT_STALE_DRAWS',
    );
    const again = (await settlements.calculate(cycle.id, actor)).data!;
    await settlements.approve(again.id, actor);
    // Approved: nothing more taken, nothing undone.
    expect((await refusal(takeBack(cycle.id, seats[0].who, 1))).code).toBe(
      'PROFIT_DRAW_CYCLE_LOCKED',
    );
    const row = await prisma.profitDraw.findFirstOrThrow({
      where: { cycleId: cycle.id, kind: 'CAPITAL' },
    });
    expect(
      (await refusal(draws.reverse(row.id, { reason: 'x' }, actor))).code,
    ).toBe('PROFIT_DRAW_CYCLE_LOCKED');
  });

  it('undone after the figures were worked out: approval refuses too', async () => {
    const { cycle, seats, pay } = await tradedCycle();
    await pay(2000);
    const { data } = await takeBack(cycle.id, seats[1].who, 50);
    const calc = (await settlements.calculate(cycle.id, actor)).data!;
    await draws.reverse(data.id, { reason: 'mistake' }, actor);
    expect((await refusal(settlements.approve(calc.id, actor))).code).toBe(
      'SETTLEMENT_STALE_DRAWS',
    );
  });

  it('a loss: the investor took back more than his payout comes to — he owes it, off his next payout', async () => {
    const { cycle, seats, pay } = await tradedCycle();
    await pay(2000);
    await takeBack(cycle.id, seats[2].who, 500);
    // A big bill charged to the cycle afterwards: profit 900 − 10,000.
    await prisma.financialTransaction.create({
      data: {
        type: 'EXPENSE',
        category: 'customs',
        direction: 'OUTFLOW',
        amount: 10_000,
        currency: 'EGP',
        cycleId: cycle.id,
        occurredOn: new Date(`${daysAgo(1)}T00:00:00Z`),
        reason: 'customs penalty',
        createdBy: actor,
      },
    });
    const id = await settle(cycle.id);
    // His half of −9,100 is −4,550; capital 2,000; taken early 500.
    // Short by 3,050: 500 of it is his capital taken early — owed — and the
    // rest is the loss, as it always was.
    const owed = await prisma.profitDraw.findFirstOrThrow({
      where: {
        kind: 'CARRIED',
        carriedFromSettlementId: id,
        partnerUserId: seats[2].who.id,
      },
    });
    expect(Number(owed.amountEgp)).toBe(500);

    // His next cycle takes it off his payout.
    const next = await tradedCycle([
      { who: seats[0].who, type: 'CORE_PARTNER', put: 1000 },
      { who: seats[1].who, type: 'CORE_PARTNER', put: 1000 },
      { who: seats[2].who, type: 'TEMP_INVESTOR', put: 2000 },
    ]);
    await next.pay(2000);
    // He owes 500, so he can still take back his part here: owing is off a payout, not off capital.
    expect((await roomOf(next.cycle.id, seats[2].who)).availableEgp).toBe(
      '500.00',
    );
    const nextId = await settle(next.cycle.id);
    expect(
      (await linesOf(nextId)).filter((l) =>
        l.startsWith(`${seats[2].who.id} PROFIT_DRAWN`),
      ),
    ).toEqual([`${seats[2].who.id} PROFIT_DRAWN -500.00`]);
    expect(
      (await prisma.profitDraw.findUniqueOrThrow({ where: { id: owed.id } }))
        .settledById,
    ).toBe(nextId);

    // The first settlement cannot be undone while the next one took what it left owing.
    expect(
      (await refusal(settlements.reverse(id, 'recount', actor))).code,
    ).toBe('SETTLEMENT_OWED_TAKEN_LATER');
    await settlements.reverse(nextId, 'recount', actor);
    await settlements.reverse(id, 'recount', actor);
    expect(
      (await prisma.profitDraw.findUniqueOrThrow({ where: { id: owed.id } }))
        .reversedAt,
    ).not.toBeNull();
  });

  it('a closed or cancelled cycle takes nothing', async () => {
    for (const status of ['CLOSED', 'CANCELLED', 'SETTLEMENT'] as const) {
      const { cycle, seats, pay } = await tradedCycle();
      await pay(2000);
      await prisma.importCycle.update({
        where: { id: cycle.id },
        data: { status },
      });
      expect((await refusal(takeBack(cycle.id, seats[0].who, 1))).code).toBe(
        'PROFIT_DRAW_CYCLE_LOCKED',
      );
      expect((await draws.capitalForCycle(cycle.id)).data.locked).toBe(status);
    }
  });
});
