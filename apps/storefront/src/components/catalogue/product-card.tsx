'use client';

import { useLocale, useTranslations } from 'next-intl';

import { Link } from '../../i18n/navigation';
import { Money } from '../ui/money';
import { StockBadge } from '../ui/stock-badge';
import { Skeleton, SkeletonText } from '../ui/skeleton';
import { ProductImage } from './product-image';
import { localName } from '../../lib/localized-name';
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
  const name = localName(item, locale);

  return (
    <li className="flex">
      <Link
        href={`/p/${encodeURIComponent(item.sku)}`}
        data-sku={item.sku}
        className="flex flex-1 flex-col overflow-hidden rounded-xl border border-gray-200 bg-white text-start shadow-sm transition-shadow hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
      >
        <ProductImage src={item.image} alt={name} className="aspect-square w-full" />

        <div className="flex flex-1 flex-col gap-1 p-3">
          {item.category ? (
            <p className="truncate text-xs text-gray-500">{localName(item.category, locale)}</p>
          ) : null}

          <h3 className="line-clamp-2 text-sm leading-snug font-semibold text-gray-900">
            {name}
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

/**
 * The card before it arrives, traced from `ProductCard` above: the same square
 * image, the category line, a two-line name in the name's own line height, and
 * the price beside the stock badge pinned to the bottom. Tokens rather than
 * palette colours (`bg-background` is the card's white, `border-border` its
 * grey-200).
 */
export function ProductCardSkeleton() {
  return (
    <li data-testid="skeleton-row" className="flex">
      <div className="flex flex-1 flex-col overflow-hidden rounded-xl border border-border bg-background text-start shadow-sm">
        <Skeleton className="aspect-square w-full rounded-none" />

        <div className="flex flex-1 flex-col gap-1 p-3">
          <SkeletonText size="xs" className="w-1/3" />

          <div className="text-sm leading-snug">
            <SkeletonText lineClassName="h-[1lh]" className="w-full" />
            {/* A part's name usually runs to two lines in a phone's two columns, one in the wider grids. */}
            <SkeletonText lineClassName="h-[1lh] sm:hidden" className="w-2/3" />
          </div>

          <div className="mt-auto flex flex-wrap items-center justify-between gap-x-2 gap-y-1 pt-2">
            <SkeletonText size="base" className="w-20" />
            <Skeleton className="h-5 w-14 rounded-full" />
          </div>
        </div>
      </div>
    </li>
  );
}
