// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; money must not become a float
import { Prisma } from '@prisma/client';
import { capitalRoom, recoveredShare } from './capital-back-early';

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

/** Capital taken back early (§8, 2026-11-08): the pure rules. */
describe('recoveredShare', () => {
  it('is what paid sales recovered over the cost to fund', () => {
    expect(recoveredShare(D(70_000), D(100_000)).toString()).toBe('0.7');
  });

  it('nothing recovered, or nothing to fund: nothing to give back', () => {
    expect(recoveredShare(D(0), D(100_000)).isZero()).toBe(true);
    expect(recoveredShare(D(5_000), D(0)).isZero()).toBe(true);
    expect(recoveredShare(D(-10), D(100)).isZero()).toBe(true);
    expect(recoveredShare(D(10), D(-100)).isZero()).toBe(true);
  });

  it('never above everything: more recovered than it cost is still all of it', () => {
    expect(recoveredShare(D(150_000), D(100_000)).toString()).toBe('1');
  });
});

describe('capitalRoom', () => {
  it('is the recovered share of what he put in, less what he took back', () => {
    const r = capitalRoom({
      share: D('0.7'),
      contribution: D(55_000),
      taken: D(10_000),
    });
    expect(r.recoveredEgp.toFixed(2)).toBe('38500.00');
    expect(r.availableEgp.toFixed(2)).toBe('28500.00');
  });

  it('investors and partners alike: each by his own contribution', () => {
    const share = D('0.7');
    const investor = capitalRoom({
      share,
      contribution: D(60_000),
      taken: D(0),
    });
    const partner = capitalRoom({
      share,
      contribution: D(33_000),
      taken: D(0),
    });
    expect(investor.availableEgp.toFixed(2)).toBe('42000.00');
    expect(partner.availableEgp.toFixed(2)).toBe('23100.00');
  });

  it('rounds down to the piastre: never a piastre of someone else’s money', () => {
    // 1/3 of 100 is 33.333… → 33.33, not 33.34.
    const r = capitalRoom({
      share: D(1).div(3),
      contribution: D(100),
      taken: D(0),
    });
    expect(r.availableEgp.toFixed(2)).toBe('33.33');
    // 2/3 of 100 = 66.666… → 66.66, where half-up would give 66.67.
    const r2 = capitalRoom({
      share: D(2).div(3),
      contribution: D(100),
      taken: D(0),
    });
    expect(r2.availableEgp.toFixed(2)).toBe('66.66');
  });

  it('took all of his part already: nothing more, never negative', () => {
    const r = capitalRoom({
      share: D('0.5'),
      contribution: D(1_000),
      taken: D(500),
    });
    expect(r.availableEgp.isZero()).toBe(true);
    // Recovered went down since (a payment undone): still zero, not −100.
    const r2 = capitalRoom({
      share: D('0.4'),
      contribution: D(1_000),
      taken: D(500),
    });
    expect(r2.availableEgp.isZero()).toBe(true);
    expect(r2.recoveredEgp.toFixed(2)).toBe('400.00');
  });

  it('everything recovered: at most what he put in', () => {
    const r = capitalRoom({
      share: D(1),
      contribution: D('1234.56'),
      taken: D(0),
    });
    expect(r.availableEgp.toFixed(2)).toBe('1234.56');
  });

  it('no contribution (zero, or a bad negative row): nothing to take back', () => {
    for (const c of [0, -500]) {
      const r = capitalRoom({
        share: D('0.9'),
        contribution: D(c),
        taken: D(0),
      });
      expect(r.availableEgp.isZero()).toBe(true);
      expect(r.recoveredEgp.isZero()).toBe(true);
    }
  });
});
