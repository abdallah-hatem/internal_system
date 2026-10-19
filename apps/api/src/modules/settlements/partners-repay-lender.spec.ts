/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- the fake database's rows are untyped records, as Prisma's argument objects are */
import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CostingService } from '../costing/costing.service';
import { CyclesService } from '../cycles/cycles.service';
import { SalesService } from '../sales/sales.service';
import { PaymentsService } from '../payments/payments.service';
import { DeliveriesService } from '../shipping/deliveries.service';
import { InventoryService } from '../inventory/inventory.service';
import { SettlementsService } from './settlements.service';
import {
  addLeg,
  cycleWithOrder,
  D,
  emptyStore,
  fakePrisma,
  type Row,
  type Store,
} from '../shipping/shipment-fake-spec';

/**
 * The partners repay the friend who paid for a cycle (BUSINESS_LOGIC §18,
 * owner 2026-10-19): "I need to show that we split money among us to repay
 * the lender … it does not have to be equally maybe 30,30,40".
 *
 * A friend's payment is a loan to the partners, not funding that replaces
 * theirs. So what the partners fund is the whole cycle cost whoever paid the
 * supplier, their contributions are their shares of repaying him, and profit
 * follows those contributions. With none entered, settling refuses like any
 * other cycle — the equal split for "a cycle a friend paid for entirely"
 * (2026-10-11) is gone.
 *
 * Built the way the business builds it (CLAUDE.md §4): an order, a leg, a
 * delivery, a checked-in receipt and a confirmed sale, through the real
 * services over the in-memory database, with a non-zero profit (§10: zero
 * hides every share bug there is).
 */

const ACTOR = randomUUID();
let db: Store;
let prisma: ReturnType<typeof fakePrisma>;
let costing: CostingService;
let settlements: SettlementsService;
let sales: SalesService;
let deliveries: DeliveriesService;
let inventory: InventoryService;
/** What friends paid towards the cycle, in pounds — the fake's aggregate. */
let financedEgp: number | null;

beforeEach(() => {
  jest.useFakeTimers({
    doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    now: new Date('2026-09-21T09:00:00Z'),
  });
  db = emptyStore();
  prisma = fakePrisma(db);
  financedEgp = null;
  // The shipment fake has no friend in it; this one paid `financedEgp`.
  (prisma as any).lenderFinancing.aggregate = () =>
    Promise.resolve({
      _sum: { amountEgp: financedEgp === null ? null : D(financedEgp) },
    });
  const audit = { log: jest.fn() } as unknown as AuditService;
  const notifications = {
    createForMultipleUsers: jest.fn(),
  } as unknown as NotificationsService;
  costing = new CostingService(prisma);
  const cycles = new CyclesService(prisma, audit, notifications);
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
  settlements = new SettlementsService(prisma, audit, costing);
  sales = new SalesService(prisma, audit, new PaymentsService(prisma, audit), {
    createForMultipleUsers: () => Promise.resolve({ count: 0 }),
  });
});
afterEach(() => jest.useRealTimers());

async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof HttpException)) throw e;
    const body = e.getResponse() as Record<string, any>;
    return { status: e.getStatus(), code: body.code };
  }
  throw new Error('expected a refusal');
}

/**
 * 40 pads at 100 and a 400 leg: the cycle cost 4,400.00 (110.00 a pad
 * landed). All delivered, checked in, and 10 sold at 200 — 900.00 profit.
 */
async function sellingCycle() {
  const { cycle, items } = cycleWithOrder(db, {
    status: 'ARRIVED_EGYPT',
    lines: [['Brake pad', 40, 100]],
  });
  const item = items[0];
  const leg = addLeg(db, cycle, 1, {
    departedOn: '2026-09-01',
    amountEgp: 400,
  });
  const { data: delivery } = await deliveries.recordDelivery(
    leg.id,
    {
      arrivedOn: '2026-09-20',
      lines: [{ purchaseOrderItemId: item.id, qty: 40 }],
    },
    ACTOR,
  );
  await inventory.verifyStock(
    cycle.id,
    {
      deliveryId: (delivery as Row).id,
      items: [
        { deliveryLineId: (delivery as Row).lines[0].id, receivedQty: 40 },
      ],
    },
    ACTOR,
  );
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
      items: [
        {
          productId: item.productId,
          quantity: 10,
          unitPrice: 200,
          discount: 0,
        },
      ],
      confirm: true,
    },
    ACTOR,
  );
  return cycle;
}

/** The three core partners, each with what they put in (or repay). */
function partners(
  cycle: Row,
  contributions: number[],
  custom: (number | null)[] = [],
) {
  return contributions.map((c, i) => {
    const row = {
      id: `p${i + 1}`,
      cycleId: cycle.id,
      participantType: 'CORE_PARTNER',
      partnerUserId: randomUUID(),
      contributionAmount: D(c),
      customProfitPct: custom[i] == null ? null : D(custom[i]),
      investorFeePct: null,
      createdAt: new Date(),
    };
    db.participants.push(row);
    return row;
  });
}

describe('what the partners fund on a cycle a friend paid for', () => {
  it('a friend paid it all: the partners still fund the whole cost, and what he paid is reported beside it', async () => {
    const cycle = await sellingCycle();
    financedEgp = 4400;
    const f = await costing.fundingFor(cycle.id);
    expect([
      f.cycleCost.toFixed(2),
      f.financed.toFixed(2),
      f.toFund.toFixed(2),
    ]).toEqual(['4400.00', '4400.00', '4400.00']);
  });

  it('a friend paid part: the same whole cost — he lent part of it, nothing less is asked', async () => {
    const cycle = await sellingCycle();
    financedEgp = 1000;
    expect((await costing.fundingFor(cycle.id)).toFund.toFixed(2)).toBe(
      '4400.00',
    );
  });

  it('nobody paid: unchanged, the whole cost', async () => {
    const cycle = await sellingCycle();
    expect((await costing.fundingFor(cycle.id)).toFund.toFixed(2)).toBe(
      '4400.00',
    );
  });

  it('the cost to fund does not move when a friend’s payment is recorded', async () => {
    const cycle = await sellingCycle();
    const before = (await costing.fundingFor(cycle.id)).toFund;
    financedEgp = 4400;
    const after = (await costing.fundingFor(cycle.id)).toFund;
    expect(after.sub(before).toFixed(2)).toBe('0.00');
  });
});

describe('the cycle page’s reading: what settling would split on', () => {
  it('a friend paid it all, nothing entered: NONE, so the funding note shows', async () => {
    const cycle = await sellingCycle();
    financedEgp = 4400;
    partners(cycle, [0, 0, 0]);
    expect(await costing.profitBasis(cycle.id)).toBe('NONE');
  });

  it('their shares of repaying him entered: CONTRIBUTIONS, and the note goes', async () => {
    const cycle = await sellingCycle();
    financedEgp = 4400;
    partners(cycle, [1320, 1320, 1760]);
    expect(await costing.profitBasis(cycle.id)).toBe('CONTRIBUTIONS');
  });
});

describe('settling a cycle a friend paid for entirely', () => {
  it('contributions 30/30/40 of the cost split a non-zero profit 30/30/40 and return exactly that capital', async () => {
    const cycle = await sellingCycle();
    financedEgp = 4400;
    partners(cycle, [1320, 1320, 1760]);
    const projected = (await settlements.project(cycle.id))!;
    expect(projected.pnl.grossProfit.toFixed(2)).toBe('900.00');
    const lines = projected.distribution.lines;
    expect(lines.map((l) => l.sharePct.toFixed(2))).toEqual([
      '30.00',
      '30.00',
      '40.00',
    ]);
    expect(lines.map((l) => l.grossProfit.toFixed(2))).toEqual([
      '270.00',
      '270.00',
      '360.00',
    ]);
    expect(lines.map((l) => l.capitalReturn.toFixed(2))).toEqual([
      '1320.00',
      '1320.00',
      '1760.00',
    ]);
    // Capital returned is capital put in: the 4,400 they repaid him.
    expect(projected.distribution.totals.capitalReturned.toFixed(2)).toBe(
      '4400.00',
    );
  });

  it('nothing entered from the partners is refused CYCLE_NOT_FUNDED — no longer split equally', async () => {
    const cycle = await sellingCycle();
    financedEgp = 4400;
    partners(cycle, [0, 0, 0]);
    expect(await refusal(settlements.project(cycle.id))).toEqual({
      status: 400,
      code: 'CYCLE_NOT_FUNDED',
    });
    expect(await refusal(settlements.preview(cycle.id))).toMatchObject({
      code: 'CYCLE_NOT_FUNDED',
    });
  });

  it('partly paid by a friend, nothing entered: refused the same way', async () => {
    const cycle = await sellingCycle();
    financedEgp = 1000;
    partners(cycle, [0, 0, 0]);
    expect((await refusal(settlements.project(cycle.id))).code).toBe(
      'CYCLE_NOT_FUNDED',
    );
  });

  it('an agreed custom split still overrides the contributions', async () => {
    const cycle = await sellingCycle();
    financedEgp = 4400;
    partners(cycle, [1320, 1320, 1760], [50, 25, 25]);
    const lines = (await settlements.project(cycle.id))!.distribution.lines;
    expect(lines.map((l) => l.grossProfit.toFixed(2))).toEqual([
      '450.00',
      '225.00',
      '225.00',
    ]);
    // Capital still comes back as put in: the split moves profit, not capital.
    expect(lines.map((l) => l.capitalReturn.toFixed(2))).toEqual([
      '1320.00',
      '1320.00',
      '1760.00',
    ]);
  });

  it('a custom split agreed with nothing entered still settles — the escape hatch is unchanged', async () => {
    const cycle = await sellingCycle();
    financedEgp = 4400;
    partners(cycle, [0, 0, 0], [30, 30, 40]);
    const lines = (await settlements.project(cycle.id))!.distribution.lines;
    expect(lines.map((l) => l.grossProfit.toFixed(2))).toEqual([
      '270.00',
      '270.00',
      '360.00',
    ]);
  });

  it('one partner repaid all of it: he takes all the profit, the others nothing — no equal split sneaks back', async () => {
    const cycle = await sellingCycle();
    financedEgp = 4400;
    partners(cycle, [0, 4400, 0]);
    const lines = (await settlements.project(cycle.id))!.distribution.lines;
    expect(lines.map((l) => l.grossProfit.toFixed(2))).toEqual([
      '0.00',
      '900.00',
      '0.00',
    ]);
  });
});
