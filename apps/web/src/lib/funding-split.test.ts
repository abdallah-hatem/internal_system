import { describe, expect, it } from 'vitest';
import { splitAcrossPartners } from './funding-split';

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

  it('a cycle a friend paid for entirely — cost to fund zero — asks the partners for nothing', () => {
    expect(splitAcrossPartners(0, 0, 3)).toEqual({ total: 0, shares: [0, 0, 0] });
  });

  it('investors putting in more than is left never makes a partner’s share negative', () => {
    expect(splitAcrossPartners(1000, 5000, 2)).toEqual({ total: 0, shares: [0, 0] });
  });

  it('no partners: nothing to split', () => {
    expect(splitAcrossPartners(1000, 0, 0)).toEqual({ total: 0, shares: [] });
  });
});
