'use client';

import { Info } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Link } from '../../i18n/navigation';
import type { CataloguePage } from './types';

/**
 * Whose prices these are.
 *
 * The server has already decided the tier and says so in `channel`; this only
 * reads it back. A shop that cannot tell trade from retail on the screen has
 * to guess, and the guess ends up in a quote to their own customer.
 *
 * The three states the API can describe:
 *   no viewer          → these are retail, and signing in may change them
 *   a viewer on B2B    → these are that shop's trade prices
 *   a viewer on B2C    → retail, and if unverified, here is why
 */
export function PriceContext({
  channel,
  viewer,
}: {
  channel: CataloguePage['channel'];
  viewer: CataloguePage['viewer'];
}) {
  const t = useTranslations('catalogue');
  // The API already words the review state, in both languages. Saying it a
  // second time here is how the two sentences drift apart.
  const tErrors = useTranslations('errors');

  if (channel === 'B2B') {
    return (
      <p className="text-sm font-medium text-brand-700" data-price-context="trade">
        {t('tradePrices')}
      </p>
    );
  }

  if (!viewer) {
    return (
      <p className="text-sm text-gray-500" data-price-context="anonymous">
        <Link
          href="/account"
          className="rounded underline underline-offset-2 hover:text-gray-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
        >
          {t('signInForTrade')}
        </Link>
      </p>
    );
  }

  if (!viewer.verified) {
    return (
      <p
        className="flex items-start gap-2 text-sm text-amber-800"
        data-price-context="unverified"
      >
        <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          {tErrors('SHOP_NOT_VERIFIED')} {t('retailPrices')}
        </span>
      </p>
    );
  }

  return (
    <p className="text-sm text-gray-500" data-price-context="retail">
      {t('retailPrices')}
    </p>
  );
}
