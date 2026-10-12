// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; the rows here are built by hand
import { Prisma } from '@prisma/client';
import {
  isRunningCostEntry,
  sharersOn,
  planRunningCostCharges,
  runningCostsFromRows,
  splitEqually,
  summariseRunningCosts,
  type RunningCost,
  type RunningCostPartner,
  type StandingCharge,
} from './running-costs';

/**
 * L7 — general running costs are the three core partners', equally, and come
 * out of their payouts (BUSINESS_LOGIC §8, owner 2026-10-11).
 *
 * The arithmetic, with no database: who owes what, what one payout takes, and
 * what is left waiting. The service that writes it is exercised in
 * `settlements/running-costs.flow.spec.ts`.
 */

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

// Oldest partner first: the last one takes the odd piastre (stated, §10).
const PARTNERS: RunningCostPartner[] = [
  { userId: 'u-a', name: 'Abdallah' },
  { userId: 'u-o', name: 'Omar' },
  { userId: 'u-m', name: 'Mahmoud' },
];

const cost = (
  id: string,
  amount: number,
  day = '2026-10-01',
  category = 'rent',
  // Shares fixed over the three partners, as recording the cost fixes them.
  sharers: RunningCostPartner[] = PARTNERS,
): RunningCost => ({
  id,
  amount: D(amount),
  day,
  category,
  shares: splitEqually(D(amount), sharers),
});

const charge = (
  costEntryId: string,
  partnerUserId: string,
  amount: number,
): StandingCharge => ({ costEntryId, partnerUserId, amount: D(amount) });

const fixed = (m: Map<string, Prisma.Decimal>) =>
  Object.fromEntries([...m.entries()].map(([k, v]) => [k, v.toFixed(2)]));

const plannedFor = (
  plan: ReturnType<typeof planRunningCostCharges>,
  userId: string,
) =>
  plan
    .filter((p) => p.partnerUserId === userId)
    .reduce((s, p) => s.add(p.amount), D(0))
    .toFixed(2);

describe('splitEqually — equal thirds in piastres', () => {
  it('30,000 is 10,000 each', () => {
    expect(fixed(splitEqually(D(30000), PARTNERS))).toEqual({
      'u-a': '10000.00',
      'u-o': '10000.00',
      'u-m': '10000.00',
    });
  });

  it('100 is 33.33 / 33.33 / 33.34 — the odd piastre on the last partner, never lost', () => {
    const split = splitEqually(D(100), PARTNERS);
    expect(fixed(split)).toEqual({
      'u-a': '33.33',
      'u-o': '33.33',
      'u-m': '33.34',
    });
    const total = [...split.values()].reduce((s, v) => s.add(v), D(0));
    expect(total.toFixed(2)).toBe('100.00');
  });

  it('the partner who takes the residual is the same whatever order the list arrived in — it is the last given', () => {
    const reordered = [PARTNERS[2], PARTNERS[0], PARTNERS[1]];
    expect(splitEqually(D(100), reordered).get('u-o')!.toFixed(2)).toBe(
      '33.34',
    );
  });

  it('200 rounds down, so the residual partner never pays less than the others', () => {
    expect(fixed(splitEqually(D(200), PARTNERS))).toEqual({
      'u-a': '66.66',
      'u-o': '66.66',
      'u-m': '66.68',
    });
  });

  it('nobody to share with: nothing, not a division by zero', () => {
    expect(splitEqually(D(100), []).size).toBe(0);
  });
});

describe('planRunningCostCharges — what one payout takes', () => {
  it('a payout big enough takes his whole share of every waiting cost', () => {
    const plan = planRunningCostCharges({
      costs: [cost('rent', 30000)],
      partners: PARTNERS,
      charges: [],
      capacities: new Map([['u-a', D(50000)]]),
    });
    expect(plan).toEqual([
      { costEntryId: 'rent', partnerUserId: 'u-a', amount: D(10000) },
    ]);
  });

  it('charged once: a second payout does not take the same share again', () => {
    const first = planRunningCostCharges({
      costs: [cost('rent', 30000)],
      partners: PARTNERS,
      charges: [],
      capacities: new Map([['u-a', D(50000)]]),
    });
    const second = planRunningCostCharges({
      costs: [cost('rent', 30000)],
      partners: PARTNERS,
      charges: first.map((p) => ({ ...p })),
      capacities: new Map([['u-a', D(50000)]]),
    });
    expect(second).toEqual([]);
  });

  it('a payout too small takes what it can; the rest carries to his next payout', () => {
    const costs = [
      cost('rent', 30000, '2026-09-01'),
      cost('salary', 6000, '2026-09-15'),
    ];
    const first = planRunningCostCharges({
      costs,
      partners: PARTNERS,
      charges: [],
      capacities: new Map([['u-a', D(11000)]]),
    });
    // Oldest first: his 10,000 of rent, then 1,000 of his 2,000 of salary.
    expect(first.map((p) => [p.costEntryId, p.amount.toFixed(2)])).toEqual([
      ['rent', '10000.00'],
      ['salary', '1000.00'],
    ]);
    const next = planRunningCostCharges({
      costs,
      partners: PARTNERS,
      charges: first,
      capacities: new Map([['u-a', D(99999)]]),
    });
    expect(next.map((p) => [p.costEntryId, p.amount.toFixed(2)])).toEqual([
      ['salary', '1000.00'],
    ]);
  });

  it('a payout of nothing, or a loss, takes nothing', () => {
    for (const capacity of [0, -500]) {
      expect(
        planRunningCostCharges({
          costs: [cost('rent', 30000)],
          partners: PARTNERS,
          charges: [],
          capacities: new Map([['u-a', D(capacity)]]),
        }),
      ).toEqual([]);
    }
  });

  it('someone who is not an active core partner is never charged, whatever his payout', () => {
    const plan = planRunningCostCharges({
      costs: [cost('rent', 30000)],
      partners: PARTNERS,
      charges: [],
      capacities: new Map([['u-investor', D(1_000_000)]]),
    });
    expect(plan).toEqual([]);
  });

  it('each partner takes his own share: two partners on one payout, each a third', () => {
    const plan = planRunningCostCharges({
      costs: [cost('rent', 100)],
      partners: PARTNERS,
      charges: [],
      capacities: new Map([
        ['u-a', D(1000)],
        ['u-m', D(1000)],
      ]),
    });
    expect(plannedFor(plan, 'u-a')).toBe('33.33');
    expect(plannedFor(plan, 'u-m')).toBe('33.34');
    expect(plannedFor(plan, 'u-o')).toBe('0.00');
  });

  it('never more than the cost: across every payout the charges add up to it exactly', () => {
    const costs = [cost('rent', 100)];
    let charges: StandingCharge[] = [];
    for (const who of ['u-a', 'u-o', 'u-m', 'u-a', 'u-m']) {
      charges = charges.concat(
        planRunningCostCharges({
          costs,
          partners: PARTNERS,
          charges,
          capacities: new Map([[who, D(1000)]]),
        }),
      );
    }
    const total = charges.reduce((s, c) => s.add(c.amount), D(0));
    expect(total.toFixed(2)).toBe('100.00');
  });

  it('a cost nobody owes any more (reversed: its net is zero) is not charged', () => {
    const plan = planRunningCostCharges({
      costs: [cost('rent', 0)],
      partners: PARTNERS,
      charges: [],
      capacities: new Map([['u-a', D(50000)]]),
    });
    expect(plan).toEqual([]);
  });
});

describe('which ledger rows are running costs — the one definition (rule 11)', () => {
  const row = (over: Partial<Parameters<typeof isRunningCostEntry>[0]>) => ({
    id: 'r1',
    direction: 'OUTFLOW',
    category: 'rent',
    amount: D(3000),
    cycleId: null,
    reversalOfId: null,
    ...over,
  });

  it('an expense with no cycle is', () => {
    expect(isRunningCostEntry(row({}))).toBe(true);
    // An old free-text expense still counts as it always did (§9).
    expect(isRunningCostEntry(row({ category: 'office tea' }))).toBe(true);
  });

  it('a cost charged to a cycle is not — it is that cycle’s, in its profit', () => {
    expect(isRunningCostEntry(row({ cycleId: 'c1' }))).toBe(false);
  });

  it('money that is not an expense is not: a payout, a contribution, a sale undone, a refund, other income, a purchase', () => {
    for (const category of [
      'settlement',
      'contribution',
      'revenue',
      'refund',
      'purchase',
      'shipping',
      'lender_repayment',
      'income_other',
      'running_cost_share',
    ]) {
      expect(isRunningCostEntry(row({ category }))).toBe(false);
    }
    expect(isRunningCostEntry(row({ direction: 'INFLOW' }))).toBe(false);
  });

  it('a reversal row is not a cost of its own', () => {
    expect(
      isRunningCostEntry(row({ direction: 'INFLOW', reversalOfId: 'r0' })),
    ).toBe(false);
  });

  it('runningCostsFromRows nets a reversal against its cost, so a reversed cost owes nothing', () => {
    const at = new Date('2026-10-05T10:00:00Z');
    const { costs } = runningCostsFromRows([
      { ...row({ id: 'rent' }), occurredOn: null, createdAt: at },
      {
        ...row({ id: 'tea', category: 'utilities', amount: D(500) }),
        occurredOn: new Date('2026-09-30T00:00:00Z'),
        createdAt: at,
      },
      {
        ...row({
          id: 'x',
          direction: 'INFLOW',
          reversalOfId: 'tea',
          amount: D(500),
          category: 'utilities',
        }),
        occurredOn: null,
        createdAt: at,
      },
      { ...row({ id: 'cyc', cycleId: 'c1' }), occurredOn: null, createdAt: at },
    ]);
    expect(costs.map((c) => [c.id, c.amount.toFixed(2), c.day])).toEqual([
      ['tea', '0.00', '2026-09-30'],
      ['rent', '3000.00', '2026-10-05'],
    ]);
  });
});

describe('summariseRunningCosts — the Partners page section', () => {
  it('spent by category, taken, waiting, and each partner’s share', () => {
    const summary = summariseRunningCosts({
      costs: [
        cost('rent', 30000),
        cost('power', 100, '2026-10-02', 'utilities'),
      ],
      partners: PARTNERS,
      charges: [charge('rent', 'u-a', 10000), charge('power', 'u-a', 20)],
    });
    expect(summary.spentEgp.toFixed(2)).toBe('30100.00');
    expect(summary.chargedEgp.toFixed(2)).toBe('10020.00');
    expect(summary.waitingEgp.toFixed(2)).toBe('20080.00');
    expect(
      summary.byCategory.map((c) => [c.category, c.spentEgp.toFixed(2)]),
    ).toEqual([
      ['rent', '30000.00'],
      ['utilities', '100.00'],
    ]);
    expect(
      summary.partners.map((p) => [
        p.userId,
        p.shareEgp.toFixed(2),
        p.chargedEgp.toFixed(2),
        p.waitingEgp.toFixed(2),
        p.takesResidual,
      ]),
    ).toEqual([
      ['u-a', '10033.33', '10020.00', '13.33', false],
      ['u-o', '10033.33', '0.00', '10033.33', false],
      ['u-m', '10033.34', '0.00', '10033.34', true],
    ]);
  });

  it('nothing spent: every figure zero, and still a row per partner', () => {
    const summary = summariseRunningCosts({
      costs: [],
      partners: PARTNERS,
      charges: [],
    });
    expect(summary.spentEgp.toFixed(2)).toBe('0.00');
    expect(summary.partners).toHaveLength(3);
  });
});

describe('a cost’s shares are fixed on its own day (review, 2026-10-12)', () => {
  const joined: RunningCostPartner[] = [
    { userId: 'u-a', name: 'Abdallah', joinedOn: '2026-01-01' },
    { userId: 'u-o', name: 'Omar', joinedOn: '2026-01-01' },
    { userId: 'u-d', name: 'Dina', joinedOn: '2026-10-01' },
  ];

  it('who shares a cost: the partners who had joined by its day — never one who joined later', () => {
    expect(sharersOn('2026-09-15', joined).map((p) => p.userId)).toEqual([
      'u-a',
      'u-o',
    ]);
    expect(sharersOn('2026-10-01', joined).map((p) => p.userId)).toEqual([
      'u-a',
      'u-o',
      'u-d',
    ]);
  });

  it('a cost from before any partner was entered is shared by all of them, not left owed by nobody', () => {
    expect(sharersOn('2025-12-31', joined)).toHaveLength(3);
  });

  it('a partner who left is not charged, and nobody takes his share — it stays on the cost, waiting', () => {
    const rent = cost('rent', 300);
    // Mahmoud has left: he is not among the partners who can be charged.
    const plan = planRunningCostCharges({
      costs: [rent],
      partners: PARTNERS.slice(0, 2),
      charges: [],
      capacities: new Map([
        ['u-a', D(10000)],
        ['u-o', D(10000)],
        ['u-m', D(10000)],
      ]),
    });
    expect(plan.map((p) => [p.partnerUserId, p.amount.toFixed(2)])).toEqual([
      ['u-a', '100.00'],
      ['u-o', '100.00'],
    ]);
  });

  it('runningCostsFromRows uses the stored shares, and only works out (and reports) those of a cost that has none', () => {
    const at = new Date('2026-09-01T10:00:00Z');
    const r = (id: string) => ({
      id,
      direction: 'OUTFLOW',
      category: 'rent',
      amount: D(300),
      cycleId: null,
      reversalOfId: null,
      occurredOn: null,
      createdAt: at,
    });
    const stored = new Map([
      [
        'old',
        new Map([
          ['u-a', D(150)],
          ['u-o', D(150)],
        ]),
      ],
    ]);
    const { costs, unfixed } = runningCostsFromRows(
      [r('old'), r('new')],
      joined,
      stored,
    );
    const old = costs.find((c) => c.id === 'old')!;
    expect(
      [...old.shares.entries()].map(([k, v]) => [k, v.toFixed(2)]),
    ).toEqual([
      ['u-a', '150.00'],
      ['u-o', '150.00'],
    ]);
    // The new one: split over the two who were there on 1 September; Dina owes nothing.
    expect(
      unfixed.map((u) => [u.costEntryId, u.partnerUserId, u.amount.toFixed(2)]),
    ).toEqual([
      ['new', 'u-a', '150.00'],
      ['new', 'u-o', '150.00'],
    ]);
  });

  it('the Partners page lists a partner who left while he still owes, with his own share waiting', () => {
    const rent = cost('rent', 300);
    const summary = summariseRunningCosts({
      costs: [rent],
      partners: PARTNERS.slice(0, 2),
      people: PARTNERS,
      charges: [charge('rent', 'u-a', 100), charge('rent', 'u-o', 100)],
    });
    const m = summary.partners.find((p) => p.userId === 'u-m')!;
    expect([m.shareEgp.toFixed(2), m.waitingEgp.toFixed(2), m.active]).toEqual([
      '100.00',
      '100.00',
      false,
    ]);
    expect(summary.waitingEgp.toFixed(2)).toBe('100.00');
  });
});
