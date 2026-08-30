'use client';

import { ChevronLeft, ChevronRight, CircleAlert, LoaderCircle, Package } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { Link } from '../../i18n/navigation';
import { useSession } from '../../lib/session';
import { useDates } from '../requests/format';
import { useRefusal } from '../requests/use-refusal';
import { ImportPhoto } from './photo';
import { useImports, type ImportRequest } from './queries';
import { ImportStatusPill } from './status-pill';

/**
 * Everything this shop has asked us to bring in, newest first.
 *
 * Built alongside `requests/request-list.tsx` and deliberately the same shape:
 * the two are siblings in the bottom bar and a shop moves between them without
 * noticing, so a different card, a different spinner or a different way of
 * saying "nothing here yet" would read as a different app.
 *
 * What it does not share is the gate. An order request needs a verified shop,
 * because it holds stock; this needs nothing, and is the one thing a brand new
 * account can do while it waits to be looked at. Nothing on this screen reads
 * `verified`.
 */
export function ImportList() {
  const t = useTranslations('imports');
  const tAccount = useTranslations('account');
  const tNav = useTranslations('nav');
  const tCommon = useTranslations('common');
  const refusal = useRefusal();

  const { signedIn, ready } = useSession();
  const { data, isPending, isError, error, refetch } = useImports();

  if (!ready) {
    return (
      <p className="flex items-center justify-center gap-2 py-16 text-sm text-gray-500">
        <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
        {tCommon('loading')}
      </p>
    );
  }

  /**
   * Signed out is not an error.
   *
   * The API would answer 401 and `useRefusal` would turn that into "please sign
   * in", in a red box with a "try again" button that will do exactly the same
   * thing next time. Someone who has not signed in yet is told where to, and
   * nothing is asked of the server to find that out.
   */
  if (!signedIn) {
    return (
      <div className="mx-4 space-y-3 rounded-xl bg-white p-4 shadow-sm ring-1 ring-gray-200/70 ring-inset">
        <p className="text-sm font-medium text-gray-900">{tAccount('signedOut')}</p>
        <p className="text-sm text-gray-600">{tAccount('signedOutBody')}</p>
        <Link
          href="/account"
          className="inline-flex min-h-11 items-center rounded-xl bg-brand-600 px-4 text-sm font-semibold text-white"
        >
          {tNav('signIn')}
        </Link>
      </div>
    );
  }

  if (isPending) {
    return (
      <p className="flex items-center justify-center gap-2 py-16 text-sm text-gray-500">
        <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
        {tCommon('loading')}
      </p>
    );
  }

  if (isError) {
    return (
      <div className="mx-4 flex flex-col items-start gap-3 rounded-xl bg-red-50 p-4">
        <p role="alert" className="flex items-start gap-2 text-sm text-red-800">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {refusal(error)}
        </p>
        <button
          type="button"
          onClick={() => refetch()}
          className="min-h-11 rounded-lg bg-white px-3 text-sm font-medium text-red-800 ring-1 ring-red-200 ring-inset"
        >
          {tCommon('retry')}
        </button>
      </div>
    );
  }

  if (data.length === 0) {
    return <p className="px-4 py-16 text-center text-sm text-gray-500">{t('empty')}</p>;
  }

  return (
    <ul className="space-y-2 px-4">
      {data.map((request) => (
        <li
          key={request.id}
          className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-gray-200/70 ring-inset"
        >
          <ImportRow request={request} />
          {/* Outside the row's link, not inside it: a link within a link is
              invalid markup, and the browser's repair of it puts the product
              somewhere neither tap reaches. */}
          {request.product && <StockedLink product={request.product} />}
        </li>
      ))}
    </ul>
  );
}

function ImportRow({ request }: { request: ImportRequest }) {
  const t = useTranslations('imports');
  const locale = useLocale();
  const dates = useDates();

  // The chevron points the way the reader travels, which is the other way in
  // Arabic.
  const Chevron = locale === 'ar' ? ChevronLeft : ChevronRight;
  const photo = request.photos[0];

  return (
    <Link
      href={`/imports/${request.id}`}
      data-import={request.id}
      className="flex items-center gap-3 p-4"
    >
      {photo && (
        <ImportPhoto
          path={photo.url}
          alt={t('photoAlt', { name: request.productName, number: 1 })}
          className="h-14 w-14 shrink-0 rounded-lg"
        />
      )}

      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          {/* `dir="auto"`: a part is as often named in Latin as in Arabic. */}
          <span dir="auto" className="text-sm font-semibold text-gray-900">
            {request.productName}
          </span>
          <ImportStatusPill status={request.status} />
        </div>

        <p className="text-xs text-gray-500">{dates.day(request.createdAt)}</p>

        {/* The owner's reply is the reason a shop opens this screen at all, so
            the first line of it is on the card rather than one tap away. */}
        {request.decisionNote && (
          <p dir="auto" className="line-clamp-2 text-xs text-gray-600">
            {request.decisionNote}
          </p>
        )}
      </div>

      <Chevron className="h-5 w-5 shrink-0 text-gray-400" aria-hidden />
    </Link>
  );
}

/** "You asked for this, and we stock it now" — straight to buying it. */
function StockedLink({ product }: { product: NonNullable<ImportRequest['product']> }) {
  const t = useTranslations('imports');

  return (
    <Link
      href={`/p/${encodeURIComponent(product.sku)}`}
      className="flex min-h-12 items-center gap-2 border-t border-gray-100 bg-green-50/60 px-4 text-sm font-medium text-green-900"
    >
      <Package className="h-4 w-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{t('nowStocked', { name: product.name })}</span>
    </Link>
  );
}
