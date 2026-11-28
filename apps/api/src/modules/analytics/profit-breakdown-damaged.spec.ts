// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; the parts here are built by hand
import { Prisma } from '@prisma/client';
import { figuresOf, type ProfitPart } from './analytics.service';
import { breakdownOf, sectionTotals } from './profit-breakdown';

/**
 * Goods damaged in storage in Analytics (§3, 2026-11-28): an expense of its
 * own ("Damaged in storage"), inside Expenses, off net profit, one row per
 * damage in What made a bar, on the day it was dated.
 */
const D = (v: number) => new Prisma.Decimal(v);

const PARTS: ProfitPart[] = [
  {
    line: 'revenue',
    day: '2026-11-28',
    amount: D(80000),
    source: { kind: 'sale', orderId: 'o1' },
  },
  {
    line: 'cogs',
    day: '2026-11-28',
    amount: D(50000),
    source: { kind: 'sale', orderId: 'o1' },
  },
  {
    line: 'losses',
    day: '2026-11-28',
    amount: D(90),
    source: { kind: 'loss', id: 'l1' },
  },
  {
    line: 'damaged',
    day: '2026-11-28',
    amount: D(5000),
    source: { kind: 'damaged', id: 'd1' },
  },
  {
    line: 'damaged',
    day: '2026-11-27',
    amount: D(3750),
    source: { kind: 'damaged', id: 'd2' },
  },
];

describe('TC-DMG-01 goods damaged in storage in the profit figures', () => {
  it('its own figure, inside Expenses, off net profit', () => {
    const f = figuresOf(PARTS);
    expect(f.damagedInStorage.toFixed(2)).toBe('8750.00');
    expect(f.losses.toFixed(2)).toBe('90.00');
    expect(f.operatingExpenses.toFixed(2)).toBe('8840.00');
    expect(f.netProfit.toFixed(2)).toBe('21160.00');
  });

  it('TC-DMG-13 one row per damage in What made a bar, each on its own day, adding up to the figure', () => {
    const b = breakdownOf(PARTS);
    const rows = b.expenses.filter((r) => r.kind === 'damaged');
    expect(rows.map((r) => [r.id, r.day, r.amountEgp.toFixed(2)])).toEqual(
      expect.arrayContaining([
        ['d1', '2026-11-28', '5000.00'],
        ['d2', '2026-11-27', '3750.00'],
      ]),
    );
    expect(sectionTotals(b).expenses.amountEgp.toFixed(2)).toBe(
      figuresOf(PARTS).operatingExpenses.toFixed(2),
    );
  });

  it('a damaged part from another kind of record is refused, not guessed', () => {
    expect(() =>
      breakdownOf([
        {
          line: 'damaged',
          day: '2026-11-28',
          amount: D(1),
          source: { kind: 'loss', id: 'x' },
        },
      ]),
    ).toThrow();
  });
});
