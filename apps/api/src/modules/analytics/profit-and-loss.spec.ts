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
  /** A list of statuses, or one by name (samples written off, §4). */
  status?: { in?: string[] } | string;
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
  samplesDecidedAt?: Range;
}

interface Order {
  id: string;
  status: string;
  orderedAt: Date;
  total: number;
  cogs: number;
  /** A samples order written off (§4): when it was. */
  samplesDecidedAt?: Date | null;
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
  typeof w === 'string' ? status === w : !w?.in || w.in.includes(status);

function matchOrder(o: Order, w: W = {}): boolean {
  return (
    statusOk(o.status, w.status) &&
    inRange(o.orderedAt, w.orderedAt) &&
    (!w.samplesDecidedAt ||
      inRange(o.samplesDecidedAt ?? null, w.samplesDecidedAt))
  );
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

/** Every call the service makes to the fake, counted (the query budget). */
const calls = { n: 0 };

function fakeDb(world: World) {
  const orderOf = (id: string) => world.orders.find((o) => o.id === id)!;
  const returnsOf = (where: W) =>
    world.returns.filter(
      (r) =>
        matchOrder(orderOf(r.orderId), where.saleOrder) &&
        inRange(r.returnedOn, where.returnedOn),
    );
  const empty = {
    aggregate: () => Promise.resolve({ _sum: {}, _min: {} }),
    findMany: () => Promise.resolve([]),
    count: () => Promise.resolve(0),
    groupBy: () => Promise.resolve([]),
  };
  const models: Record<string, unknown> = {
    saleOrder: {
      ...empty,
      findMany: ({ where }: { where: W }) =>
        Promise.resolve(world.orders.filter((o) => matchOrder(o, where))),
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
      findMany: ({ where = {} }: { where?: W }) =>
        Promise.resolve(returnsOf(where)),
      aggregate: ({ where = {} }: { where?: W }) => {
        const rows = returnsOf(where);
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
      // One allocation per order, carrying the order it sold under.
      findMany: ({ where }: { where: W }) =>
        Promise.resolve(
          world.orders
            .filter((o) => matchOrder(o, where.saleItem?.saleOrder))
            .map((o) => ({ cogsEgp: D(o.cogs), saleItem: { saleOrder: o } })),
        ),
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
      findMany: ({ where = {} }: { where?: W }) =>
        Promise.resolve(
          world.losses.filter((l) => inRange(l.createdAt, where.createdAt)),
        ),
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
      findMany: ({ where = {} }: { where?: W }) =>
        Promise.resolve(
          world.repayments.filter((r) => inRange(r.paidOn, where.paidOn)),
        ),
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
  const counted = (model: Record<string, (...a: unknown[]) => unknown>) =>
    new Proxy(model, {
      get: (m, op: string) =>
        typeof m[op] === 'function'
          ? (...a: unknown[]) => {
              calls.n++;
              return m[op](...a);
            }
          : m[op],
    });
  return new Proxy(models, {
    get: (t, k: string) =>
      counted((t[k] ?? empty) as Record<string, (...a: unknown[]) => unknown>),
  });
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
    // Drawn by month (a year), by week (two months) and by day (two days),
    // the 23:30 sale is October's and the 00:30 one November's every time.
    const at = async (from: string, to: string) =>
      (await service(w).getProfitAndLoss(from, to, later)).data.buckets
        .filter((b) => b.netProfitEgp !== 0)
        .map((b) => [b.key, b.netProfitEgp]);
    expect(await at('2026-01-01', '2026-11-30')).toEqual([
      ['2026-10', 600],
      ['2026-11', 30],
    ]);
    // 31 October 2026 is a Saturday, so it opens a week of its own.
    expect(await at('2026-10-01', '2026-11-30')).toEqual([['2026-10-31', 630]]);
    expect(await at('2026-10-31', '2026-11-01')).toEqual([
      ['2026-10-31', 600],
      ['2026-11-01', 30],
    ]);
  });

  it('a sale at 23:30 on a Friday is that week’s; one at 00:30 on the Saturday opens the next (both Friday in UTC)', async () => {
    const w = world({
      orders: [
        sale('2026-10-09', 700, 0, 'PAID', cairo('2026-10-09', 23, 30)),
        sale('2026-10-10', 90, 0, 'PAID', cairo('2026-10-10', 0, 30)),
      ],
    });
    expect(cairo('2026-10-10', 0, 30).toISOString().slice(0, 10)).toBe(
      '2026-10-09',
    );
    const p = await pnl(w, '2026-08-15', '2026-10-18');
    expect(p.granularity).toBe('week');
    expect(
      p.buckets.filter((b) => b.salesEgp).map((b) => [b.key, b.salesEgp]),
    ).toEqual([
      ['2026-10-03', 700],
      ['2026-10-10', 90],
    ]);
    const days = await pnl(w, '2026-10-01', '2026-10-18');
    expect(
      days.buckets.filter((b) => b.salesEgp).map((b) => [b.key, b.salesEgp]),
    ).toEqual([
      ['2026-10-09', 700],
      ['2026-10-10', 90],
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
    expect(p.data.granularity).toBe('month');
    expect(
      p.data.buckets.map((b) => ({
        month: b.key,
        netProfitEgp: b.netProfitEgp,
      })),
    ).toEqual(expected);
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

  it('the buckets add up to the period’s net profit, and all time starts on the first recorded day', async () => {
    const p = await pnl(busy());
    expect(p.from).toBe('2026-09-01');
    expect(p.to).toBe('2026-10-18');
    // 1 September – 18 October is 48 days: weeks, the first cut to a Tuesday.
    expect(p.granularity).toBe('week');
    expect(p.buckets[0]).toMatchObject({
      key: '2026-08-29',
      from: '2026-09-01',
      to: '2026-09-04',
    });
    const total = p.buckets.reduce((s, m) => s.add(m.netProfitEgp), D(0));
    expect(Number(total)).toBe(p.netProfitEgp);
    // September alone lost money: 10,000 − 6,000 − 6,500.25 + 400.
    const sep = await pnl(busy(), '2024-09-01', '2026-09-30');
    expect(sep.buckets.find((b) => b.key === '2026-09')?.netProfitEgp).toBe(
      -2_100.25,
    );
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
      granularity: 'day',
    });
    // Every day so far, each a zero — never an empty chart.
    expect(p.buckets).toHaveLength(18);
    expect(
      p.buckets.every((b) => b.netProfitEgp === 0 && b.salesEgp === 0),
    ).toBe(true);
    // Nothing recorded at all, all time: no buckets, still zeros.
    const all = await pnl(world({}));
    expect(all).toMatchObject({ from: null, netProfitEgp: 0, buckets: [] });
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
    expect(p.buckets.map((b) => b.key)).toHaveLength(18);
    expect(p.buckets[p.buckets.length - 1].key).toBe('2026-10-18');
    expect(await pnl(w, '2026-10-01', undefined)).toEqual(p);
    expect(await pnl(w, '2026-10-01', '')).toEqual(p);
  });
});

// ─── The chart's buckets (owner 2026-10-18, "Option A") ─────────────
/**
 * Ten months of everything: a sale every third day with cents in it, a
 * return now and then, an expense every fifth day and one undone, income, a
 * refund, goods lost, samples written off, a repayment — so a bucket that
 * dropped or doubled any kind of figure would show in the sums.
 */
function spread(): World {
  const orders: Order[] = [];
  const returns: Return[] = [];
  const txs: Tx[] = [];
  const losses: Loss[] = [];
  const repayments: Repayment[] = [];
  const day = (i: number) =>
    new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
  for (let i = 0; i < 290; i++) {
    const d = day(i);
    if (i % 3 === 0) {
      // Late at night: still that Cairo day, though UTC is near its end.
      const s = sale(
        d,
        1_000 + i + 0.37,
        600 + i / 4,
        'PAID',
        cairo(d, 23, 30),
      );
      orders.push(s);
      if (i % 27 === 0) {
        returns.push({
          orderId: s.id,
          returnedOn: dateCol(day(i + 2)),
          refundEgp: 100.5,
          cogsReversedEgp: 60.25,
        });
      }
    }
    if (i % 5 === 0) txs.push(tx('OUTFLOW', 'fuel', 33.33 + i, d));
    if (i % 40 === 7) {
      txs.push(tx('OUTFLOW', 'salaries', 2_000, d, { id: `sal${i}` }));
      txs.push(
        tx('INFLOW', 'salaries', 2_000, day(i + 9), {
          reversalOfId: `sal${i}`,
        }),
      );
    }
    if (i % 45 === 11) txs.push(tx('INFLOW', 'interest', 12.5, d));
    if (i % 50 === 13) txs.push(tx('INFLOW', 'supplier_refund', 75.75, d));
    if (i % 60 === 17)
      losses.push({ createdAt: cairo(d, 0, 15), costEgp: 140 });
    if (i % 70 === 19) {
      orders.push({
        ...sale(d, 0, 55.55, 'SAMPLES_WRITTEN_OFF'),
        samplesDecidedAt: cairo(d, 23, 45),
      });
    }
    if (i % 80 === 23) {
      repayments.push({ paidOn: dateCol(d), exchangeDiffEgp: -18.2 });
    }
  }
  // A flow row with no day of its own, entered at 23:50 Cairo.
  txs.push(
    tx('OUTFLOW', 'bank_fees', 9.99, null, {
      createdAt: cairo('2026-07-31', 23, 50),
    }),
  );
  return world({ orders, returns, tx: txs, losses, repayments });
}

type Pnl = Awaited<ReturnType<typeof pnl>>;
const bucketSum = (p: Pnl, f: (b: Pnl['buckets'][number]) => number) =>
  Number(p.buckets.reduce((s, b) => s.add(f(b)), D(0)));

describe('profit and loss — the chart’s buckets', () => {
  it('a day each up to 35 days, a Saturday–Friday week each up to 124, a month each beyond', async () => {
    const w = world({});
    const shape = async (from: string, to: string) => {
      const p = await pnl(w, from, to);
      return [p.granularity, p.buckets.length];
    };
    expect(await shape('2026-10-01', '2026-10-31')).toEqual(['day', 18]); // this month, to today
    expect(await shape('2026-09-01', '2026-09-30')).toEqual(['day', 30]); // last month
    expect(await shape('2026-08-01', '2026-09-04')).toEqual(['day', 35]);
    expect(await shape('2026-08-01', '2026-09-05')).toEqual(['week', 6]);
    expect(await shape('2026-06-17', '2026-10-18')).toEqual(['week', 19]); // 124 days, cut weeks at both ends
    expect(await shape('2026-06-16', '2026-10-18')).toEqual(['month', 5]); // 125 days
    expect(await shape('2026-01-01', '2026-12-31')).toEqual(['month', 10]); // this year

    // A two-month custom range from a Tuesday: weeks keyed by their Saturday,
    // the first cut to start on the Tuesday, every full one Saturday–Friday.
    const p = await pnl(w, '2026-08-04', '2026-10-18');
    expect(p.buckets[0]).toMatchObject({
      key: '2026-08-01',
      from: '2026-08-04',
      to: '2026-08-07',
    });
    for (const b of p.buckets) {
      expect(new Date(`${b.key}T00:00:00Z`).getUTCDay()).toBe(6);
    }
    for (const b of p.buckets.slice(1, -1)) {
      expect([b.from, new Date(`${b.to}T00:00:00Z`).getUTCDay()]).toEqual([
        b.key,
        5,
      ]);
    }
    expect(p.buckets[p.buckets.length - 1]).toMatchObject({
      key: '2026-10-17',
      to: '2026-10-18',
    });
  });

  it('no gaps: every bucket starts the day after the one before ends, quiet ones as zeros', async () => {
    const w = world({ orders: [sale('2026-08-20', 500, 200)] });
    for (const [from, to] of [
      ['2026-10-01', '2026-10-18'],
      ['2026-08-04', '2026-10-18'],
      ['2026-01-01', '2026-10-18'],
    ]) {
      const p = await pnl(w, from, to);
      expect(p.buckets[0].from).toBe(from);
      expect(p.buckets[p.buckets.length - 1].to).toBe(to);
      for (let i = 1; i < p.buckets.length; i++) {
        const next = new Date(
          Date.parse(`${p.buckets[i - 1].to}T00:00:00Z`) + 86_400_000,
        )
          .toISOString()
          .slice(0, 10);
        expect(p.buckets[i].from).toBe(next);
      }
      expect(p.buckets.filter((b) => b.salesEgp !== 0).length).toBe(
        from === '2026-10-01' ? 0 : 1,
      );
    }
  });

  it('for every granularity, and all time, the buckets add up to every total exactly', async () => {
    const w = spread();
    const now = cairo('2026-10-18', 15);
    const periods: [string | undefined, string | undefined, string][] = [
      ['2026-10-01', '2026-10-31', 'day'],
      ['2026-02-27', '2026-03-03', 'day'], // across the end of February
      ['2026-07-04', '2026-09-20', 'week'],
      ['2026-01-01', '2026-12-31', 'month'],
      [undefined, undefined, 'month'],
    ];
    for (const [from, to, granularity] of periods) {
      const p = (await service(w).getProfitAndLoss(from, to, now)).data;
      expect([from, p.granularity]).toEqual([from, granularity]);
      expect(p.salesEgp).not.toBe(0); // not zeros agreeing (rule 10)
      expect([from, bucketSum(p, (b) => b.salesEgp)]).toEqual([
        from,
        p.salesEgp,
      ]);
      expect([from, bucketSum(p, (b) => b.grossProfitEgp)]).toEqual([
        from,
        p.grossProfitEgp,
      ]);
      expect([from, bucketSum(p, (b) => b.expensesEgp)]).toEqual([
        from,
        p.expensesEgp,
      ]);
      expect([from, bucketSum(p, (b) => b.netProfitEgp)]).toEqual([
        from,
        p.netProfitEgp,
      ]);
    }
    // And all time's totals are still the dashboard's, figure for figure.
    const dash = (await service(w).getDashboardKPIs()).data;
    const all = (await service(w).getProfitAndLoss(undefined, undefined, now))
      .data;
    expect([all.salesEgp, all.expensesEgp, all.netProfitEgp]).toEqual([
      dash.totalRevenue,
      dash.totalExpenses,
      dash.netProfit,
    ]);
  });

  it('a bucket is the same figure as asking for its days alone', async () => {
    const w = spread();
    const p = await pnl(w, '2026-07-04', '2026-09-20');
    for (const b of p.buckets) {
      const alone = await pnl(w, b.from, b.to);
      expect([b.key, b.salesEgp, b.expensesEgp, b.netProfitEgp]).toEqual([
        b.key,
        alone.salesEgp,
        alone.expensesEgp,
        alone.netProfitEgp,
      ]);
    }
  });

  it('a day of expenses and nothing sold is a loss on that day, and only that day', async () => {
    const w = world({
      orders: [sale('2026-10-03', 1_000, 400)],
      tx: [tx('OUTFLOW', 'rent', 2_500, '2026-10-05')],
    });
    const p = await pnl(w, '2026-10-01', '2026-10-18');
    expect(
      p.buckets
        .filter((b) => b.netProfitEgp !== 0)
        .map((b) => [b.key, b.netProfitEgp]),
    ).toEqual([
      ['2026-10-03', 600],
      ['2026-10-05', -2_500],
    ]);
    expect(p.netProfitEgp).toBe(-1_900);
  });

  it('a row dated after today still counts in all time, and so its bucket exists', async () => {
    const w = world({
      orders: [sale('2026-09-10', 1_000, 400)],
      tx: [tx('OUTFLOW', 'rent', 300, '2026-12-01')], // check-data 25's kind
    });
    const p = await pnl(w);
    expect(p.expensesEgp).toBe(300);
    expect(bucketSum(p, (b) => b.netProfitEgp)).toBe(p.netProfitEgp);
    // 10 September – 1 December: weeks, the last the one 1 December is in.
    expect(p.buckets[p.buckets.length - 1]).toMatchObject({
      key: '2026-11-28',
      to: '2026-12-01',
      expensesEgp: 300,
    });
    expect(p.to).toBe('2026-10-18');
  });

  it('the query count does not grow with the buckets: twelve for a 31-day month, a week view or all time', async () => {
    const w = spread();
    const now = cairo('2026-10-18', 15);
    const count = async (from?: string, to?: string) => {
      calls.n = 0;
      await service(w).getProfitAndLoss(from, to, now);
      return calls.n;
    };
    expect(await count('2026-08-01', '2026-08-31')).toBe(12);
    expect(await count('2026-07-04', '2026-09-20')).toBe(12);
    expect(await count(undefined, undefined)).toBe(12);
    // And the dashboard's reading is unchanged: twelve sums.
    calls.n = 0;
    await service(w).profitFigures();
    expect(calls.n).toBe(12);
  });
});
