// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; the parts here are built by hand
import { Prisma } from '@prisma/client';
import { figuresOf, type ProfitPart } from './analytics.service';
import { breakdownOf, sectionTotals } from './profit-breakdown';

/**
 * The grouping behind "what made a bar" (BUSINESS_LOGIC §9, 2026-10-28): every
 * part in exactly one row, the rows adding up to the bar's own figures — the
 * kinds the database suite does not build by hand (goods lost, samples written
 * off, money recovered, other income) included.
 */

const D = (v: number) => new Prisma.Decimal(v);
const part = (
  p: Omit<ProfitPart, 'amount'> & { amount: number },
): ProfitPart => ({
  ...p,
  amount: D(p.amount),
});

const PARTS: ProfitPart[] = [
  part({
    line: 'revenue',
    day: '2026-10-05',
    amount: 1000,
    source: { kind: 'sale', orderId: 'o1' },
  }),
  part({
    line: 'cogs',
    day: '2026-10-05',
    amount: 700,
    source: { kind: 'sale', orderId: 'o1' },
  }),
  part({
    line: 'cogs',
    day: '2026-10-05',
    amount: 100,
    source: { kind: 'sale', orderId: 'o1' },
  }),
  part({
    line: 'revenue',
    day: '2026-10-06',
    amount: -200,
    source: { kind: 'return', orderId: 'o1', id: 'r1' },
  }),
  part({
    line: 'cogs',
    day: '2026-10-06',
    amount: -160,
    source: { kind: 'return', orderId: 'o1', id: 'r1' },
  }),
  part({
    line: 'revenue',
    day: '2026-10-07',
    amount: -50,
    source: { kind: 'priceCut', orderId: 'o2', id: 'a1' },
  }),
  part({
    line: 'operating',
    day: '2026-10-05',
    amount: 300,
    category: 'fuel',
    source: { kind: 'ledger', id: 'e1' },
  }),
  part({
    line: 'losses',
    day: '2026-10-05',
    amount: 90,
    source: { kind: 'loss', id: 'l1' },
  }),
  part({
    line: 'samples',
    day: '2026-10-06',
    amount: 40,
    source: { kind: 'samples', orderId: 's1' },
  }),
  part({
    line: 'samples',
    day: '2026-10-06',
    amount: 15,
    source: { kind: 'samples', orderId: 's1' },
  }),
  part({
    line: 'recovered',
    day: '2026-10-07',
    amount: 25,
    category: 'supplier_refund',
    source: { kind: 'ledger', id: 'x1' },
  }),
  part({
    line: 'otherIncome',
    day: '2026-10-07',
    amount: 10,
    category: 'interest',
    source: { kind: 'ledger', id: 'x2' },
  }),
  part({
    line: 'exchangeDiff',
    day: '2026-10-07',
    amount: 33.33,
    source: { kind: 'repayment', id: 'p1' },
  }),
  part({
    line: 'exchangeDiff',
    day: '2026-10-07',
    amount: -3.33,
    source: { kind: 'repayment', id: 'p2' },
  }),
];

describe('breakdownOf — grouping a bar’s parts by the record each came from', () => {
  it('orders: a sale, its return and another order’s price cut — one row each, worst first', () => {
    const b = breakdownOf(PARTS);
    expect(
      b.orders.map((r) => [
        r.orderId,
        r.day,
        r.saleEgp.toFixed(2),
        r.returnsEgp.toFixed(2),
        r.priceCutsEgp.toFixed(2),
        r.cogsEgp.toFixed(2),
        r.grossEgp.toFixed(2),
      ]),
    ).toEqual([
      ['o2', '2026-10-07', '0.00', '0.00', '-50.00', '0.00', '-50.00'],
      ['o1', '2026-10-05', '1000.00', '-200.00', '0.00', '640.00', '160.00'],
    ]);
    expect(
      b.orders[1].events.map((e) => [
        e.kind,
        e.id,
        e.day,
        e.revenueEgp.toFixed(2),
        e.cogsEgp.toFixed(2),
      ]),
    ).toEqual([['return', 'r1', '2026-10-06', '-200.00', '-160.00']]);
  });

  it('expenses: a ledger row, goods lost, and one row per samples order — largest first', () => {
    const b = breakdownOf(PARTS);
    expect(
      b.expenses.map((r) => [r.kind, r.id, r.amountEgp.toFixed(2), r.category]),
    ).toEqual([
      ['ledger', 'e1', '300.00', 'fuel'],
      ['loss', 'l1', '90.00', null],
      ['samples', 's1', '55.00', null],
    ]);
  });

  it('exchange by repayment, a gain below a cost; recovered and other income apart', () => {
    const b = breakdownOf(PARTS);
    expect(b.exchange.map((r) => [r.id, r.amountEgp.toFixed(2)])).toEqual([
      ['p1', '33.33'],
      ['p2', '-3.33'],
    ]);
    expect(b.other.map((r) => [r.line, r.id])).toEqual([
      ['recovered', 'x1'],
      ['otherIncome', 'x2'],
    ]);
  });

  it('the sections add up to the figures the bar shows, line by line', () => {
    const f = figuresOf(PARTS);
    const s = sectionTotals(breakdownOf(PARTS));
    expect(s.orders.revenueEgp.toFixed(2)).toBe(f.revenue.toFixed(2));
    expect(s.orders.cogsEgp.toFixed(2)).toBe(f.cogs.toFixed(2));
    expect(s.expenses.amountEgp.toFixed(2)).toBe(
      f.operatingExpenses.toFixed(2),
    );
    expect(s.exchange.amountEgp.toFixed(2)).toBe(f.exchangeDiff.toFixed(2));
    expect(s.other.recoveredEgp.toFixed(2)).toBe(f.recovered.toFixed(2));
    expect(s.other.otherIncomeEgp.toFixed(2)).toBe(f.otherIncome.toFixed(2));
    const net = s.orders.grossEgp
      .sub(s.expenses.amountEgp)
      .add(s.other.recoveredEgp)
      .add(s.other.otherIncomeEgp)
      .sub(s.exchange.amountEgp);
    expect(net.toFixed(2)).toBe(f.netProfit.toFixed(2));
  });

  it('nothing is no rows', () => {
    expect(breakdownOf([])).toEqual({
      orders: [],
      expenses: [],
      exchange: [],
      other: [],
    });
  });

  it('a part with no record, or from a record that cannot make it, throws rather than vanish from the popup', () => {
    expect(() =>
      breakdownOf([part({ line: 'revenue', day: '2026-10-05', amount: 1 })]),
    ).toThrow(/no record/);
    expect(() =>
      breakdownOf([
        part({
          line: 'revenue',
          day: null,
          amount: 1,
          source: { kind: 'sale', orderId: 'o' },
        }),
      ]),
    ).toThrow(/no record/);
    expect(() =>
      breakdownOf([
        part({
          line: 'operating',
          day: '2026-10-05',
          amount: 1,
          source: { kind: 'loss', id: 'l' },
        }),
      ]),
    ).toThrow(/from a loss/);
    expect(() =>
      breakdownOf([
        part({
          line: 'cogs',
          day: '2026-10-05',
          amount: 1,
          source: { kind: 'repayment', id: 'p' },
        }),
      ]),
    ).toThrow(/from a repayment/);
  });
});
