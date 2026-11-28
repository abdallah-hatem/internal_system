import { HttpException } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access
import { Prisma } from '@prisma/client';
import {
  assertDamageable,
  assertNotBeforeReceived,
  damageCostEgp,
  damageCycleRefusal,
  damageQty,
  damageText,
  damageableOn,
  undoDamageRefusal,
} from './stock-damage';
import {
  distributeCycleProfit,
  type ParticipantInput,
} from '../modules/settlements/settlement-math';
import { cycleCostLines, sumCostLines } from './payout-breakdown';

/**
 * Goods damaged in storage (§3, §8 — owner 2026-11-28): the pure rules and
 * the arithmetic. The flows against Postgres are in
 * `modules/inventory/stock-damages.db.spec.ts`. Test names starting TC-DMG-NN
 * are the blind scenarios written from the docs only (scratchpad
 * damaged-scenarios.md); the number is the scenario's.
 */

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof HttpException) {
      return (e.getResponse() as { code: string }).code;
    }
    throw e;
  }
  throw new Error('expected a refusal');
}
/** The code of a refusal a rule returned rather than threw. */
const codeOfErr = (e: HttpException | null) =>
  e ? (e.getResponse() as { code: string }).code : null;
const paramsOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as HttpException).getResponse() as {
      params?: Record<string, unknown>;
    };
  }
  throw new Error('expected a refusal');
};

/** The blind scenarios' fixture: 90,000 / 90,000 / 60,000 and Ihab 60,000. */
const fixture = (fee: number | null = null): ParticipantInput[] => [
  {
    id: 'abdallah',
    type: 'CORE_PARTNER',
    contribution: D(90000),
    customProfitPct: null,
    investorFeePct: null,
  },
  {
    id: 'shady',
    type: 'CORE_PARTNER',
    contribution: D(90000),
    customProfitPct: null,
    investorFeePct: null,
  },
  {
    id: 'fares',
    type: 'CORE_PARTNER',
    contribution: D(60000),
    customProfitPct: null,
    investorFeePct: null,
  },
  {
    id: 'ihab',
    type: 'TEMP_INVESTOR',
    contribution: D(60000),
    customProfitPct: null,
    investorFeePct: fee === null ? null : D(fee),
  },
];
const profits = (ps: ParticipantInput[], profit: Prisma.Decimal.Value) =>
  distributeCycleProfit(ps, D(profit)).lines.map((l) =>
    l.grossProfit.toFixed(2),
  );

describe('goods damaged in storage — the rules', () => {
  it('TC-DMG-01 Marking 4 units damaged: the loss is 4 × 1,250 = 5,000 and the shares fall 9,000→7,500, 9,000→7,500, 6,000→5,000, 6,000→5,000', () => {
    expect(damageCostEgp({ qty: 4, unitCostEgp: '1250.0000' }).toFixed(2)).toBe(
      '5000.00',
    );
    expect(profits(fixture(), 30000)).toEqual([
      '9000.00',
      '9000.00',
      '6000.00',
      '6000.00',
    ]);
    expect(profits(fixture(), D(30000).sub(5000))).toEqual([
      '7500.00',
      '7500.00',
      '5000.00',
      '5000.00',
    ]);
  });

  it('TC-DMG-01 its own cost line, "Damaged in storage", which the payout lines add up to', () => {
    const lines = cycleCostLines({
      expenseRows: [],
      recoveryRows: [],
      otherIncomeRows: [],
      lossesEgp: D(0),
      samplesWrittenOffEgp: D(0),
      damagedInStorageEgp: D(5000),
      exchangeDifferenceEgp: D(0),
    });
    expect(lines).toEqual([
      { kind: 'loss', category: 'damaged_in_storage', amountEgp: '5000.00' },
    ]);
    expect(sumCostLines(lines).toFixed(2)).toBe('5000.00');
  });

  it('TC-DMG-02 Non-zero distribution with rounding: 7 × 1,111.1111 = 7,777.78, profit 42,222.22 split 14,074.07 / 14,074.07 / 14,074.08 — nobody absorbs the whole loss', () => {
    const loss = damageCostEgp({ qty: 7, unitCostEgp: '1111.1111' });
    expect(loss.toFixed(2)).toBe('7777.78');
    const three: ParticipantInput[] = ['a', 'b', 'c'].map((id) => ({
      id,
      type: 'CORE_PARTNER',
      contribution: D(100000),
      customProfitPct: null,
      investorFeePct: null,
    }));
    const before = profits(three, 50000);
    const after = profits(three, D(50000).sub(loss));
    expect(after).toEqual(['14074.07', '14074.07', '14074.08']);
    expect(after.reduce((s, x) => s.add(x), D(0)).toFixed(2)).toBe('42222.22');
    // Every share fell by about a third of it — none by 0, none by all of it.
    for (const [i, a] of after.entries()) {
      const drop = D(before[i]).sub(a);
      expect(drop.gt(2592) && drop.lt(2593)).toBe(true);
    }
  });

  it('TC-DMG-02 the damage that takes a line’s last units takes the rounding residual: the line re-sums to what it cost', () => {
    // 9 at 1,111.1111 booked at 10,000.00; 2 sold at 2,222.22.
    expect(
      damageCostEgp({
        qty: 7,
        unitCostEgp: '1111.1111',
        final: { bookedEgp: '10000.00', drawnEgp: '2222.22' },
      }).toFixed(2),
    ).toBe('7777.78');
    // 3 at 3,333.3333 (10,000 booked), 1 sold at 3,333.33, 2 damaged last:
    // the plain figure 6,666.67 would leave the line at 10,000.00 — and so
    // does the residual. One sold at 3,333.33 and one damaged earlier at
    // 3,333.33 leave 3,333.34 for the last.
    expect(
      damageCostEgp({
        qty: 1,
        unitCostEgp: '3333.3333',
        final: { bookedEgp: '10000.00', drawnEgp: '6666.66' },
      }).toFixed(2),
    ).toBe('3333.34');
  });

  it('TC-DMG-02 a residual that is not a rounding residual is not taken (a cost typed by hand, an odd re-cost)', () => {
    expect(
      damageCostEgp({
        qty: 1,
        unitCostEgp: '100.0000',
        final: { bookedEgp: '1000.00', drawnEgp: '500.00' },
      }).toFixed(2),
    ).toBe('100.00');
    expect(
      damageCostEgp({
        qty: 1,
        unitCostEgp: '100.0000',
        final: { bookedEgp: '100.00', drawnEgp: '200.00' },
      }).toFixed(2),
    ).toBe('100.00');
  });

  it('TC-DMG-03 Investor fee recalculated on the smaller profit: gross 6,000→5,000, fee 900→750, he keeps 5,100→4,250', () => {
    const before = distributeCycleProfit(fixture(15), D(30000)).lines[3];
    const after = distributeCycleProfit(fixture(15), D(25000));
    const ihab = after.lines[3];
    expect(
      [before.grossProfit, before.investorFee, before.netProfit].map((v) =>
        v.toFixed(2),
      ),
    ).toEqual(['6000.00', '900.00', '5100.00']);
    expect(
      [ihab.grossProfit, ihab.investorFee, ihab.netProfit].map((v) =>
        v.toFixed(2),
      ),
    ).toEqual(['5000.00', '750.00', '4250.00']);
    const received = after.lines.reduce((s, l) => s.add(l.feeReceived), D(0));
    expect(received.toFixed(2)).toBe('750.00');
    // Capital back unchanged for all.
    expect(after.totals.capitalReturned.toFixed(2)).toBe('300000.00');
  });

  it('TC-DMG-04 Zero, negative and fractional units are refused with a code', () => {
    expect(codeOf(() => damageQty(0))).toBe('STOCK_DAMAGE_QTY_NOT_POSITIVE');
    expect(codeOf(() => damageQty(-3))).toBe('STOCK_DAMAGE_QTY_NOT_POSITIVE');
    expect(codeOf(() => damageQty('-3'))).toBe('STOCK_DAMAGE_QTY_NOT_POSITIVE');
    expect(codeOf(() => damageQty(1.5))).toBe('STOCK_DAMAGE_QTY_NOT_WHOLE');
    expect(codeOf(() => damageQty('abc'))).toBe(
      'STOCK_DAMAGE_QTY_NOT_POSITIVE',
    );
    expect(codeOf(() => damageQty(undefined))).toBe(
      'STOCK_DAMAGE_QTY_NOT_POSITIVE',
    );
    expect(codeOf(() => damageQty({ qty: 4 }))).toBe(
      'STOCK_DAMAGE_QTY_NOT_POSITIVE',
    );
    expect(codeOf(() => damageQty(Infinity))).toBe(
      'STOCK_DAMAGE_QTY_NOT_POSITIVE',
    );
    expect(damageQty('4').toFixed(0)).toBe('4');
    expect(damageQty(4).toFixed(0)).toBe('4');
  });

  it('TC-DMG-05 More than is on the shelf: 61 of 60 refused with available 60; exactly 60 allowed, and the cycle can go into a loss', () => {
    const shelf = damageableOn({
      verificationStatus: 'VERIFIED',
      saleableQty: 60,
      heldQty: 0,
    });
    expect(shelf.toFixed(0)).toBe('60');
    expect(codeOf(() => assertDamageable(D(61), shelf, 'Helmet headset'))).toBe(
      'STOCK_DAMAGE_MORE_THAN_ON_SHELF',
    );
    expect(
      paramsOf(() => assertDamageable(D(61), shelf, 'Helmet headset')).params,
    ).toMatchObject({ available: '60', requested: '61' });
    expect(() =>
      assertDamageable(D(60), shelf, 'Helmet headset'),
    ).not.toThrow();
    const loss = damageCostEgp({ qty: 60, unitCostEgp: 1250 });
    expect(loss.toFixed(2)).toBe('75000.00');
    expect(profits(fixture(), D(30000).sub(loss))).toEqual([
      '-13500.00',
      '-13500.00',
      '-9000.00',
      '-9000.00',
    ]);
  });

  it('TC-DMG-08 Units held by a storefront order request are not on offer: 57 on the shelf, 5 held → 52; a batch not yet checked has none', () => {
    const b = { verificationStatus: 'VERIFIED', saleableQty: 57, heldQty: 5 };
    expect(damageableOn(b).toFixed(0)).toBe('52');
    expect(codeOf(() => assertDamageable(D(55), damageableOn(b), 'x'))).toBe(
      'STOCK_DAMAGE_MORE_THAN_ON_SHELF',
    );
    expect(
      damageableOn({ ...b, verificationStatus: 'PENDING' }).toFixed(0),
    ).toBe('0');
    // Holds that outlived their stock: zero, never negative.
    expect(damageableOn({ ...b, heldQty: 60 }).toFixed(0)).toBe('0');
  });

  it('TC-DMG-09 A date before the stock was received is refused; the day it was received is fine', () => {
    expect(
      codeOf(() => assertNotBeforeReceived('2026-09-01', '2026-10-15')),
    ).toBe('STOCK_DAMAGE_BEFORE_RECEIVED');
    expect(() =>
      assertNotBeforeReceived('2026-10-15', '2026-10-15'),
    ).not.toThrow();
  });

  it('TC-DMG-10 A cycle being settled, settled, closed or cancelled refuses; a draft settlement does not', () => {
    const c = (status: string) => ({ code: 'CYC-T1', status });
    expect(damageCycleRefusal(c('SETTLEMENT'))).not.toBeNull();
    expect(codeOfErr(damageCycleRefusal(c('SETTLEMENT')))).toBe(
      'CYCLE_SETTLING',
    );
    expect(codeOfErr(damageCycleRefusal(c('CLOSED')))).toBe('CYCLE_SETTLING');
    expect(codeOfErr(damageCycleRefusal(c('CANCELLED')))).toBe('CYCLE_CLOSED');
    expect(codeOfErr(damageCycleRefusal(c('SELLING'), 'APPROVED'))).toBe(
      'CYCLE_SETTLING',
    );
    expect(codeOfErr(damageCycleRefusal(c('SELLING'), 'PAID'))).toBe(
      'CYCLE_SETTLING',
    );
    expect(damageCycleRefusal(c('SELLING'))).toBeNull();
    expect(damageCycleRefusal(c('ARRIVED_EGYPT'))).toBeNull();
  });

  it('TC-DMG-15 A damage already undone cannot be undone again', () => {
    expect(undoDamageRefusal({ undoneAt: null })).toBeNull();
    expect(codeOfErr(undoDamageRefusal({ undoneAt: new Date() }))).toBe(
      'STOCK_DAMAGE_ALREADY_UNDONE',
    );
  });

  it('a note longer than 500 characters is refused, not cut; blank is nothing', () => {
    expect(damageText('  dropped  ', 'note')).toBe('dropped');
    expect(damageText(undefined, 'note')).toBe('');
    expect(damageText(42, 'reason')).toBe('');
    expect(codeOf(() => damageText('x'.repeat(501), 'note'))).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('TC-DMG-20 Damage after an investor exited falls only on those still on the cycle: Ihab stays 6,000; 19,000 → 7,125 / 7,125 / 4,750', () => {
    const ps = fixture();
    ps[3].exited = {
      grossProfit: D(6000),
      investorFee: D(0),
      netProfit: D(6000),
      sharePct: D(20),
    };
    expect(profits(ps, 25000)).toEqual([
      '7125.00',
      '7125.00',
      '4750.00',
      '6000.00',
    ]);
    // Without the damage: 9,000 / 9,000 / 6,000 — the 5,000 is all theirs.
    expect(profits(ps, 30000)).toEqual([
      '9000.00',
      '9000.00',
      '6000.00',
      '6000.00',
    ]);
  });

  it('TC-DMG-21 Damage before the exit, undone after it: Ihab stays at 5,000; the remaining 25,000 → 9,375 / 9,375 / 6,250', () => {
    const ps = fixture();
    ps[3].exited = {
      grossProfit: D(5000),
      investorFee: D(0),
      netProfit: D(5000),
      sharePct: D(20),
    };
    expect(profits(ps, 25000)).toEqual([
      '7500.00',
      '7500.00',
      '5000.00',
      '5000.00',
    ]);
    expect(profits(ps, 30000)).toEqual([
      '9375.00',
      '9375.00',
      '6250.00',
      '5000.00',
    ]);
  });

  it('TC-DMG-22 Damage pushes the cycle into a loss after an exit: −2,000 − 600 = −2,600 → −975 / −975 / −650; Ihab untouched', () => {
    const ps = fixture();
    ps[3].exited = {
      grossProfit: D(600),
      investorFee: D(0),
      netProfit: D(600),
      sharePct: D(20),
    };
    expect(profits(ps, -2000)).toEqual([
      '-975.00',
      '-975.00',
      '-650.00',
      '600.00',
    ]);
  });
});
