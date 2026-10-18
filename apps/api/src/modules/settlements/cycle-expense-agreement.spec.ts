// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; the rows here are built by hand
import { Prisma } from '@prisma/client';
import { SettlementsService } from './settlements.service';
import { AnalyticsService } from '../analytics/analytics.service';

/**
 * L6 — a cycle-charged manual entry moves the cycle's profit by the same
 * amount on the settlement and on the cycle's page (rule 11).
 *
 * Before: settlement subtracted a cycle-linked expense, the cycle
 * profitability did not, so the cycle page read 1,800 higher than the
 * settlement for the same cycle. A reversed expense stayed charged in both,
 * because both summed only the outflows. Other income was counted nowhere.
 */

const D = (v: number) => new Prisma.Decimal(v);
const CYCLE = 'c0000000-0000-4000-8000-000000000001';

/** 6 of 10 units sold at 300 each, landed at 100: 1,800 revenue, 600 cost. */
const BATCH = {
  receivedQty: D(10),
  remainingQty: D(4),
  landedUnitCostEgp: D(100),
};
const ALLOCATION = {
  qty: D(6),
  cogsEgp: D(600),
  saleItem: { quantity: D(6), lineTotal: D(1800) },
};

type Row = {
  cycleId: string | null;
  direction: 'INFLOW' | 'OUTFLOW';
  category: string;
  amount: Prisma.Decimal;
  reversalOfId: string | null;
};
const row = (
  direction: Row['direction'],
  category: string,
  amount: number,
  reversalOfId: string | null = null,
): Row => ({
  cycleId: CYCLE,
  direction,
  category,
  amount: D(amount),
  reversalOfId,
});

/** Enough of Prisma's `where` for the reads these two services make. */
type Where = {
  cycleId?: string;
  direction?: string;
  category?: string | { in?: string[]; notIn?: string[] };
  reversalOfId?: { not: null };
};
function matches(r: Row, where: Where): boolean {
  if (where.cycleId !== undefined && r.cycleId !== where.cycleId) return false;
  if (where.direction !== undefined && r.direction !== where.direction)
    return false;
  const c = where.category;
  if (typeof c === 'string' && r.category !== c) return false;
  if (typeof c === 'object' && c.in && !c.in.includes(r.category)) return false;
  if (typeof c === 'object' && c.notIn && c.notIn.includes(r.category))
    return false;
  if (where.reversalOfId?.not === null && r.reversalOfId === null) return false;
  return true;
}

function fakeDb(rows: Row[]) {
  const pick = (r: Row, select?: Record<string, boolean>) =>
    select
      ? Object.fromEntries(
          Object.keys(select).map((k) => [
            k,
            (r as unknown as Record<string, unknown>)[k],
          ]),
        )
      : r;
  return {
    cycleParticipant: {
      findMany: () =>
        Promise.resolve([
          {
            id: 'p-1',
            participantType: 'CORE_PARTNER',
            contributionAmount: D(1000),
            customProfitPct: null,
            investorFeePct: null,
          },
        ]),
    },
    // The cycle's one sale; it has no samples at a shop or written off (§4),
    // which are asked for by status.
    saleItemAllocation: {
      findMany: ({
        where,
      }: {
        where?: { saleItem?: { saleOrder?: { status?: unknown } } };
      } = {}) =>
        Promise.resolve(
          typeof where?.saleItem?.saleOrder?.status === 'string'
            ? []
            : [ALLOCATION],
        ),
      aggregate: () => Promise.resolve({ _sum: { cogsEgp: null } }),
    },
    saleReturnItem: { findMany: () => Promise.resolve([]) },
    inventoryBatch: { findMany: () => Promise.resolve([BATCH]) },
    financialTransaction: {
      findMany: ({
        where,
        select,
      }: {
        where: Where;
        select?: Record<string, boolean>;
      }) =>
        Promise.resolve(
          rows.filter((r) => matches(r, where)).map((r) => pick(r, select)),
        ),
    },
    shipmentLoss: {
      aggregate: () => Promise.resolve({ _sum: { costEgp: null } }),
    },
    lenderRepayment: {
      aggregate: () => Promise.resolve({ _sum: { exchangeDiffEgp: null } }),
    },
    importCycle: {
      findMany: () =>
        Promise.resolve([
          {
            id: CYCLE,
            code: 'CYC-2026-001',
            status: 'SELLING',
            originType: 'CHINA_DIRECT',
            financialTransactions: rows,
            inventoryBatches: [
              { ...BATCH, saleItemAllocations: [ALLOCATION], returnItems: [] },
            ],
          },
        ]),
    },
  };
}

async function bothProfits(rows: Row[]) {
  const db = fakeDb(rows);
  const settlement = await new SettlementsService(
    db as never,
    {} as never,
    {} as never,
  ).project(CYCLE);
  const analytics = (
    await new AnalyticsService(db as never).getCycleProfitability('internal')
  ).data[0];
  return {
    settlement: settlement!.pnl.grossProfit.toFixed(2),
    page: analytics.profit.toFixed(2),
    analytics,
  };
}

describe('settlement and the cycle page agree on a cycle-charged entry', () => {
  it('with no manual entries, both read 1,200', async () => {
    const r = await bothProfits([
      row('OUTFLOW', 'purchase', 1000),
      row('INFLOW', 'contribution', 1000),
    ]);
    expect(r).toMatchObject({ settlement: '1200.00', page: '1200.00' });
  });

  it('an expense and extra freight charged to the cycle come off both', async () => {
    const r = await bothProfits([
      row('OUTFLOW', 'purchase', 1000),
      row('OUTFLOW', 'rent', 500),
      row('OUTFLOW', 'extra_freight', 200),
    ]);
    expect(r).toMatchObject({ settlement: '500.00', page: '500.00' });
    expect(r.analytics.expensesEgp).toBe(700);
  });

  it('a reversed expense comes off neither', async () => {
    const r = await bothProfits([
      row('OUTFLOW', 'marketing', 100),
      row('INFLOW', 'marketing', 100, 'tx-marketing'),
    ]);
    expect(r).toMatchObject({ settlement: '1200.00', page: '1200.00' });
  });

  it('other income on the cycle raises both; undone, it raises neither', async () => {
    const raised = await bothProfits([row('INFLOW', 'interest', 50)]);
    expect(raised).toMatchObject({ settlement: '1250.00', page: '1250.00' });
    expect(raised.analytics.otherIncomeEgp).toBe(50);

    const undone = await bothProfits([
      row('INFLOW', 'interest', 50),
      row('OUTFLOW', 'interest', 50, 'tx-interest'),
    ]);
    expect(undone).toMatchObject({ settlement: '1200.00', page: '1200.00' });
  });

  it('everything at once: 1,800 − 600 − 500 − 200 + 50 = 550 on both', async () => {
    const r = await bothProfits([
      row('OUTFLOW', 'purchase', 1000),
      row('INFLOW', 'contribution', 1000),
      row('OUTFLOW', 'rent', 500),
      row('OUTFLOW', 'extra_freight', 200),
      row('OUTFLOW', 'marketing', 100),
      row('INFLOW', 'marketing', 100, 'tx-marketing'),
      row('INFLOW', 'interest', 50),
    ]);
    expect(r).toMatchObject({ settlement: '550.00', page: '550.00' });
  });
});

/**
 * The dashboard reads the same rows business-wide. Every other model answers
 * empty, so net profit is the ledger's manual entries alone.
 */
function dashboardDb(rows: Row[]) {
  const sum = (where: Where) =>
    rows
      .filter((r) => matches(r, where))
      .reduce((s, r) => s.add(r.amount), D(0));
  const empty = {
    aggregate: () => Promise.resolve({ _sum: {} }),
    findMany: () => Promise.resolve([]),
    count: () => Promise.resolve(0),
    groupBy: () => Promise.resolve([]),
  };
  const financialTransaction = {
    ...empty,
    aggregate: ({ where }: { where: Where }) =>
      Promise.resolve({ _sum: { amount: sum(where) } }),
  };
  const models: Record<string, unknown> = { financialTransaction };
  return new Proxy(models, {
    get: (target, key: string) => target[key] ?? empty,
  });
}

describe('the dashboard counts manual entries the same way', () => {
  const kpis = async (rows: Row[]) =>
    (await new AnalyticsService(dashboardDb(rows) as never).getDashboardKPIs())
      .data as Record<string, unknown>;

  it('an expense is in Expenses and off net profit; reversed, it is in neither', async () => {
    const charged = await kpis([row('OUTFLOW', 'rent', 500)]);
    expect(charged).toMatchObject({ totalExpenses: 500, netProfit: -500 });

    const reversed = await kpis([
      row('OUTFLOW', 'rent', 500),
      row('INFLOW', 'rent', 500, 'tx-rent'),
    ]);
    expect(reversed).toMatchObject({ totalExpenses: 0, netProfit: 0 });
  });

  it('other income raises net profit, is not Revenue and not a negative expense', async () => {
    const r = await kpis([
      row('INFLOW', 'interest', 50),
      row('INFLOW', 'other_income', 25),
    ]);
    expect(r).toMatchObject({
      totalRevenue: 0,
      totalExpenses: 0,
      totalOtherIncomeEgp: 75,
      netProfit: 75,
    });
  });

  it('undone income is not an expense either', async () => {
    const r = await kpis([
      row('INFLOW', 'interest', 50),
      row('OUTFLOW', 'interest', 50, 'tx-interest'),
    ]);
    expect(r).toMatchObject({
      totalExpenses: 0,
      totalOtherIncomeEgp: 0,
      netProfit: 0,
    });
  });

  it('system rows a partner can no longer type stay out of Expenses', async () => {
    const r = await kpis([
      row('OUTFLOW', 'settlement', 900),
      row('OUTFLOW', 'contribution', 900),
      row('OUTFLOW', 'purchase', 900),
    ]);
    expect(r).toMatchObject({ totalExpenses: 0, netProfit: 0 });
  });
});
