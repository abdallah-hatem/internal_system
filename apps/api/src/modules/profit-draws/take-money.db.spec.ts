import { randomUUID } from 'crypto';
import { businessToday } from '../../common/dates';
import { HttpException } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- this suite talks to a real, throwaway Postgres; that is its point
import { Prisma, PrismaClient } from '@prisma/client';
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
import { cashPosition } from '../../common/cash-position';
import { ProfitDrawsService } from './profit-draws.service';
import { quietRunningCosts } from '../../common/running-costs-quiet-spec';

/**
 * One take from a cycle, profit first and then capital (BUSINESS_LOGIC §8,
 * owner 2026-11-10: the "Take money from this cycle" card), against a real
 * Postgres: the cut, the limits, the wrong person and the wrong cycle, a locked
 * cycle, doing it twice, undoing one part, two at once, and that a take is
 * whole or nothing — never half recorded.
 *
 * Built the way the business builds it (CLAUDE.md §4): an order, a leg, a
 * departure, a delivery, a checked-in receipt, confirmed sales and the shop's
 * payments, through the real services.
 *
 *   INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/motorcycle_parts_<name> \
 *     npx jest take-money.db --runInBand
 */
// eslint-disable-next-line no-restricted-properties -- an opt-in switch for a suite that must never run by default
const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;

const daysAgo = (n: number) =>
  businessToday(new Date(Date.now() - n * 86_400_000));
const daysAhead = (n: number) =>
  businessToday(new Date(Date.now() + n * 86_400_000));

type Person = { id: string };
type Seat = {
  who: Person;
  type: 'CORE_PARTNER' | 'TEMP_INVESTOR';
  put: number;
};

suite('one take from a cycle: profit first, then capital (Postgres)', () => {
  jest.setTimeout(60_000);

  let prisma: PrismaClient;
  let draws: ProfitDrawsService;
  let deliveries: DeliveriesService;
  let inventory: InventoryService;
  let sales: SalesService;
  let payments: PaymentsService;
  let settlements: SettlementsService;
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

  const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

  const take = (
    cycleId: string,
    who: Person,
    amountEgp: number | string,
    extra: Record<string, unknown> = {},
  ) =>
    draws.take(
      cycleId,
      { userId: who.id, amountEgp: amountEgp as number, ...extra },
      actor,
    );

  const roomOf = async (cycleId: string, who: Person) =>
    (await draws.takeForCycle(cycleId)).data.people.find(
      (p) => p.userId === who.id,
    )!;

  /** Everything a take writes on this cycle: the draw rows and their cash rows. */
  const writes = async (cycleId: string) => ({
    rows: (
      await prisma.profitDraw.findMany({
        where: { cycleId },
        orderBy: { createdAt: 'asc' },
      })
    ).map((r) => `${r.kind} ${Number(r.amountEgp).toFixed(2)}`),
    cash: (
      await prisma.financialTransaction.findMany({
        where: { cycleId, relatedType: 'PROFIT_DRAW' },
        orderBy: { createdAt: 'asc' },
      })
    ).map((r) => `${r.direction} ${r.category} ${Number(r.amount).toFixed(2)}`),
  });

  const cashOnHand = async () =>
    (await cashPosition(prisma)).cashOnHand.toFixed(2);

  /** A cycle whose shop has paid for all it bought: profit collected and cost recovered. */
  async function paidCycle(seats?: Seat[]) {
    const c = await tradedCycle(seats);
    await c.pay(2000);
    const a = await roomOf(c.cycle.id, c.seats[0].who);
    const profit = D(a.profit!.availableEgp);
    // The fixture must leave both rooms open, or nothing below tests a cut.
    expect(profit.gt(100)).toBe(true);
    expect(a.capital.availableEgp).toBe('250.00');
    return { ...c, profit, total: profit.add(250) };
  }

  // ─── The rooms ──────────────────────────────────────────────────────

  it('per person: profit and capital he can take, the total their sum; an investor has capital only', async () => {
    const { cycle, seats, profit } = await paidCycle();
    const { data } = await draws.takeForCycle(cycle.id);
    expect(data.locked).toBeNull();
    expect(data.problem).toBeNull();
    expect(data.recoveredPct).toBe('25.00');
    const [a, s, m] = data.people;
    expect(a.userId).toBe(seats[0].who.id);
    expect(a.availableEgp).toBe(profit.add(250).toFixed(2));
    expect(s.profit).not.toBeNull();
    expect(m).toMatchObject({
      participantType: 'TEMP_INVESTOR',
      profit: null,
      availableEgp: '500.00',
      capital: { contributionEgp: '2000.00', availableEgp: '500.00' },
    });
    // The same figures as each card's own read: one reckoning, not two.
    const own = (await draws.forCycle(cycle.id)).data.partners[0];
    expect(a.profit!.availableEgp).toBe(own.availableEgp);
    const cap = (await draws.capitalForCycle(cycle.id)).data.people[0];
    expect(a.capital).toMatchObject({
      recoveredEgp: cap.recoveredEgp,
      availableEgp: cap.availableEgp,
    });
  });

  // ─── The cut: profit first, then capital ────────────────────────────

  it('more than his profit: all his profit first, the rest from capital — two rows, two cash rows, one take', async () => {
    const { cycle, seats, profit } = await paidCycle();
    const cash = await cashOnHand();
    const asked = profit.add(100);
    const { data } = await take(cycle.id, seats[0].who, asked.toNumber(), {
      note: 'school fees',
    });
    expect(data.profit?.amountEgp).toBe(profit.toFixed(2));
    expect(data.capital?.amountEgp).toBe('100.00');
    expect(await writes(cycle.id)).toEqual({
      rows: [`DRAW ${profit.toFixed(2)}`, 'CAPITAL 100.00'],
      cash: [
        `OUTFLOW profit_draw ${profit.toFixed(2)}`,
        'OUTFLOW capital_back_early 100.00',
      ],
    });
    expect(await cashOnHand()).toBe(D(cash).sub(asked).toFixed(2));
    const after = await roomOf(cycle.id, seats[0].who);
    expect(after.profit!.availableEgp).toBe('0.00');
    expect(after.profit!.takenEgp).toBe(profit.toFixed(2));
    expect(after.capital.availableEgp).toBe('150.00');
    expect(after.capital.takenEgp).toBe('100.00');
    expect(after.availableEgp).toBe('150.00');
    // The note travels with both parts.
    const notes = await prisma.profitDraw.findMany({
      where: { cycleId: cycle.id },
      select: { note: true },
    });
    expect(notes.map((n) => n.note)).toEqual(['school fees', 'school fees']);
  });

  it('less than his profit: profit only, no capital row at all', async () => {
    const { cycle, seats } = await paidCycle();
    const { data } = await take(cycle.id, seats[0].who, 10);
    expect(data.profit?.amountEgp).toBe('10.00');
    expect(data.capital).toBeNull();
    expect((await writes(cycle.id)).rows).toEqual(['DRAW 10.00']);
    expect((await roomOf(cycle.id, seats[0].who)).capital.availableEgp).toBe(
      '250.00',
    );
  });

  it('exactly his profit: profit only, and nothing of his capital moves', async () => {
    const { cycle, seats, profit } = await paidCycle();
    const { data } = await take(cycle.id, seats[0].who, profit.toNumber());
    expect(data.capital).toBeNull();
    expect((await writes(cycle.id)).rows).toEqual([
      `DRAW ${profit.toFixed(2)}`,
    ]);
  });

  it('exactly the total: both rooms to zero', async () => {
    const { cycle, seats, profit, total } = await paidCycle();
    const { data } = await take(cycle.id, seats[0].who, total.toNumber());
    expect(data.profit?.amountEgp).toBe(profit.toFixed(2));
    expect(data.capital?.amountEgp).toBe('250.00');
    const after = await roomOf(cycle.id, seats[0].who);
    expect([
      after.profit!.availableEgp,
      after.capital.availableEgp,
      after.availableEgp,
    ]).toEqual(['0.00', '0.00', '0.00']);
  });

  it('one piastre over the total: refused with the total, its profit and its capital — nothing recorded, cash unchanged', async () => {
    const { cycle, seats, profit, total } = await paidCycle();
    const cash = await cashOnHand();
    const r = await refusal(
      take(cycle.id, seats[0].who, total.add('0.01').toNumber()),
    );
    expect(r).toMatchObject({ status: 400, code: 'TAKE_OVER_AVAILABLE' });
    const plain = (v: unknown) => String(v).replace(/,/g, '');
    expect(plain(r.params!.available)).toBe(total.toFixed(2));
    expect(plain(r.params!.profit)).toBe(profit.toFixed(2));
    expect(r.params!.capital).toBe('250.00');
    expect(await writes(cycle.id)).toEqual({ rows: [], cash: [] });
    expect(await cashOnHand()).toBe(cash);
  });

  it('an investor: capital only, never profit — his total is his capital', async () => {
    const { cycle, seats } = await paidCycle();
    const m = seats[2].who;
    const r = await refusal(take(cycle.id, m, 500.01));
    expect(r.code).toBe('TAKE_OVER_AVAILABLE');
    expect(r.params).toMatchObject({
      available: '500.00',
      profit: '0.00',
      capital: '500.00',
    });
    const { data } = await take(cycle.id, m, 500);
    expect(data.profit).toBeNull();
    expect(data.capital?.amountEgp).toBe('500.00');
    expect((await writes(cycle.id)).rows).toEqual(['CAPITAL 500.00']);
  });

  it('his profit already taken on its own: a take is all capital', async () => {
    const { cycle, seats, profit } = await paidCycle();
    await draws.create(
      cycle.id,
      { partnerUserId: seats[0].who.id, amountEgp: profit.toNumber() },
      actor,
    );
    const { data } = await take(cycle.id, seats[0].who, 100);
    expect(data.profit).toBeNull();
    expect(data.capital?.amountEgp).toBe('100.00');
  });

  it('he owes from an earlier payout: his profit room is what is left after it, and the cut follows', async () => {
    // An earlier cycle: he took 40 of capital back, then a bill turned it into
    // a loss, so its settlement left him owing those 40 (a CARRIED row).
    const first = await paidCycle();
    await draws.takeCapital(
      first.cycle.id,
      { userId: first.seats[0].who.id, amountEgp: 40 },
      actor,
    );
    await prisma.financialTransaction.create({
      data: {
        type: 'EXPENSE',
        category: 'customs',
        direction: 'OUTFLOW',
        amount: 10_000,
        currency: 'EGP',
        cycleId: first.cycle.id,
        occurredOn: new Date(`${daysAgo(1)}T00:00:00Z`),
        reason: 'customs penalty',
        createdBy: actor,
      },
    });
    const calc = (await settlements.calculate(first.cycle.id, actor)).data!;
    await settlements.approve(calc.id, actor);
    await settlements.markPaid(calc.id, actor, { acceptRemainingStock: true });
    const owed = await prisma.profitDraw.findMany({
      where: {
        kind: 'CARRIED',
        carriedFromSettlementId: calc.id,
        partnerUserId: first.seats[0].who.id,
      },
    });
    const owes = owed.reduce((s, o) => s.add(o.amountEgp), D(0));
    expect(owes.gt(0)).toBe(true);

    // Same people, a new cycle: what he owes comes off his profit room here.
    const { cycle, seats, profit } = await paidCycle(first.seats);
    const room = await roomOf(cycle.id, seats[0].who);
    expect(room.profit!.owedEgp).toBe(owes.toFixed(2));
    expect(profit.toFixed(2)).toBe(
      D(room.profit!.shareOfCollectedEgp).sub(owes).toFixed(2),
    );
    // His share in full: what he owes of it is cut from capital instead.
    const { data } = await take(
      cycle.id,
      seats[0].who,
      D(room.profit!.shareOfCollectedEgp).toNumber(),
    );
    expect(data.profit?.amountEgp).toBe(profit.toFixed(2));
    expect(data.capital?.amountEgp).toBe(owes.toFixed(2));
  });

  // ─── The second time ────────────────────────────────────────────────

  it('twice in a row: the second is cut from what the first left', async () => {
    const { cycle, seats, profit, total } = await paidCycle();
    await take(cycle.id, seats[0].who, profit.sub(50).toNumber());
    const { data } = await take(cycle.id, seats[0].who, 100);
    expect(data.profit?.amountEgp).toBe('50.00');
    expect(data.capital?.amountEgp).toBe('50.00');
    const left = total.sub(profit.sub(50)).sub(100); // 200 of capital
    expect(left.toFixed(2)).toBe('200.00');
    expect(
      (await refusal(take(cycle.id, seats[0].who, left.add('0.01').toNumber())))
        .code,
    ).toBe('TAKE_OVER_AVAILABLE');
    await take(cycle.id, seats[0].who, left.toNumber());
    expect((await roomOf(cycle.id, seats[0].who)).availableEgp).toBe('0.00');
  });

  it('undo one part: only that part comes back, the other stands', async () => {
    const { cycle, seats, profit } = await paidCycle();
    const { data } = await take(
      cycle.id,
      seats[0].who,
      profit.add(100).toNumber(),
    );
    await draws.reverse(data.capital!.id, { reason: 'wrong amount' }, actor);
    let room = await roomOf(cycle.id, seats[0].who);
    expect(room.capital.availableEgp).toBe('250.00');
    expect(room.profit!.availableEgp).toBe('0.00');
    await draws.reverse(data.profit!.id, { reason: 'wrong amount' }, actor);
    room = await roomOf(cycle.id, seats[0].who);
    expect(room.profit!.availableEgp).toBe(profit.toFixed(2));
    // The history keeps both, each labelled, each undone once.
    const history = (await draws.takeForCycle(cycle.id)).data.taken;
    expect(history.map((h) => [h.kind, !!h.reversedAt]).sort()).toEqual([
      ['CAPITAL', true],
      ['PROFIT', true],
    ]);
    expect(
      (
        await refusal(
          draws.reverse(data.profit!.id, { reason: 'again' }, actor),
        )
      ).code,
    ).toBe('PROFIT_DRAW_ALREADY_REVERSED');
  });

  it('history: profit and capital in one list, newest first, each labelled', async () => {
    const { cycle, seats } = await paidCycle();
    await take(cycle.id, seats[0].who, 10, { takenOn: daysAgo(3) });
    await draws.takeCapital(
      cycle.id,
      { userId: seats[2].who.id, amountEgp: 20, takenOn: daysAgo(1) },
      actor,
    );
    await draws.create(
      cycle.id,
      { partnerUserId: seats[1].who.id, amountEgp: 30, drawnOn: daysAgo(2) },
      actor,
    );
    const history = (await draws.takeForCycle(cycle.id)).data.taken;
    expect(history.map((h) => [h.kind, h.amountEgp, h.takenOn])).toEqual([
      ['CAPITAL', '20.00', daysAgo(1)],
      ['PROFIT', '30.00', daysAgo(2)],
      ['PROFIT', '10.00', daysAgo(3)],
    ]);
  });

  // ─── Whole or nothing ───────────────────────────────────────────────

  it('the capital part failing after the profit part was written leaves no profit row and no cash moved', async () => {
    const { cycle, seats, profit } = await paidCycle();
    const cash = await cashOnHand();
    const spy = jest
      .spyOn(
        draws as unknown as {
          writeCapital: (...a: unknown[]) => Promise<unknown>;
        },
        'writeCapital',
      )
      .mockImplementationOnce(() =>
        Promise.reject(new Error('the connection dropped')),
      );
    try {
      await expect(
        take(cycle.id, seats[0].who, profit.add(100).toNumber()),
      ).rejects.toThrow('the connection dropped');
    } finally {
      spy.mockRestore();
    }
    expect(await writes(cycle.id)).toEqual({ rows: [], cash: [] });
    expect(await cashOnHand()).toBe(cash);
  });

  it('two at once for the whole total: one is taken, the other refused', async () => {
    const { cycle, seats, total } = await paidCycle();
    const results = await Promise.allSettled([
      take(cycle.id, seats[0].who, total.toNumber()),
      take(cycle.id, seats[0].who, total.toNumber()),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await writes(cycle.id)).rows).toHaveLength(2);
  });

  // ─── Limits and the wrong context ───────────────────────────────────

  it('zero, negative, three decimals, not a number, dated tomorrow: refused before anything moves', async () => {
    const { cycle, seats } = await paidCycle();
    const a = seats[0].who;
    for (const bad of [0, -5, 'abc']) {
      expect((await refusal(take(cycle.id, a, bad))).code).toBe(
        'PROFIT_DRAW_AMOUNT_NOT_POSITIVE',
      );
    }
    expect((await refusal(take(cycle.id, a, 1.005))).code).toBe(
      'PROFIT_DRAW_AMOUNT_PRECISION',
    );
    const r = await refusal(take(cycle.id, a, 10, { takenOn: daysAhead(1) }));
    expect(r).toMatchObject({ code: 'DATE_IN_FUTURE' });
    expect(r.params).toMatchObject({ label: 'MONEY_TAKEN' });
    expect(await writes(cycle.id)).toEqual({ rows: [], cash: [] });
  });

  it('someone not on the cycle, on another cycle only, a user that does not exist, bad ids', async () => {
    const { cycle } = await paidCycle();
    const other = await paidCycle();
    expect((await refusal(take(cycle.id, other.seats[0].who, 10))).code).toBe(
      'CAPITAL_BACK_NOT_ON_CYCLE',
    );
    expect(
      await refusal(take(cycle.id, { id: randomUUID() }, 10)),
    ).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(await refusal(take(cycle.id, { id: 'nope' }, 10))).toMatchObject({
      status: 404,
    });
    expect(
      await refusal(take(randomUUID(), other.seats[0].who, 10)),
    ).toMatchObject({ status: 404 });
    expect(await refusal(take('nope', other.seats[0].who, 10))).toMatchObject({
      status: 404,
    });
    expect(await refusal(draws.takeForCycle('nope'))).toMatchObject({
      status: 404,
    });
    expect(await writes(cycle.id)).toEqual({ rows: [], cash: [] });
  });

  it('a closed, cancelled or settling cycle, or an approved settlement: nothing taken', async () => {
    for (const status of ['CLOSED', 'CANCELLED', 'SETTLEMENT'] as const) {
      const { cycle, seats } = await paidCycle();
      await prisma.importCycle.update({
        where: { id: cycle.id },
        data: { status },
      });
      expect((await refusal(take(cycle.id, seats[0].who, 1))).code).toBe(
        'PROFIT_DRAW_CYCLE_LOCKED',
      );
      expect((await draws.takeForCycle(cycle.id)).data.locked).toBe(status);
    }
    const { cycle, seats } = await paidCycle();
    const calc = (await settlements.calculate(cycle.id, actor)).data!;
    await settlements.approve(calc.id, actor);
    expect((await refusal(take(cycle.id, seats[2].who, 1))).code).toBe(
      'PROFIT_DRAW_CYCLE_LOCKED',
    );
    expect((await draws.takeForCycle(cycle.id)).data.locked).toBe(
      'SETTLEMENT_APPROVED',
    );
  });

  it('taken after the figures were worked out: approval refuses until calculated again', async () => {
    const { cycle, seats, profit } = await paidCycle();
    const calc = (await settlements.calculate(cycle.id, actor)).data!;
    await take(cycle.id, seats[0].who, profit.add(10).toNumber());
    expect((await refusal(settlements.approve(calc.id, actor))).code).toBe(
      'SETTLEMENT_STALE_DRAWS',
    );
  });

  // Production's pool holds one connection (connection_limit=1), so a read made
  // outside the transaction waits for the connection the transaction holds and
  // hangs (P2028). This suite's larger pool hides that; this client does not.
  it('takes both parts on a single connection, as production does', async () => {
    const { cycle, seats, profit } = await paidCycle();
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
      const costing = new CostingService(db);
      const single = new ProfitDrawsService(
        db,
        audit,
        new SettlementsService(db, audit, costing),
        costing,
      );
      const { data } = await single.take(
        cycle.id,
        { userId: seats[0].who.id, amountEgp: profit.add(100).toNumber() },
        actor,
      );
      expect(data.profit).not.toBeNull();
      expect(data.capital).not.toBeNull();
      await expect(single.takeForCycle(cycle.id)).resolves.toBeDefined();
    } finally {
      await one.$disconnect();
    }
  });
});
