// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access
import { Prisma } from '@prisma/client';
import { splitTake } from './take-money';

/** One take cut into profit first, then capital (§8, owner 2026-11-10). */
const D = (v: string | number) => new Prisma.Decimal(v);
const cut = (amount: string, profit: string, capital: string) => {
  const s = splitTake(D(amount), D(profit), D(capital));
  return s && [s.profit.toFixed(2), s.capital.toFixed(2)];
};

describe('splitTake', () => {
  it('profit first, the rest from capital: 60,000 of 20,000 + 50,000', () => {
    expect(cut('60000', '20000', '50000')).toEqual(['20000.00', '40000.00']);
  });
  it('within his profit: profit only', () => {
    expect(cut('15000', '20000', '50000')).toEqual(['15000.00', '0.00']);
    expect(cut('20000', '20000', '50000')).toEqual(['20000.00', '0.00']);
  });
  it('no profit room: capital only', () => {
    expect(cut('100', '0', '500')).toEqual(['0.00', '100.00']);
  });
  it('exactly the total, and a piastre over it', () => {
    expect(cut('70000', '20000', '50000')).toEqual(['20000.00', '50000.00']);
    expect(cut('70000.01', '20000', '50000')).toBeNull();
  });
  it('a negative room counts as nothing, never as more room elsewhere', () => {
    expect(cut('500', '-300', '500')).toEqual(['0.00', '500.00']);
    expect(cut('500.01', '-300', '500')).toBeNull();
  });
  it('zero and negative amounts cut nothing', () => {
    expect(cut('0', '20', '50')).toBeNull();
    expect(cut('-1', '20', '50')).toBeNull();
  });
  it('piastres stay exact: 0.1 + 0.2', () => {
    expect(cut('0.30', '0.10', '0.20')).toEqual(['0.10', '0.20']);
  });
});
