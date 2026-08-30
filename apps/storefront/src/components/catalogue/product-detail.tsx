'use client';

import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { notFound } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';

import { Link } from '../../i18n/navigation';
import { Money } from '../ui/money';
import { StockBadge } from '../ui/stock-badge';
import { ProductImage } from './product-image';
import { QueryError } from './query-error';
import { isNotFound, useProduct } from './queries';
import { useBasket } from '../../stores/basket';

/**
 * One product, in full.
 *
 * Fetched in the browser rather than on the server because the price depends
 * on who is holding the phone, and the token that says so is in
 * `localStorage`. That puts the 404 in the browser too: `notFound()` throws
 * the same fallback from a client render as from a server one, so a withdrawn
 * SKU reaches the 404 page rather than an empty product page.
 */
export function ProductDetail({ sku }: { sku: string }) {
  const t = useTranslations('catalogue');
  const tc = useTranslations('common');
  const locale = useLocale();
  const [active, setActive] = useState(0);

  const { data, error, isError, isPending, refetch } = useProduct(sku);
  const addToBasket = useBasket((s) => s.add);
  const [added, setAdded] = useState(false);

  // Every hook above this line, always: `notFound()` throws.
  if (isError && isNotFound(error)) notFound();

  const back = (
    <Link
      href="/"
      className="inline-flex min-h-11 items-center gap-2 rounded-lg text-sm font-medium text-gray-600 hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
    >
      <ArrowLeft aria-hidden className="h-4 w-4 rtl:-scale-x-100" />
      {tc('back')}
    </Link>
  );

  if (isError) {
    return (
      <div className="mx-auto w-full max-w-3xl p-4">
        {back}
        <div className="mt-4">
          <QueryError error={error} onRetry={() => void refetch()} />
        </div>
      </div>
    );
  }

  if (isPending) {
    return (
      <div className="mx-auto w-full max-w-3xl p-4">
        {back}
        <span className="sr-only" role="status">
          {tc('loading')}
        </span>
        <div aria-hidden className="mt-4 animate-pulse space-y-4">
          <div className="aspect-square w-full rounded-xl bg-gray-100 sm:aspect-16/10" />
          <div className="h-6 w-2/3 rounded bg-gray-100" />
          <div className="h-5 w-1/3 rounded bg-gray-100" />
          <div className="h-20 w-full rounded bg-gray-100" />
        </div>
      </div>
    );
  }

  const images = data.images;
  const index = Math.min(active, Math.max(images.length - 1, 0));
  const outOfStock = data.stock === 'OUT';
  // An unpriced product cannot be asked for either: a request line carries a
  // price snapshot, and `PRODUCT_NOT_PRICED` is what the API answers if one is
  // missing. Letting it into the basket would build a request that cannot be
  // sent, and the shop would find that out at the end rather than here.
  const unpriced = data.price === null;

  return (
    <div className="mx-auto w-full max-w-3xl p-4">
      {back}

      <article className="mt-4 grid gap-6 sm:grid-cols-2">
        <div>
          <ProductImage
            src={images[index] ?? null}
            alt={data.name}
            priority
            className="aspect-square w-full rounded-xl"
          />

          {images.length > 1 ? (
            <ul className="mt-2 flex flex-wrap gap-2">
              {images.map((image, position) => (
                <li key={image}>
                  <button
                    type="button"
                    onClick={() => setActive(position)}
                    aria-pressed={position === index}
                    aria-label={`${data.name} ${position + 1}`}
                    className={`block overflow-hidden rounded-lg border-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 ${
                      position === index ? 'border-brand-600' : 'border-transparent'
                    }`}
                  >
                    <ProductImage src={image} alt="" className="h-16 w-16" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <div className="flex flex-col gap-3 text-start">
          {data.category ? <p className="text-sm text-gray-500">{data.category.name}</p> : null}

          <h1 className="text-xl font-bold text-gray-900">{data.name}</h1>

          <p className="text-xs text-gray-400">{t('sku', { sku: data.sku })}</p>

          <div className="flex flex-wrap items-center gap-3">
            {data.price === null ? (
              <span className="text-base text-gray-500">{t('noPrice')}</span>
            ) : (
              <Money
                amount={data.price}
                locale={locale}
                className="text-2xl font-bold text-gray-900"
              />
            )}
            <StockBadge stock={data.stock} />
          </div>

          {data.channel === 'B2B' ? (
            <p className="text-sm font-medium text-brand-700">{t('tradePrices')}</p>
          ) : null}

          {data.description ? (
            <p className="text-sm leading-relaxed whitespace-pre-line text-gray-700">
              {data.description}
            </p>
          ) : null}

          {data.fitsModels.length > 0 ? (
            <section className="mt-1">
              <h2 className="text-sm font-semibold text-gray-900">{t('fits')}</h2>
              <ul className="mt-2 flex flex-wrap gap-2">
                {data.fitsModels.map((model) => (
                  <li
                    key={model}
                    className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-700"
                  >
                    {model}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <button
            type="button"
            disabled={outOfStock || unpriced}
            onClick={() => {
              if (outOfStock || unpriced) return;
              // The price travels with the line, and the store refreshes it on
              // every add — so a basket left for a week quotes today's figure
              // rather than the one it was built with. It is still only an
              // estimate: the server resolves the price again when the request
              // is placed, and that is the number that becomes the order.
              addToBasket({
                productId: data.id,
                name: data.name,
                sku: data.sku,
                unitPrice: data.price!,
              });
              setAdded(true);
            }}
            className="mt-2 flex min-h-12 w-full items-center justify-center rounded-xl bg-brand-700 px-4 text-base font-semibold text-white hover:bg-brand-600 disabled:bg-gray-200 disabled:text-gray-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
          >
            {added ? t('addedToRequest') : t('addToRequest')}
          </button>

          {unpriced && !outOfStock ? (
            <p className="mt-2 text-center text-sm text-gray-500">{t('askUsForAPrice')}</p>
          ) : null}
        </div>
      </article>
    </div>
  );
}
