// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; the rows here are built by hand
import { Prisma } from '@prisma/client';
import { AnalyticsService } from './analytics.service';
import { startOfBusinessDay } from '../../common/dates';

/**
 * Analytics' profit and loss (owner 2026-10-18; BUSINESS_LOGIC §9 "Profit and
 * loss"). Its totals are the dashboard's own computation cut to a period, so
 * the fake below answers the queries that computation makes by reading their
 * `where` — the same rows filtered the way Postgres would — rather than
 * handing back canned sums. A test that answered every aggregate with a fixed
 * number would pass whatever dates the service asked for.
 */

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
type Range = { gte?: Date; gt?: Date; lt?: Date; lte?: Date };
/** The parts of a Prisma `where` the computation uses, read below as Postgres would. */
interface W {
  status?: { in?: string[] };
  orderedAt?: Range;
  direction?: string;
  category?: { in?: string[]; notIn?: string[] };
  type?: { notIn?: string[] };
  reversalOfId?: null | { not: null };
  id?: { notIn?: string[] };
  occurredOn?: Range | null;
  createdAt?: Range;
  OR?: W[];
  saleOrder?: W;
  saleItem?: { saleOrder?: W };
  returnedOn?: Range;
  paidOn?: Range;
}

interface Order {
  id: string;
  status: string;
  orderedAt: Date;
  total: number;
  cogs: number;
}
interface Return {
  orderId: string;
  returnedOn: Date;
  refundEgp: number;
  cogsReversedEgp: number;
}
interface Tx {
  id: string;
  direction: 'INFLOW' | 'OUTFLOW';
  category: string;
  type: string;
  amount: number;
  reversalOfId: string | null;
  occurredOn: Date | null;
  createdAt: Date;
}
interface Loss {
  createdAt: Date;
  costEgp: number;
}
interface Repayment {
  paidOn: Date;
  exchangeDiffEgp: number;
}
interface World {
  orders: Order[];
  returns: Return[];
  tx: Tx[];
  losses: Loss[];
  repayments: Repayment[];
}

const inRange = (v: Date | null, r?: Range) =>
  !r ||
  (v !== null &&
    (r.gte === undefined || v >= r.gte) &&
    (r.gt === undefined || v > r.gt) &&
    (r.lt === undefined || v < r.lt) &&
    (r.lte === undefined || v <= r.lte));

const statusOk = (status: string, w?: W['status']) =>
  !w?.in || w.in.includes(status);

function matchOrder(o: Order, w: W = {}): boolean {
  return statusOk(o.status, w.status) && inRange(o.orderedAt, w.orderedAt);
}

function matchTx(t: Tx, w: W = {}): boolean {
  if (w.direction && t.direction !== w.direction) return false;
  if (w.category?.in && !w.category.in.includes(t.category)) return false;
  if (w.category?.notIn && w.category.notIn.includes(t.category)) return false;
  if (w.type?.notIn && w.type.notIn.includes(t.type)) return false;
  if (w.reversalOfId === null && t.reversalOfId !== null) return false;
  if (w.reversalOfId && t.reversalOfId === null) return false;
  if (w.id?.notIn && w.id.notIn.includes(t.id)) return false;
  if ('occurredOn' in w) {
    if (w.occurredOn === null) {
      if (t.occurredOn !== null) return false;
    } else if (!inRange(t.occurredOn, w.occurredOn)) return false;
  }
  if (w.createdAt && !inRange(t.createdAt, w.createdAt)) return false;
  if (w.OR && !w.OR.some((o) => matchTx(t, o))) return false;
  return true;
}

const sum = <T>(rows: T[], f: (r: T) => number) =>
  rows.reduce((s, r) => s.add(f(r)), D(0));
const min = <T>(rows: T[], f: (r: T) => Date | null) =>
  rows
    .map(f)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;

function fakeDb(world: World) {
  const orderOf = (id: string) => world.orders.find((o) => o.id === id)!;
  const empty = {
    aggregate: () => Promise.resolve({ _sum: {}, _min: {} }),
    findMany: () => Promise.resolve([]),
    count: () => Promise.resolve(0),
    groupBy: () => Promise.resolve([]),
  };
  const models: Record<string, unknown> = {
    saleOrder: {
      ...empty,
      aggregate: ({ where }: { where: W }) => {
        const rows = world.orders.filter((o) => matchOrder(o, where));
        return Promise.resolve({
          _sum: { total: sum(rows, (o) => o.total) },
          _min: { orderedAt: min(rows, (o) => o.orderedAt) },
        });
      },
    },
    saleReturn: {
      ...empty,
      aggregate: ({ where = {} }: { where?: W }) => {
        const rows = world.returns.filter(
          (r) =>
            matchOrder(orderOf(r.orderId), where.saleOrder) &&
            inRange(r.returnedOn, where.returnedOn),
        );
        return Promise.resolve({
          _sum: {
            refundEgp: sum(rows, (r) => r.refundEgp),
            cogsReversedEgp: sum(rows, (r) => r.cogsReversedEgp),
          },
          _min: { returnedOn: min(rows, (r) => r.returnedOn) },
        });
      },
    },
    saleItemAllocation: {
      ...empty,
      aggregate: ({ where }: { where: W }) =>
        Promise.resolve({
          _sum: {
            cogsEgp: sum(
              world.orders.filter((o) =>
                matchOrder(o, where.saleItem?.saleOrder),
              ),
              (o) => o.cogs,
            ),
          },
        }),
    },
    financialTransaction: {
      ...empty,
      findMany: ({ where }: { where: W }) =>
        Promise.resolve(world.tx.filter((t) => matchTx(t, where))),
      aggregate: ({ where }: { where?: W }) => {
        const rows = world.tx.filter((t) => matchTx(t, where));
        return Promise.resolve({
          _sum: { amount: sum(rows, (t) => t.amount) },
          _min: {
            occurredOn: min(rows, (t) => t.occurredOn),
            createdAt: min(rows, (t) => t.createdAt),
          },
        });
      },
      groupBy: ({ by, where }: { by: (keyof Tx)[]; where: W }) => {
        const groups = new Map<string, Tx[]>();
        for (const t of world.tx.filter((x) => matchTx(x, where))) {
          const k = by.map((b) => String(t[b])).join('|');
          groups.set(k, [...(groups.get(k) ?? []), t]);
        }
        return Promise.resolve(
          [...groups.values()].map((rows) => ({
            ...Object.fromEntries(by.map((b) => [b, rows[0][b]])),
            _sum: { amount: sum(rows, (t) => t.amount) },
          })),
        );
      },
    },
    shipmentLoss: {
      ...empty,
      aggregate: ({ where = {} }: { where?: W }) => {
        const rows = world.losses.filter((l) =>
          inRange(l.createdAt, where.createdAt),
        );
        return Promise.resolve({
          _sum: { costEgp: sum(rows, (l) => l.costEgp) },
          _min: { createdAt: min(rows, (l) => l.createdAt) },
        });
      },
    },
    lenderRepayment: {
      ...empty,
      aggregate: ({ where = {} }: { where?: W }) => {
        const rows = world.repayments.filter((r) =>
          inRange(r.paidOn, where.paidOn),
        );
        return Promise.resolve({
          _sum: { exchangeDiffEgp: sum(rows, (r) => r.exchangeDiffEgp) },
          _min: { paidOn: min(rows, (r) => r.paidOn) },
        });
      },
    },
  };
  return new Proxy(models, { get: (t, k: string) => t[k] ?? empty });
}

// ─── Building the world ──────────────────────────────────────────────
/**
 * The instant Cairo's clocks read `hh:mm` on `day`, whatever the offset is
 * that day. Read off the wall clock, not added to the day's start: on 30 April
 * 2027 the clocks jump an hour at midnight, so "start + 23h30" is already
 * 00:30 on 1 May — which is how this test's first draft failed.
 */
const wall = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Cairo',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
const cairo = (day: string, hh = 12, mm = 0) => {
  const want = `${day}, ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  const [y, m, d] = day.split('-').map(Number);
  for (const offsetHours of [2, 3]) {
    const t = new Date(Date.UTC(y, m - 1, d, hh - offsetHours, mm));
    if (wall.format(t) === want) return t;
  }
  throw new Error(`${want} does not exist in Cairo`);
};

/** A date column's value: UTC midnight of the day. */
const dateCol = (day: string) => new Date(`${day}T00:00:00Z`);

let n = 0;
const sale = (
  day: string,
  total: number,
  cogs: number,
  status = 'CONFIRMED',
  at?: Date,
): Order => ({
  id: `o${++n}`,
  status,
  orderedAt: at ?? cairo(day),
  total,
  cogs,
});
const tx = (
  direction: Tx['direction'],
  category: string,
  amount: number,
  day: string | null,
  extra: Partial<Tx> = {},
): Tx => ({
  id: `t${++n}`,
  direction,
  category,
  type: 'MANUAL',
  amount,
  reversalOfId: null,
  occurredOn: day ? dateCol(day) : null,
  createdAt: day ? cairo(day) : cairo('2026-01-01'),
  ...extra,
});
const world = (w: Partial<World>): World => ({
  orders: [],
  returns: [],
  tx: [],
  losses: [],
  repayments: [],
  ...w,
});

/** "Now" for every test: 18 Oct 2026, mid-afternoon in Cairo. */
const NOW = cairo('2026-10-18', 15);

const service = (w: World) => new AnalyticsService(fakeDb(w) as never);
const pnl = async (w: World, from?: unknown, to?: unknown) =>
  (await service(w).getProfitAndLoss(from, to, NOW)).data;

/** A business with every kind of figure, across September and October. */
function busy(): World {
  const s1 = sale('2026-09-10', 10_000, 6_000);
  const s2 = sale('2026-10-05', 8_000, 5_000, 'PAID');
  const s3 = sale('2026-10-12', 3_000, 2_000, 'PARTIALLY_PAID');
  const rent = tx('OUTFLOW', 'rent', 1_500, '2026-09-01');
  return world({
    orders: [
      s1,
      s2,
      s3,
      sale('2026-10-06', 99_999, 50_000, 'DRAFT'),
      sale('2026-10-07', 77_777, 40_000, 'CANCELLED'),
    ],
    returns: [
      {
        orderId: s1.id,
        returnedOn: dateCol('2026-10-02'),
        refundEgp: 1_000,
        cogsReversedEgp: 600,
      },
    ],
    tx: [
      rent,
      tx('OUTFLOW', 'rent', 1_500, '2026-10-01'),
      tx('OUTFLOW', 'fuel', 250.5, '2026-10-03'),
      tx('OUTFLOW', 'fuel', 300.25, '2026-09-20'),
      // A salary entered, then undone in October: September keeps the cost,
      // October takes it back.
      tx('OUTFLOW', 'salaries', 4_000, '2026-09-28', { id: 'sal' }),
      tx('INFLOW', 'salaries', 4_000, '2026-10-04', { reversalOfId: 'sal' }),
      tx('INFLOW', 'interest', 120, '2026-10-09'),
      tx('INFLOW', 'supplier_refund', 400, '2026-09-15'),
      // Not expenses at all.
      tx('OUTFLOW', 'purchase', 50_000, '2026-09-02'),
      tx('INFLOW', 'revenue', 8_000, '2026-10-05'),
      tx('OUTFLOW', 'settlement', 9_000, '2026-10-10'),
      // A flow row with no occurredOn: its day is when it was entered.
      tx('OUTFLOW', 'bank_fees', 35, null, { createdAt: cairo('2026-10-11') }),
    ],
    losses: [{ createdAt: cairo('2026-09-25'), costEgp: 700 }],
    repayments: [{ paidOn: dateCol('2026-10-08'), exchangeDiffEgp: 210 }],
  });
}

// ─── The tests ───────────────────────────────────────────────────────
describe('profit and loss — one computation with the dashboard', () => {
  it('all time is the dashboard, figure for figure, from the same rows', async () => {
    const w = busy();
    const dash = (await service(w).getDashboardKPIs()).data;
    const p = await pnl(w);
    expect(p.allTime).toBe(true);
    expect({
      sales: p.salesEgp,
      cogs: p.cogsEgp,
      expenses: p.expensesEgp,
      recovered: p.recoveredEgp,
      otherIncome: p.otherIncomeEgp,
      exchange: p.exchangeDifferenceEgp,
      net: p.netProfitEgp,
    }).toEqual({
      sales: dash.totalRevenue,
      cogs: dash.totalCogs,
      expenses: dash.totalExpenses,
      recovered: dash.totalRecoveredEgp,
      otherIncome: dash.totalOtherIncomeEgp,
      exchange: dash.exchangeDifferenceEgp,
      net: dash.netProfit,
    });
    // And the figures are the ones the rows say, so the equality is not two
    // zeros agreeing: 21,000 sold less a 1,000 return.
    expect(p.salesEgp).toBe(20_000);
    expect(p.cogsEgp).toBe(12_400);
    // rent 3,000 + fuel 550.75 + salaries 0 (undone) + bank 35 + lost 700
    expect(p.expensesEgp).toBe(4_285.75);
    expect(p.netProfitEgp).toBe(20_000 - 12_400 - 4_285.75 + 400 + 120 - 210);
  });

  it('the summary adds up on screen: sales − COGS = gross; gross − expenses + recovered + other income − exchange = net', async () => {
    const p = await pnl(busy(), '2026-09-01', '2026-10-31');
    expect(p.grossProfitEgp).toBe(p.salesEgp - p.cogsEgp);
    expect(
      Number(
        D(p.grossProfitEgp)
          .sub(p.expensesEgp)
          .add(p.recoveredEgp)
          .add(p.otherIncomeEgp)
          .sub(p.exchangeDifferenceEgp),
      ),
    ).toBe(p.netProfitEgp);
  });

  it('a draft or a cancelled order counts nothing — not in sales, not in cost', async () => {
    const w = world({
      orders: [
        sale('2026-10-06', 99_999, 50_000, 'DRAFT'),
        sale('2026-10-07', 77_777, 40_000, 'CANCELLED'),
      ],
    });
    const p = await pnl(w, '2026-10-01', '2026-10-31');
    expect(p).toMatchObject({ salesEgp: 0, cogsEgp: 0, netProfitEgp: 0 });
    expect((await pnl(w)).salesEgp).toBe(0);
  });
});

describe('profit and loss — which day each figure belongs to', () => {
  it('(the test’s own clock agrees with the service’s start of a Cairo day, summer and winter)', () => {
    expect(cairo('2026-07-01', 0, 0)).toEqual(startOfBusinessDay('2026-07-01'));
    expect(cairo('2026-12-01', 0, 0)).toEqual(startOfBusinessDay('2026-12-01'));
  });

  it('September alone: the sale, the costs and the loss of September; October’s return and repayment are October’s', async () => {
    const p = await pnl(busy(), '2026-09-01', '2026-09-30');
    expect(p.salesEgp).toBe(10_000); // the return came back in October
    expect(p.cogsEgp).toBe(6_000);
    // rent 1,500 + fuel 300.25 + salaries 4,000 + lost 700
    expect(p.expensesEgp).toBe(6_500.25);
    expect(p.recoveredEgp).toBe(400);
    expect(p.otherIncomeEgp).toBe(0);
    expect(p.exchangeDifferenceEgp).toBe(0);
  });

  it('an expense outside the range is left out — by its own day, not the day it was typed', async () => {
    const w = world({
      tx: [
        // Typed on 2 October for a bill paid on 30 September.
        tx('OUTFLOW', 'utilities', 900, '2026-09-30', {
          createdAt: cairo('2026-10-02'),
        }),
        tx('OUTFLOW', 'rent', 1_000, '2026-10-01'),
        tx('OUTFLOW', 'rent', 5_000, '2026-11-01'),
      ],
    });
    const oct = await pnl(w, '2026-10-01', '2026-10-31');
    expect(oct.expensesEgp).toBe(1_000);
    expect(oct.expensesByCategory).toEqual([
      { category: 'rent', amountEgp: 1_000 },
    ]);
  });

  it('a sale at 23:30 in Cairo on the last day of a month is that month’s; one at 00:30 on the 1st is the next', async () => {
    const w = world({
      orders: [
        sale(
          '2026-10-31',
          1_000,
          400,
          'CONFIRMED',
          cairo('2026-10-31', 23, 30),
        ),
        sale('2026-11-01', 50, 20, 'CONFIRMED', cairo('2026-11-01', 0, 30)),
      ],
    });
    // In UTC both are still 31 October (21:30 and 22:30).
    expect(cairo('2026-11-01', 0, 30).toISOString().slice(0, 10)).toBe(
      '2026-10-31',
    );
    const later = cairo('2026-12-05');
    const oct = await service(w).getProfitAndLoss(
      '2026-10-01',
      '2026-10-31',
      later,
    );
    expect(oct.data.salesEgp).toBe(1_000);
    const p = await service(w).getProfitAndLoss(
      '2026-10-01',
      '2026-11-30',
      cairo('2026-12-05'),
    );
    expect(p.data.months).toEqual([
      { month: '2026-10', netProfitEgp: 600 },
      { month: '2026-11', netProfitEgp: 30 },
    ]);
  });

  it('every month of a four-year span: sales at 23:30 on its last day and 00:30 on its first land in it', async () => {
    const orders: Order[] = [];
    const expected: { month: string; netProfitEgp: number }[] = [];
    for (let i = 0; i < 48; i++) {
      const first = new Date(Date.UTC(2024, i, 1)).toISOString().slice(0, 10);
      const last = new Date(Date.UTC(2024, i + 1, 0))
        .toISOString()
        .slice(0, 10);
      // A different figure per month, so a sale landing a month off shows.
      orders.push(sale(first, 100 + i, 0, 'PAID', cairo(first, 0, 30)));
      orders.push(sale(last, 1_000 * (i + 1), 0, 'PAID', cairo(last, 23, 30)));
      expected.push({
        month: first.slice(0, 7),
        netProfitEgp: 100 + i + 1_000 * (i + 1),
      });
    }
    const p = await service(world({ orders })).getProfitAndLoss(
      '2024-01-01',
      '2027-12-31',
      cairo('2028-01-10'),
    );
    expect(p.data.months).toEqual(expected);
  });
});

describe('profit and loss — the splits add up', () => {
  it('expenses by category, largest first, add up to the Expenses line — the undone salary and the lost goods included', async () => {
    for (const [from, to] of [
      ['2026-09-01', '2026-09-30'],
      ['2026-10-01', '2026-10-31'],
      [undefined, undefined],
    ]) {
      const p = await pnl(busy(), from, to);
      const total = p.expensesByCategory.reduce(
        (s, c) => s.add(c.amountEgp),
        D(0),
      );
      expect([from, Number(total)]).toEqual([from, p.expensesEgp]);
      const amounts = p.expensesByCategory.map((c) => c.amountEgp);
      expect(amounts).toEqual([...amounts].sort((a, b) => b - a));
    }
    const oct = await pnl(busy(), '2026-10-01', '2026-10-31');
    // October: rent 1,500, fuel 250.50, bank 35, salaries −4,000 (undone).
    expect(oct.expensesByCategory).toEqual([
      { category: 'rent', amountEgp: 1_500 },
      { category: 'fuel', amountEgp: 250.5 },
      { category: 'bank_fees', amountEgp: 35 },
      { category: 'salaries', amountEgp: -4_000 },
    ]);
    const sep = await pnl(busy(), '2026-09-01', '2026-09-30');
    expect(sep.expensesByCategory).toContainEqual({
      category: 'goods_lost',
      amountEgp: 700,
    });
  });

  it('the month bars add up to the period’s net profit, and all time starts on the first recorded day', async () => {
    const p = await pnl(busy());
    expect(p.from).toBe('2026-09-01');
    expect(p.to).toBe('2026-10-18');
    expect(p.months.map((m) => m.month)).toEqual(['2026-09', '2026-10']);
    const total = p.months.reduce((s, m) => s.add(m.netProfitEgp), D(0));
    expect(Number(total)).toBe(p.netProfitEgp);
    // September lost money: 10,000 − 6,000 − 6,500.25 + 400.
    expect(p.months[0].netProfitEgp).toBe(-2_100.25);
  });
});

describe('profit and loss — the limits', () => {
  it('an empty period is zeros, never NaN; no percentage of nothing', async () => {
    const p = await pnl(world({}), '2026-10-01', '2026-10-31');
    expect(p).toMatchObject({
      salesEgp: 0,
      cogsEgp: 0,
      grossProfitEgp: 0,
      expensesEgp: 0,
      netProfitEgp: 0,
      netProfitPctOfSales: null,
      expensesByCategory: [],
      months: [{ month: '2026-10', netProfitEgp: 0 }],
    });
    // Nothing recorded at all, all time: no months, still zeros.
    const all = await pnl(world({}));
    expect(all).toMatchObject({ from: null, netProfitEgp: 0, months: [] });
  });

  it('the percentage is of sales, to one decimal', async () => {
    const p = await pnl(
      world({ orders: [sale('2026-10-02', 3_000, 2_000)] }),
      '2026-10-01',
      '2026-10-31',
    );
    expect(p.netProfitPctOfSales).toBe(33.3);
  });

  it('from after to → DATE_RANGE_REVERSED; a malformed day → BAD_DATE; a list → BAD_DATE; never a 500', async () => {
    const code = (from: unknown, to: unknown) =>
      service(world({}))
        .getProfitAndLoss(from, to, NOW)
        .then(
          () => 'accepted',
          (e: { getStatus(): number; getResponse(): { code: string } }) =>
            `${e.getStatus()} ${e.getResponse().code}`,
        );
    expect(await code('2026-10-10', '2026-10-01')).toBe(
      '400 DATE_RANGE_REVERSED',
    );
    expect(await code('2026-02-30', undefined)).toBe('400 BAD_DATE');
    expect(await code('yesterday', undefined)).toBe('400 BAD_DATE');
    expect(await code(undefined, '2026-1-1')).toBe('400 BAD_DATE');
    expect(await code(['2026-10-01', '2026-10-02'], undefined)).toBe(
      '400 BAD_DATE',
    );
    expect(await code('2026-11-01', undefined)).toBe('400 PERIOD_NOT_STARTED');
  });

  it('a to-date after today is today; a period with only a start runs to today', async () => {
    const w = busy();
    const p = await pnl(w, '2026-10-01', '2027-03-31');
    expect(p.to).toBe('2026-10-18');
    expect(p.months.map((m) => m.month)).toEqual(['2026-10']);
    expect(await pnl(w, '2026-10-01', undefined)).toEqual(p);
    expect(await pnl(w, '2026-10-01', '')).toEqual(p);
  });
});
