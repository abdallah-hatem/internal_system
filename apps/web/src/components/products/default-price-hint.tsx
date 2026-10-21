'use client';

import { useTranslations } from 'next-intl';
import type { ListPrice } from '@/lib/list-price';

/**
 * "Default (landed + 20%)" under a price nobody set (BUSINESS_LOGIC §3,
 * 2026-10-18). Nothing for a set price: that is the owner's figure and needs
 * no explaining. The percentage is the one the API worked it out with.
 */
export function DefaultPriceHint({
  price,
  className = 'block text-[11px] font-normal text-muted-foreground',
}: {
  price: ListPrice | null | undefined;
  className?: string;
}) {
  const t = useTranslations('products');
  if (price?.source !== 'DEFAULT') return null;
  return (
    <span data-testid="default-price-hint" className={className}>
      {t('defaultPriceHint', { pct: price.markupPct ?? 0 })}
    </span>
  );
}

/**
 * The same, as a small tag beside the price on one line, the full wording on
 * hover (owner 2026-10-21: in the Products list a two-line price made those rows
 * taller than the rest). Nothing for a set price.
 */
export function DefaultPriceTag({ price }: { price: ListPrice | null | undefined }) {
  const t = useTranslations('products');
  if (price?.source !== 'DEFAULT') return null;
  const full = t('defaultPriceHint', { pct: price.markupPct ?? 0 });
  return (
    <span
      data-testid="default-price-hint"
      title={full}
      aria-label={full}
      className="inline-flex shrink-0 items-center rounded bg-muted px-1.5 py-px text-[10px] font-medium leading-4 text-muted-foreground"
    >
      {t('defaultPriceTag')}
    </span>
  );
}
