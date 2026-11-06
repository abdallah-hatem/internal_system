'use client';

import { useLocale, useTranslations } from 'next-intl';
import { formatMoney } from '@/lib/numbers';
import { cn } from '@/lib/utils';

/**
 * The exchange difference on repaying a friend who paid a supplier (§18), as a
 * loss or a gain — never a neutral "Exchange difference" (owner 2026-11-06:
 * "this needs to show that it's a loss").
 *
 * The API's sign, the one convention (`exchangeDiffEgp`,
 * `exchangeDifferenceEgp`): above zero, more pounds were paid than the debt was
 * worth at the order's rate — the rate rose, a LOSS taken off profit; below
 * zero, fewer — a GAIN. Every screen that shows the figure reads it here.
 */
export type ExchangeResult = 'loss' | 'gain' | 'none';

export function exchangeResult(diffEgp: number | string | null | undefined): ExchangeResult {
  const n = Number(diffEgp ?? 0);
  if (!Number.isFinite(n) || n === 0) return 'none';
  return n > 0 ? 'loss' : 'gain';
}

/** Red for a loss, green for a gain: the money tokens, no new colours. */
export const EXCHANGE_TONE: Record<ExchangeResult, string> = {
  loss: 'text-destructive',
  gain: 'text-success',
  none: 'text-foreground',
};

/**
 * The figure as it moves profit: a loss "−3,183.74 EGP" in red, a gain
 * "+1,200.00 EGP" in green. One left-to-right run, so in Arabic the sign stays
 * in front of the digits (as `Money` does).
 */
export function ExchangeAmount({
  diffEgp,
  className,
  testId,
}: {
  diffEgp: number | string | null | undefined;
  className?: string;
  testId?: string;
}) {
  const locale = useLocale();
  const n = Number(diffEgp ?? 0);
  const result = exchangeResult(n);
  const abs = Math.abs(Number.isFinite(n) ? n : 0);
  const text = formatMoney(abs, { locale, currency: 'EGP' });
  return (
    <span
      data-slot="money"
      data-testid={testId}
      data-result={result}
      dir="ltr"
      style={{ unicodeBidi: 'isolate' }}
      className={cn('tabular-nums', EXCHANGE_TONE[result], className)}
    >
      {result === 'loss' ? '−' : result === 'gain' ? '+' : ''}
      {text}
    </span>
  );
}

/** "Exchange-rate loss" / "Exchange-rate gain", and the line under it saying why. */
export function useExchangeWords(diffEgp: number | string | null | undefined) {
  const t = useTranslations('exchangeResult');
  const result = exchangeResult(diffEgp);
  return {
    result,
    label: result === 'gain' ? t('gain') : result === 'loss' ? t('loss') : t('label'),
    hint: result === 'gain' ? t('gainHint') : result === 'loss' ? t('lossHint') : null,
  };
}

/**
 * One line of an account — Analytics' "How it adds up", a bar's breakdown, a
 * settlement's cycle lines: the label that says loss or gain, its hint under
 * it, muted, and the signed figure in red or green. Hidden at zero, as the
 * line always was.
 *
 * `operator` keeps the account's column of − / + / = in line: the figure here
 * carries its own sign, so the column is left empty rather than put a second
 * minus in front of a negative number.
 */
export function ExchangeAccountLine({
  diffEgp,
  operatorColumn = true,
  labelClassName = 'text-foreground',
  amountForTotal,
}: {
  diffEgp: number;
  /** The account has a − / + / = column before its labels. */
  operatorColumn?: boolean;
  labelClassName?: string;
  /** Signed as it moves the total (`data-amount`), for a list that adds its lines up. */
  amountForTotal?: number;
}) {
  const { result, label, hint } = useExchangeWords(diffEgp);
  if (result === 'none') return null;
  return (
    <div
      data-line="exchange"
      data-result={result}
      data-amount={amountForTotal}
      data-testid="exchange-line"
      className="flex items-baseline justify-between gap-3 py-1"
    >
      <dt className={cn('flex min-w-0 items-baseline gap-2', labelClassName)}>
        {operatorColumn && <span aria-hidden="true" className="w-3 shrink-0" />}
        <span className="min-w-0">
          <span data-label data-testid="exchange-line-label" className={cn('font-medium', EXCHANGE_TONE[result])}>
            {label}
          </span>
          <span data-testid="exchange-line-hint" className="block text-xs font-normal text-muted-foreground">
            {hint}
          </span>
        </span>
      </dt>
      <dd className="shrink-0 whitespace-nowrap">
        <ExchangeAmount diffEgp={diffEgp} testId="exchange-line-amount" className="font-medium" />
      </dd>
    </div>
  );
}
