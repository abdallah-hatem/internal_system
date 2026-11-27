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
 * A temporary investor paid out and taken off a cycle before it settles
 * (BUSINESS_LOGIC §8, owner 2026-11-27: "we want to kick them both out by
 * giving them their money" — with their profit "until today with all
 * expenses"), against a real Postgres.
 *
 * Built as CYC-2026-0001 stands (CLAUDE.md §4): an order, a leg, a delivery,
 * a checked-in receipt, confirmed sales paid in part, a cycle expense — the
 * partners Abdallah 55,000, Shady 45,584.50, Fares 45,584.49 and the
 * investors Ahmad Eraiby and Mohamed Osama 27,500 each, a profit of exactly
 * 34,433.90. Then: the payout, both exits, the settlement after, a cost after,
 * the second time, the wrong person, a locked cycle, a loss, the Take money
 * room afterwards, and reversing the settlement.
 *
 *   INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/motorcycle_parts_<name> \
 *     npx jest investor-exit.db --runInBand
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
  put: number | string;
  fee?: number;
};

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const PROFIT = '34433.90';

suite('an investor paid out and removed (Postgres)', () => {
  jest.setTimeout(120_000);

  let prisma: PrismaClient;
  let draws: ProfitDrawsService;
  let deliveries: DeliveriesService;
  let inventory: InventoryService;
  let sales: SalesService;
  let payments: PaymentsService;
  let settlements: SettlementsService;
  let cycles: CyclesService;
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
        email: `exit-${name.toLowerCase()}-${tag}@example.test`,
        passwordHash: 'x',
        role,
        partner: { create: { displayName: `${name} ${tag}` } },
      },
    });
  }

  /** CYC-2026-0001's five. */
  const cycleOne = async (): Promise<Seat[]> => [
    { who: await person('Abdallah'), type: 'CORE_PARTNER', put: 55000 },
    { who: await person('Shady'), type: 'CORE_PARTNER', put: '45584.50' },
    { who: await person('Fares'), type: 'CORE_PARTNER', put: '45584.49' },
    {
      who: await person('Eraiby', 'TEMP_INVESTOR'),
      type: 'TEMP_INVESTOR',
      put: 27500,
    },
    {
      who: await person('Osama', 'TEMP_INVESTOR'),
      type: 'TEMP_INVESTOR',
      put: 27500,
    },
  ];

  async function expense(cycleId: string, amount: Prisma.Decimal.Value) {
    await prisma.financialTransaction.create({
      data: {
        type: 'EXPENSE',
        category: 'customs',
        direction: 'OUTFLOW',
        amount,
        currency: 'EGP',
        cycleId,
        occurredOn: new Date(`${daysAgo(1)}T00:00:00Z`),
        reason: 'customs',
        createdBy: actor,
      },
    });
  }

  const profitNow = async (cycleId: string) =>
    (await settlements.project(cycleId))!.pnl.grossProfit;

  /**
   * A cycle as the business makes it: 1,000 ordered at 200 and a 1,168.99
   * leg (201,168.99 to fund — what the five put in), all delivered and
   * checked in, 400 sold at 300 to a verified shop, 95.04% of it paid, and a
   * customs bill that brings the profit to exactly 34,433.90.
   */
  async function cycleLikeOne(seats?: Seat[], opts: { pay?: number } = {}) {
    const who = seats ?? (await cycleOne());
    const tag = randomUUID().slice(0, 8);
    const cycle = await prisma.importCycle.create({
      data: {
        code: `EXIT-${tag}`,
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
            partnerUserId: s.type === 'CORE_PARTNER' ? s.who.id : null,
            investorUserId: s.type === 'TEMP_INVESTOR' ? s.who.id : null,
            contributionAmount: s.put,
            investorFeePct: s.fee ?? null,
            createdAt: new Date(joined + i * 1000),
            updatedAt: new Date(joined + i * 1000),
          },
        }),
      );
    }
    const supplier = await prisma.supplier.create({
      data: { name: `Exit ${tag}`, country: 'AE' },
    });
    const product = await prisma.product.create({
      data: { sku: `EXIT-${tag}`, name: `Exit part ${tag}` },
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
        orderedQty: 1000,
        unitPrice: 200,
        lineTotal: 200000,
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
        amount: '1168.99',
        amountEgp: '1168.99',
      },
    });
    await prisma.shipmentDeparture.create({
      data: {
        legId: leg.id,
        departedOn: new Date(`${daysAgo(20)}T00:00:00Z`),
        lines: { create: [{ purchaseOrderItemId: item.id, qty: 1000 }] },
      },
    });
    const { data: delivery } = await deliveries.recordDelivery(
      leg.id,
      {
        arrivedOn: daysAgo(5),
        lines: [{ purchaseOrderItemId: item.id, qty: 1000 }],
      },
      actor,
    );
    const d = delivery as unknown as { id: string; lines: { id: string }[] };
    await inventory.verifyStock(
      cycle.id,
      {
        deliveryId: d.id,
        items: [{ deliveryLineId: d.lines[0].id, receivedQty: 1000 }],
      },
      actor,
    );
    const shop = await prisma.customer.create({
      data: {
        type: 'B2B',
        displayName: `Exit shop ${tag}`,
        verificationStatus: 'VERIFIED',
      },
    });
    await sales.create(
      {
        customerId: shop.id,
        channel: 'B2B',
        currency: 'EGP',
        items: [{ productId: product.id, quantity: 400, unitPrice: 300 }],
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
    if ((opts.pay ?? 114048) > 0) await pay(opts.pay ?? 114048);
    // The customs bill that makes it CYC-2026-0001's profit to the piastre.
    const before = await profitNow(cycle.id);
    await expense(cycle.id, before.sub(PROFIT));
    expect((await profitNow(cycle.id)).toFixed(2)).toBe(PROFIT);
    return { cycle, seats: who, participants, shop, product, pay };
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

  const exit = (cycleId: string, participantId: string, extra = {}) =>
    draws.exit(cycleId, participantId, extra, actor);

  const cashOnHand = async () => (await cashPosition(prisma)).cashOnHand;

  const roomOf = async (cycleId: string, who: Person) =>
    (await draws.takeForCycle(cycleId)).data.people.find(
      (p) => p.userId === who.id,
    )!;

  async function settle(cycleId: string) {
    const calc = (await settlements.calculate(cycleId, actor)).data!;
    await settlements.approve(calc.id, actor);
    await settlements.markPaid(calc.id, actor, { acceptRemainingStock: true });
    return calc.id;
  }

  /** Each participant's payable lines on a settlement, summed, by participant. */
  async function payable(settlementId: string) {
    const lines = await prisma.settlementLine.findMany({
      where: { settlementId },
    });
    const out = new Map<string, Prisma.Decimal>();
    for (const l of lines) {
      if (l.component === 'INVESTOR_FEE') continue;
      out.set(
        l.participantId,
        (out.get(l.participantId) ?? D(0)).add(l.amount),
      );
    }
    return out;
  }

  /** All money the business handed out on a cycle: exits, draws, payouts. */
  async function paidOut(cycleId: string) {
    const rows = await prisma.financialTransaction.findMany({
      where: {
        cycleId,
        category: { in: ['profit_draw', 'capital_back_early', 'settlement'] },
      },
    });
    return rows.reduce(
      (s, r) => (r.direction === 'OUTFLOW' ? s.add(r.amount) : s.sub(r.amount)),
      D(0),
    );
  }

  // ─── The payout ─────────────────────────────────────────────────────

  it('CYC-2026-0001: each investor is paid 27,500 + 4,707.15 = 32,207.15 — beyond what the card allows — and the profit does not move', async () => {
    const { cycle, seats, participants } = await cycleLikeOne();
    // The card today: only what customers have paid for.
    const card = await roomOf(cycle.id, seats[3].who);
    expect(D(card.availableEgp).lt('32207.15')).toBe(true);

    const { data: preview } = await draws.exitPreview(
      cycle.id,
      participants[3].id,
    );
    expect(preview).toMatchObject({
      cycleProfitEgp: PROFIT,
      sharePct: '13.6701',
      capitalEgp: '27500.00',
      profitEgp: '4707.15',
      investorFeeEgp: '0.00',
      takenProfitEgp: '0.00',
      takenCapitalEgp: '0.00',
      payProfitEgp: '4707.15',
      payCapitalEgp: '27500.00',
      payoutEgp: '32207.15',
    });

    const cash = await cashOnHand();
    const { data } = await exit(cycle.id, participants[3].id, {
      note: 'leaving',
    });
    expect(data.payoutEgp).toBe('32207.15');
    expect(data.exitedOn).toBe(businessToday());
    expect((await cashOnHand()).toFixed(2)).toBe(
      cash.sub('32207.15').toFixed(2),
    );
    // Two rows, in their own categories, owned by the exit.
    const rows = await prisma.profitDraw.findMany({
      where: { cycleId: cycle.id },
      orderBy: { kind: 'asc' },
    });
    expect(
      rows.map((r) => [r.kind, r.amountEgp.toFixed(2), r.exitParticipantId]),
    ).toEqual([
      ['DRAW', '4707.15', participants[3].id],
      ['CAPITAL', '27500.00', participants[3].id],
    ]);
    // "The profit we made does not change."
    expect((await profitNow(cycle.id)).toFixed(2)).toBe(PROFIT);
    const frozen = await prisma.cycleParticipant.findUniqueOrThrow({
      where: { id: participants[3].id },
    });
    expect({
      capital: frozen.exitCapitalEgp?.toFixed(2),
      profit: frozen.exitProfitEgp?.toFixed(2),
      paid: frozen.exitPaidEgp?.toFixed(2),
      pct: frozen.exitSharePct?.toFixed(4),
      basis: frozen.exitCycleProfitEgp?.toFixed(2),
    }).toEqual({
      capital: '27500.00',
      profit: '4707.15',
      paid: '32207.15',
      pct: '13.6701',
      basis: PROFIT,
    });
    // On the card: shown, nothing to take.
    const after = await roomOf(cycle.id, seats[3].who);
    expect(after.availableEgp).toBe('0.00');
    expect(after.exit).toMatchObject({
      paidEgp: '32207.15',
      capitalEgp: '27500.00',
      profitEgp: '4707.15',
    });
  });

  it('both exit, then the settlement: the partners split 34,433.90 − 9,414.30 by contribution; the investors are paid 0; everything paid = capital + profit', async () => {
    const { cycle, participants } = await cycleLikeOne();
    const first = (await exit(cycle.id, participants[3].id)).data;
    const second = (await exit(cycle.id, participants[4].id)).data;
    expect(first.payoutEgp).toBe('32207.15');
    expect(second.payoutEgp).toBe('32207.15');

    const id = await settle(cycle.id);
    const lines = await prisma.settlementLine.findMany({
      where: { settlementId: id },
    });
    const share = (pid: string) =>
      lines
        .filter(
          (l) => l.participantId === pid && l.component === 'PROFIT_SHARE',
        )
        .reduce((s, l) => s.add(l.amount), D(0));
    const partners = participants.slice(0, 3).map((p) => share(p.id));
    const partnersTotal = partners.reduce((s, x) => s.add(x), D(0));
    expect(partnersTotal.toFixed(2)).toBe(D(PROFIT).sub('9414.30').toFixed(2));
    // By contribution among the three: 55,000 of 146,168.99.
    expect(partners[0].toFixed(2)).toBe(
      partnersTotal
        .mul(55000)
        .div('146168.99')
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
        .toFixed(2),
    );
    expect(share(participants[3].id).toFixed(2)).toBe('4707.15');

    const pay = await payable(id);
    expect(pay.get(participants[3].id)!.toFixed(2)).toBe('0.00');
    expect(pay.get(participants[4].id)!.toFixed(2)).toBe('0.00');
    // No payout row for them; theirs left at the exit.
    const payouts = await prisma.financialTransaction.findMany({
      where: { relatedType: 'SETTLEMENT', relatedId: id },
    });
    expect(payouts).toHaveLength(3);
    // What the business paid out in all = all capital + the cycle's profit.
    expect((await paidOut(cycle.id)).toFixed(2)).toBe(
      D('201168.99').add(PROFIT).toFixed(2),
    );
    // The breakdown names them as exited.
    const { data: s } = await settlements.findOne(id);
    const exited = s.breakdown!.participants.find(
      (p) => p.participantId === participants[3].id,
    )!;
    expect(exited).toMatchObject({
      exitedOn: businessToday(),
      exitPaidEgp: '32207.15',
      paidEgp: '0.00',
    });
  });

  it('a cost recorded after the exit comes off the remaining partners only', async () => {
    const { cycle, participants } = await cycleLikeOne();
    await exit(cycle.id, participants[3].id);
    await expense(cycle.id, 10_000);
    const lines = (await settlements.project(cycle.id))!.distribution.lines;
    expect(lines[3].netProfit.toFixed(2)).toBe('4707.15');
    const others = lines
      .filter((_, i) => i !== 3)
      .reduce((s, l) => s.add(l.grossProfit), D(0));
    expect(others.toFixed(2)).toBe(
      D(PROFIT).sub(10_000).sub('4707.15').toFixed(2),
    );
    // Osama, still on the cycle, bears his part of it.
    expect(lines[4].grossProfit.lt('4707.15')).toBe(true);
  });

  it('what he took on the card first comes off: the payout is the rest, and the settlement still pays him nothing', async () => {
    const { cycle, seats, participants } = await cycleLikeOne();
    const room = await roomOf(cycle.id, seats[3].who);
    await draws.take(
      cycle.id,
      { userId: seats[3].who.id, amountEgp: Number(room.availableEgp) },
      actor,
    );
    const { data } = await draws.exitPreview(cycle.id, participants[3].id);
    const taken = D(data.takenProfitEgp).add(data.takenCapitalEgp);
    expect(taken.toFixed(2)).toBe(D(room.availableEgp).toFixed(2));
    expect(D(data.payoutEgp).add(taken).toFixed(2)).toBe('32207.15');
    await exit(cycle.id, participants[3].id);
    const id = await settle(cycle.id);
    expect((await payable(id)).get(participants[3].id)!.toFixed(2)).toBe(
      '0.00',
    );
    expect((await paidOut(cycle.id)).toFixed(2)).toBe(
      D('201168.99').add(PROFIT).toFixed(2),
    );
  });

  it('an investor with a fee: paid net of it; the fee reaches the partners at settlement, the sums still close', async () => {
    const seats = await cycleOne();
    seats[3].fee = 20;
    const { cycle, participants } = await cycleLikeOne(seats);
    const { data } = await exit(cycle.id, participants[3].id);
    expect(data.grossProfitEgp).toBe('4707.15');
    expect(data.investorFeeEgp).toBe('941.43');
    expect(data.profitEgp).toBe('3765.72');
    expect(data.payoutEgp).toBe('31265.72');
    const id = await settle(cycle.id);
    const fees = await prisma.settlementLine.findMany({
      where: { settlementId: id, component: 'INVESTOR_FEE_RECEIVED' },
    });
    expect(fees.reduce((s, l) => s.add(l.amount), D(0)).toFixed(2)).toBe(
      '941.43',
    );
    expect((await paidOut(cycle.id)).toFixed(2)).toBe(
      D('201168.99').add(PROFIT).toFixed(2),
    );
  });

  // ─── Take money after the exit ──────────────────────────────────────

  it('the partners advanced it: their Take money room shrinks by what the exit paid, and taking more than that is refused', async () => {
    const { cycle, seats, participants } = await cycleLikeOne();
    const before = await roomOf(cycle.id, seats[0].who);
    await exit(cycle.id, participants[3].id);
    await exit(cycle.id, participants[4].id);
    const { data } = await draws.takeForCycle(cycle.id);
    const partners = data.people.slice(0, 3);
    // Profit: what is collected less the 9,414.30 the exits paid as profit.
    const collected = D(data.collectedProfitEgp);
    const profitRoom = partners.reduce(
      (s, p) => s.add(p.profit!.availableEgp),
      D(0),
    );
    expect(profitRoom.sub(collected.sub('9414.30')).abs().lte('0.02')).toBe(
      true,
    );
    // Capital: what was recovered less the 55,000 paid out of it.
    // The recovered share of what everyone put in (the cost to fund counts
    // the cycle's expenses too, so it is more than the 201,168.99 put in).
    const recovered = D(data.recoveredEgp).div(data.toFundEgp).mul('201168.99');
    const capitalRoom = partners.reduce(
      (s, p) => s.add(p.capital.availableEgp),
      D(0),
    );
    expect(capitalRoom.lte(recovered.sub(55000))).toBe(true);
    expect(capitalRoom.gt(recovered.sub(55000).sub(1))).toBe(true);
    const after = partners[0];
    expect(D(after.availableEgp).lt(before.availableEgp)).toBe(true);
    // Everyone takes all he may: the cash taken never exceeds what came in
    // for them — nobody takes the advanced money again.
    for (const p of partners) {
      await draws.take(
        cycle.id,
        { userId: p.userId, amountEgp: Number(p.availableEgp) },
        actor,
      );
    }
    const r = await refusal(
      draws.take(cycle.id, { userId: seats[0].who.id, amountEgp: 0.01 }, actor),
    );
    expect(r.code).toBe('TAKE_OVER_AVAILABLE');
  });

  it('an exited investor cannot take, nor have what he took undone; his contribution and split are frozen', async () => {
    const { cycle, seats, participants } = await cycleLikeOne();
    await exit(cycle.id, participants[3].id);
    expect(
      (
        await refusal(
          draws.take(
            cycle.id,
            { userId: seats[3].who.id, amountEgp: 1 },
            actor,
          ),
        )
      ).code,
    ).toBe('EXIT_PARTICIPANT_EXITED');
    const row = await prisma.profitDraw.findFirstOrThrow({
      where: { cycleId: cycle.id, kind: 'DRAW' },
    });
    expect(
      (await refusal(draws.reverse(row.id, { reason: 'oops' }, actor))).code,
    ).toBe('EXIT_PARTICIPANT_EXITED');
    expect(
      (
        await refusal(
          cycles.updateParticipant(
            participants[3].id,
            { contributionAmount: 1 },
            actor,
          ),
        )
      ).code,
    ).toBe('EXIT_PARTICIPANT_EXITED');
  });

  // ─── Refusals ───────────────────────────────────────────────────────

  it('twice: the second exit is refused and nothing more is paid', async () => {
    const { cycle, participants } = await cycleLikeOne();
    await exit(cycle.id, participants[3].id);
    const cash = await cashOnHand();
    const r = await refusal(exit(cycle.id, participants[3].id));
    expect(r).toMatchObject({ status: 400, code: 'EXIT_ALREADY_EXITED' });
    expect((await cashOnHand()).toFixed(2)).toBe(cash.toFixed(2));
    expect(
      (await refusal(draws.exitPreview(cycle.id, participants[3].id))).code,
    ).toBe('EXIT_ALREADY_EXITED');
  });

  it('two at once: one is paid, the other refused', async () => {
    const { cycle, participants } = await cycleLikeOne();
    const results = await Promise.allSettled([
      exit(cycle.id, participants[3].id),
      exit(cycle.id, participants[3].id),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      await prisma.profitDraw.count({ where: { cycleId: cycle.id } }),
    ).toBe(2);
  });

  it('a core partner is refused: only an investor exits', async () => {
    const { cycle, participants } = await cycleLikeOne();
    const r = await refusal(exit(cycle.id, participants[0].id));
    expect(r).toMatchObject({ status: 400, code: 'EXIT_NOT_AN_INVESTOR' });
  });

  it("someone else's cycle, an unknown id, a malformed id: 404, never a 500", async () => {
    const a = await cycleLikeOne();
    const b = await cycleLikeOne();
    expect((await refusal(exit(a.cycle.id, b.participants[3].id))).status).toBe(
      404,
    );
    expect((await refusal(exit(a.cycle.id, randomUUID()))).status).toBe(404);
    expect((await refusal(exit(a.cycle.id, 'nope'))).status).toBe(404);
    expect(
      (await refusal(exit(randomUUID(), a.participants[3].id))).status,
    ).toBe(404);
  });

  it('dated forward: refused; dated today or before: recorded on that day', async () => {
    const { cycle, participants } = await cycleLikeOne();
    const r = await refusal(
      exit(cycle.id, participants[3].id, { exitedOn: daysAhead(1) }),
    );
    expect(r.code).toBe('DATE_IN_FUTURE');
    expect(r.params?.label).toBe('INVESTOR_EXITED');
    const { data } = await exit(cycle.id, participants[3].id, {
      exitedOn: daysAgo(2),
    });
    expect(data.exitedOn).toBe(daysAgo(2));
  });

  it('a cycle being settled, or settled, is refused', async () => {
    const { cycle, participants } = await cycleLikeOne();
    const calc = (await settlements.calculate(cycle.id, actor)).data!;
    await settlements.approve(calc.id, actor);
    expect((await refusal(exit(cycle.id, participants[3].id))).code).toBe(
      'EXIT_CYCLE_LOCKED',
    );
    await settlements.markPaid(calc.id, actor, { acceptRemainingStock: true });
    expect((await refusal(exit(cycle.id, participants[3].id))).code).toBe(
      'EXIT_CYCLE_LOCKED',
    );
  });

  it('a draft settlement calculated before the exit is stale: approving it is refused until calculated again', async () => {
    const { cycle, participants } = await cycleLikeOne();
    const draft = (await settlements.calculate(cycle.id, actor)).data!;
    await exit(cycle.id, participants[3].id);
    const r = await refusal(settlements.approve(draft.id, actor));
    expect(['SETTLEMENT_STALE_FUNDING', 'SETTLEMENT_STALE_DRAWS']).toContain(
      r.code,
    );
    const again = (await settlements.calculate(cycle.id, actor)).data!;
    await settlements.approve(again.id, actor);
  });

  it('no split yet (nothing contributed): refused with the split’s own code, nothing written', async () => {
    const seats = (await cycleOne()).map((s) => ({ ...s, put: 0 }));
    const tag = randomUUID().slice(0, 8);
    const cycle = await prisma.importCycle.create({
      data: {
        code: `EXIT0-${tag}`,
        originType: 'UAE_DIRECT',
        currency: 'EGP',
        status: 'SELLING',
      },
    });
    const ps = [];
    for (const [i, s] of seats.entries()) {
      ps.push(
        await prisma.cycleParticipant.create({
          data: {
            cycleId: cycle.id,
            participantType: s.type,
            partnerUserId: s.type === 'CORE_PARTNER' ? s.who.id : null,
            investorUserId: s.type === 'TEMP_INVESTOR' ? s.who.id : null,
            contributionAmount: 0,
            createdAt: new Date(Date.now() - 60_000 + i * 1000),
          },
        }),
      );
    }
    expect((await refusal(exit(cycle.id, ps[3].id))).code).toBe(
      'CYCLE_NOT_FUNDED',
    );
    expect(
      await prisma.profitDraw.count({ where: { cycleId: cycle.id } }),
    ).toBe(0);
  });

  // ─── A loss ─────────────────────────────────────────────────────────

  it('a loss (GUESS): he takes his capital less his share of the loss', async () => {
    const { cycle, participants } = await cycleLikeOne();
    await expense(cycle.id, D(PROFIT).add(10_000));
    expect((await profitNow(cycle.id)).toFixed(2)).toBe('-10000.00');
    const { data } = await exit(cycle.id, participants[3].id);
    expect(data.profitEgp).toBe('-1367.01');
    expect(data.payProfitEgp).toBe('0.00');
    expect(data.payCapitalEgp).toBe('26132.99');
    expect(data.payoutEgp).toBe('26132.99');
    const id = await settle(cycle.id);
    expect((await payable(id)).get(participants[3].id)!.toFixed(2)).toBe(
      '0.00',
    );
    expect((await paidOut(cycle.id)).toFixed(2)).toBe(
      D('201168.99').sub(10_000).toFixed(2),
    );
  });

  it('a loss bigger than what he has left after taking capital early: refused, he would owe the business', async () => {
    const { cycle, seats, participants } = await cycleLikeOne();
    const room = await roomOf(cycle.id, seats[3].who);
    await draws.take(
      cycle.id,
      { userId: seats[3].who.id, amountEgp: Number(room.availableEgp) },
      actor,
    );
    await expense(cycle.id, 300_000);
    const r = await refusal(exit(cycle.id, participants[3].id));
    expect(r).toMatchObject({ status: 400, code: 'EXIT_PAYOUT_NEGATIVE' });
    expect(
      await prisma.cycleParticipant.count({
        where: { id: participants[3].id, exitedOn: { not: null } },
      }),
    ).toBe(0);
  });

  // ─── Reversing the settlement ───────────────────────────────────────

  it('reversing the settlement leaves the exits standing; settling again pays the same', async () => {
    const { cycle, participants } = await cycleLikeOne();
    await exit(cycle.id, participants[3].id);
    await exit(cycle.id, participants[4].id);
    const id = await settle(cycle.id);
    const firstPay = await payable(id);
    await settlements.reverse(id, 'recount', actor);
    const still = await prisma.cycleParticipant.findMany({
      where: { cycleId: cycle.id, exitedOn: { not: null } },
    });
    expect(still).toHaveLength(2);
    // Undoing an exit's payment is still refused.
    const row = await prisma.profitDraw.findFirstOrThrow({
      where: { exitParticipantId: participants[3].id, kind: 'CAPITAL' },
    });
    expect(row.settledById).toBeNull();
    expect(
      (await refusal(draws.reverse(row.id, { reason: 'x' }, actor))).code,
    ).toBe('EXIT_PARTICIPANT_EXITED');
    const again = await settle(cycle.id);
    const secondPay = await payable(again);
    for (const p of participants) {
      expect(secondPay.get(p.id)!.toFixed(2)).toBe(
        firstPay.get(p.id)!.toFixed(2),
      );
    }
    expect((await paidOut(cycle.id)).toFixed(2)).toBe(
      D('201168.99').add(PROFIT).toFixed(2),
    );
  });
});
