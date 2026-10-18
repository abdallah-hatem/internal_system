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
