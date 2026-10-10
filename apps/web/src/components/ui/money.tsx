'use client';

import { useLocale } from 'next-intl';
import { DEFAULT_CURRENCY, formatMoney } from '@/lib/numbers';

/**
 * Render a monetary amount so it stays readable in both writing directions.
 *
 * Arabic pages are RTL, and the bidi algorithm will push a leading minus sign
 * to the far side of the digits — "-2,395.69" displays as "2,395.69-", which
 * reads as a positive number at a glance. Money is always a left-to-right run,
 * so isolate it explicitly.
 *
 * Digits are Latin in both languages and the currency always follows the
 * number ("-529.23 EGP"); `formatMoney` in `lib/numbers.ts` owns both choices.
 */
export function Money({
  value,
  currency = DEFAULT_CURRENCY,
  className,
}: {
  value: number | string | null | undefined;
  currency?: string;
  className?: string;
}) {
  const locale = useLocale();
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return <span className={className}>—</span>;

  return (
    <span className={className} dir="ltr" style={{ unicodeBidi: 'isolate' }} data-slot="money">
      {formatMoney(n, { locale, currency })}
    </span>
  );
}
