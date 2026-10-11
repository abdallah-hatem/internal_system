// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; money must not become a float
import { Prisma } from '@prisma/client';
import { badRequest } from './api-error';
import { formatMoney } from './money';

/**
 * The money of a friend's loan (BUSINESS_LOGIC §18): he paid a supplier in the
 * order's currency, we owe him that amount in that currency, and we repay it
 * in pounds at whatever the rate is on the day.
 *
 * Pure — no Nest, no Prisma client — so every branch is unit-tested
 * (`lender-math.spec.ts`) and the service, the quote endpoint and the checks
 * all read the same arithmetic (CLAUDE.md rule 11).
 *
 * The rules, each a guess recorded in §18:
 * - A part repayment clears pounds ÷ rate **rounded down** to the piastre of
 *   his currency, so it never clears more than the pounds bought.
 * - The settling amount — what is owed × the rate, half up — clears exactly
 *   what is owed. Rounding down leaves at most 0.01 per part payment, and the
 *   settling amount includes it, so the debt always ends at exactly zero.
 * - More than the settling amount is refused (rule 1: too much).
 * - At the order's rate, the final repayment takes whatever keeps the parts
 *   equal to his payment at that rate, so the exchange difference over a repaid
 *   debt is exactly pounds paid − his amount at the order's rate.
 */

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const ZERO = D(0);

export interface FinancingTerms {
  /** What he paid, in the order's currency. */
  amount: Prisma.Decimal;
  /** amount × the order's rate, half up — the ledger inflow. */
  amountEgp: Prisma.Decimal;
  /** The order's rate. */
  orderRate: Prisma.Decimal;
}

export interface StandingRepayment {
  amountEgp: Prisma.Decimal;
  cleared: Prisma.Decimal;
  clearedAtOrderRateEgp: Prisma.Decimal;
  exchangeDiffEgp: Prisma.Decimal;
}

export interface PlannedRepayment {
  /** Debt cleared, in his currency. */
  cleared: Prisma.Decimal;
  clearedAtOrderRateEgp: Prisma.Decimal;
  /** Pounds paid − what was cleared at the order's rate. Positive is a cost. */
  exchangeDiffEgp: Prisma.Decimal;
  /** True when this repayment pays the debt off. */
  final: boolean;
}

/** What is still owed, in his currency: the amount less standing repayments. */
export function owedOn(
  amount: Prisma.Decimal.Value,
  standing: readonly { cleared: Prisma.Decimal.Value }[],
): Prisma.Decimal {
  return standing.reduce((s, r) => s.sub(D(r.cleared)), D(amount));
}

/** The pounds that pay off `owed` at `rate`: owed × rate, half up. */
export function settlingEgp(
  owed: Prisma.Decimal.Value,
  rate: Prisma.Decimal.Value,
): Prisma.Decimal {
  return D(owed).mul(D(rate)).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/** Debt valued at the order's rate, to the piastre. */
export function atOrderRate(
  cleared: Prisma.Decimal.Value,
  orderRate: Prisma.Decimal.Value,
): Prisma.Decimal {
  return D(cleared)
    .mul(D(orderRate))
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * Work out what `egp` pounds at `rate` does to the debt, or refuse it.
 *
 * `standing` is every repayment on this financing that has not been reversed —
 * a reversed one cleared nothing, so the caller leaves it out.
 */
export function planRepayment(
  financing: FinancingTerms,
  standing: readonly StandingRepayment[],
  egp: Prisma.Decimal.Value,
  rate: Prisma.Decimal.Value,
): PlannedRepayment {
  const pounds = D(egp);
  const r = D(rate);
  if (!r.isFinite() || r.lte(0)) {
    throw badRequest(
      'RATE_NOT_POSITIVE',
      'An exchange rate must be greater than zero.',
    );
  }
  if (!pounds.isFinite() || pounds.lte(0)) {
    throw badRequest(
      'AMOUNT_NOT_POSITIVE',
      'The amount must be greater than zero.',
    );
  }

  const owed = owedOn(financing.amount, standing);
  const settling = settlingEgp(owed, r);
  if (owed.lte(0) || pounds.gt(settling)) {
    throw badRequest(
      'LENDER_REPAYMENT_EXCEEDS_OWED',
      `${formatMoney(pounds)} EGP is more than is owed: ${formatMoney(owed)} is left, ` +
        `which ${formatMoney(settling)} EGP pays off at ${r.toString()}.`,
      {
        amount: formatMoney(pounds),
        owed: formatMoney(Prisma.Decimal.max(owed, ZERO)),
        settling: formatMoney(Prisma.Decimal.max(settling, ZERO)),
        rate: r.toString(),
      },
    );
  }

  if (pounds.eq(settling)) {
    // Pays it off: everything left is cleared, and at the order's rate this
    // takes whatever keeps the parts equal to what he paid (§2's residual).
    const before = standing.reduce(
      (s, x) => s.add(D(x.clearedAtOrderRateEgp)),
      ZERO,
    );
    const atOrder = D(financing.amountEgp).sub(before);
    return {
      cleared: owed,
      clearedAtOrderRateEgp: atOrder,
      exchangeDiffEgp: pounds.sub(atOrder),
      final: true,
    };
  }

  const cleared = pounds.div(r).toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
  if (cleared.lte(0)) {
    throw badRequest(
      'LENDER_REPAYMENT_CLEARS_NOTHING',
      `${formatMoney(pounds)} EGP at ${r.toString()} clears nothing of the debt.`,
      { amount: formatMoney(pounds), rate: r.toString() },
    );
  }
  const atOrder = atOrderRate(cleared, financing.orderRate);
  return {
    cleared,
    clearedAtOrderRateEgp: atOrder,
    exchangeDiffEgp: pounds.sub(atOrder),
    final: false,
  };
}
