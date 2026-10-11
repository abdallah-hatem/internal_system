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
  return inPoundsToday(
    db,
    [...byCurrency.entries()].map(([currency, owed]) => ({ currency, owed })),
  );
}

/**
 * Today's rate for each currency: the one on the exchange-rate page, which the
 * repayment form and the assistant's repayment prefill. EGP is 1; a currency
 * with no rate there is absent, never zero.
 */
export async function ratesToday(
  db: Pick<Prisma.TransactionClient, 'currencyRate'>,
  codes: readonly string[],
): Promise<Map<string, Prisma.Decimal>> {
  const rows = codes.some((c) => c !== 'EGP')
    ? await db.currencyRate.findMany({
        where: { code: { in: codes.filter((c) => c !== 'EGP') } },
      })
    : [];
  const out = new Map<string, Prisma.Decimal>();
  if (codes.includes('EGP')) out.set('EGP', new Prisma.Decimal(1));
  for (const r of rows) {
    if (r.rateToEgp !== null) out.set(r.code, new Prisma.Decimal(r.rateToEgp));
  }
  return out;
}

/**
 * Debts in their own currencies, each also in pounds at today's rate — the
 * dashboard's "owed to lenders" and the assistant's list_lenders and
 * get_lender read this one definition (CLAUDE.md rule 11).
 */
export async function inPoundsToday(
  db: Pick<Prisma.TransactionClient, 'currencyRate'>,
  owed: readonly { currency: string; owed: Prisma.Decimal.Value }[],
) {
  const rates = await ratesToday(
    db,
    owed.map((o) => o.currency),
  );
  let totalEgp = new Prisma.Decimal(0);
  let missingRate = false;
  const lines = owed
    .slice()
    .sort((a, b) => a.currency.localeCompare(b.currency))
    .map(({ currency, owed: amount }) => {
      const debt = new Prisma.Decimal(amount);
      const rate = rates.get(currency) ?? null;
      const owedEgp =
        rate === null
          ? null
          : debt.mul(rate).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      if (owedEgp === null) missingRate = true;
      else totalEgp = totalEgp.add(owedEgp);
      return {
        currency,
        owed: debt.toFixed(2),
        rateToEgp: rate === null ? null : rate.toFixed(4),
        owedEgp: owedEgp === null ? null : owedEgp.toFixed(2),
      };
    });
  return { lines, totalEgp: totalEgp.toFixed(2), missingRate };
}
