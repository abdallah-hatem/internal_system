import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
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
import { PartnerAccountsService } from '../partner-accounts/partner-accounts.service';
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
  let accounts: PartnerAccountsService;
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
    accounts = new PartnerAccountsService(db, audit, costing);
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
  async function inAjman(opts: { leg1Egp?: number } = {}) {
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
        amount: opts.leg1Egp ?? 0,
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
          freightAmount: string;
          freightAmountEgp: string;
          freightPaid: string;
          freightToPay: string;
          freightToPayEgp: string;
          freightRateToEgp: string;
          payments: {
            id: string;
            paidOn: string;
            amount: string;
            rateToEgp: string;
            amountEgp: string;
            paidBy: { name: string; kind: string } | null;
            owed: { currency: string; owed: string } | null;
          }[];
        }[];
        freightEgp: string;
        paidByCurrency: { currency: string; amount: string }[];
        toPayByCurrency: {
          currency: string;
          amount: string;
          rateToEgp: string;
          amountEgp: string;
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
    expect(h.handovers[0].payments[0].paidBy?.name).toMatch(/^Shady/);
    expect(h.handovers[0].payments[0].owed).toMatchObject({
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
    // An investor who is not in this cycle cannot have paid its freight.
    expect(await refusal(handOver(w, { paidByUserId: INVESTOR }))).toBe(
      'FREIGHT_PAYER_NOT_ON_CYCLE',
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
    // Once repaid, the payment cannot be undone or its payer changed.
    const payment = await prisma.handoverFreightPayment.findFirstOrThrow({
      where: { departureId: h.id },
    });
    expect(
      await refusal(
        handovers.updatePayment(payment.id, { paidByUserId: null }, ABDALLAH),
      ),
    ).toBe('FINANCING_HAS_REPAYMENTS');
    expect(await refusal(handovers.removePayment(payment.id, ABDALLAH))).toBe(
      'FINANCING_HAS_REPAYMENTS',
    );
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

  // ─── Where the goods are, in the leg card's words (owner 2026-11-20: "fix wording") ───

  /**
   * Everything the cycle page counts about leg 2 must agree with the leg
   * card: the shipment's `handedOver` (totals line, goods cards) and the leg
   * card's own `stillInUae` / `withForwarder`; and the pieces add up —
   * not left + with the forwarder + arrived + lost = what entered the leg.
   */
  async function agrees(w: World) {
    const { shipment, leg, h } = await leg2View(w);
    const handed = shipment.handedOver;
    expect(handed.legs).toEqual([
      {
        legId: w.leg2.id,
        stillInUae: h.stillInUae,
        withForwarder: h.withForwarder,
        withForwarderUnknown: h.withForwarderUnknown,
      },
    ]);
    expect(handed.withForwarder).toBe(h.withForwarder);
    expect(handed.withForwarderUnknown).toBe(h.withForwarderUnknown);
    expect(handed.notLeft).toBe(h.stillInUae);
    expect(
      handed.notLeft + handed.withForwarder + leg.delivered + leg.lost,
    ).toBe(leg.entered);
    return { handed, shipment, leg };
  }

  const restStep = async (w: World) =>
    (await cycles.getTimeline(w.cycle.id)).data.steps.some(
      (s) => s.key === 'leg2-departed-rest',
    );

  it('Production’s CYC-2026-0002: 400 handed over with a count, nothing arrived — 400 with the forwarder, none "not left yet", no "rest to leave" on the timeline', async () => {
    const w = await inAjman();
    await handOver(w, {
      pieces: 400,
      freightAmount: 4000,
      freightRateToEgp: 14.8,
      handedOverOn: '2026-11-20',
    });
    const { handed, shipment } = await agrees(w);
    expect(handed).toMatchObject({
      withForwarder: 400,
      withForwarderUnknown: 0,
      notLeft: 0,
    });
    // The position itself is unchanged: a handover writes no departure lines.
    expect(shipment.totals.atOrigin).toBe(400);
    expect(shipment.status).toBe('IN_TRANSIT_TO_EGYPT');
    expect(await restStep(w)).toBe(false);
  });

  it('A handover with no count: nothing counted with the forwarder, one handover "not known", the rest still not left; the timeline does not claim the rest waits', async () => {
    const w = await inAjman();
    await handOver(w, { freightAmount: 4200 });
    const { handed } = await agrees(w);
    expect(handed).toMatchObject({
      withForwarder: 0,
      withForwarderUnknown: 1,
      notLeft: 400,
    });
    expect(await restStep(w)).toBe(false);
  });

  it('Part handed over, part arrived: 150 counted, 40 arrived → 110 with the forwarder, 250 not left — and the timeline says the rest is still to leave', async () => {
    const w = await inAjman();
    const h1 = await handOver(w, { pieces: 150 });
    await arrive(w, h1.id, [
      [w.A, 30],
      [w.B, 10],
    ]);
    const { handed, leg } = await agrees(w);
    expect(handed).toMatchObject({
      withForwarder: 110,
      withForwarderUnknown: 0,
      notLeft: 250,
    });
    expect(leg.delivered).toBe(40);
    expect(await restStep(w)).toBe(true);

    // The second time: another lot for the rest, counted — nothing left to leave.
    await handOver(w, { pieces: 250, handedOverOn: '2026-11-05' });
    const again = await agrees(w);
    expect(again.handed).toMatchObject({ withForwarder: 360, notLeft: 0 });
    expect(await restStep(w)).toBe(false);
  });

  it('All arrived with pieces missing: the lost ones leave the forwarder — 150 counted, 145 arrived, 5 lost → 0 with the forwarder, 250 not left, 5 lost', async () => {
    const w = await inAjman();
    const h1 = await handOver(w, { pieces: 150 });
    await arrive(w, h1.id, [
      [w.A, 100],
      [w.B, 45],
    ]);
    await handovers.allArrived(
      h1.id,
      { lost: [{ purchaseOrderItemId: w.B, qty: 5 }] },
      ABDALLAH,
    );
    const { handed, shipment } = await agrees(w);
    expect(handed).toMatchObject({
      withForwarder: 0,
      withForwarderUnknown: 0,
      notLeft: 250,
    });
    expect(shipment.totals.lost).toBe(5);
  });

  it('A leg in handovers with nothing handed over yet: nothing with the forwarder, not left is what waits at the origin', async () => {
    const w = await inAjman();
    const { data } = await cycles.getShipment(w.cycle.id);
    expect(data.handedOver).toEqual({
      withForwarder: 0,
      withForwarderUnknown: 0,
      notLeft: data.totals.atOrigin,
      legs: [
        {
          legId: w.leg2.id,
          stillInUae: 400,
          withForwarder: 0,
          withForwarderUnknown: 0,
        },
      ],
    });
  });

  // ─── The equal-shares gap on the Funding card (owner 2026-11-20: "this must be shown") ───

  /**
   * CYC-2026-0002 as production holds it: three partners at 65,862.26 and
   * Mohammed Youssef, a temporary investor, at 59,200 (the freight he paid),
   * the split saved as 25% each. Goods 40,000 + leg 1 157,586.78 = 197,586.78
   * before the handover; 400 pieces handed over for 4,000 AED at 14.8.
   */
  async function cycleTwo(split: (string | null)[] = ['25', '25', '25', '25']) {
    const w = await inAjman({ leg1Egp: 157_586.78 });
    const FARES = await partner('Fares');
    const existing = await prisma.cycleParticipant.findMany({
      where: { cycleId: w.cycle.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    for (const [i, p] of existing.entries()) {
      await prisma.cycleParticipant.update({
        where: { id: p.id },
        data: { contributionAmount: 65_862.26, customProfitPct: split[i] },
      });
    }
    await prisma.financialTransaction.updateMany({
      where: { cycleId: w.cycle.id, category: 'contribution' },
      data: { amount: 65_862.26 },
    });
    const more = [
      { who: FARES, type: 'CORE_PARTNER', amount: 65_862.26, pct: split[2] },
      { who: INVESTOR, type: 'TEMP_INVESTOR', amount: 59_200, pct: split[3] },
    ] as const;
    for (const m of more) {
      const p = await prisma.cycleParticipant.create({
        data: {
          cycleId: w.cycle.id,
          participantType: m.type,
          ...(m.type === 'CORE_PARTNER'
            ? { partnerUserId: m.who }
            : { investorUserId: m.who, investorFeePct: 0 }),
          contributionAmount: m.amount,
          customProfitPct: m.pct,
        },
      });
      await prisma.financialTransaction.create({
        data: {
          type: 'CAPITAL_CONTRIBUTION',
          category: 'contribution',
          direction: 'INFLOW',
          amount: m.amount,
          currency: 'EGP',
          cycleId: w.cycle.id,
          relatedType: 'CYCLE_PARTICIPANT',
          relatedId: p.id,
          createdBy: ABDALLAH,
        },
      });
    }
    return w;
  }

  it('Four equal shares of 256,786.78 (goods, leg 1 and the handover’s 59,200): Youssef 4,996.71 short, each partner 1,665.57 over — to the piastre', async () => {
    const w = await cycleTwo();
    // Before the handover the card's figure is goods + leg 1.
    let { data } = await accounts.cycleFunding(w.cycle.id);
    expect(data.toFundEgp).toBe('197586.78');
    await handOver(w, {
      pieces: 400,
      freightAmount: 4000,
      freightRateToEgp: 14.8,
      handedOverOn: '2026-11-20',
    });
    ({ data } = await accounts.cycleFunding(w.cycle.id));
    expect(data.toFundEgp).toBe('256786.78');
    const gap = data.equalShares!;
    expect(gap.basis).toBe('COST_TO_FUND');
    expect(gap.ofEgp).toBe('256786.78');
    expect(
      gap.lines.map((l) => [
        l.participantType,
        l.shareEgp,
        l.contributedEgp,
        l.differenceEgp,
        l.state,
      ]),
    ).toEqual([
      ['CORE_PARTNER', '64196.69', '65862.26', '1665.57', 'OVER'],
      ['CORE_PARTNER', '64196.69', '65862.26', '1665.57', 'OVER'],
      ['CORE_PARTNER', '64196.69', '65862.26', '1665.57', 'OVER'],
      ['TEMP_INVESTOR', '64196.71', '59200.00', '-4996.71', 'SHORT'],
    ]);
    // The shares are the total exactly; the differences cancel exactly.
    const sum = (k: 'shareEgp' | 'differenceEgp') =>
      gap.lines.reduce((s, l) => s.add(l[k]), D(0)).toFixed(2);
    expect(sum('shareEgp')).toBe('256786.78');
    expect(sum('differenceEgp')).toBe('0.00');
    // Display only: no contribution moved.
    const after = await prisma.cycleParticipant.findMany({
      where: { cycleId: w.cycle.id },
      select: { contributionAmount: true },
    });
    expect(after.map((p) => p.contributionAmount.toFixed(2)).sort()).toEqual([
      '59200.00',
      '65862.26',
      '65862.26',
      '65862.26',
    ]);
  });

  it('Three partners and no investor, equal by agreement (33.33 / 33.33 / 33.34): one even, one short, one over — the last share carrying the odd piastre', async () => {
    const w = await inAjman({ leg1Egp: 1000 });
    const FARES = await partner('Fares');
    // 41,000 to fund; thirds 13,666.66 / 13,666.66 / 13,666.68.
    const existing = await prisma.cycleParticipant.findMany({
      where: { cycleId: w.cycle.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    await prisma.cycleParticipant.update({
      where: { id: existing[0].id },
      data: { contributionAmount: 13_666.66, customProfitPct: '33.33' },
    });
    await prisma.cycleParticipant.update({
      where: { id: existing[1].id },
      data: { contributionAmount: 10_000, customProfitPct: '33.33' },
    });
    await prisma.cycleParticipant.create({
      data: {
        cycleId: w.cycle.id,
        participantType: 'CORE_PARTNER',
        partnerUserId: FARES,
        contributionAmount: 17_333.34,
        customProfitPct: '33.34',
      },
    });
    const { data } = await accounts.cycleFunding(w.cycle.id);
    expect(data.equalShares!.ofEgp).toBe('41000.00');
    expect(
      data.equalShares!.lines.map((l) => [
        l.shareEgp,
        l.differenceEgp,
        l.state,
      ]),
    ).toEqual([
      ['13666.66', '0.00', 'EVEN'],
      ['13666.66', '-3666.66', 'SHORT'],
      ['13666.68', '3666.66', 'OVER'],
    ]);
  });

  it('An unequal agreed split (30 / 30 / 20 / 20), a partial one, or none at all: no equal-shares section', async () => {
    for (const split of [
      ['30', '30', '20', '20'],
      ['25', '25', '25', null],
      [null, null, null, null],
    ]) {
      const w = await cycleTwo(split);
      expect(
        (await accounts.cycleFunding(w.cycle.id)).data.equalShares,
      ).toBeNull();
    }
  });

  it('A target above the cost to fund is what the equal shares are of, as the contributions table reads it', async () => {
    const w = await cycleTwo();
    await prisma.importCycle.update({
      where: { id: w.cycle.id },
      data: {
        fundingTargetAmount: 300_000,
        fundingTargetCurrency: 'EGP',
        fundingTargetRate: 1,
      },
    });
    const { data } = await accounts.cycleFunding(w.cycle.id);
    expect(data.equalShares!.basis).toBe('TARGET');
    expect(data.equalShares!.lines.map((l) => l.shareEgp)).toEqual([
      '75000.00',
      '75000.00',
      '75000.00',
      '75000.00',
    ]);
  });

  // ─── Freight paid in parts (owner 2026-11-20, mockup approved) ──────────

  /** The Exchange rates page's AED rate, as the forms and the estimate read it. */
  const pageRate = (rate: number) =>
    prisma.currencyRate.update({
      where: { code: 'AED' },
      data: { rateToEgp: rate },
    });

  const paymentsOf = (handoverId: string) =>
    prisma.handoverFreightPayment.findMany({
      where: { departureId: handoverId },
      orderBy: [{ paidOn: 'asc' }, { createdAt: 'asc' }],
    });

  const pay = (
    handoverId: string,
    over: Partial<Parameters<HandoversService['addPayment']>[1]> = {},
  ) =>
    handovers
      .addPayment(
        handoverId,
        { paidOn: '2026-11-20', amount: 4000, rateToEgp: 15.5, ...over },
        ABDALLAH,
      )
      .then((r) => r.data);

  it('Backfill: a handover stored before payments existed gets one payment of exactly its freight, rate, day and payer — and every cost reads as it did', async () => {
    // Runs first in this section: the backfill SQL is the migration's own,
    // and it touches only handovers with freight and no payment.
    const w = await inAjman();
    await pageRate(15.2);
    const h1 = await handOver(w, {
      pieces: 150,
      freightAmount: 6000,
      freightRateToEgp: 15,
      paidByUserId: SHADY,
    });
    const h2 = await handOver(w, {
      pieces: null,
      freightAmount: 4200,
      freightRateToEgp: 15.1,
      handedOverOn: '2026-11-05',
    });
    const free = await handOver(w, { pieces: 10, freightAmount: 0 });
    const before = (await leg2View(w)).h;
    const costBefore = await legCost(w);
    const own = await prisma.handoverFreightPayment.findMany({
      where: { departureId: { in: [h1.id, h2.id, free.id] } },
    });
    // As the code before this change stored them: no payments, the payer on
    // the handover, his debt naming the handover only.
    await prisma.lenderFinancing.updateMany({
      where: { departureId: h1.id },
      data: { freightPaymentId: null },
    });
    await prisma.shipmentDeparture.update({
      where: { id: h1.id },
      data: { paidByUserId: SHADY },
    });
    await prisma.handoverFreightPayment.deleteMany({
      where: { id: { in: own.map((p) => p.id) } },
    });
    expect((await leg2View(w)).h.handovers.map((x) => x.freightToPay)).toEqual([
      '6000.00',
      '0.00',
      '4200.00',
    ]);

    const sql = readFileSync(
      join(
        __dirname,
        '../../../prisma/migrations/20261120180000_handover_freight_payments/migration.sql',
      ),
      'utf8',
    );
    const backfill = sql.slice(sql.indexOf('-- Backfill:'));
    for (const statement of backfill
      .split(';')
      .map((x) => x.replace(/^\s*--.*$/gm, '').trim())
      .filter(Boolean)) {
      // eslint-disable-next-line no-restricted-properties -- the migration file's own backfill, run as written: no values go in
      await prisma.$executeRawUnsafe(statement);
    }

    const [p1] = await paymentsOf(h1.id);
    const [p2] = await paymentsOf(h2.id);
    expect(await paymentsOf(free.id)).toEqual([]);
    expect([
      p1.paidOn.toISOString().slice(0, 10),
      p1.amount.toFixed(2),
      p1.rateToEgp.toFixed(4),
      p1.amountEgp.toFixed(2),
      p1.paidByUserId,
    ]).toEqual(['2026-11-03', '6000.00', '15.0000', '90000.00', SHADY]);
    expect([
      p2.paidOn.toISOString().slice(0, 10),
      p2.amount.toFixed(2),
      p2.rateToEgp.toFixed(4),
      p2.amountEgp.toFixed(2),
      p2.paidByUserId,
    ]).toEqual(['2026-11-05', '4200.00', '15.1000', '63420.00', null]);
    // His debt is now the debt of that payment.
    const f = await prisma.lenderFinancing.findFirstOrThrow({
      where: { departureId: h1.id, removedAt: null },
    });
    expect(f.freightPaymentId).toBe(p1.id);
    // Nothing reads differently: the leg's cost and every figure of the card.
    expect(await legCost(w)).toBe(costBefore);
    const after = (await leg2View(w)).h;
    const figures = (x: typeof after) => ({
      legCostEgp: x.legCostEgp,
      perPiece: x.perPiece,
      perPieceEgp: x.perPieceEgp,
      freightEgp: x.freightEgp,
      final: x.final,
      toPay: x.toPayByCurrency,
      handovers: x.handovers.map((y) => [
        y.freightAmount,
        y.freightAmountEgp,
        y.freightPaid,
        y.freightToPay,
      ]),
    });
    expect(figures(after)).toEqual(figures(before));
    expect(after.toPayByCurrency).toEqual([]);
    // A second run changes nothing.
    for (const statement of backfill
      .split(';')
      .map((x) => x.replace(/^\s*--.*$/gm, '').trim())
      .filter(Boolean)) {
      // eslint-disable-next-line no-restricted-properties -- the migration file's own backfill, run as written: no values go in
      await prisma.$executeRawUnsafe(statement);
    }
    expect(await paymentsOf(h1.id)).toHaveLength(1);
    // A change to the leg re-costs to the same figure: nothing was stale.
    await handovers.recount(w.leg2.id, ABDALLAH);
    expect(await legCost(w)).toBe(costBefore);
  });

  it("CYC-2026-0002's Handover 1: 8,000 AED, Youssef paid 4,000 at 14.8 — the rest counted at the page's 15.2: 120,000 EGP so far, an estimate; the second 4,000 at 15.5 makes it 121,200", async () => {
    const w = await cycleTwo();
    await pageRate(15.2);
    const h = await handOver(w, {
      pieces: 400,
      freightAmount: 8000,
      paidAmount: 4000,
      freightRateToEgp: 14.8,
      paidByUserId: INVESTOR,
      handedOverOn: '2026-11-20',
    });
    let { h: view } = await leg2View(w);
    const mine = view.handovers[0];
    expect([
      mine.freightAmount,
      mine.freightPaid,
      mine.freightToPay,
      mine.freightRateToEgp,
      mine.freightToPayEgp,
      mine.freightAmountEgp,
    ]).toEqual([
      '8000.00',
      '4000.00',
      '4000.00',
      '15.2000',
      '60800.00',
      '120000.00',
    ]);
    expect(
      mine.payments.map((p) => [
        p.paidOn,
        p.amount,
        p.rateToEgp,
        p.amountEgp,
        p.paidBy?.kind,
        p.owed,
      ]),
    ).toEqual([
      ['2026-11-20', '4000.00', '14.8000', '59200.00', 'INVESTOR', null],
    ]);
    // His money is his contribution: nobody is owed anything for it.
    expect(
      await prisma.lenderFinancing.count({ where: { cycleId: w.cycle.id } }),
    ).toBe(0);
    expect(view.paidByCurrency).toEqual([
      { currency: 'AED', amount: '4000.00' },
    ]);
    expect(view.toPayByCurrency).toEqual([
      {
        currency: 'AED',
        amount: '4000.00',
        rateToEgp: '15.2000',
        amountEgp: '60800.00',
      },
    ]);
    expect(view.freightEgp).toBe('120000.00');
    expect(view.perPiece).toEqual({ amount: '20.00', currency: 'AED' });
    expect(await legCost(w)).toBe('120000.00');
    expect(await cycleFreightIsEstimate(prisma, w.cycle.id)).toBe(true);
    // Who can be named as paying: the partners and this cycle's investor.
    const { shipment } = await leg2View(w);
    const payers = (
      shipment as unknown as {
        freightPayers: { id: string; kind: string }[];
      }
    ).freightPayers;
    expect(payers.find((p) => p.id === INVESTOR)?.kind).toBe('INVESTOR');
    expect(payers.find((p) => p.id === SHADY)?.kind).toBe('PARTNER');
    // The Funding card reads the leg's cost with the estimate in it:
    // goods 40,000 + leg 1 157,586.78 + 120,000.
    let { data } = await accounts.cycleFunding(w.cycle.id);
    expect(data.toFundEgp).toBe('317586.78');
    expect(data.equalShares!.ofEgp).toBe('317586.78');

    // The page moving restates nothing by itself (§22)…
    await pageRate(15.4);
    expect(await legCost(w)).toBe('120000.00');
    // …the next freight change, or Count at today's rate, takes it.
    await handovers.recount(w.leg2.id, ABDALLAH);
    expect(await legCost(w)).toBe('120800.00');
    await pageRate(15.2);
    await handovers.recount(w.leg2.id, ABDALLAH);
    expect(await legCost(w)).toBe('120000.00');

    // The second 4,000 paid at 15.5 by the business.
    const second = await pay(h.id);
    expect(second.amountEgp.toFixed(2)).toBe('62000.00');
    ({ h: view } = await leg2View(w));
    expect(view.handovers[0].freightToPay).toBe('0.00');
    expect(view.toPayByCurrency).toEqual([]);
    expect(view.freightEgp).toBe('121200.00');
    expect(await legCost(w)).toBe('121200.00');
    ({ data } = await accounts.cycleFunding(w.cycle.id));
    expect(data.toFundEgp).toBe('318786.78');
    // Still an estimate while nothing has arrived; freight is no longer why.
    expect(view.final).toBe(false);
  });

  it('The second payment at a different rate re-costs the units already sold: 1,200 EGP more on the leg is 3 a piece, 150 off the profit on the 50 sold — exactly', async () => {
    const w = await inAjman();
    await pageRate(15.2);
    const h = await handOver(w, {
      pieces: 400,
      freightAmount: 8000,
      paidAmount: 4000,
      freightRateToEgp: 14.8,
    });
    // 59,200 + 4,000 × 15.2 = 120,000 over 400 → 300 a piece.
    const { data: delivery } = await handovers.recordArrival(
      w.leg2.id,
      {
        handoverId: h.id,
        arrivedOn: '2026-11-20',
        lines: [{ purchaseOrderItemId: w.A, qty: 100 }],
      },
      ABDALLAH,
    );
    await inventory.verifyStock(
      w.cycle.id,
      {
        deliveryId: delivery.id,
        receivedOn: '2026-11-20',
        items: [{ deliveryLineId: delivery.lines[0].id, receivedQty: 100 }],
      },
      ABDALLAH,
    );
    const batch = await prisma.inventoryBatch.findFirstOrThrow({
      where: { cycleId: w.cycle.id },
    });
    expect(batch.landedUnitCostEgp.toFixed(4)).toBe('400.0000');
    await sales.create(
      {
        walkIn: true,
        channel: 'B2C',
        currency: 'EGP',
        items: [{ productId: w.products[0].id, quantity: 50, unitPrice: 1000 }],
      },
      ABDALLAH,
    );
    const profit = async () =>
      (await analytics.getCycleProfitability()).data.find(
        (c) => c.cycleId === w.cycle.id,
      )!;
    const before = await profit();
    expect(before.freightEstimate).toBe(true);
    expect(before.profit).toBe(30_000); // 50 × (1,000 − 400)

    await pay(h.id, { amount: 4000, rateToEgp: 15.5 });
    expect(await legCost(w)).toBe('121200.00');
    const after = await prisma.inventoryBatch.findUniqueOrThrow({
      where: { id: batch.id },
      include: { saleItemAllocations: true },
    });
    expect(after.landedUnitCostEgp.toFixed(4)).toBe('403.0000');
    expect(after.saleItemAllocations.map((a) => a.cogsEgp.toFixed(2))).toEqual([
      '20150.00',
    ]);
    expect(before.profit - (await profit()).profit).toBe(150);

    // Undone, the rest is to pay again at the page's rate and the profit is back.
    const [, second] = await paymentsOf(h.id);
    await handovers.removePayment(second.id, ABDALLAH);
    expect(await legCost(w)).toBe('120000.00');
    expect((await profit()).profit).toBe(30_000);
    expect(await refusal(handovers.removePayment(second.id, ABDALLAH))).toBe(
      'NOT_FOUND:freightPayment',
    );
    // And recorded again: the same figures as the first time.
    await pay(h.id, { amount: 4000, rateToEgp: 15.5 });
    expect(await legCost(w)).toBe('121200.00');
    expect(before.profit - (await profit()).profit).toBe(150);
  });

  it('Too much, too early, too late, nothing: refused with their codes, and nothing written', async () => {
    const w = await inAjman();
    await pageRate(15.2);
    // More paid now than the freight.
    expect(
      await refusal(handOver(w, { freightAmount: 8000, paidAmount: 8000.01 })),
    ).toBe('FREIGHT_PAYMENT_EXCEEDS_UNPAID');
    expect(
      await refusal(handOver(w, { freightAmount: 8000, paidAmount: -1 })),
    ).toBe('AMOUNT_NOT_POSITIVE');
    // Named as paying nothing.
    expect(
      await refusal(
        handOver(w, {
          freightAmount: 8000,
          paidAmount: 0,
          paidByUserId: SHADY,
        }),
      ),
    ).toBe('HANDOVER_PAID_BY_NOTHING_PAID');
    const h = await handOver(w, {
      pieces: 400,
      freightAmount: 8000,
      paidAmount: 3000,
      freightRateToEgp: 14.8,
    });
    const cost = await legCost(w);
    // 3,000 × 14.8 + 5,000 × 15.2 = 44,400 + 76,000.
    expect(cost).toBe('120400.00');
    expect(await refusal(pay(h.id, { amount: 5000.01 }))).toBe(
      'FREIGHT_PAYMENT_EXCEEDS_UNPAID',
    );
    expect(await refusal(pay(h.id, { amount: 0 }))).toBe('AMOUNT_NOT_POSITIVE');
    expect(await refusal(pay(h.id, { amount: -5 }))).toBe(
      'AMOUNT_NOT_POSITIVE',
    );
    expect(await refusal(pay(h.id, { paidOn: '2099-01-01' }))).toBe(
      'DATE_IN_FUTURE',
    );
    // Before the goods were handed over (3 November).
    expect(await refusal(pay(h.id, { paidOn: '2026-11-02' }))).toBe(
      'FREIGHT_PAYMENT_BEFORE_HANDOVER',
    );
    expect(await refusal(pay(h.id, { rateToEgp: 0 }))).toBe(
      'RATE_NOT_POSITIVE',
    );
    expect(await refusal(pay(h.id, { paidOn: 'soon' }))).toBe(
      'VALIDATION_FAILED',
    );
    // The second time: 3,000 paid, then 4,000, leaves 1,000 — 1,000.01 is too much.
    await pay(h.id, { amount: 4000 });
    expect(await refusal(pay(h.id, { amount: 1000.01 }))).toBe(
      'FREIGHT_PAYMENT_EXCEEDS_UNPAID',
    );
    // Correcting one never makes it more than the freight either.
    const [first] = await paymentsOf(h.id);
    expect(
      await refusal(
        handovers.updatePayment(first.id, { amount: 4000.01 }, ABDALLAH),
      ),
    ).toBe('FREIGHT_PAYMENT_EXCEEDS_UNPAID');
    // The freight cannot drop below what was paid, nor change currency under it.
    expect(
      await refusal(
        handovers.update(h.id, { freightAmount: 6999.99 }, ABDALLAH),
      ),
    ).toBe('HANDOVER_FREIGHT_BELOW_PAID');
    expect(
      await refusal(
        handovers.update(h.id, { freightCurrency: 'USD' }, ABDALLAH),
      ),
    ).toBe('HANDOVER_FREIGHT_CURRENCY_HAS_PAYMENTS');
    // Nothing of the refused ones was written.
    expect((await paymentsOf(h.id)).map((p) => p.amount.toFixed(2))).toEqual([
      '3000.00',
      '4000.00',
    ]);
    // 44,400 + 62,000 + 1,000 × 15.2
    expect(await legCost(w)).toBe('121600.00');
    // A freight raised later (a bigger bill) is to pay, at the page's rate.
    await handovers.update(h.id, { freightAmount: 9000 }, ABDALLAH);
    expect(await legCost(w)).toBe('136800.00');
    // Nothing still to pay, no page rate known: refused, not costed at 0.
    await prisma.currencyRate.update({
      where: { code: 'AED' },
      data: { rateToEgp: null },
    });
    expect(
      await refusal(
        handOver(w, { freightAmount: 100, paidAmount: 0, pieces: null }),
      ),
    ).toBe('NO_RATE_RECORDED');
    await pageRate(15.2);
  });

  it("The wrong context: someone else's investor, a stranger, a departure that is no handover, a leg not in handovers, a cycle being settled", async () => {
    const w = await cycleTwo();
    const other = await cycleTwo();
    await pageRate(15.2);
    const h = await handOver(w, {
      pieces: 400,
      freightAmount: 8000,
      paidAmount: 0,
      handedOverOn: '2026-11-20',
    });
    // An investor of another cycle only.
    const STRANGER = randomUUID();
    await prisma.user.create({
      data: {
        id: STRANGER,
        email: `handover-stranger-${STRANGER}@example.test`,
        passwordHash: 'x',
        role: 'TEMP_INVESTOR',
      },
    });
    await prisma.cycleParticipant.create({
      data: {
        cycleId: other.cycle.id,
        participantType: 'TEMP_INVESTOR',
        investorUserId: STRANGER,
        investorFeePct: 0,
        contributionAmount: 1,
      },
    });
    expect(await refusal(pay(h.id, { paidByUserId: STRANGER }))).toBe(
      'FREIGHT_PAYER_NOT_ON_CYCLE',
    );
    expect(await refusal(pay(h.id, { paidByUserId: randomUUID() }))).toBe(
      'FREIGHT_PAYER_NOT_ON_CYCLE',
    );
    expect(await refusal(pay(h.id, { paidByUserId: 'nobody' }))).toBe(
      'FREIGHT_PAYER_NOT_ON_CYCLE',
    );
    // Leg 1's departure is a departure, not a handover.
    const leg1Departure = await prisma.shipmentDeparture.findFirstOrThrow({
      where: { legId: w.leg1.id },
    });
    expect(await refusal(pay(leg1Departure.id))).toBe('NOT_FOUND:handover');
    expect(await refusal(pay(randomUUID()))).toBe('NOT_FOUND:handover');
    expect(await refusal(pay('not-a-uuid'))).toBe('NOT_FOUND:handover');
    expect(
      await refusal(
        handovers.updatePayment(randomUUID(), { amount: 1 }, ABDALLAH),
      ),
    ).toBe('NOT_FOUND:freightPayment');
    expect(await refusal(handovers.recount(w.leg1.id, ABDALLAH))).toBe(
      'LEG_NOT_IN_HANDOVERS',
    );
    // A cycle being settled records nothing.
    await prisma.importCycle.update({
      where: { id: w.cycle.id },
      data: { status: 'SETTLEMENT' },
    });
    expect(await refusal(pay(h.id))).toBe('CYCLE_SETTLING');
    expect(await paymentsOf(h.id)).toEqual([]);
  });

  it('A partner who paid a payment is owed that payment in AED — two partners on one lot owe each his own; correcting or undoing one moves only his', async () => {
    const w = await inAjman();
    await pageRate(15.2);
    const h = await handOver(w, {
      pieces: 400,
      freightAmount: 8000,
      paidAmount: 4000,
      freightRateToEgp: 14.8,
      paidByUserId: SHADY,
    });
    await pay(h.id, { amount: 4000, rateToEgp: 15.5, paidByUserId: ABDALLAH });
    const [shady, abdallah] = await paymentsOf(h.id);
    const debts = async () =>
      (
        await prisma.lenderFinancing.findMany({
          where: { cycleId: w.cycle.id, removedAt: null },
          include: { lender: true },
          orderBy: { createdAt: 'asc' },
        })
      ).map((f) => [
        f.lender.partnerUserId,
        f.freightPaymentId,
        f.departureId,
        f.currency,
        f.amount.toFixed(2),
        f.amountEgp.toFixed(2),
      ]);
    expect(await debts()).toEqual([
      [SHADY, shady.id, h.id, 'AED', '4000.00', '59200.00'],
      [ABDALLAH, abdallah.id, h.id, 'AED', '4000.00', '62000.00'],
    ]);
    const { h: view } = await leg2View(w);
    expect(view.handovers[0].payments.map((p) => p.owed?.owed)).toEqual([
      '4000.00',
      '4000.00',
    ]);
    // Shady paid 3,000, not 4,000: his debt is replaced; Abdallah's stands.
    await handovers.updatePayment(shady.id, { amount: 3000 }, ABDALLAH);
    expect(await debts()).toEqual([
      [ABDALLAH, abdallah.id, h.id, 'AED', '4000.00', '62000.00'],
      [SHADY, shady.id, h.id, 'AED', '3000.00', '44400.00'],
    ]);
    // 44,400 + 62,000 + 1,000 × 15.2
    expect(await legCost(w)).toBe('121600.00');
    // Undoing Abdallah's: his debt removed and its ledger row balanced.
    await handovers.removePayment(abdallah.id, ABDALLAH);
    const gone = await prisma.lenderFinancing.findFirstOrThrow({
      where: { cycleId: w.cycle.id, removalReason: { contains: 'undone' } },
    });
    const ledger = await prisma.financialTransaction.findMany({
      where: { relatedType: 'LENDER_FINANCING', relatedId: gone.id },
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
    expect(await debts()).toEqual([
      [SHADY, shady.id, h.id, 'AED', '3000.00', '44400.00'],
    ]);
    // Naming the business instead takes Shady's debt away too.
    await handovers.updatePayment(shady.id, { paidByUserId: null }, ABDALLAH);
    expect(await debts()).toEqual([]);
    // A note alone changes no debt and no cost.
    const cost = await legCost(w);
    await handovers.updatePayment(shady.id, { note: 'cash' }, ABDALLAH);
    expect(await legCost(w)).toBe(cost);
    // Undoing the handover takes its payments with it.
    await prisma.importCycle.update({
      where: { id: w.cycle.id },
      data: { status: 'ARRIVED_UAE' },
    });
    await handovers.remove(h.id, ABDALLAH);
    expect(await paymentsOf(h.id)).toEqual([]);
  });

  it('Moving a handover day takes the payment made with it; a later payment dated before the new day refuses the move', async () => {
    const w = await inAjman();
    await pageRate(15.2);
    const h = await handOver(w, {
      pieces: 400,
      freightAmount: 8000,
      paidAmount: 4000,
      freightRateToEgp: 14.8,
      paidByUserId: SHADY,
    });
    await pay(h.id, { amount: 1000, paidOn: '2026-11-05' });
    await handovers.update(h.id, { handedOverOn: '2026-11-04' }, ABDALLAH);
    const [first] = await paymentsOf(h.id);
    expect(first.paidOn.toISOString().slice(0, 10)).toBe('2026-11-04');
    const debt = await prisma.lenderFinancing.findFirstOrThrow({
      where: { freightPaymentId: first.id, removedAt: null },
    });
    expect(debt.paidOn.toISOString().slice(0, 10)).toBe('2026-11-04');
    expect(
      await refusal(
        handovers.update(h.id, { handedOverOn: '2026-11-06' }, ABDALLAH),
      ),
    ).toBe('FREIGHT_PAYMENT_BEFORE_HANDOVER');
  });

  it('Settling is refused while any handover freight is still to pay — approving the settlement, or moving the cycle to Settlement; paid, it goes through', async () => {
    const w = await inAjman();
    await pageRate(15.2);
    const h = await handOver(w, {
      pieces: 400,
      freightAmount: 8000,
      paidAmount: 4000,
      freightRateToEgp: 14.8,
      handedOverOn: '2026-11-20',
    });
    const { data: delivery } = await handovers.recordArrival(
      w.leg2.id,
      {
        handoverId: h.id,
        arrivedOn: '2026-11-20',
        lines: [
          { purchaseOrderItemId: w.A, qty: 250 },
          { purchaseOrderItemId: w.B, qty: 150 },
        ],
      },
      ABDALLAH,
    );
    await inventory.verifyStock(
      w.cycle.id,
      {
        deliveryId: delivery.id,
        receivedOn: '2026-11-20',
        items: delivery.lines.map((l: { id: string; qty: unknown }) => ({
          deliveryLineId: l.id,
          receivedQty: Number(l.qty),
        })),
      },
      ABDALLAH,
    );
    await handovers.allArrived(h.id, { on: '2026-11-20' }, ABDALLAH);
    // Not even a draft: a draft settlement locks the leg's cost, and the
    // payment could not be recorded after it.
    expect(await refusal(settlements.calculate(w.cycle.id, ABDALLAH))).toBe(
      'HANDOVER_FREIGHT_UNPAID',
    );
    expect(
      await prisma.settlement.count({ where: { cycleId: w.cycle.id } }),
    ).toBe(0);
    expect(
      await refusal(cycles.transition(w.cycle.id, 'SETTLEMENT', ABDALLAH)),
    ).toBe('HANDOVER_FREIGHT_UNPAID');
    expect(
      (
        await prisma.importCycle.findUniqueOrThrow({
          where: { id: w.cycle.id },
        })
      ).status,
    ).not.toBe('SETTLEMENT');
    // Everything arrived and counted, and still an estimate: freight is to pay.
    expect((await leg2View(w)).h.final).toBe(false);
    expect(await cycleFreightIsEstimate(prisma, w.cycle.id)).toBe(true);
    await pay(h.id);
    const { h: view } = await leg2View(w);
    expect(view.final).toBe(true);
    expect(await cycleFreightIsEstimate(prisma, w.cycle.id)).toBe(false);
    const again = (await settlements.calculate(w.cycle.id, ABDALLAH)).data!;
    await settlements.approve(again.id, ABDALLAH);
    expect(
      (
        await prisma.importCycle.findUniqueOrThrow({
          where: { id: w.cycle.id },
        })
      ).status,
    ).toBe('SETTLEMENT');
  });
});
