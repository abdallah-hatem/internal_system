/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await -- the fake database's rows are untyped records, as Prisma's argument objects are */
import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; the rows here are built by hand
import { Prisma } from '@prisma/client';
import { SettlementsService } from './settlements.service';
import { SettlementsController } from './settlements.controller';
import { ROLES_KEY } from '../../common/guards/roles.guard';
import { cashPosition } from '../../common/cash-position';
import { fixRunningCostShares } from '../../common/running-costs';

/**
 * L7 — general running costs come out of the core partners' payouts, and a
 * payout explains itself (BUSINESS_LOGIC §8, owner 2026-10-11).
 *
 * Through the real SettlementsService — calculate, Mark paid, reverse, read —
 * over an in-memory database that answers the queries those make. Each cycle
 * is a cycle the business recognises (CLAUDE.md §4): partners who put money
 * in, goods that sold at a profit, costs recorded in the ledger the way the
 * ledger's own form records them.
 */

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
type Row = Record<string, any>;

interface Store {
  users: Row[];
  partners: Row[];
  cycles: Row[];
  participants: Row[];
  allocations: Row[];
  ledger: Row[];
  settlements: Row[];
  lines: Row[];
  charges: Row[];
  /** Each running cost's shares, fixed once (§8, L7 review). */
  shares: Row[];
}

function inOrNot(value: unknown, cond: any): boolean {
  if (cond === undefined) return true;
  if (cond === null) return value === null || value === undefined;
  if (typeof cond !== 'object' || cond instanceof Date) return value === cond;
  if (cond.in && !cond.in.includes(value)) return false;
  if (cond.notIn && cond.notIn.includes(value)) return false;
  if (
    'not' in cond &&
    cond.not === null &&
    (value === null || value === undefined)
  )
    return false;
  return true;
}

function fakePrisma(db: Store) {
  let lockHeld: Promise<void> | null = null;
  let release: (() => void) | null = null;
  const wait = () => new Promise<void>((r) => setImmediate(r));

  const ledgerMatches = (t: Row, w: Row = {}) =>
    inOrNot(t.cycleId ?? null, w.cycleId) &&
    inOrNot(t.reversalOfId ?? null, w.reversalOfId) &&
    inOrNot(t.direction, w.direction) &&
    inOrNot(t.category, w.category) &&
    inOrNot(t.type, w.type) &&
    inOrNot(t.relatedType ?? null, w.relatedType) &&
    inOrNot(t.relatedId ?? null, w.relatedId);

  const withParticipant = (l: Row) => ({
    ...l,
    participant: db.participants.find((p) => p.id === l.participantId),
  });
  const settlementView = (s: Row) => ({
    ...s,
    cycle: db.cycles.find((c) => c.id === s.cycleId),
    lines: db.lines.filter((l) => l.settlementId === s.id).map(withParticipant),
  });

  const api: any = {
    $transaction: async (cb: (tx: any) => Promise<unknown>) => {
      try {
        return await cb(api);
      } finally {
        if (release) {
          const r = release;
          release = null;
          lockHeld = null;
          r();
        }
      }
    },
    // The advisory lock: a second payout waits until the first one's
    // transaction ends, as Postgres makes it.
    $executeRaw: async () => {
      while (lockHeld) await lockHeld;
      lockHeld = new Promise<void>((r) => (release = r));
      return 1;
    },
    partner: {
      findMany: async ({ where }: Row) => {
        await wait();
        return db.partners
          .filter((p) => {
            const u = db.users.find((x) => x.id === p.userId);
            return (
              p.active === where.active &&
              u?.role === where.user.role &&
              u?.status === where.user.status
            );
          })
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map((p) => ({
            userId: p.userId,
            displayName: p.displayName,
            createdAt: p.createdAt,
          }));
      },
    },
    importCycle: {
      findUnique: async ({ where }: Row) =>
        db.cycles.find((c) => c.id === where.id) ?? null,
      update: async ({ where, data }: Row) => {
        const c = db.cycles.find((x) => x.id === where.id)!;
        Object.assign(c, data);
        return c;
      },
    },
    cycleParticipant: {
      findMany: async ({ where }: Row) =>
        db.participants.filter((p) => p.cycleId === where.cycleId),
    },
    saleItemAllocation: {
      findMany: async ({ where }: Row) =>
        db.allocations.filter(
          (a) => a.cycleId === where.inventoryBatch.cycleId,
        ),
    },
    saleReturnItem: { findMany: async () => [] },
    inventoryBatch: { findMany: async () => [] },
    shipmentLoss: { aggregate: async () => ({ _sum: { costEgp: null } }) },
    lenderRepayment: {
      aggregate: async () => ({ _sum: { exchangeDiffEgp: null } }),
    },
    stockTransferLine: { aggregate: async () => ({ _sum: { costEgp: null } }) },
    financialTransaction: {
      findMany: async ({ where }: Row) => {
        await wait();
        return db.ledger.filter((t) => ledgerMatches(t, where));
      },
      groupBy: async ({ where }: Row) =>
        ['INFLOW', 'OUTFLOW'].map((direction) => ({
          direction,
          _sum: {
            amount: db.ledger
              .filter(
                (t) => t.direction === direction && ledgerMatches(t, where),
              )
              .reduce((s, t) => s.add(t.amount), D(0)),
          },
        })),
      create: async ({ data }: Row) => {
        const row = {
          id: randomUUID(),
          cycleId: null,
          reversalOfId: null,
          occurredOn: null,
          createdAt: new Date(),
          ...data,
          amount: D(data.amount),
        };
        db.ledger.push(row);
        return row;
      },
    },
    runningCostShare: {
      findMany: async ({ where }: Row) => {
        await wait();
        return db.shares.filter((x) =>
          inOrNot(x.costEntryId, where?.costEntryId),
        );
      },
      createMany: async ({ data }: Row) => {
        for (const d of data) {
          if (
            db.shares.some(
              (x) =>
                x.costEntryId === d.costEntryId &&
                x.partnerUserId === d.partnerUserId,
            )
          )
            continue;
          db.shares.push({ id: randomUUID(), ...d, amount: D(d.amount) });
        }
        return { count: data.length };
      },
    },
    user: {
      findMany: async ({ where }: Row) =>
        db.partners
          .filter((p) => inOrNot(p.userId, where?.id))
          .map((p) => ({
            id: p.userId,
            partner: { displayName: p.displayName },
          })),
    },
    runningCostCharge: {
      findMany: async ({ where }: Row) => {
        await wait();
        return db.charges
          .filter(
            (c) =>
              inOrNot(c.releasedAt ?? null, where.releasedAt) &&
              inOrNot(c.settlementId, where.settlementId) &&
              inOrNot(c.costEntryId, where.costEntryId),
          )
          .map((c) => ({
            ...c,
            costEntry: db.ledger.find((t) => t.id === c.costEntryId),
          }));
      },
      create: async ({ data }: Row) => {
        const row = { id: randomUUID(), releasedAt: null, ...data };
        db.charges.push(row);
        return row;
      },
      updateMany: async ({ where, data }: Row) => {
        const hit = db.charges.filter(
          (c) => c.settlementId === where.settlementId && c.releasedAt === null,
        );
        hit.forEach((c) => Object.assign(c, data));
        return { count: hit.length };
      },
    },
    settlement: {
      findFirst: async ({ where }: Row) =>
        db.settlements.find(
          (s) =>
            s.cycleId === where.cycleId && where.status.in.includes(s.status),
        ) ?? null,
      findMany: async ({ where }: Row) =>
        db.settlements
          .filter(
            (s) =>
              (!where?.cycleId || s.cycleId === where.cycleId) &&
              (!where?.status || s.status === where.status),
          )
          .map(settlementView),
      findUnique: async ({ where }: Row) => {
        await wait();
        const s = db.settlements.find((x) => x.id === where.id);
        return s ? settlementView(s) : null;
      },
      create: async ({ data }: Row) => {
        const row = { id: randomUUID(), createdAt: new Date(), ...data };
        db.settlements.push(row);
        return row;
      },
      update: async ({ where, data }: Row) => {
        const s = db.settlements.find((x) => x.id === where.id)!;
        Object.assign(s, data);
        return settlementView(s);
      },
      deleteMany: async ({ where }: Row) => {
        db.settlements = db.settlements.filter(
          (s) => !where.id.in.includes(s.id),
        );
        return {};
      },
    },
    settlementLine: {
      create: async ({ data }: Row) => {
        const row = { id: randomUUID(), ...data, amount: D(data.amount) };
        db.lines.push(row);
        return row;
      },
      deleteMany: async ({ where }: Row) => {
        db.lines = db.lines.filter(
          (l) => !where.settlementId.in.includes(l.settlementId),
        );
        return {};
      },
    },
  };
  return api;
}

// ── The business ─────────────────────────────────────────────────────

let db: Store;
let prisma: any;
let service: SettlementsService;
const ACTOR = 'u-a';

const core = ['u-a', 'u-o', 'u-m'];
const names: Record<string, string> = {
  'u-a': 'Abdallah',
  'u-o': 'Omar',
  'u-m': 'Mahmoud',
};

beforeEach(() => {
  db = {
    users: [
      ...core.map((id) => ({ id, role: 'CORE_PARTNER', status: 'ACTIVE' })),
      { id: 'u-i', role: 'TEMP_INVESTOR', status: 'ACTIVE' },
    ],
    // Joined in this order: Mahmoud joined last, so takes the odd piastre.
    partners: core.map((userId, i) => ({
      userId,
      displayName: names[userId],
      active: true,
      // Joined on 1, 2 and 3 January 2026.
      createdAt: new Date(Date.UTC(2026, 0, 1 + i, 8)),
    })),
    cycles: [],
    participants: [],
    allocations: [],
    ledger: [],
    settlements: [],
    lines: [],
    charges: [],
    shares: [],
  };
  prisma = fakePrisma(db);
  service = new SettlementsService(
    prisma,
    { log: jest.fn().mockResolvedValue(undefined) } as never,
    {} as never,
  );
});

/**
 * A cycle that sold everything: `revenue` against `cogs`, with these people
 * having put in these amounts (an investor at a 10% fee).
 */
function cycle(
  code: string,
  people: [string, number][],
  revenue: number,
  cogs: number,
) {
  const c = { id: randomUUID(), code, status: 'SELLING', currency: 'EGP' };
  db.cycles.push(c);
  people.forEach(([userId, contribution], i) =>
    db.participants.push({
      id: `${code}-${userId}`,
      cycleId: c.id,
      participantType: userId === 'u-i' ? 'TEMP_INVESTOR' : 'CORE_PARTNER',
      partnerUserId: userId === 'u-i' ? null : userId,
      investorUserId: userId === 'u-i' ? userId : null,
      contributionAmount: D(contribution),
      customProfitPct: null,
      investorFeePct: userId === 'u-i' ? D(10) : null,
      createdAt: i,
    }),
  );
  db.allocations.push({
    cycleId: c.id,
    qty: D(10),
    cogsEgp: D(cogs),
    saleItem: { quantity: D(10), lineTotal: D(revenue) },
  });
  return c;
}

/** An expense recorded in the ledger the way "Record money in or out" does. */
function expense(
  category: string,
  amount: number,
  day: string,
  cycleId: string | null = null,
) {
  const row = {
    id: randomUUID(),
    type: 'EXPENSE',
    category,
    direction: 'OUTFLOW',
    amount: D(amount),
    currency: 'EGP',
    cycleId,
    reversalOfId: null,
    relatedType: null,
    relatedId: null,
    occurredOn: new Date(`${day}T00:00:00Z`),
    createdAt: new Date(`${day}T08:00:00Z`),
  };
  db.ledger.push(row);
  return row;
}

/** Calculate, approve (its gates are other suites'), pay. */
async function settle(c: Row) {
  const { data } = await service.calculate(c.id, ACTOR);
  db.settlements.find((s) => s.id === data!.id)!.status = 'APPROVED';
  await service.markPaid(data!.id, ACTOR);
  return data!.id;
}

const chargedTo = (userId: string) =>
  db.charges
    .filter((c) => c.partnerUserId === userId && c.releasedAt === null)
    .reduce((s, c) => s.add(c.amount), D(0))
    .toFixed(2);

const payoutRow = (settlementId: string, participantId: string) => {
  const line = db.lines.find(
    (l) => l.settlementId === settlementId && l.participantId === participantId,
  );
  void line;
  return db.ledger.filter(
    (t) => t.relatedId === settlementId && t.type === 'SETTLEMENT_PAYOUT',
  );
};

// Cycle A: Abdallah and Omar 20,000 each, the investor 10,000. 80,000 sold
// against 50,000 of goods, 2,000 of extra freight charged to it: 28,000 profit,
// 40 / 40 / 20. The investor's 5,600 pays a 560 fee, 280 to each partner.
// Abdallah is paid 20,000 + 11,200 + 280 = 31,480 before running costs.
function cycleA() {
  const a = cycle(
    'CYC-A',
    [
      ['u-a', 20000],
      ['u-o', 20000],
      ['u-i', 10000],
    ],
    80000,
    50000,
  );
  expense('extra_freight', 2000, '2026-09-10', a.id);
  return a;
}

describe('Mark paid takes each core partner’s share of the running costs', () => {
  it('his third of each waiting cost, on its own line; the investor pays none; the partner not on the cycle waits', async () => {
    const a = cycleA();
    expense('rent', 30000, '2026-09-01');
    expense('salaries', 3000, '2026-09-20');
    const id = await settle(a);

    expect(chargedTo('u-a')).toBe('11000.00');
    expect(chargedTo('u-o')).toBe('11000.00');
    expect(chargedTo('u-m')).toBe('0.00');
    expect(db.charges.some((c) => c.partnerUserId === 'u-i')).toBe(false);

    const line = (pid: string) =>
      db.lines.find(
        (l) =>
          l.settlementId === id &&
          l.participantId === pid &&
          l.component === 'RUNNING_COSTS',
      );
    expect(line('CYC-A-u-a')!.amount.toFixed(2)).toBe('-11000.00');
    expect(line('CYC-A-u-i')).toBeUndefined();
  });

  it('the payout handed over is net of it, and the ledger records the deduction — not cash, not an expense', async () => {
    const a = cycleA();
    expense('rent', 30000, '2026-09-01');
    expense('salaries', 3000, '2026-09-20');
    const before = await cashPosition(prisma);
    const id = await settle(a);
    const after = await cashPosition(prisma);

    const payouts = payoutRow(id, '')
      .map((t) => t.amount.toFixed(2))
      .sort();
    // Abdallah and Omar 31,480 − 11,000; the investor 10,000 + 5,040.
    expect(payouts).toEqual(['15040.00', '20480.00', '20480.00']);
    const memo = db.ledger.filter(
      (t) => t.relatedId === id && t.type === 'RUNNING_COST_CHARGE',
    );
    expect(
      memo.map((t) => [t.category, t.direction, t.amount.toFixed(2)]),
    ).toEqual([
      ['running_cost_share', 'INFLOW', '11000.00'],
      ['running_cost_share', 'INFLOW', '11000.00'],
    ]);
    // Cash out is exactly what was handed over: 20,480 × 2 + 15,040.
    expect(after.cashOut.sub(before.cashOut).toFixed(2)).toBe('56000.00');
    expect(after.cashIn.sub(before.cashIn).toFixed(2)).toBe('0.00');
  });

  it('the cycle’s own profit is untouched by running costs', async () => {
    const a = cycleA();
    const without = (await service.project(a.id))!.pnl.grossProfit.toFixed(2);
    expense('rent', 30000, '2026-09-01');
    const withCosts = (await service.project(a.id))!.pnl.grossProfit.toFixed(2);
    expect(withCosts).toBe(without);
    expect(withCosts).toBe('28000.00');
    const id = await settle(a);
    expect(
      db.settlements.find((s) => s.id === id)!.grossProfitEgp.toFixed(2),
    ).toBe('28000.00');
  });

  it('a cost charged to a cycle is that cycle’s, never a running cost', async () => {
    const a = cycleA();
    const freight = db.ledger.find((t) => t.category === 'extra_freight')!;
    await settle(a);
    expect(db.charges.filter((c) => c.costEntryId === freight.id)).toEqual([]);
  });

  it('a running cost that was reversed is not charged', async () => {
    const a = cycleA();
    const power = expense('utilities', 900, '2026-09-05');
    db.ledger.push({
      ...power,
      id: randomUUID(),
      direction: 'INFLOW',
      reversalOfId: power.id,
    });
    await settle(a);
    expect(db.charges).toEqual([]);
  });
});

describe('the second time', () => {
  it('charged once: the next payout, from another cycle, takes only what is still waiting', async () => {
    const a = cycleA();
    expense('rent', 30000, '2026-09-01');
    await settle(a);
    const b = cycle(
      'CYC-B',
      [
        ['u-a', 5000],
        ['u-m', 5000],
      ],
      20000,
      10000,
    );
    await settle(b);
    // Abdallah paid his 10,000 from A; Mahmoud's comes from B.
    expect(chargedTo('u-a')).toBe('10000.00');
    expect(chargedTo('u-m')).toBe('10000.00');
    const total = db.charges.reduce((s, c) => s.add(c.amount), D(0));
    expect(total.toFixed(2)).toBe('30000.00');
  });

  it('a payout too small takes what it can; the rest carries to his next one', async () => {
    // Omar put in 4,000 and the cycle broke even: his payout is his 4,000.
    const small = cycle('CYC-S', [['u-o', 4000]], 10000, 10000);
    expense('rent', 30000, '2026-09-01');
    const id = await settle(small);
    expect(chargedTo('u-o')).toBe('4000.00');
    // He was handed nothing, and nothing negative.
    expect(
      db.ledger.filter(
        (t) => t.relatedId === id && t.type === 'SETTLEMENT_PAYOUT',
      ),
    ).toEqual([]);

    const next = cycle('CYC-N', [['u-o', 10000]], 30000, 10000);
    await settle(next);
    expect(chargedTo('u-o')).toBe('10000.00');
  });

  it('reversing the settlement puts its running costs back to waiting, and the ledger nets to nothing', async () => {
    const a = cycleA();
    expense('rent', 30000, '2026-09-01');
    const before = await cashPosition(prisma);
    const id = await settle(a);
    await service.reverse(id, 'paid the wrong amounts', ACTOR);

    expect(chargedTo('u-a')).toBe('0.00');
    expect(db.charges.every((c) => c.releasedAt instanceof Date)).toBe(true);
    const after = await cashPosition(prisma);
    expect(after.cashOnHand.toFixed(2)).toBe(before.cashOnHand.toFixed(2));
    const memo = db.ledger.filter(
      (t) => t.relatedId === id && t.category === 'running_cost_share',
    );
    const net = memo.reduce(
      (s, t) => (t.direction === 'INFLOW' ? s.add(t.amount) : s.sub(t.amount)),
      D(0),
    );
    expect(net.toFixed(2)).toBe('0.00');

    // Paid again: charged again, once.
    db.cycles.find((c) => c.id === a.id)!.status = 'SELLING';
    await settle(a);
    expect(chargedTo('u-a')).toBe('10000.00');
  });

  it('two clicks on Mark paid at once: one pays, the other is refused — nothing is charged twice', async () => {
    const a = cycleA();
    expense('rent', 30000, '2026-09-01');
    const { data } = await service.calculate(a.id, ACTOR);
    db.settlements.find((s) => s.id === data!.id)!.status = 'APPROVED';
    const results = await Promise.allSettled([
      service.markPaid(data!.id, ACTOR),
      service.markPaid(data!.id, ACTOR),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const refused = results.find(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult;
    expect((refused.reason as HttpException).getResponse()).toMatchObject({
      code: 'ONLY_APPROVED_PAYABLE',
    });
    expect(chargedTo('u-a')).toBe('10000.00');
  });
});

describe('a payout explains itself — the breakdown is the settlement’s own figures', () => {
  it('cycle lines and each partner’s lines, summing to the settlement and to what the ledger paid him', async () => {
    const a = cycleA();
    expense('rent', 30000, '2026-09-01');
    expense('salaries', 3000, '2026-09-20');
    const id = await settle(a);
    const { data } = await service.findOne(id);
    const s = db.settlements.find((x) => x.id === id)!;
    const b = data.breakdown!;

    expect(b.revenueEgp).toBe(s.revenueEgp.toFixed(2));
    expect(b.cogsEgp).toBe(s.cogsEgp.toFixed(2));
    expect(b.cycleProfitEgp).toBe(s.grossProfitEgp.toFixed(2));
    expect(b.costs).toEqual([
      { kind: 'charge', category: 'extra_freight', amountEgp: '2000.00' },
    ]);
    const costs = b.costs!.reduce((sum, c) => sum.add(c.amountEgp), D(0));
    expect(costs.toFixed(2)).toBe(s.expensesEgp.toFixed(2));

    const abdallah = b.participants.find(
      (p) => p.participantId === 'CYC-A-u-a',
    )!;
    expect(abdallah).toMatchObject({
      sharePct: '40.00',
      profitShareEgp: '11200.00',
      feeReceivedEgp: '280.00',
      capitalBackEgp: '20000.00',
      runningCostsEgp: '-11000.00',
      runningCostsFrom: '2026-09-01',
      runningCostsTo: '2026-09-20',
      runningCostsStatus: 'charged',
      paidEgp: '20480.00',
    });
    // What the breakdown says he was paid is what the ledger handed him.
    const paid = db.ledger
      .filter((t) => t.relatedId === id && t.type === 'SETTLEMENT_PAYOUT')
      .map((t) => t.amount.toFixed(2));
    for (const p of b.participants) expect(paid).toContain(p.paidEgp);
  });

  it('before it is paid, the screen shows what paying now would take — and paying takes exactly that', async () => {
    const a = cycleA();
    expense('rent', 30000, '2026-09-01');
    const { data } = await service.calculate(a.id, ACTOR);
    db.settlements.find((s) => s.id === data!.id)!.status = 'APPROVED';
    const before = (await service.findOne(data!.id)).data.breakdown!;
    const projected = before.participants.map((p) => [
      p.participantId,
      p.runningCostsEgp,
      p.paidEgp,
    ]);
    expect(
      before.participants.find((p) => p.participantId === 'CYC-A-u-a')!
        .runningCostsStatus,
    ).toBe('projected');

    await service.markPaid(data!.id, ACTOR);
    const after = (await service.findOne(data!.id)).data.breakdown!;
    expect(
      after.participants.map((p) => [
        p.participantId,
        p.runningCostsEgp,
        p.paidEgp,
      ]),
    ).toEqual(projected);
  });
});

describe('the Partners page section', () => {
  it('a period: spent by category, taken, waiting, and each partner’s share — the odd piastre stated', async () => {
    const a = cycleA();
    expense('rent', 30000, '2026-09-01');
    expense('utilities', 100, '2026-09-02');
    expense('rent', 9000, '2026-06-01'); // last quarter: outside the period
    await settle(a);
    const { data } = await service.runningCosts({
      from: '2026-07-01',
      to: '2026-09-30',
    });
    expect(data.spentEgp).toBe('30100.00');
    expect(data.byCategory).toEqual([
      { category: 'rent', spentEgp: '30000.00' },
      { category: 'utilities', spentEgp: '100.00' },
    ]);
    // A's payouts covered Abdallah's and Omar's whole thirds — June's rent
    // and this quarter's alike; Mahmoud is not on A, so his third waits.
    expect(
      data.partners.map((p) => [
        p.name,
        p.shareEgp,
        p.chargedEgp,
        p.waitingEgp,
        p.takesResidual,
      ]),
    ).toEqual([
      ['Abdallah', '10033.33', '10033.33', '0.00', false],
      ['Omar', '10033.33', '10033.33', '0.00', false],
      ['Mahmoud', '10033.34', '0.00', '10033.34', true],
    ]);
    expect(data.chargedEgp).toBe('20066.66');
    expect(data.waitingEgp).toBe('10033.34');
    // Whatever the period: Mahmoud's third of all 39,100.
    expect(data.waitingAllTimeEgp).toBe('13033.34');
  });

  it('a range that ends before it starts is refused, not answered with nothing', async () => {
    await expect(
      service.runningCosts({ from: '2026-09-30', to: '2026-07-01' }),
    ).rejects.toMatchObject({ response: { code: 'DATE_RANGE_REVERSED' } });
  });
});

// ─── The alignment review (2026-10-12): a cost's shares are fixed once ──────
// Over the core partners active on the cost's own day; a partner's share of it
// never changes afterwards. Nobody silently pays a share that is not his.

/** A core partner joining (or a record that stands for one) on `day`. */
function joins(userId: string, name: string, day: string) {
  db.users.push({ id: userId, role: 'CORE_PARTNER', status: 'ACTIVE' });
  db.partners.push({
    userId,
    displayName: name,
    active: true,
    createdAt: new Date(`${day}T08:00:00Z`),
  });
}

describe('a cost’s shares are fixed on its own day (review, 2026-10-12)', () => {
  it('C leaves with his share unpaid: A and B are never charged more than a third each, and C’s third stays waiting — as his', async () => {
    expense('rent', 300, '2026-09-01');
    // A is paid first: his third.
    await settle(cycle('CYC-1', [['u-a', 5000]], 10000, 8000));
    expect(chargedTo('u-a')).toBe('100.00');
    // Mahmoud leaves before anyone takes his third.
    db.partners.find((p) => p.userId === 'u-m')!.active = false;
    await settle(
      cycle(
        'CYC-2',
        [
          ['u-a', 5000],
          ['u-o', 5000],
        ],
        20000,
        16000,
      ),
    );
    expect(chargedTo('u-a')).toBe('100.00');
    expect(chargedTo('u-o')).toBe('100.00');
    expect(chargedTo('u-m')).toBe('0.00');
    const { data } = await service.runningCosts({
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(data.waitingEgp).toBe('100.00');
    // His part, still waiting, shown as his.
    expect(data.partners.find((p) => p.userId === 'u-m')?.waitingEgp).toBe(
      '100.00',
    );
  });

  it('D joins after the cost’s day: he is never charged for it, and the three who were there still owe a third each', async () => {
    expense('rent', 300, '2026-09-01');
    joins('u-d', 'Dina', '2026-10-01');
    await settle(
      cycle(
        'CYC-D',
        [
          ['u-d', 5000],
          ['u-a', 5000],
        ],
        20000,
        16000,
      ),
    );
    expect(chargedTo('u-d')).toBe('0.00');
    expect(chargedTo('u-a')).toBe('100.00');
    // A cost on D's watch is his too.
    expense('utilities', 400, '2026-10-05');
    await settle(cycle('CYC-D2', [['u-d', 5000]], 20000, 16000));
    expect(chargedTo('u-d')).toBe('100.00');
  });

  it('the shares are written once and never move, whoever joins or leaves later', async () => {
    const rent = expense('rent', 100, '2026-09-01');
    await settle(cycle('CYC-F', [['u-a', 5000]], 10000, 8000));
    const fixed = () =>
      db.shares
        .filter((x) => x.costEntryId === rent.id)
        .map((x) => [x.partnerUserId, x.amount.toFixed(2)])
        .sort();
    expect(fixed()).toEqual([
      ['u-a', '33.33'],
      ['u-m', '33.34'],
      ['u-o', '33.33'],
    ]);
    joins('u-d', 'Dina', '2026-10-01');
    db.partners.find((p) => p.userId === 'u-o')!.active = false;
    await settle(
      cycle(
        'CYC-G',
        [
          ['u-d', 5000],
          ['u-m', 5000],
        ],
        10000,
        8000,
      ),
    );
    expect(fixed()).toEqual([
      ['u-a', '33.33'],
      ['u-m', '33.34'],
      ['u-o', '33.33'],
    ]);
    expect(chargedTo('u-m')).toBe('33.34');
  });
});

describe('who the loader lets be charged (review, 2026-10-12)', () => {
  it.each([
    ['partner record deactivated', (p: Row, _u: Row) => (p.active = false)],
    ['login suspended', (_p: Row, u: Row) => (u.status = 'SUSPENDED')],
    ['login inactive', (_p: Row, u: Row) => (u.status = 'INACTIVE')],
  ])(
    'a core partner — %s — is never charged; his share waits',
    async (_why, off) => {
      expense('rent', 300, '2026-09-01');
      // Recorded while he was a partner: the ledger fixes the shares then.
      await fixRunningCostShares(prisma);
      off(
        db.partners.find((p) => p.userId === 'u-o')!,
        db.users.find((u) => u.id === 'u-o')!,
      );
      await settle(
        cycle(
          'CYC-L',
          [
            ['u-o', 5000],
            ['u-a', 5000],
          ],
          20000,
          16000,
        ),
      );
      expect(chargedTo('u-o')).toBe('0.00');
      expect(chargedTo('u-a')).toBe('100.00');
    },
  );

  it('a core partner who is also an investor on the cycle: only his core-partner line is charged', async () => {
    expense('rent', 300, '2026-09-01');
    const c = cycle('CYC-B', [['u-a', 5000]], 20000, 16000);
    // Abdallah also puts 5,000 in as an investor (fee 0).
    db.participants.push({
      id: 'CYC-B-u-a-inv',
      cycleId: c.id,
      participantType: 'TEMP_INVESTOR',
      partnerUserId: null,
      investorUserId: 'u-a',
      contributionAmount: D(5000),
      customProfitPct: null,
      investorFeePct: null,
      createdAt: 9,
    });
    const id = await settle(c);
    const running = db.lines.filter(
      (l) => l.settlementId === id && l.component === 'RUNNING_COSTS',
    );
    expect(running.map((l) => [l.participantId, l.amount.toFixed(2)])).toEqual([
      ['CYC-B-u-a', '-100.00'],
    ]);
    expect(db.charges.every((ch) => ch.participantId === 'CYC-B-u-a')).toBe(
      true,
    );
  });
});

describe('who may pay out or reverse (review, 2026-10-12)', () => {
  const roles = (name: 'markPaid' | 'reverse' | 'runningCosts') =>
    Reflect.getMetadata(
      ROLES_KEY,
      // eslint-disable-next-line @typescript-eslint/unbound-method -- read for its decorator metadata, never called
      SettlementsController.prototype[name],
    ) as string[];

  it('Mark paid and reversal are a core partner’s alone — not the office, not an investor', () => {
    expect(roles('markPaid')).toEqual(['CORE_PARTNER']);
    expect(roles('reverse')).toEqual(['CORE_PARTNER']);
  });

  it('the running costs are read by the partners and the office, never an investor', () => {
    expect(roles('runningCosts')).toEqual(['CORE_PARTNER', 'ADMIN_SUPPORT']);
  });
});
