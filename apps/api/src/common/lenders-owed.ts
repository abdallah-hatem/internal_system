// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; money must not become a float
import { Prisma } from '@prisma/client';
import { owedOn } from './lender-math';
import { STANDING_FINANCING, STANDING_REPAYMENT } from './lender-debt';

/**
 * What the business owes friends, for the dashboard (BUSINESS_LOGIC §18): in
 * each friend's currency — the debt itself — and in pounds at today's rate,
 * which is what repaying it all today would cost.
 *
 * Today's rate is the one on the exchange-rate page (`CurrencyRate`), the same
 * one the repayment form prefills. A currency with no rate there is shown
 * without pounds and `missingRate` says so, rather than counting it as zero.
 */
export async function owedToLenders(
  db: Pick<Prisma.TransactionClient, 'lenderFinancing' | 'currencyRate'>,
) {
  const financings = await db.lenderFinancing.findMany({
    where: STANDING_FINANCING,
    select: {
      currency: true,
      amount: true,
      repayments: { where: STANDING_REPAYMENT, select: { cleared: true } },
    },
  });
  const byCurrency = new Map<string, Prisma.Decimal>();
  for (const f of financings) {
    const owed = owedOn(f.amount, f.repayments);
    if (owed.lte(0)) continue;
    byCurrency.set(
      f.currency,
      (byCurrency.get(f.currency) ?? new Prisma.Decimal(0)).add(owed),
    );
  }
  if (byCurrency.size === 0) {
    return { lines: [], totalEgp: '0.00', missingRate: false };
  }
  const rates = await db.currencyRate.findMany({
    where: { code: { in: [...byCurrency.keys()] } },
  });
  let totalEgp = new Prisma.Decimal(0);
  let missingRate = false;
  const lines = [...byCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, owed]) => {
      const rate =
        currency === 'EGP'
          ? new Prisma.Decimal(1)
          : (rates.find((r) => r.code === currency)?.rateToEgp ?? null);
      const owedEgp =
        rate === null
          ? null
          : owed.mul(rate).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      if (owedEgp === null) missingRate = true;
      else totalEgp = totalEgp.add(owedEgp);
      return {
        currency,
        owed: owed.toFixed(2),
        rateToEgp: rate === null ? null : new Prisma.Decimal(rate).toFixed(4),
        owedEgp: owedEgp === null ? null : owedEgp.toFixed(2),
      };
    });
  return { lines, totalEgp: totalEgp.toFixed(2), missingRate };
}
