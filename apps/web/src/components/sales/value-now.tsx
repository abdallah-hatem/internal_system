'use client';

import { useTranslations } from 'next-intl';
import { Money } from '@/components/ui/money';
import { useNumberFormat } from '@/lib/numbers';

/**
 * What a sale order is worth now (BUSINESS_LOGIC §4, owner 2026-10-22,
 * "Option A"): the sold total less what came back and less every price cut,
 * with what was sold under it in small muted text — only when the two differ.
 *
 * Every figure here is the API's (`common/order-value-now.ts`); nothing is
 * summed or re-priced in the browser. An order from before the API said it
 * (no `valueNowEgp`) shows its total as it always did.
 */

const cents = (v: unknown) => Math.round(Number(v ?? 0) * 100);

/** The two figures differ by at least a cent. */
function differs(now: unknown, sold: unknown) {
  return now != null && cents(now) !== cents(sold);
}

/** Small muted line under a figure: "sold at 30,300.00 EGP", "was 1,250.00". */
function Under({ testId, children }: { testId: string; children: React.ReactNode }) {
  return (
    <span data-testid={testId} className="block whitespace-nowrap text-xs font-normal text-muted-foreground">
      {children}
    </span>
  );
}

/** An order's Total: the value now, and "sold at …" beneath it when it moved. */
export function OrderTotal({
  total,
  valueNow,
  currency,
}: {
  total: number | string;
  valueNow?: number | string | null;
  currency?: string;
}) {
  const t = useTranslations('sales.valueNow');
  if (!differs(valueNow, total)) return <Money value={total} currency={currency} />;
  return (
    <span className="inline-block" title={t('nowTitle')}>
      <Money value={valueNow} currency={currency} className="block" />
      <Under testId="sold-at">{t.rich('soldAt', { amount: () => <Money value={total} currency={currency} /> })}</Under>
    </span>
  );
}

export interface LineNow {
  quantity: number | string;
  lineTotal?: number | string;
  returnedQty?: string;
  heldQty?: string;
  soldUnitPrice?: string;
  unitPriceNow?: string;
  priceCut?: boolean;
  lineValueNow?: string;
}

/** "1 returned · 3 held", under the product's name, once anything came back. */
export function LineHeldNote({ line }: { line: LineNow }) {
  const t = useTranslations('sales.valueNow');
  const { formatNumber } = useNumberFormat();
  if (!(Number(line.returnedQty ?? 0) > 0)) return null;
  return (
    <span data-testid="line-held" className="block text-xs text-muted-foreground">
      {t('held', { returned: formatNumber(line.returnedQty), held: formatNumber(line.heldQty) })}
    </span>
  );
}

/**
 * The unit price cell: as sold, or — once lowered — the price now with
 * "was …" (the price per unit it was sold at) under it.
 */
export function LineUnitPrice({ line, sold }: { line: LineNow; sold: React.ReactNode }) {
  const t = useTranslations('sales.valueNow');
  const { formatAmount } = useNumberFormat();
  if (!line.priceCut || line.unitPriceNow == null) return <>{sold}</>;
  return (
    <span className="inline-block">
      <bdi dir="ltr" data-testid="unit-price-now" className="block font-medium text-foreground">
        {formatAmount(line.unitPriceNow)}
      </bdi>
      <Under testId="unit-price-was">
        {t.rich('was', {
          amount: () => <bdi dir="ltr">{formatAmount(line.soldUnitPrice)}</bdi>,
        })}
      </Under>
    </span>
  );
}

/** The line total cell: what the line is worth now, and "sold at …" when it moved. */
export function LineTotalNow({ line, currency }: { line: LineNow; currency?: string }) {
  const t = useTranslations('sales.valueNow');
  if (!differs(line.lineValueNow, line.lineTotal)) return <Money value={line.lineTotal} currency={currency} />;
  return (
    <span className="inline-block">
      <Money value={line.lineValueNow} currency={currency} className="block" />
      <Under testId="line-sold-at">
        {t.rich('soldAt', { amount: () => <Money value={line.lineTotal} currency={currency} /> })}
      </Under>
    </span>
  );
}
