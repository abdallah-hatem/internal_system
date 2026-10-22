'use client';

import { useTranslations } from 'next-intl';
import { AlertTriangle } from '@/components/ui/icons';
import { useNumberFormat } from '@/lib/numbers';
import type { PriceCheckLine, PriceCheckResult } from '@/lib/price-check';

/**
 * How a below-cost warning is said (BUSINESS_LOGIC §4, 2026-10-11).
 *
 * The API names it with a code (`BELOW_COST`) and the figures; the sentence is
 * written here, under `priceCheck`, in the reader's language (rule 9). It
 * wears the house warning — the amber `accent` tokens `SettlementWarnings`
 * uses — because a refusal is red and this is not one: the button beside it
 * still works. Each amount is its own left-to-right run, so an Arabic
 * sentence never reorders "2,616.67 EGP".
 */

const WARNING =
  'flex items-start gap-1.5 rounded-lg border border-accent-200 bg-accent-50 px-2.5 py-1.5 text-accent-800';

/** An amount for a sentence: grouped, two places, the currency after, isolated LTR. */
function useMoneyText() {
  const { formatMoney } = useNumberFormat();
  // The space before the currency is a no-break one: a narrow line in Arabic
  // broke "950.00 EGP" across two lines (seen at 390px, L4 audit).
  return (value: string | number | null | undefined) =>
    `\u2066${formatMoney(value ?? 0).replace(/ /g, '\u00a0')}\u2069`;
}

/** Under one line of a sale: what each costs, what it sells at, what the line loses. */
export function BelowCostLine({ check }: { check: PriceCheckLine | undefined }) {
  const t = useTranslations('priceCheck');
  const money = useMoneyText();
  if (!check?.belowCost) return null;
  return (
    <p role="status" data-testid="below-cost-line" className={`mt-2 text-xs ${WARNING}`}>
      <AlertTriangle aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0">
        {t.has(check.code ?? '')
          ? t(check.code as 'BELOW_COST', {
              cost: money(check.unitCostEgp),
              price: money(check.unitPriceEgp),
              loss: money(check.lossEgp),
            })
          : t('unknown')}
      </span>
    </p>
  );
}

/** Under an order's total: what every line below cost loses together. */
export function BelowCostTotal({ result, className = '' }: { result: PriceCheckResult | undefined; className?: string }) {
  const t = useTranslations('priceCheck');
  const money = useMoneyText();
  if (!result || result.belowCostLines === 0) return null;
  return (
    <p role="status" data-testid="below-cost-total" className={`text-sm ${WARNING} ${className}`}>
      <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="min-w-0">{t('BELOW_COST_TOTAL', { loss: money(result.totalLossEgp) })}</span>
    </p>
  );
}

/**
 * Before a draft is confirmed: every line below cost by name, the total, and
 * that Confirm still goes ahead.
 */
export function BelowCostSummary({
  result,
  names,
}: {
  result: PriceCheckResult | undefined;
  /** The product name per line, in the order the lines were checked. */
  names: string[];
}) {
  const t = useTranslations('priceCheck');
  const money = useMoneyText();
  if (!result || result.belowCostLines === 0) return null;
  return (
    <div role="status" data-testid="below-cost-summary" className="rounded-lg border border-accent-200 bg-accent-50 px-3 py-2 text-sm text-accent-800">
      <p className="flex items-center gap-1.5 font-medium">
        <AlertTriangle aria-hidden className="h-4 w-4 shrink-0" />
        {t('summaryTitle')}
      </p>
      <ul className="mt-1 space-y-0.5 ps-5 text-xs">
        {result.lines.map((line, i) =>
          line.belowCost ? (
            <li key={i} data-testid="below-cost-summary-line">
              {t('lineNamed', {
                // A Latin name in an Arabic sentence is its own run, so the colon after it stays after it.
                product: `\u2068${names[i] ?? ''}\u2069`,
                cost: money(line.unitCostEgp),
                price: money(line.unitPriceEgp),
                loss: money(line.lossEgp),
              })}
            </li>
          ) : null,
        )}
      </ul>
      <p className="mt-1 ps-5 font-medium">{t('BELOW_COST_TOTAL', { loss: money(result.totalLossEgp) })}</p>
      <p className="mt-0.5 ps-5 text-xs">{t('confirmHint')}</p>
    </div>
  );
}

/**
 * Beside a product's selling price: against the cost of the oldest batch on
 * the shelf, which is what the next unit sold at this price would draw.
 */
export function BelowCostPrice({ check }: { check: PriceCheckLine | undefined }) {
  const t = useTranslations('priceCheck');
  const money = useMoneyText();
  if (!check?.belowCost) return null;
  return (
    <p role="status" data-testid="below-cost-price" className={`mt-2 text-xs ${WARNING}`}>
      <AlertTriangle aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0">
        {t('BELOW_COST_PRICE', { cost: money(check.unitCostEgp), loss: money(check.lossEgp) })}
      </span>
    </p>
  );
}
