import { describe, expect, it } from 'vitest';
import { amountFromPct, balanceLastPartner, pctFromAmount, pctTotal, splitAcrossPartners } from './funding-split';

describe('Split equally — what each core partner puts in', () => {
  it('splits the cost to fund to the piastre, the last partner taking the residual', () => {
    const { total, shares } = splitAcrossPartners(75645.5, 0, 3);
    expect(total).toBe(75645.5);
    expect(shares).toEqual([25215.16, 25215.16, 25215.18]);
    expect(Math.round(shares.reduce((s, x) => s + x, 0) * 100)).toBe(7564550);
  });

  it('takes investors’ money off first', () => {
    expect(splitAcrossPartners(90000, 30000, 2)).toEqual({ total: 60000, shares: [30000, 30000] });
  });

  it('a cycle a friend paid for entirely: the server no longer takes him off, so the partners split the whole cost — their shares of repaying him (2026-10-19)', () => {
    // The owner's cycle: Ahmad Eraiby paid 172,155.50. This used to be 0 / 0 / 0.
    const { total, shares } = splitAcrossPartners(172155.5, 0, 3);
    expect(total).toBe(172155.5);
    expect(shares).toEqual([57385.16, 57385.16, 57385.18]);
  });

  it('a cost to fund of zero asks for nothing', () => {
    expect(splitAcrossPartners(0, 0, 3)).toEqual({ total: 0, shares: [0, 0, 0] });
  });

  it('investors putting in more than is left never makes a partner’s share negative', () => {
    expect(splitAcrossPartners(1000, 5000, 2)).toEqual({ total: 0, shares: [0, 0] });
  });

  it('no partners: nothing to split', () => {
    expect(splitAcrossPartners(1000, 0, 0)).toEqual({ total: 0, shares: [] });
  });
});

describe('any split — the % and amount arithmetic of Enter amounts (owner 2026-10-19)', () => {
  it('amountFromPct: 30% of 172,155.50 to the piastre; blank and nonsense give blank', () => {
    expect(amountFromPct(172155.5, '30')).toBe('51646.65');
    expect(amountFromPct(172155.5, '40')).toBe('68862.20');
    expect(amountFromPct(100, '33.333')).toBe('33.33');
    expect(amountFromPct(100, '')).toBe('');
    expect(amountFromPct(100, 'abc')).toBe('');
    expect(amountFromPct(-5, '50')).toBe('0.00');
  });

  it('pctFromAmount: two decimals, and nothing when there is no base', () => {
    expect(pctFromAmount(172155.5, '68862.20')).toBe('40.00');
    expect(pctFromAmount(0, '100')).toBe('');
    expect(pctFromAmount(100, '')).toBe('');
  });

  it('pctTotal sums to the hundredth — 33.33 three times is 99.99, not 100', () => {
    expect(pctTotal(['30', '30', '40'])).toBe(100);
    expect(pctTotal(['33.33', '33.33', '33.33'])).toBe(99.99);
    expect(pctTotal(['', '50'])).toBe(50);
  });

  it('balanceLastPartner: at exactly 100%, the last partner (from his %) takes the residual', () => {
    const rows = [
      { amount: '33330.00', pct: '33.33', from: 'pct' as const },
      { amount: '33330.00', pct: '33.33', from: 'pct' as const },
      { amount: '33340.00', pct: '33.34', from: 'pct' as const },
    ];
    expect(balanceLastPartner(rows, 100000.01).map((r) => r.amount)).toEqual(['33330.00', '33330.00', '33340.01']);
  });

  it('balanceLastPartner leaves it alone when the % are not 100, one is blank, or the last amount was typed', () => {
    const base = 1000;
    const r = (amount: string, pct: string, from: 'pct' | 'amount' = 'pct') => ({ amount, pct, from });
    const short = [r('300.00', '30'), r('300.00', '30'), r('300.00', '30')];
    expect(balanceLastPartner(short, base)).toBe(short);
    const blank = [r('300.00', '30'), r('', ''), r('700.00', '70')];
    expect(balanceLastPartner(blank, base)).toBe(blank);
    const typed = [r('300.00', '30'), r('300.00', '30'), r('399.99', '40', 'amount')];
    expect(balanceLastPartner(typed, base)).toBe(typed);
    expect(balanceLastPartner([], base)).toEqual([]);
  });

  it('balanceLastPartner never makes the last amount negative when the others already exceed the base', () => {
    const rows = [
      { amount: '1200.00', pct: '50', from: 'amount' as const },
      { amount: '500.00', pct: '50', from: 'pct' as const },
    ];
    expect(balanceLastPartner(rows, 1000)).toBe(rows);
  });
});
