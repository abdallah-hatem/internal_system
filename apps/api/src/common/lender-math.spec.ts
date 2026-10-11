import { HttpException } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; money must not become a float
import { Prisma } from '@prisma/client';
import {
  owedOn,
  planRepayment,
  settlingEgp,
  type StandingRepayment,
} from './lender-math';

/**
 * The money of a debt in dirhams repaid in pounds (BUSINESS_LOGIC §18), branch
 * by branch. A friend paid 30,000 AED for an order booked at 13.00, so the
 * debt is 30,000 AED and 390,000 EGP at the order's rate.
 */
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const FINANCING = {
  amount: D('30000'),
  amountEgp: D('390000'),
  orderRate: D('13'),
};

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof HttpException) {
      return (e.getResponse() as { code: string }).code;
    }
    throw e;
  }
  return undefined;
}

/** Records a planned repayment the way the service stores it. */
function standing(
  p: ReturnType<typeof planRepayment>,
  egp: Prisma.Decimal.Value,
): StandingRepayment {
  return {
    amountEgp: D(egp),
    cleared: p.cleared,
    clearedAtOrderRateEgp: p.clearedAtOrderRateEgp,
    exchangeDiffEgp: p.exchangeDiffEgp,
  };
}

describe('owedOn', () => {
  it('is the amount less what standing repayments cleared', () => {
    expect(owedOn(D('30000'), []).toFixed(2)).toBe('30000.00');
    expect(
      owedOn(D('30000'), [
        { cleared: D('10000') },
        { cleared: D('2500.5') },
      ]).toFixed(2),
    ).toBe('17499.50');
  });
});

describe('settlingEgp — what pays off what is owed at a rate', () => {
  it('is owed × rate, half up to the piastre', () => {
    expect(settlingEgp(D('1000'), D('13.3333')).toFixed(2)).toBe('13333.30');
    expect(settlingEgp(D('0.01'), D('13.5555')).toFixed(2)).toBe('0.14');
  });
});

describe('planRepayment', () => {
  it('a part repayment clears pounds ÷ rate, rounded DOWN, never more than bought', () => {
    // 100,000 / 13.7 = 7299.2700… → 7299.27; 100,000 / 13.3333 = 7500.0187… → 7500.01
    const p = planRepayment(FINANCING, [], D('100000'), D('13.3333'));
    expect(p.final).toBe(false);
    expect(p.cleared.toFixed(2)).toBe('7500.01');
    // What it buys at the order's rate, and the pounds above that.
    expect(p.clearedAtOrderRateEgp.toFixed(2)).toBe('97500.13');
    expect(p.exchangeDiffEgp.toFixed(2)).toBe('2499.87');
  });

  it('a dirham that rose is a cost (positive), one that fell is a gain (negative)', () => {
    const rose = planRepayment(FINANCING, [], D('14000'), D('14'));
    expect(rose.cleared.toFixed(2)).toBe('1000.00');
    expect(rose.exchangeDiffEgp.toFixed(2)).toBe('1000.00');

    const fell = planRepayment(FINANCING, [], D('12000'), D('12'));
    expect(fell.cleared.toFixed(2)).toBe('1000.00');
    expect(fell.exchangeDiffEgp.toFixed(2)).toBe('-1000.00');

    const same = planRepayment(FINANCING, [], D('13000'), D('13'));
    expect(same.exchangeDiffEgp.toFixed(2)).toBe('0.00');
  });

  it('the settling amount clears exactly what is owed (final)', () => {
    // 30,000 × 13.3333 = 399,999.00
    const p = planRepayment(FINANCING, [], D('399999'), D('13.3333'));
    expect(p.final).toBe(true);
    expect(p.cleared.toFixed(2)).toBe('30000.00');
    expect(p.clearedAtOrderRateEgp.toFixed(2)).toBe('390000.00');
    expect(p.exchangeDiffEgp.toFixed(2)).toBe('9999.00');
  });

  it('one piastre above the settling amount is refused (too much)', () => {
    expect(
      codeOf(() => planRepayment(FINANCING, [], D('399999.01'), D('13.3333'))),
    ).toBe('LENDER_REPAYMENT_EXCEEDS_OWED');
  });

  it('a debt already repaid takes nothing more', () => {
    const all = planRepayment(FINANCING, [], D('390000'), D('13'));
    expect(
      codeOf(() =>
        planRepayment(FINANCING, [standing(all, '390000')], D('1'), D('13')),
      ),
    ).toBe('LENDER_REPAYMENT_EXCEEDS_OWED');
  });

  it('a repayment that clears 0.00 is refused', () => {
    expect(codeOf(() => planRepayment(FINANCING, [], D('0.05'), D('13')))).toBe(
      'LENDER_REPAYMENT_CLEARS_NOTHING',
    );
  });

  it('a rate of zero or less, or pounds of zero or less, are refused', () => {
    expect(codeOf(() => planRepayment(FINANCING, [], D('100'), D('0')))).toBe(
      'RATE_NOT_POSITIVE',
    );
    expect(codeOf(() => planRepayment(FINANCING, [], D('100'), D('-13')))).toBe(
      'RATE_NOT_POSITIVE',
    );
    expect(codeOf(() => planRepayment(FINANCING, [], D('0'), D('13')))).toBe(
      'AMOUNT_NOT_POSITIVE',
    );
    expect(codeOf(() => planRepayment(FINANCING, [], D('-5'), D('13')))).toBe(
      'AMOUNT_NOT_POSITIVE',
    );
  });

  it('three repayments at three rates — one up, one down — end at exactly zero', () => {
    const done: StandingRepayment[] = [];
    const pay = (egp: string, rate: string) => {
      const p = planRepayment(FINANCING, done, D(egp), D(rate));
      done.push(standing(p, egp));
      return p;
    };
    pay('137000', '13.7'); // 10,000.00 AED, the dirham up
    pay('125555.55', '12.5555'); // 10000.0438… → 10,000.04 AED, down
    const owedBeforeLast = owedOn(FINANCING.amount, done);
    expect(owedBeforeLast.toFixed(2)).toBe('9999.96');
    const last = pay(
      settlingEgp(owedBeforeLast, D('13.4321')).toFixed(2),
      '13.4321',
    );

    expect(last.final).toBe(true);
    expect(owedOn(FINANCING.amount, done).toFixed(2)).toBe('0.00');
    // The parts re-sum to what he paid at the order's rate, to the piastre…
    const atOrder = done.reduce((s, r) => s.add(r.clearedAtOrderRateEgp), D(0));
    expect(atOrder.toFixed(2)).toBe('390000.00');
    // …so the exchange difference is exactly pounds paid less that.
    const paid = done.reduce((s, r) => s.add(r.amountEgp), D(0));
    const diff = done.reduce((s, r) => s.add(r.exchangeDiffEgp), D(0));
    expect(diff.toFixed(2)).toBe(paid.sub('390000').toFixed(2));
  });

  it('the last repayment takes the rounding of the earlier ones at the order rate', () => {
    // An order rate whose products round: 0.3333 per unit.
    const f = {
      amount: D('100'),
      amountEgp: D('33.33'),
      orderRate: D('0.3333'),
    };
    const done: StandingRepayment[] = [];
    for (let i = 0; i < 2; i++) {
      // 33.32 of the debt each time, 11.11 at the order rate each
      const p = planRepayment(f, done, D('16.66'), D('0.5'));
      done.push(standing(p, '16.66'));
    }
    const owed = owedOn(f.amount, done);
    // 33.36 at the order rate would round to 11.12; the last takes 11.11.
    expect(owed.toFixed(2)).toBe('33.36');
    const last = planRepayment(f, done, settlingEgp(owed, D('0.5')), D('0.5'));
    done.push(standing(last, settlingEgp(owed, D('0.5'))));
    expect(owedOn(f.amount, done).toFixed(2)).toBe('0.00');
    expect(last.clearedAtOrderRateEgp.toFixed(2)).toBe('11.11');
    expect(
      done.reduce((s, r) => s.add(r.clearedAtOrderRateEgp), D(0)).toFixed(2),
    ).toBe('33.33');
  });

  it('a reversed repayment is simply not standing: the debt it cleared is owed again', () => {
    const first = planRepayment(FINANCING, [], D('130000'), D('13'));
    // Reversed: the service passes only standing repayments, so none.
    const again = planRepayment(FINANCING, [], D('390000'), D('13'));
    expect(first.cleared.toFixed(2)).toBe('10000.00');
    expect(again.final).toBe(true);
    expect(again.cleared.toFixed(2)).toBe('30000.00');
  });
});
