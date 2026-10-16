// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; money must not become a float
import { Prisma } from '@prisma/client';
import { badRequest } from './api-error';
import { formatMoney } from './money';

/**
 * The money of a friend's loan (BUSINESS_LOGIC §18): he paid a supplier in his
 * own currency at that day's rate (2026-10-16 — not necessarily the order's),
 * we owe him that amount in that currency, and we repay it in pounds at
 * whatever the rate is on the day.
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
 * - At the financing's own rate (the rate on the day he paid), the final
 *   repayment takes whatever keeps the parts equal to his payment at that
 *   rate, so the exchange difference over a repaid debt is exactly pounds
 *   paid − his payment's pounds (`amountEgp`).
 */

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const ZERO = D(0);

export interface FinancingTerms {
  /** What he paid, in his currency. */
  amount: Prisma.Decimal;
  /** amount × the financing's rate, half up — the ledger inflow. */
  amountEgp: Prisma.Decimal;
  /**
   * The rate on the day he paid, stored on the financing. Until 2026-10-16
   * this was always the order's, copied; now it is his own.
   */
  financingRate: Prisma.Decimal;
}

export interface StandingRepayment {
  amountEgp: Prisma.Decimal;
  cleared: Prisma.Decimal;
  /** What it cleared at the financing's rate (the column keeps its old name). */
  clearedAtOrderRateEgp: Prisma.Decimal;
  exchangeDiffEgp: Prisma.Decimal;
}

export interface PlannedRepayment {
  /** Debt cleared, in his currency. */
  cleared: Prisma.Decimal;
  /** What it cleared at the financing's rate (stored as clearedAtOrderRateEgp). */
  clearedAtOrderRateEgp: Prisma.Decimal;
  /** Pounds paid − what was cleared at the financing's rate. Positive is a cost. */
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

/** Debt valued at the financing's own rate, to the piastre. */
export function atFinancingRate(
  cleared: Prisma.Decimal.Value,
  financingRate: Prisma.Decimal.Value,
): Prisma.Decimal {
  return D(cleared)
    .mul(D(financingRate))
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
    // Pays it off: everything left is cleared, and at the financing's rate this
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
  const atOrder = atFinancingRate(cleared, financing.financingRate);
  return {
    cleared,
    clearedAtOrderRateEgp: atOrder,
    exchangeDiffEgp: pounds.sub(atOrder),
    final: false,
  };
}

// ─── What he paid, in pounds (§18, 2026-10-16) ─────────────────────────────

/**
 * An order's worth in pounds: its lines at its own rate, half up. What
 * friends' payments on it are capped at — they may pay in different
 * currencies, so pounds are the one unit that compares them.
 */
export function orderTotalEgp(
  lineTotals: readonly Prisma.Decimal.Value[],
  orderRate: Prisma.Decimal.Value,
): Prisma.Decimal {
  return lineTotals
    .reduce<Prisma.Decimal>((s, t) => s.add(D(t)), ZERO)
    .mul(D(orderRate))
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * Would this payment take what friends paid towards a cycle past the cycle's
 * cost (§18, owner 2026-10-16)? A friend who paid the supplier by card paid
 * the goods, the shipping to the UAE and the card fee in one sum, so his
 * payment may cover any of the cycle's cost — every order's goods, every leg,
 * every expense charged to it — less what friends already paid towards it.
 *
 * Compared in pounds, since friends may pay in different currencies, and
 * **exactly**, before any rounding: two friends paying 1.00 each of a 2.00
 * order at 13.8567 are 13.86 + 13.86 rounded but 27.7134 together, which is
 * the order to the last digit. Rounding each first would refuse a payment of
 * exactly what is left.
 *
 * `cost` is `CostingService.cycleCost` — the one definition of a cycle's
 * cost. The figures returned are the rounded ones people read.
 */
export function financingCap(input: {
  cost: { totalEgp: Prisma.Decimal.Value; exactEgp: Prisma.Decimal.Value };
  /** Every friend's payment standing on the cycle, this one excluded. */
  standing: readonly {
    amount: Prisma.Decimal.Value;
    rate: Prisma.Decimal.Value;
  }[];
  adding: { amount: Prisma.Decimal.Value; rate: Prisma.Decimal.Value };
}): {
  exceeds: boolean;
  costEgp: Prisma.Decimal;
  financedEgp: Prisma.Decimal;
  availableEgp: Prisma.Decimal;
  addingEgp: Prisma.Decimal;
} {
  const exact = (f: {
    amount: Prisma.Decimal.Value;
    rate: Prisma.Decimal.Value;
  }) => D(f.amount).mul(D(f.rate));
  const financedExact = input.standing.reduce<Prisma.Decimal>(
    (s, f) => s.add(exact(f)),
    ZERO,
  );
  const financedEgp = input.standing.reduce<Prisma.Decimal>(
    (s, f) => s.add(financingAmountEgp(f.amount, f.rate)),
    ZERO,
  );
  return {
    exceeds: financedExact.add(exact(input.adding)).gt(D(input.cost.exactEgp)),
    costEgp: D(input.cost.totalEgp),
    financedEgp,
    availableEgp: availableToFinanceEgp(input.cost.totalEgp, financedEgp),
    addingEgp: financingAmountEgp(input.adding.amount, input.adding.rate),
  };
}

/**
 * What friends may still pay towards a cycle, in pounds: its cost less what
 * they already paid, never below zero — a leg corrected down or an expense
 * reversed after he paid leaves nothing more to pay, not a negative.
 */
export function availableToFinanceEgp(
  costEgp: Prisma.Decimal.Value,
  financedEgp: Prisma.Decimal.Value,
): Prisma.Decimal {
  return Prisma.Decimal.max(D(costEgp).sub(D(financedEgp)), ZERO);
}

/** What he paid, in pounds at his rate: amount × rate, half up. */
export function financingAmountEgp(
  amount: Prisma.Decimal.Value,
  rate: Prisma.Decimal.Value,
): Prisma.Decimal {
  return D(amount)
    .mul(D(rate))
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * The currency and rate a friend's payment is recorded at.
 *
 * - Neither said: the order's currency at the order's rate — how it was
 *   before 2026-10-16.
 * - EGP: rate 1; any other rate is BASE_CURRENCY_RATE_FIXED.
 * - A rate said: that rate, the one on the day he paid.
 * - The order's currency with no rate: the order's rate.
 * - Another currency with no rate: FINANCING_RATE_REQUIRED — a rate on the
 *   exchange-rate page is today's, not the day he paid, so it only prefills.
 *
 * Whether a currency other than EGP and the order's is one the business keeps
 * a rate for is the caller's to check: it needs the database.
 */
export function financingTerms(input: {
  currency?: string;
  rate?: Prisma.Decimal;
  orderCurrency: string;
  orderRate: Prisma.Decimal.Value;
  orderReference: string;
}): { currency: string; rate: Prisma.Decimal } {
  const currency = input.currency ?? input.orderCurrency;
  if (currency === 'EGP') {
    if (input.rate && !input.rate.eq(1)) {
      throw badRequest(
        'BASE_CURRENCY_RATE_FIXED',
        'EGP is the base currency — its rate is 1 by definition and cannot be changed.',
        { currency: 'EGP' },
      );
    }
    return { currency, rate: D(1) };
  }
  if (input.rate) return { currency, rate: input.rate };
  if (currency === input.orderCurrency) {
    return { currency, rate: D(input.orderRate) };
  }
  throw badRequest(
    'FINANCING_RATE_REQUIRED',
    `He paid in ${currency}, which is not ${input.orderReference}'s currency: say what ${currency} was worth in pounds on the day he paid.`,
    { currency, reference: input.orderReference },
  );
}
