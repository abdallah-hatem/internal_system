import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- this suite talks to a real, throwaway Postgres; that is its point
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { CostingService } from '../costing/costing.service';
import { DeliveriesService } from '../shipping/deliveries.service';
import { InventoryService } from '../inventory/inventory.service';
import { PaymentsService } from '../payments/payments.service';
import { SalesService } from '../sales/sales.service';
import { SettlementsService } from '../settlements/settlements.service';
import { CyclesService } from './cycles.service';

/**
 * Change split, saved and checked on the server in one go (BUSINESS_LOGIC §8,
 * 2026-10-27): `PUT /cycles/:id/split`. All or none, adding to exactly 100,
 * refused with `PARTIAL_CUSTOM_SPLIT` / `SPLIT_NOT_100` at save time — and a
 * refusal or a failure halfway leaves every participant as it was. Against a
 * real Postgres, because "all or nothing" is only honest in a transaction.
 *
 * The cycle the settlement tests need is built the way the business builds
 * one (CLAUDE.md §4): an order, a leg that left, a delivery checked in, a
 * confirmed sale — through the real services.
 *
 *   INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/motorcycle_parts_<name> \
 *     npx jest profit-split.db --runInBand
 */
// eslint-disable-next-line no-restricted-properties -- an opt-in switch for a suite that must never run by default
const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;

const daysAgo = (n: number) =>
  new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

suite('saving a cycle’s whole profit split (Postgres)', () => {
  let prisma: PrismaClient;
  let cycles: CyclesService;
  let deliveries: DeliveriesService;
  let inventory: InventoryService;
  let sales: SalesService;
  let settlements: SettlementsService;
  let audit: { log: jest.Mock };
  let actor: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const db = prisma as unknown as PrismaService;
    audit = { log: jest.fn() };
    const notifications = {
      createForMultipleUsers: jest.fn(),
      create: jest.fn(),
    } as unknown as NotificationsService;
    const costing = new CostingService(db);
    cycles = new CyclesService(
      db,
      audit as unknown as AuditService,
      notifications,
    );
    deliveries = new DeliveriesService(
      db,
      audit as unknown as AuditService,
      notifications,
      costing,
      cycles,
    );
    inventory = new InventoryService(
      db,
      audit as unknown as AuditService,
      notifications,
      costing,
      cycles,
    );
    sales = new SalesService(
      db,
      audit as unknown as AuditService,
      new PaymentsService(db, audit as unknown as AuditService),
      { createForMultipleUsers: () => Promise.resolve({ count: 0 }) },
    );
    settlements = new SettlementsService(
      db,
      audit as unknown as AuditService,
      costing,
    );
    actor = (await partner('Actor')).id;
  });
  afterAll(() => prisma.$disconnect());
  beforeEach(() => audit.log.mockClear());

  // ─── Fixtures ───────────────────────────────────────────────────────

  async function partner(name: string) {
    const tag = randomUUID().slice(0, 8);
    return prisma.user.create({
      data: {
        email: `split-${name.toLowerCase()}-${tag}@example.test`,
        passwordHash: 'x',
        role: 'CORE_PARTNER',
        partner: { create: { displayName: `${name} ${tag}` } },
      },
    });
  }

  /** Three partners on a fresh cycle, each with 1,000 put in, no agreed split. */
  async function cycleWithPartners(status: string = 'PURCHASING') {
    const tag = randomUUID().slice(0, 8);
    const cycle = await prisma.importCycle.create({
      data: {
        code: `SPLIT-${tag}`,
        originType: 'UAE_DIRECT',
        currency: 'EGP',
        status: status as never,
      },
    });
    const joined = Date.now() - 60_000;
    const participants = [];
    for (const [i, name] of ['Abdallah', 'Shady', 'Fares'].entries()) {
      const p = await partner(name);
      participants.push(
        await prisma.cycleParticipant.create({
          data: {
            cycleId: cycle.id,
            participantType: 'CORE_PARTNER',
            partnerUserId: p.id,
            contributionAmount: 1000,
            createdAt: new Date(joined + i * 1000),
          },
        }),
      );
    }
    return { cycle, participants, ids: participants.map((p) => p.id) };
  }

  /**
   * A cycle as the business makes it: 40 ordered at 100, a 400 leg, all
   * delivered and checked in, 10 sold at 200 — 900 of profit to split (not
   * zero, so a share bug shows; CLAUDE.md §10).
   */
  async function tradedCycle() {
    const base = await cycleWithPartners('ARRIVED_EGYPT');
    const tag = randomUUID().slice(0, 8);
    const supplier = await prisma.supplier.create({
      data: { name: `Split ${tag}`, country: 'AE' },
    });
    const product = await prisma.product.create({
      data: { sku: `SPLIT-${tag}`, name: `Split part ${tag}` },
    });
    const po = await prisma.purchaseOrder.create({
      data: {
        cycleId: base.cycle.id,
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
        cycleId: base.cycle.id,
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
      base.cycle.id,
      {
        deliveryId: d.id,
        items: [{ deliveryLineId: d.lines[0].id, receivedQty: 40 }],
      },
      actor,
    );
    const shop = await prisma.customer.create({
      data: {
        type: 'B2B',
        displayName: `Split shop ${tag}`,
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
    return base;
  }

  const body = (ids: string[], pcts: (number | string | null)[]) => ({
    split: ids.map((participantId, i) => ({
      participantId,
      customProfitPct: pcts[i],
    })),
  });

  async function refusal(p: Promise<unknown>) {
    try {
      await p;
    } catch (e) {
      if (!(e instanceof HttpException)) throw e;
      const b = e.getResponse() as {
        code: string;
        params?: Record<string, unknown>;
      };
      return { status: e.getStatus(), code: b.code, params: b.params };
    }
    throw new Error('expected a refusal');
  }

  /** Each participant's stored percentage and when it was last written. */
  async function stored(ids: string[]) {
    const rows = await prisma.cycleParticipant.findMany({
      where: { id: { in: ids } },
    });
    return ids.map((id) => {
      const r = rows.find((x) => x.id === id)!;
      return {
        pct: r.customProfitPct === null ? null : r.customProfitPct.toFixed(2),
        at: r.updatedAt.getTime(),
      };
    });
  }
  const pcts = async (ids: string[]) => (await stored(ids)).map((s) => s.pct);

  // ─── The happy path, once ───────────────────────────────────────────

  it('saves every participant’s percentage in one request', async () => {
    const { cycle, ids } = await cycleWithPartners();
    const { data } = await cycles.saveSplit(
      cycle.id,
      body(ids, [50, 30, 20]),
      actor,
    );
    expect(await pcts(ids)).toEqual(['50.00', '30.00', '20.00']);
    expect(data.participants.map((p) => p.customProfitPct)).toEqual([
      '50',
      '30',
      '20',
    ]);
    expect(audit.log).toHaveBeenCalledTimes(1);
  });

  // ─── The limits ─────────────────────────────────────────────────────

  it.each([
    ['99.99', [33.33, 33.33, 33.33]],
    ['100.01', [33.33, 33.34, 33.34]],
  ])(
    'a split adding to %s is refused SPLIT_NOT_100, naming the total — and nothing is written',
    async (total, split) => {
      const { cycle, ids } = await cycleWithPartners();
      const before = await stored(ids);
      const r = await refusal(
        cycles.saveSplit(cycle.id, body(ids, split), actor),
      );
      expect(r).toMatchObject({
        status: 400,
        code: 'SPLIT_NOT_100',
        params: { total },
      });
      expect(await stored(ids)).toEqual(before);
    },
  );

  it('two of three set is refused PARTIAL_CUSTOM_SPLIT; so is leaving one out of the list', async () => {
    const { cycle, ids } = await cycleWithPartners();
    expect(
      (
        await refusal(
          cycles.saveSplit(cycle.id, body(ids, [50, 50, null]), actor),
        )
      ).code,
    ).toBe('PARTIAL_CUSTOM_SPLIT');
    expect(
      (
        await refusal(
          cycles.saveSplit(cycle.id, body(ids.slice(0, 2), [50, 50]), actor),
        )
      ).code,
    ).toBe('PARTIAL_CUSTOM_SPLIT');
    expect(await pcts(ids)).toEqual([null, null, null]);
  });

  it('a negative share is refused even when the total is 100; so is one over 100, and a fifth decimal', async () => {
    const { cycle, ids } = await cycleWithPartners();
    for (const split of [
      [-10, 60, 50],
      [110, -5, -5],
      [33.33335, 33.33335, 33.3333],
      ['abc', 50, 50],
    ]) {
      const r = await refusal(
        cycles.saveSplit(cycle.id, body(ids, split), actor),
      );
      expect(r).toMatchObject({ status: 400, code: 'SPLIT_PCT_INVALID' });
    }
    expect(await pcts(ids)).toEqual([null, null, null]);
  });

  it('zero is a share like any other: 0 / 40 / 60 saves', async () => {
    const { cycle, ids } = await cycleWithPartners();
    await cycles.saveSplit(cycle.id, body(ids, [0, 40, 60]), actor);
    expect(await pcts(ids)).toEqual(['0.00', '40.00', '60.00']);
  });

  it('a body that is not a list is a coded 400, never a 500', async () => {
    const { cycle } = await cycleWithPartners();
    for (const bad of [{}, { split: 'all' }, null]) {
      expect((await refusal(cycles.saveSplit(cycle.id, bad, actor))).code).toBe(
        'VALIDATION_FAILED',
      );
    }
  });

  // ─── The wrong context ──────────────────────────────────────────────

  it('a participant who is nobody, or not an id at all, is refused SPLIT_PARTICIPANT_NOT_ON_CYCLE', async () => {
    const { cycle, ids } = await cycleWithPartners();
    for (const stranger of [randomUUID(), 'p-1']) {
      const r = await refusal(
        cycles.saveSplit(
          cycle.id,
          body([...ids, stranger], [25, 25, 25, 25]),
          actor,
        ),
      );
      expect(r).toMatchObject({
        status: 400,
        code: 'SPLIT_PARTICIPANT_NOT_ON_CYCLE',
      });
    }
    expect(await pcts(ids)).toEqual([null, null, null]);
  });

  it('another cycle’s participant is refused — neither cycle changes', async () => {
    const a = await cycleWithPartners();
    const b = await cycleWithPartners();
    const r = await refusal(
      cycles.saveSplit(
        a.cycle.id,
        body([a.ids[0], a.ids[1], b.ids[2]], [50, 30, 20]),
        actor,
      ),
    );
    expect(r.code).toBe('SPLIT_PARTICIPANT_NOT_ON_CYCLE');
    expect(await pcts(a.ids)).toEqual([null, null, null]);
    expect(await pcts(b.ids)).toEqual([null, null, null]);
  });

  it('the same participant named twice is refused, even when the numbers add up', async () => {
    const { cycle, ids } = await cycleWithPartners();
    const r = await refusal(
      cycles.saveSplit(
        cycle.id,
        body([ids[0], ids[0], ids[1], ids[2]], [25, 25, 25, 25]),
        actor,
      ),
    );
    expect(r.code).toBe('SPLIT_PARTICIPANT_TWICE');
  });

  it('a cycle that does not exist is a 404, not a 500', async () => {
    for (const id of [randomUUID(), 'not-a-cycle']) {
      const r = await refusal(cycles.saveSplit(id, { split: [] }, actor));
      expect(r).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    }
  });

  it('once the settlement is approved the split is locked: FUNDING_LOCKED_AFTER_SETTLEMENT, nothing written', async () => {
    const { cycle, ids } = await tradedCycle();
    const calc = (await settlements.calculate(cycle.id, actor)).data!;
    await settlements.approve(calc.id, actor);
    const before = await stored(ids);
    const r = await refusal(
      cycles.saveSplit(cycle.id, body(ids, [50, 30, 20]), actor),
    );
    expect(r).toMatchObject({
      status: 400,
      code: 'FUNDING_LOCKED_AFTER_SETTLEMENT',
      params: { reason: 'SETTLEMENT_APPROVED' },
    });
    expect(await stored(ids)).toEqual(before);
  });

  // ─── The interaction it changes: the settlement's split ─────────────

  it('thirds of 900 at 33.33 / 33.33 / 33.34 settle as 299.97 / 299.97 / 300.06 — the profit not on one line', async () => {
    const { cycle, ids } = await tradedCycle();
    await cycles.saveSplit(cycle.id, body(ids, [33.33, 33.33, 33.34]), actor);
    const projected = (await settlements.project(cycle.id))!;
    const gross = ids.map((id) =>
      projected.distribution.lines
        .find((l) => l.participantId === id)!
        .grossProfit.toFixed(2),
    );
    expect(projected.distribution.totals.grossProfit.toFixed(2)).toBe('900.00');
    expect(gross).toEqual(['299.97', '299.97', '300.06']);
  });

  it('an unequal agreed split moves the money: 50 / 30 / 20 of 900 is 450 / 270 / 180', async () => {
    const { cycle, ids } = await tradedCycle();
    await cycles.saveSplit(cycle.id, body(ids, [50, 30, 20]), actor);
    const projected = (await settlements.project(cycle.id))!;
    expect(
      ids.map((id) =>
        projected.distribution.lines
          .find((l) => l.participantId === id)!
          .grossProfit.toFixed(2),
      ),
    ).toEqual(['450.00', '270.00', '180.00']);
  });

  // ─── The second time ────────────────────────────────────────────────

  it('saving the same split twice writes nothing the second time — a calculated draft stays approvable', async () => {
    const { cycle, ids } = await tradedCycle();
    await cycles.saveSplit(cycle.id, body(ids, [50, 30, 20]), actor);
    const calc = (await settlements.calculate(cycle.id, actor)).data!;
    const before = await stored(ids);
    audit.log.mockClear();
    await cycles.saveSplit(cycle.id, body(ids, ['50', '30.00', 20]), actor);
    expect(await stored(ids)).toEqual(before);
    expect(audit.log).not.toHaveBeenCalled();
    // Had the second save touched the rows, approval would refuse the draft
    // as calculated on funding that has since changed.
    await expect(settlements.approve(calc.id, actor)).resolves.toBeTruthy();
  });

  it('changing it, then clearing it: the last save is what stands, and clearing returns to by-contribution', async () => {
    const { cycle, ids } = await cycleWithPartners();
    await cycles.saveSplit(cycle.id, body(ids, [50, 30, 20]), actor);
    await cycles.saveSplit(cycle.id, body(ids, [20, 30, 50]), actor);
    expect(await pcts(ids)).toEqual(['20.00', '30.00', '50.00']);
    await cycles.saveSplit(cycle.id, body(ids, [null, null, null]), actor);
    expect(await pcts(ids)).toEqual([null, null, null]);
    // An empty list is "none" too.
    await cycles.saveSplit(cycle.id, body(ids, [50, 30, 20]), actor);
    await cycles.saveSplit(cycle.id, { split: [] }, actor);
    expect(await pcts(ids)).toEqual([null, null, null]);
  });

  // ─── All or nothing ─────────────────────────────────────────────────

  it('a failure halfway through the writes leaves every participant as it was', async () => {
    const { cycle, ids } = await cycleWithPartners();
    await cycles.saveSplit(cycle.id, body(ids, [50, 30, 20]), actor);
    const before = await stored(ids);

    // The database, except that the second participant write fails — as a
    // dropped connection or a deadlock would, after the first has gone in.
    // Inside a transaction or outside one alike, so a save that wrote outside
    // its transaction would be caught leaving the first write behind.
    let writes = 0;
    type Client = Pick<PrismaClient, 'cycleParticipant'>;
    const failingWrites = <C extends Client>(client: C): C =>
      new Proxy(client, {
        get(t, k, r) {
          if (k === '$transaction') {
            return (fn: (tx: unknown) => Promise<unknown>) =>
              prisma.$transaction((tx) => fn(failingWrites(tx)));
          }
          if (k !== 'cycleParticipant') return Reflect.get(t, k, r) as unknown;
          const delegate = t.cycleParticipant;
          return new Proxy(delegate, {
            get(d, m, dr) {
              if (m !== 'update') return Reflect.get(d, m, dr) as unknown;
              return (args: Parameters<typeof delegate.update>[0]) => {
                writes += 1;
                if (writes === 2) {
                  return Promise.reject(new Error('connection lost'));
                }
                return delegate.update(args);
              };
            },
          });
        },
      });
    const failing = failingWrites(prisma);
    const flaky = new CyclesService(
      failing as unknown as PrismaService,
      audit as unknown as AuditService,
      {} as NotificationsService,
    );
    await expect(
      flaky.saveSplit(cycle.id, body(ids, [10, 20, 70]), actor),
    ).rejects.toThrow('connection lost');
    expect(writes).toBe(2);
    expect(await stored(ids)).toEqual(before);
  });
});
