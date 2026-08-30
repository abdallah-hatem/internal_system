'use client';

import { useState } from 'react';
import { PackageSearch } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { CategoryFilter } from './category-filter';
import { PriceContext } from './price-context';
import { ProductCard, ProductCardSkeleton } from './product-card';
import { QueryError } from './query-error';
import { SearchField } from './search-field';
import { useCatalogue, useCategories } from './queries';
import { useDebounced } from './use-debounced';

/**
 * The shop window.
 *
 * Search and category live in component state rather than the URL: on a phone
 * a history entry per keystroke turns the back button into an undo key, and
 * nothing on this screen is worth linking to that a product page does not
 * already cover.
 *
 * "Load more" rather than numbered pages, for the same reason — one thumb, and
 * a page-number strip is a row of targets too small to hit.
 */
export function CatalogueList() {
  const t = useTranslations('catalogue');
  const tc = useTranslations('common');

  const [text, setText] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const search = useDebounced(text.trim(), 300);

  const catalogue = useCatalogue(search, categoryId);
  const categories = useCategories();

  const pages = catalogue.data?.pages ?? [];
  const items = pages.flatMap((page) => page.items);
  const first = pages[0];

  return (
    <div className="mx-auto w-full max-w-5xl">
      <header className="sticky top-0 z-30 border-b border-gray-200 bg-gray-50/95 px-4 pt-4 pb-3 backdrop-blur">
        <h1 className="text-xl font-bold text-gray-900">{t('title')}</h1>

        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <SearchField value={text} onChange={setText} />
          <CategoryFilter
            categories={categories.data ?? []}
            value={categoryId}
            onChange={setCategoryId}
          />
        </div>

        {first ? (
          <div className="mt-3">
            <PriceContext channel={first.channel} viewer={first.viewer} />
          </div>
        ) : null}
      </header>

      <div className="p-4">
        {catalogue.isError ? (
          <QueryError error={catalogue.error} onRetry={() => void catalogue.refetch()} />
        ) : catalogue.isPending ? (
          <>
            <span className="sr-only" role="status">
              {tc('loading')}
            </span>
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {Array.from({ length: 6 }, (_, index) => (
                <ProductCardSkeleton key={index} />
              ))}
            </ul>
          </>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-gray-300 bg-white px-6 py-12 text-center">
            <PackageSearch aria-hidden className="h-8 w-8 text-gray-300" />
            <p className="text-sm text-gray-500">{t('empty')}</p>
          </div>
        ) : (
          <>
            <p className="mb-3 text-xs text-gray-500" aria-live="polite">
              {t('showing', { shown: items.length, total: first?.total ?? items.length })}
            </p>

            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {items.map((item) => (
                <ProductCard key={item.id} item={item} />
              ))}
            </ul>

            {catalogue.hasNextPage ? (
              <button
                type="button"
                onClick={() => void catalogue.fetchNextPage()}
                disabled={catalogue.isFetchingNextPage}
                className="mt-4 flex min-h-12 w-full items-center justify-center rounded-xl border border-gray-300 bg-white px-4 text-base font-semibold text-gray-900 hover:bg-gray-50 disabled:text-gray-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
              >
                {catalogue.isFetchingNextPage ? tc('loading') : t('loadMore')}
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
