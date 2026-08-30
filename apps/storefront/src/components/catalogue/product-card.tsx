'use client';

import { useLocale, useTranslations } from 'next-intl';

import { Link } from '../../i18n/navigation';
import { Money } from '../ui/money';
import { StockBadge } from '../ui/stock-badge';
import { ProductImage } from './product-image';
import type { CatalogueItem } from './types';

/**
 * One product in the grid.
 *
 * The whole card is the link — a thumb on a phone is not aiming at a title.
 * The price is whatever string the API sent, rendered through `Money`; a
 * product with no price on this viewer's channel says so, because a blank
 * where a figure belongs reads as free and "0" reads as free out loud.
 */
export function ProductCard({ item }: { item: CatalogueItem }) {
  const t = useTranslations('catalogue');
  const locale = useLocale();

  return (
    <li className="flex">
      <Link
        href={`/p/${encodeURIComponent(item.sku)}`}
        data-sku={item.sku}
        className="flex flex-1 flex-col overflow-hidden rounded-xl border border-gray-200 bg-white text-start shadow-sm transition-shadow hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
      >
        <ProductImage src={item.image} alt={item.name} className="aspect-square w-full" />

        <div className="flex flex-1 flex-col gap-1 p-3">
          {item.category ? (
            <p className="truncate text-xs text-gray-500">{item.category.name}</p>
          ) : null}

          <h3 className="line-clamp-2 text-sm leading-snug font-semibold text-gray-900">
            {item.name}
          </h3>

          <div className="mt-auto flex flex-wrap items-center justify-between gap-x-2 gap-y-1 pt-2">
            {item.price === null ? (
              <span className="text-sm text-gray-500">{t('noPrice')}</span>
            ) : (
              <Money
                amount={item.price}
                locale={locale}
                className="text-base font-bold text-gray-900"
              />
            )}
            <StockBadge stock={item.stock} />
          </div>
        </div>
      </Link>
    </li>
  );
}

/** A card-shaped hole, so the grid does not jump when the answer arrives. */
export function ProductCardSkeleton() {
  return (
    <li
      aria-hidden
      className="flex animate-pulse flex-col overflow-hidden rounded-xl border border-gray-200 bg-white"
    >
      <div className="aspect-square w-full bg-gray-100" />
      <div className="flex flex-col gap-2 p-3">
        <div className="h-3 w-1/3 rounded bg-gray-100" />
        <div className="h-4 w-4/5 rounded bg-gray-100" />
        <div className="h-4 w-1/2 rounded bg-gray-100" />
      </div>
    </li>
  );
}
