import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- this suite talks to a real, throwaway Postgres; that is its point
import { PrismaClient, Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { CostingService } from '../costing/costing.service';
import { CyclesService } from '../cycles/cycles.service';
import { InventoryService } from '../inventory/inventory.service';
import { LendersService } from '../lenders/lenders.service';
import { PaymentsService } from '../payments/payments.service';
import { SalesService } from '../sales/sales.service';
import { SettlementsService } from '../settlements/settlements.service';
import { DeliveriesService } from './deliveries.service';
import { HandoversService } from './handovers.service';
import { ShippingService } from './shipping.service';
import { exchangeDifferenceEgp } from '../../common/lender-debt';
import { cycleFreightIsEstimate } from '../../common/leg-handovers';
import { quietRunningCosts } from '../../common/running-costs-quiet-spec';

/**
 * A UAE leg in handovers (BUSINESS_LOGIC §1, §2, §18 — owner 2026-11-20).
 *
 * Against a real Postgres, because a handover is written through the
 * shipment's own departures, deliveries and losses and its freight re-costs
 * batches, purchase rows and sale allocations written by the real receipt
 * and sale services. Every fixture goes through those services: an order,
 * leg 1 leaving and arriving in Ajman, leg 2 added in handovers, arrivals,
 * a verified receipt, a walk-in sale.
 *
 * Runs only when INTEGRATION_DATABASE_URL points at a THROWAWAY database
 * with the migrations applied — an agent's own (`scripts/agent-env.sh`):
 *
 *   INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/motorcycle_parts_<name> \
 *     npx jest handovers.db --runInBand
 */
// eslint-disable-next-line no-restricted-properties -- an opt-in switch for a suite that must never run by default
const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

suite('a UAE leg in handovers (Postgres)', () => {
  jest.setTimeout(60_000);

  let prisma: PrismaClient;
  let shipping: ShippingService;
  let deliveries: DeliveriesService;
  let handovers: HandoversService;
  let inventory: InventoryService;
  let sales: SalesService;
  let settlements: SettlementsService;
  let analytics: AnalyticsService;
  let lenders: LendersService;
  let cycles: CyclesService;
  /** Two core partners; SHADY pays freight from his pocket. */
  let ABDALLAH: string;
  let SHADY: string;
  let INVESTOR: string;

  async function partner(name: string) {
    const id = randomUUID();
    await prisma.user.create({
      data: {
        id,
        email: `handover-${name}-${id}@example.test`,
        passwordHash: 'x',
        role: 'CORE_PARTNER',
        partner: { create: { displayName: `${name} ${id.slice(0, 4)}` } },
      },
    });
    return id;
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const db = prisma as unknown as PrismaService;
    const audit = { log: jest.fn() } as unknown as AuditService;
    const notifications = {
      createForMultipleUsers: jest.fn(),
      create: jest.fn(),
    } as unknown as NotificationsService;
    const costing = new CostingService(db);
    cycles = new CyclesService(db, audit, notifications, costing);
    deliveries = new DeliveriesService(
      db,
      audit,
      notifications,
      costing,
      cycles,
    );
    shipping = new ShippingService(db, audit, costing, deliveries);
    handovers = new HandoversService(db, audit, costing, cycles, deliveries);
    inventory = new InventoryService(db, audit, notifications, costing, cycles);
    sales = new SalesService(db, audit, new PaymentsService(db, audit), {
      createForMultipleUsers: () => Promise.resolve({ count: 0 }),
    });
    settlements = new SettlementsService(db, audit, costing);
    analytics = new AnalyticsService(db);
    lenders = new LendersService(db, audit, notifications, costing);
    ABDALLAH = await partner('Abdallah');
    SHADY = await partner('Shady');
    INVESTOR = randomUUID();
    await prisma.user.create({
      data: {
        id: INVESTOR,
        email: `handover-investor-${INVESTOR}@example.test`,
        passwordHash: 'x',
        role: 'TEMP_INVESTOR',
      },
    });
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => quietRunningCosts(prisma));

  // ─── Fixtures, through the services ─────────────────────────────────────

  /**
   * CYC-2026-0002's shape: a China cycle whose 400 pieces all reached Ajman.
   * A: 250 pieces for 25,000 EGP (100 each), B: 150 for 15,000 (100 each).
   * Leg 1 free. Two partners fund it 50/50. Leg 2 added in handovers.
   */
  async function inAjman() {
    const tag = randomUUID().slice(0, 8);
    const supplier = await prisma.supplier.create({
      data: { name: `Handover ${tag}`, country: 'CN' },
    });
    const cycle = await prisma.importCycle.create({
      data: {
        code: `HO-${tag}`,
        originType: 'CHINA',
        currency: 'EGP',
        status: 'PREPARING',
      },
    });
    const po = await prisma.purchaseOrder.create({
      data: {
        cycleId: cycle.id,
        supplierId: supplier.id,
        reference: `PO-${tag}`,
        currency: 'EGP',
        fxRateToEgp: 1,
        orderedOn: new Date('2026-09-20T00:00:00Z'),
        status: 'CONFIRMED',
      },
    });
    const items = [];
    const products = [];
    for (const [i, qty] of [250, 150].entries()) {
      const product = await prisma.product.create({
        data: { sku: `HO-${tag}-${i}`, name: `Handover part ${tag}-${i}` },
      });
      products.push(product);
      items.push(
        await prisma.purchaseOrderItem.create({
          data: {
            purchaseOrderId: po.id,
            productId: product.id,
            orderedQty: qty,
            unitPrice: 100,
            lineTotal: qty * 100,
          },
        }),
      );
    }
    for (const who of [ABDALLAH, SHADY]) {
      const p = await prisma.cycleParticipant.create({
        data: {
          cycleId: cycle.id,
          participantType: 'CORE_PARTNER',
          partnerUserId: who,
          contributionAmount: 20_000,
        },
      });
      await prisma.financialTransaction.create({
        data: {
          type: 'CAPITAL_CONTRIBUTION',
          category: 'contribution',
          direction: 'INFLOW',
          amount: 20_000,
          currency: 'EGP',
          cycleId: cycle.id,
          relatedType: 'CYCLE_PARTICIPANT',
          relatedId: p.id,
          createdBy: ABDALLAH,
        },
      });
    }
    const { data: leg1 } = await shipping.createLeg(
      cycle.id,
      {
        sequence: 1,
        departedOn: '2026-10-01',
        costBasis: 'FLAT',
        amount: 0,
      },
      ABDALLAH,
    );
    await deliveries.recordDelivery(
      leg1.id,
      {
        arrivedOn: '2026-11-01',
        lines: items.map((it, i) => ({
          purchaseOrderItemId: it.id,
          qty: [250, 150][i],
        })),
      },
      ABDALLAH,
    );
    const provider = await prisma.provider.create({
      data: { name: `Gulf Freight ${tag}` },
    });
    const { data: leg2 } = await shipping.createLeg(
      cycle.id,
      { sequence: 2, usesHandovers: true },
      ABDALLAH,
    );
    return {
      cycle,
      leg1,
      leg2,
      items,
      products,
      provider,
      A: items[0].id,
      B: items[1].id,
    };
  }
  type World = Awaited<ReturnType<typeof inAjman>>;

  async function refusal(p: Promise<unknown>) {
    try {
      await p;
    } catch (e) {
      if (!(e instanceof HttpException)) throw e;
      const body = e.getResponse() as {
        code: string;
        params?: Record<string, unknown>;
      };
      return body.code === 'NOT_FOUND'
        ? `NOT_FOUND:${String(body.params?.entity)}`
        : body.code;
    }
    throw new Error('expected a refusal, got success');
  }

  const handOver = (
    w: World,
    over: Partial<Parameters<HandoversService['create']>[1]> = {},
  ) =>
    handovers
      .create(
        w.leg2.id,
        {
          handedOverOn: '2026-11-03',
          providerId: w.provider.id,
          freightAmount: 6000,
          freightCurrency: 'AED',
          freightRateToEgp: 15,
          ...over,
        },
        ABDALLAH,
      )
      .then((r) => r.data);

  const arrive = (
    w: World,
    handoverId: string | undefined,
    lines: [string, number][],
    arrivedOn = '2026-11-10',
  ) =>
    handovers
      .recordArrival(
        w.leg2.id,
        {
          handoverId,
          arrivedOn,
          lines: lines.map(([purchaseOrderItemId, qty]) => ({
            purchaseOrderItemId,
            qty,
          })),
        },
        ABDALLAH,
      )
      .then((r) => r.data);

  const legCost = async (w: World) =>
    (
      await prisma.shippingLeg.findUniqueOrThrow({ where: { id: w.leg2.id } })
    ).amountEgp!.toFixed(2);

  const leg2View = async (w: World) => {
    const shipment = (await cycles.getShipment(w.cycle.id)).data;
    const leg = shipment.legs.find((l) => l.legId === w.leg2.id)!;
    return {
      shipment,
      leg,
      h: leg.handovers as unknown as {
        handovers: {
          id: string;
          number: number;
          arrived: number;
          covered: number;
          toCome: number | null;
          open: boolean;
          paidBy: { name: string } | null;
          owed: { currency: string; owed: string } | null;
        }[];
        covered: number;
        legCostEgp: string;
        perPieceEgp: string | null;
        perPiece: { amount: string; currency: string } | null;
        final: boolean;
        stillInUae: number;
        withForwarder: number;
        withForwarderUnknown: number;
        arrived: number;
      },
    };
  };

  // ─── The happy path, once ────────────────────────────────────────────────

  it("The owner's example: 150 handed over for 6,000 AED (Shady paid), two arrivals, a second lot with no count for 4,200 AED, one arrival — 53.68 AED a piece, an estimate", async () => {
    const w = await inAjman();
    const h1 = await handOver(w, { pieces: 150, paidByUserId: SHADY });
    // Leg 2 left: the cycle walked on (§1, L3).
    expect(
      (
        await prisma.importCycle.findUniqueOrThrow({
          where: { id: w.cycle.id },
        })
      ).status,
    ).toBe('IN_TRANSIT_TO_EGYPT');
    // 90,000 EGP over the 150 it covers is 600 a piece; every one of the 400 carries it.
    expect(await legCost(w)).toBe('240000.00');

    await arrive(
      w,
      h1.id,
      [
        [w.A, 30],
        [w.B, 30],
      ],
      '2026-11-08',
    );
    await arrive(
      w,
      h1.id,
      [
        [w.A, 20],
        [w.B, 30],
      ],
      '2026-11-12',
    );
    const h2 = await handOver(w, {
      handedOverOn: '2026-11-10',
      freightAmount: 4200,
      pieces: null,
    });
    await arrive(
      w,
      h2.id,
      [
        [w.A, 25],
        [w.B, 15],
      ],
      '2026-11-14',
    );

    const { h, leg } = await leg2View(w);
    expect(
      h.handovers.map((x) => [
        x.number,
        x.arrived,
        x.covered,
        x.toCome,
        x.open,
      ]),
    ).toEqual([
      [1, 110, 150, 40, true],
      [2, 40, 40, null, true],
    ]);
    // 10,200 AED over 190 covered (150 counted + 40 arrived of the uncounted).
    expect(h.covered).toBe(190);
    expect(h.perPiece).toEqual({ amount: '53.68', currency: 'AED' });
    expect(h.perPieceEgp).toBe('805.26');
    // 153,000 × 400 ÷ 190
    expect(h.legCostEgp).toBe('322105.26');
    expect(await legCost(w)).toBe('322105.26');
    expect(h.final).toBe(false);
    // 400 reached Ajman, 150 arrived, 40 of handover 1 still with the forwarder.
    expect(h.arrived).toBe(150);
    expect(h.withForwarder).toBe(40);
    expect(h.withForwarderUnknown).toBe(1);
    expect(h.stillInUae).toBe(210);
    expect(leg.atOrigin).toBe(250);
    expect(leg.delivered).toBe(150);
    expect(h.handovers[0].paidBy?.name).toMatch(/^Shady/);
    expect(h.handovers[0].owed).toMatchObject({
      currency: 'AED',
      owed: '6000.00',
    });
    expect(await cycleFreightIsEstimate(prisma, w.cycle.id)).toBe(true);
    // The arrivals are ordinary deliveries of the leg: received the usual way.
    expect(leg.deliveries).toHaveLength(3);
  });

  // ─── The limits ──────────────────────────────────────────────────────────

  it('A handover without a count covers only what has arrived from it; with nothing arrived the leg carries what was paid', async () => {
    const w = await inAjman();
    const h = await handOver(w, {
      freightAmount: 1000,
      freightCurrency: 'EGP',
      freightRateToEgp: undefined,
    });
    expect(await legCost(w)).toBe('1000.00');
    const { h: before } = await leg2View(w);
    expect(before.perPieceEgp).toBeNull();
    expect(before.withForwarderUnknown).toBe(1);
    await arrive(w, h.id, [[w.A, 40]]);
    // 1,000 over 40 = 25 a piece, × 400.
    expect(await legCost(w)).toBe('10000.00');
  });

  it('More of a product than still waits in the UAE is refused; so is more than the handover held, before it, or in the future', async () => {
    const w = await inAjman();
    const h = await handOver(w, { pieces: 20 });
    expect(await refusal(arrive(w, h.id, [[w.B, 151]]))).toBe(
      'ARRIVAL_EXCEEDS_WAITING',
    );
    expect(
      await refusal(
        arrive(w, h.id, [
          [w.A, 15],
          [w.B, 6],
        ]),
      ),
    ).toBe('ARRIVAL_EXCEEDS_HANDOVER');
    await arrive(w, h.id, [[w.A, 15]]);
    // The second time: only 5 are left of its 20.
    expect(await refusal(arrive(w, h.id, [[w.A, 6]]))).toBe(
      'ARRIVAL_EXCEEDS_HANDOVER',
    );
    expect(await refusal(arrive(w, h.id, [[w.A, 1]], '2026-11-02'))).toBe(
      'ARRIVAL_BEFORE_HANDOVER',
    );
    expect(await refusal(arrive(w, h.id, [[w.A, 1]], '2099-01-01'))).toBe(
      'DATE_IN_FUTURE',
    );
    expect(await refusal(arrive(w, h.id, [[w.A, 0]]))).toBe('QTY_NOT_POSITIVE');
    // Nothing of the refused ones was written.
    const { h: after } = await leg2View(w);
    expect(after.handovers[0].arrived).toBe(15);
  });

  it('A handover: no future day, no negative freight, whole pieces only, never more pieces than are still in the UAE and not already with the forwarder', async () => {
    const w = await inAjman();
    expect(await refusal(handOver(w, { handedOverOn: '2099-01-01' }))).toBe(
      'DATE_IN_FUTURE',
    );
    expect(await refusal(handOver(w, { freightAmount: -1 }))).toBe(
      'LEG_COST_NEGATIVE',
    );
    expect(await refusal(handOver(w, { pieces: 1.5 }))).toBe(
      'HANDOVER_PIECES_WHOLE',
    );
    expect(await refusal(handOver(w, { pieces: 0 }))).toBe('QTY_NOT_POSITIVE');
    expect(await refusal(handOver(w, { pieces: 401 }))).toBe(
      'HANDOVER_PIECES_EXCEED_WAITING',
    );
    // Before anything reached Ajman (1 November).
    expect(await refusal(handOver(w, { handedOverOn: '2026-10-25' }))).toBe(
      'DEPARTURE_BEFORE_ARRIVAL',
    );
    await handOver(w, { pieces: 300 });
    // 100 left that are not with the forwarder.
    expect(await refusal(handOver(w, { pieces: 101 }))).toBe(
      'HANDOVER_PIECES_EXCEED_WAITING',
    );
    await handOver(w, { pieces: 100 });
    // A free lot is allowed (GUESS): freight 0, no count.
    await handOver(w, { freightAmount: 0, pieces: null });
    expect(
      await refusal(handOver(w, { freightAmount: 0, paidByUserId: SHADY })),
    ).toBe('HANDOVER_PAID_BY_NOTHING_PAID');
    expect(await refusal(handOver(w, { paidByUserId: INVESTOR }))).toBe(
      'LEDGER_PAYER_NOT_PARTNER',
    );
    expect(
      await refusal(
        handOver(w, { freightCurrency: 'XQZ', freightRateToEgp: undefined }),
      ),
    ).toBe('NO_RATE_RECORDED');
  });

  // ─── The wrong context ──────────────────────────────────────────────────

  it("Another cycle's handover, another cycle's product, a leg not leaving the UAE, a leg recorded the old way — refused", async () => {
    const w = await inAjman();
    const other = await inAjman();
    const theirs = await handOver(other, { pieces: 10 });
    expect(await refusal(arrive(w, theirs.id, [[w.A, 1]]))).toBe(
      'NOT_FOUND:handover',
    );
    const mine = await handOver(w, { pieces: 10 });
    expect(await refusal(arrive(w, mine.id, [[other.A, 1]]))).toBe(
      'NOT_FOUND:purchaseOrderItem',
    );
    expect(
      await refusal(
        handovers.create(
          w.leg1.id,
          { handedOverOn: '2026-11-03', freightAmount: 1 },
          ABDALLAH,
        ),
      ),
    ).toBe('HANDOVER_NOT_FROM_UAE');
    // The generic delivery and departure on a handover leg are refused.
    expect(
      await refusal(
        deliveries.recordDelivery(
          w.leg2.id,
          {
            arrivedOn: '2026-11-10',
            lines: [{ purchaseOrderItemId: w.A, qty: 1 }],
          },
          ABDALLAH,
        ),
      ),
    ).toBe('LEG_USES_HANDOVERS');
    expect(
      await refusal(
        deliveries.recordDeparture(
          w.leg2.id,
          { departedOn: '2026-11-03' },
          ABDALLAH,
        ),
      ),
    ).toBe('LEG_USES_HANDOVERS');
    // Its cost is its handovers'; never by weight.
    expect(
      await refusal(
        shipping.updateLeg(
          w.leg2.id,
          { costBasis: 'FLAT', amount: 5 },
          ABDALLAH,
        ),
      ),
    ).toBe('LEG_COST_FROM_HANDOVERS');
    expect(
      await refusal(
        shipping.updateLeg(
          w.leg2.id,
          { costBasis: 'PER_WEIGHT', ratePerUnit: 1, chargeableWeightKg: 1 },
          ABDALLAH,
        ),
      ),
    ).toBe('LEG_HANDOVERS_PER_PIECE');
    // A UAE leg recorded the old way stays on the old form.
    const old = await inAjman();
    await prisma.shippingLeg.update({
      where: { id: old.leg2.id },
      data: { usesHandovers: false },
    });
    await deliveries.recordDeparture(
      old.leg2.id,
      {
        departedOn: '2026-11-03',
        lines: [{ purchaseOrderItemId: old.A, qty: 5 }],
      },
      ABDALLAH,
    );
    expect(await refusal(handOver(old))).toBe('LEG_RECORDED_WITHOUT_HANDOVERS');
  });

  it('With two handovers open an arrival must say which; with one it is that one', async () => {
    const w = await inAjman();
    const h1 = await handOver(w, { pieces: 10 });
    await arrive(w, undefined, [[w.A, 2]]);
    await handOver(w, { pieces: 10 });
    expect(await refusal(arrive(w, undefined, [[w.A, 1]]))).toBe(
      'HANDOVER_REQUIRED',
    );
    const { h } = await leg2View(w);
    expect(h.handovers.find((x) => x.id === h1.id)!.arrived).toBe(2);
  });

  // ─── All arrived and losses ─────────────────────────────────────────────

  it('All arrived with pieces missing: the partner says which, they are lost at the full landed unit cost; the count must match', async () => {
    const w = await inAjman();
    const h = await handOver(w, {
      pieces: 10,
      freightAmount: 4000,
      freightCurrency: 'EGP',
      freightRateToEgp: 1,
    });
    await arrive(w, h.id, [[w.A, 8]]);
    // 4,000 over the 10 it covers → 400 a piece of freight, on top of 100 of goods.
    expect(
      await refusal(
        handovers.allArrived(
          h.id,
          { lost: [{ purchaseOrderItemId: w.A, qty: 1 }] },
          ABDALLAH,
        ),
      ),
    ).toBe('HANDOVER_LOST_MUST_MATCH');
    expect(await refusal(handovers.allArrived(h.id, {}, ABDALLAH))).toBe(
      'HANDOVER_LOST_MUST_MATCH',
    );
    await handovers.allArrived(
      h.id,
      { lost: [{ purchaseOrderItemId: w.B, qty: 2 }] },
      ABDALLAH,
    );
    const losses = await prisma.shipmentLoss.findMany({
      where: { legId: w.leg2.id },
    });
    expect(
      losses.map((l) => [
        l.qty.toString(),
        l.unitCostEgp.toFixed(4),
        l.costEgp.toFixed(2),
        l.departureId,
      ]),
    ).toEqual([['2', '500.0000', '1000.00', h.id]]);
    const { h: after, leg } = await leg2View(w);
    expect(after.handovers[0].open).toBe(false);
    expect(after.handovers[0].toCome).toBe(0);
    expect(leg.lost).toBe(2);
    // The second time: refused, nothing more lost.
    expect(await refusal(handovers.allArrived(h.id, {}, ABDALLAH))).toBe(
      'HANDOVER_ALREADY_ALL_ARRIVED',
    );
    expect(await refusal(arrive(w, h.id, [[w.A, 1]]))).toBe(
      'HANDOVER_ALL_ARRIVED',
    );
    // Its loss is taken back only by undoing All arrived.
    expect(await refusal(deliveries.takeBackLoss(losses[0].id, ABDALLAH))).toBe(
      'HANDOVER_LOSS_UNDO_ALL_ARRIVED',
    );
    await handovers.undoAllArrived(h.id, ABDALLAH);
    expect(
      await prisma.shipmentLoss.count({ where: { legId: w.leg2.id } }),
    ).toBe(0);
    const { h: reopened, leg: legAgain } = await leg2View(w);
    expect(reopened.handovers[0].open).toBe(true);
    expect(reopened.handovers[0].toCome).toBe(2);
    expect(legAgain.lost).toBe(0);
    expect(legAgain.onTheWay).toBe(0);
    expect(await refusal(handovers.undoAllArrived(h.id, ABDALLAH))).toBe(
      'HANDOVER_NOT_ALL_ARRIVED',
    );
  });

  it('A handover with no count loses nothing at All arrived', async () => {
    const w = await inAjman();
    const h = await handOver(w, { pieces: null });
    await arrive(w, h.id, [[w.A, 5]]);
    expect(
      await refusal(
        handovers.allArrived(
          h.id,
          { lost: [{ purchaseOrderItemId: w.A, qty: 1 }] },
          ABDALLAH,
        ),
      ),
    ).toBe('HANDOVER_NOTHING_MISSING');
    await handovers.allArrived(h.id, {}, ABDALLAH);
    expect(
      await prisma.shipmentLoss.count({ where: { legId: w.leg2.id } }),
    ).toBe(0);
  });

  it('Final once every handover is all arrived and every piece accounted for; the cost is then exactly the freight paid', async () => {
    const w = await inAjman();
    const h1 = await handOver(w, {
      pieces: 300,
      freightAmount: 9000,
      freightCurrency: 'EGP',
      freightRateToEgp: 1,
    });
    const h2 = await handOver(w, {
      pieces: null,
      freightAmount: 3001,
      freightCurrency: 'EGP',
      freightRateToEgp: 1,
    });
    await arrive(w, h1.id, [
      [w.A, 250],
      [w.B, 50],
    ]);
    await arrive(w, h2.id, [[w.B, 100]]);
    await handovers.allArrived(h1.id, {}, ABDALLAH);
    const { h: open } = await leg2View(w);
    expect(open.final).toBe(false);
    expect(await cycleFreightIsEstimate(prisma, w.cycle.id)).toBe(true);
    await handovers.allArrived(h2.id, {}, ABDALLAH);
    const { h: done } = await leg2View(w);
    expect(done.final).toBe(true);
    expect(done.legCostEgp).toBe('12001.00');
    expect(await legCost(w)).toBe('12001.00');
    expect(await cycleFreightIsEstimate(prisma, w.cycle.id)).toBe(false);
    const row = (await analytics.getCycleProfitability()).data.find(
      (c) => c.cycleId === w.cycle.id,
    );
    expect(row?.freightEstimate ?? false).toBe(false);
  });

  // ─── The interaction it changes: re-costing ─────────────────────────────

  it('A second handover re-costs units already received and sold: their COGS and the cycle profit move by exactly the freight added to them', async () => {
    const w = await inAjman();
    // 15,000 EGP for 150 → 100 a piece.
    const h1 = await handOver(w, {
      pieces: 150,
      freightAmount: 15000,
      freightCurrency: 'EGP',
      freightRateToEgp: 1,
    });
    const { data: delivery } = await handovers.recordArrival(
      w.leg2.id,
      {
        handoverId: h1.id,
        arrivedOn: '2026-11-10',
        lines: [{ purchaseOrderItemId: w.A, qty: 100 }],
      },
      ABDALLAH,
    );
    await inventory.verifyStock(
      w.cycle.id,
      {
        deliveryId: delivery.id,
        receivedOn: '2026-11-10',
        items: [{ deliveryLineId: delivery.lines[0].id, receivedQty: 100 }],
      },
      ABDALLAH,
    );
    const batch = await prisma.inventoryBatch.findFirstOrThrow({
      where: { cycleId: w.cycle.id },
    });
    // Goods 100 + leg-2 freight 100 a piece.
    expect(batch.landedUnitCostEgp.toFixed(4)).toBe('200.0000');
    await sales.create(
      {
        walkIn: true,
        channel: 'B2C',
        currency: 'EGP',
        items: [{ productId: w.products[0].id, quantity: 50, unitPrice: 1000 }],
      },
      ABDALLAH,
    );
    const profitBefore = (await analytics.getCycleProfitability()).data.find(
      (c) => c.cycleId === w.cycle.id,
    )!;
    expect(profitBefore.freightEstimate).toBe(true);
    expect(profitBefore.profit).toBe(40_000); // 50 × (1,000 − 200)

    // 250 more for 37,500 (150 a piece): 52,500 over the 400 → 131.25 each.
    await handOver(w, {
      handedOverOn: '2026-11-11',
      pieces: 250,
      freightAmount: 37500,
      freightCurrency: 'EGP',
      freightRateToEgp: 1,
    });
    expect(await legCost(w)).toBe('52500.00');
    const after = await prisma.inventoryBatch.findUniqueOrThrow({
      where: { id: batch.id },
      include: { saleItemAllocations: true },
    });
    expect(after.landedUnitCostEgp.toFixed(4)).toBe('231.2500');
    expect(after.saleItemAllocations.map((a) => a.cogsEgp.toFixed(2))).toEqual([
      '11562.50',
    ]);
    const purchase = await prisma.financialTransaction.findFirstOrThrow({
      where: { cycleId: w.cycle.id, type: 'PURCHASE_COST' },
    });
    expect(purchase.amount.toFixed(2)).toBe('23125.00');
    const profitAfter = (await analytics.getCycleProfitability()).data.find(
      (c) => c.cycleId === w.cycle.id,
    )!;
    // 31.25 more freight on each of the 50 sold.
    expect(profitBefore.profit - profitAfter.profit).toBe(1562.5);
    const preview = (await settlements.preview(w.cycle.id)).data;
    expect(preview.freightEstimate).toBe(true);
  });

  it('When the re-cost is locked the handover is refused with its code, and nothing is written or booked as an expense', async () => {
    const w = await inAjman();
    const h1 = await handOver(w, {
      pieces: 10,
      freightAmount: 1000,
      freightCurrency: 'EGP',
      freightRateToEgp: 1,
    });
    await arrive(w, h1.id, [[w.A, 8]]);
    await handovers.allArrived(
      h1.id,
      { lost: [{ purchaseOrderItemId: w.A, qty: 2 }] },
      ABDALLAH,
    );
    const before = await legCost(w);
    const departures = await prisma.shipmentDeparture.count({
      where: { legId: w.leg2.id },
    });
    const expenses = await prisma.financialTransaction.count({
      where: { cycleId: w.cycle.id },
    });
    expect(
      await refusal(
        handOver(w, {
          pieces: 100,
          freightAmount: 5000,
          freightCurrency: 'EGP',
          freightRateToEgp: 1,
        }),
      ),
    ).toBe('LEG_COST_LOCKED_LOSSES');
    expect(await legCost(w)).toBe(before);
    expect(
      await prisma.shipmentDeparture.count({ where: { legId: w.leg2.id } }),
    ).toBe(departures);
    expect(
      await prisma.financialTransaction.count({
        where: { cycleId: w.cycle.id },
      }),
    ).toBe(expenses);
  });

  // ─── A partner paid the freight himself (§18) ───────────────────────────

  it("Shady paid 6,000 AED at 15: owed in AED, repaid in pounds at 16 then 16.5 → the exchange difference is the cycle's, 8,062.50, split 50/50", async () => {
    const w = await inAjman();
    const h = await handOver(w, { pieces: 400, paidByUserId: SHADY });
    const financing = await prisma.lenderFinancing.findFirstOrThrow({
      where: { departureId: h.id },
      include: { lender: true },
    });
    expect(financing.lender.partnerUserId).toBe(SHADY);
    expect([
      financing.currency,
      financing.amount.toFixed(2),
      financing.amountEgp.toFixed(2),
    ]).toEqual(['AED', '6000.00', '90000.00']);
    // No business cash left: the ledger says his money came in.
    const inflow = await prisma.financialTransaction.findUniqueOrThrow({
      where: { id: financing.ledgerTransactionId! },
    });
    expect([
      inflow.direction,
      inflow.category,
      inflow.amount.toFixed(2),
    ]).toEqual(['INFLOW', 'lender_financing', '90000.00']);
    // The same lender record the second time.
    await arrive(w, h.id, [[w.A, 10]]);
    const before = (await settlements.project(w.cycle.id))!;

    await lenders.repay(
      financing.id,
      { amountEgp: 30000, rateToEgp: 16, paidOn: '2026-11-12' },
      ABDALLAH,
    );
    // 1,875 AED cleared; 4,125 left pays off at 16.5 with 68,062.50.
    expect(
      await refusal(
        lenders.repay(
          financing.id,
          { amountEgp: 68062.51, rateToEgp: 16.5, paidOn: '2026-11-13' },
          ABDALLAH,
        ),
      ),
    ).toBe('LENDER_REPAYMENT_EXCEEDS_OWED');
    await lenders.repay(
      financing.id,
      { amountEgp: 68062.5, rateToEgp: 16.5, paidOn: '2026-11-13' },
      ABDALLAH,
    );

    // 98,062.50 paid for what was worth 90,000 on the handover day.
    expect((await exchangeDifferenceEgp(prisma, w.cycle.id)).toFixed(2)).toBe(
      '8062.50',
    );
    const after = (await settlements.project(w.cycle.id))!;
    expect(after.exchangeDifferenceEgp.toFixed(2)).toBe('8062.50');
    expect(before.pnl.grossProfit.sub(after.pnl.grossProfit).toFixed(2)).toBe(
      '8062.50',
    );
    const share = (p: typeof before, who: string) =>
      p.distribution.lines.find(
        (l) =>
          p.participants.find((x) => x.id === l.participantId)!
            .partnerUserId === who,
      )!.netProfit;
    expect(share(before, ABDALLAH).sub(share(after, ABDALLAH)).toFixed(2)).toBe(
      '4031.25',
    );
    expect(share(before, SHADY).sub(share(after, SHADY)).toFixed(2)).toBe(
      '4031.25',
    );
    // Nothing more to repay.
    expect(
      await refusal(
        lenders.repay(
          financing.id,
          { amountEgp: 1, rateToEgp: 16, paidOn: '2026-11-14' },
          ABDALLAH,
        ),
      ),
    ).toBe('LENDER_REPAYMENT_EXCEEDS_OWED');
    // Once repaid, the handover cannot be undone or its payer changed.
    expect(
      await refusal(
        handovers.update(
          h.id,
          {
            handedOverOn: '2026-11-03',
            freightAmount: 6000,
            paidByUserId: null,
          },
          ABDALLAH,
        ),
      ),
    ).toBe('FINANCING_HAS_REPAYMENTS');
  });

  // ─── The second time: undo ──────────────────────────────────────────────

  it('Undo: an arrival first (its goods wait in the UAE again and the freight a piece moves back), then the handover (the partner’s debt is removed and its ledger row balanced)', async () => {
    const w = await inAjman();
    const h = await handOver(w, {
      pieces: null,
      freightAmount: 1000,
      freightCurrency: 'AED',
      freightRateToEgp: 15,
      paidByUserId: SHADY,
    });
    const a1 = await arrive(w, h.id, [[w.A, 10]]);
    const a2 = await arrive(w, h.id, [[w.A, 10]]);
    // 15,000 over 20 = 750 × 400
    expect(await legCost(w)).toBe('300000.00');
    expect(await refusal(handovers.remove(h.id, ABDALLAH))).toBe(
      'HANDOVER_IN_USE',
    );
    await handovers.removeArrival(a2.id, ABDALLAH);
    // 15,000 over 10
    expect(await legCost(w)).toBe('600000.00');
    const { leg } = await leg2View(w);
    expect(leg.atOrigin).toBe(390);
    expect(leg.delivered).toBe(10);
    // The generic delete is refused on an arrival.
    expect(await refusal(deliveries.deleteDelivery(a1.id, ABDALLAH))).toBe(
      'LEG_USES_HANDOVERS',
    );
    // The last arrival is what puts the cycle in Egypt: refused, as a delivery is.
    expect(await refusal(handovers.removeArrival(a1.id, ABDALLAH))).toBe(
      'DELIVERY_IN_USE',
    );
    await prisma.importCycle.update({
      where: { id: w.cycle.id },
      data: { status: 'IN_TRANSIT_TO_EGYPT' },
    });
    await handovers.removeArrival(a1.id, ABDALLAH);
    expect(await refusal(handovers.removeArrival(a1.id, ABDALLAH))).toBe(
      'NOT_FOUND:shipmentDelivery',
    );
    // Leg 2's only departure while the cycle stands In transit to Egypt.
    expect(await refusal(handovers.remove(h.id, ABDALLAH))).toBe(
      'DEPARTURE_IN_USE',
    );
    await prisma.importCycle.update({
      where: { id: w.cycle.id },
      data: { status: 'ARRIVED_UAE' },
    });
    await handovers.remove(h.id, ABDALLAH);
    expect(await prisma.shipmentDeparture.count({ where: { id: h.id } })).toBe(
      0,
    );
    const f = await prisma.lenderFinancing.findFirstOrThrow({
      where: { cycleId: w.cycle.id },
    });
    expect(f.removedAt).not.toBeNull();
    const ledger = await prisma.financialTransaction.findMany({
      where: { relatedType: 'LENDER_FINANCING', relatedId: f.id },
    });
    expect(
      ledger
        .reduce(
          (s, t) =>
            t.direction === 'INFLOW' ? s.add(t.amount) : s.sub(t.amount),
          D(0),
        )
        .toFixed(2),
    ).toBe('0.00');
    expect(await legCost(w)).toBe('0.00');
    expect(await refusal(handovers.remove(h.id, ABDALLAH))).toBe(
      'NOT_FOUND:handover',
    );
  });

  it('Correcting a handover: its freight re-costs, its count never below what came, its day never after an arrival', async () => {
    const w = await inAjman();
    const h = await handOver(w, {
      pieces: 100,
      freightAmount: 1000,
      freightCurrency: 'EGP',
      freightRateToEgp: 1,
    });
    await arrive(w, h.id, [[w.A, 30]], '2026-11-05');
    await handovers.update(
      h.id,
      { handedOverOn: '2026-11-03', freightAmount: 2000 },
      ABDALLAH,
    );
    expect(await legCost(w)).toBe('8000.00');
    expect(
      await refusal(
        handovers.update(
          h.id,
          { handedOverOn: '2026-11-03', freightAmount: 2000, pieces: 29 },
          ABDALLAH,
        ),
      ),
    ).toBe('HANDOVER_PIECES_BELOW_ARRIVED');
    expect(
      await refusal(
        handovers.update(
          h.id,
          { handedOverOn: '2026-11-06', freightAmount: 2000 },
          ABDALLAH,
        ),
      ),
    ).toBe('ARRIVAL_BEFORE_HANDOVER');
    expect(
      await refusal(
        handovers.update(
          h.id,
          { handedOverOn: '2026-11-03', freightAmount: 2000, pieces: 401 },
          ABDALLAH,
        ),
      ),
    ).toBe('HANDOVER_PIECES_EXCEED_WAITING');
  });
});
