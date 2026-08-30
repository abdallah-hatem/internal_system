'use client';

import {
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  LoaderCircle,
  Package,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';

import { Link } from '../../i18n/navigation';
import { useSession } from '../../lib/session';
import { trimQuantity } from '../requests/decimal';
import { useDates } from '../requests/format';
import { useRefusal } from '../requests/use-refusal';
import { isHttpUrl } from './import-form';
import { ImportPhoto } from './photo';
import { PhotoUploader } from './photo-uploader';
import {
  acceptsPhotos,
  canWithdraw,
  useImport,
  useWithdrawImport,
  type ImportRequest,
} from './queries';
import { ImportStatusPill } from './status-pill';

/**
 * One request to bring something in, and what came of it.
 *
 * The shape follows `requests/request-detail.tsx` — same back link, same
 * spinner, same refusal box, same inline confirmation before anything
 * destructive — because the two screens are one tap apart in the bottom bar.
 *
 * What it adds is the photographs, which are the substance of this feature
 * rather than a decoration on it: the description is a shop's best guess at
 * what the part is called, and the picture is the part. They stay addable while
 * the owner is still sourcing, because "here is a better photo of the casting
 * number" is the most useful thing a shop can send after the fact.
 */
export function ImportDetail({ id }: { id: string }) {
  const t = useTranslations('imports');
  const tAccount = useTranslations('account');
  const tNav = useTranslations('nav');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const refusal = useRefusal();

  const { signedIn, ready } = useSession();
  const { data, isPending, isError, error, refetch } = useImport(id);

  const Back = locale === 'ar' ? ChevronRight : ChevronLeft;

  const back = (
    <Link
      href="/imports"
      className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-gray-600"
    >
      <Back className="h-4 w-4" aria-hidden />
      {tCommon('back')}
    </Link>
  );

  if (!ready || (signedIn && isPending)) {
    return (
      <div className="space-y-4 px-4 py-4">
        {back}
        <p className="flex items-center justify-center gap-2 py-16 text-sm text-gray-500">
          <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
          {tCommon('loading')}
        </p>
      </div>
    );
  }

  // Signed out is not an error — see `import-list.tsx`. The request is theirs
  // and the API scopes it to the token, so there is nothing to fetch until
  // there is one.
  if (!signedIn) {
    return (
      <div className="space-y-4 px-4 py-4">
        {back}
        <div className="space-y-3 rounded-xl bg-white p-4 shadow-sm ring-1 ring-gray-200/70 ring-inset">
          <p className="text-sm font-medium text-gray-900">{tAccount('signedOut')}</p>
          <p className="text-sm text-gray-600">{tAccount('signedOutBody')}</p>
          <Link
            href="/account"
            className="inline-flex min-h-11 items-center rounded-xl bg-brand-600 px-4 text-sm font-semibold text-white"
          >
            {tNav('signIn')}
          </Link>
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="space-y-4 px-4 py-4">
        {back}
        <div className="flex flex-col items-start gap-3 rounded-xl bg-red-50 p-4">
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
      </div>
    );
  }

  return (
    <div className="space-y-4 px-4 py-4">
      {back}

      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 dir="auto" className="text-lg font-semibold">
            {data.productName}
          </h1>
          <ImportStatusPill status={data.status} />
        </div>
        <Timestamps request={data} />
      </header>

      {/* The owner's reply first, above the details the shop typed themselves:
          it is the one thing on this screen they do not already know. */}
      {data.decisionNote && <ReplyCard body={data.decisionNote} />}

      {data.product && <StockedCard product={data.product} />}

      <Details request={data} />

      {acceptsPhotos(data.status) ? (
        <PhotoUploader request={data} />
      ) : (
        <Gallery request={data} />
      )}

      {canWithdraw(data.status) && <Withdraw id={data.id} />}
    </div>
  );
}

function Timestamps({ request }: { request: ImportRequest }) {
  const t = useTranslations('imports');
  const dates = useDates();

  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
      <div className="flex gap-1">
        <dt>{t('submitted')}</dt>
        {/* Never the ISO string the API sends. `useDates` formats at the active
            locale, which also picks the numbering system. */}
        <dd className="font-medium text-gray-700">{dates.day(request.createdAt)}</dd>
      </div>
      {dates.has(request.decidedAt) && (
        <div className="flex gap-1">
          <dt>{t('decided')}</dt>
          <dd className="font-medium text-gray-700">{dates.day(request.decidedAt)}</dd>
        </div>
      )}
    </dl>
  );
}

/** What the shop told us, and only the parts they actually filled in. */
function Details({ request }: { request: ImportRequest }) {
  const t = useTranslations('imports');

  const quantity = trimQuantity(request.quantity);
  const rows: { label: string; value: React.ReactNode }[] = [];

  if (request.compatibilityText) rows.push({ label: t('fits'), value: request.compatibilityText });
  if (quantity) rows.push({ label: t('quantity'), value: quantity });
  if (request.supplierUrl) {
    rows.push({
      label: t('link'),
      value: isHttpUrl(request.supplierUrl) ? (
        <a
          href={request.supplierUrl}
          target="_blank"
          // `noopener` first: without it the opened page can reach back through
          // `window.opener` and navigate this one.
          rel="noopener noreferrer"
          dir="ltr"
          className="inline-flex min-h-11 items-center gap-1 break-all text-brand-700 underline"
        >
          {request.supplierUrl}
          <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden />
        </a>
      ) : (
        // Not a scheme we will make tappable. Shown so the shop can see what
        // they sent, and nothing more.
        <span dir="ltr" className="break-all">
          {request.supplierUrl}
        </span>
      ),
    });
  }
  if (request.notes) rows.push({ label: t('notes'), value: request.notes });

  if (rows.length === 0) return null;

  return (
    <dl className="divide-y divide-gray-100 overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-gray-200/70 ring-inset">
      {rows.map((row) => (
        <div key={row.label} className="p-4">
          <dt className="text-xs font-medium text-gray-500">{row.label}</dt>
          {/* `dir="auto"`, because what a shop types here is as often Latin as
              Arabic — a part number, a model, an English note. Left to the
              page's direction, "Cable snapped." renders with its full stop at
              the wrong end, which reads as a typo the shop did not make. */}
          <dd dir="auto" className="mt-1 text-sm whitespace-pre-line text-gray-800">
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ReplyCard({ body }: { body: string }) {
  const t = useTranslations('imports');

  return (
    <div className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-gray-200/70 ring-inset">
      <p className="text-xs font-medium text-gray-500">{t('ourReply')}</p>
      <p dir="auto" className="mt-1 text-sm whitespace-pre-line text-gray-800">
        {body}
      </p>
    </div>
  );
}

/** Asked for, found, and now on the shelf. */
function StockedCard({ product }: { product: NonNullable<ImportRequest['product']> }) {
  const t = useTranslations('imports');

  return (
    <Link
      href={`/p/${encodeURIComponent(product.sku)}`}
      className="flex min-h-12 items-center gap-2 rounded-xl bg-green-50 p-4 text-sm font-medium text-green-900"
    >
      <Package className="h-5 w-5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">{t('nowStocked', { name: product.name })}</span>
    </Link>
  );
}

/** The photos, once no more can be added. */
function Gallery({ request }: { request: ImportRequest }) {
  const t = useTranslations('imports');

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-gray-700">{t('photos')}</h2>
      {request.photos.length === 0 ? (
        <p className="text-xs text-gray-500">{t('noPhotos')}</p>
      ) : (
        <ul className="grid grid-cols-3 gap-2">
          {request.photos.map((photo, index) => (
            <li key={photo.id}>
              <ImportPhoto
                path={photo.url}
                alt={t('photoAlt', { name: request.productName, number: index + 1 })}
                className="aspect-square w-full rounded-xl"
              />
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-gray-500">{t('photosClosed')}</p>
    </section>
  );
}

/**
 * Taking it back, while nobody has answered.
 *
 * Confirmed in place rather than with `window.confirm`, for the same reason as
 * the sibling screen: the native dialog is suppressed outright in some in-app
 * browsers, and this app is opened from WhatsApp more often than from an
 * address bar. A confirmation that silently never appears is one nobody gave.
 */
function Withdraw({ id }: { id: string }) {
  const t = useTranslations('imports');
  const refusal = useRefusal();

  const [asking, setAsking] = useState(false);
  const withdraw = useWithdrawImport();

  if (!asking) {
    return (
      <div className="space-y-2">
        {withdraw.isError && (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-lg bg-red-50 p-2.5 text-xs text-red-800"
          >
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            {refusal(withdraw.error)}
          </p>
        )}
        <button
          type="button"
          onClick={() => {
            withdraw.reset();
            setAsking(true);
          }}
          className="min-h-12 w-full rounded-xl bg-white px-4 text-sm font-medium text-red-700 ring-1 ring-red-200 ring-inset"
        >
          {t('withdraw')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-xl bg-red-50 p-4">
      <p className="text-sm text-red-900">{t('withdrawConfirm')}</p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setAsking(false)}
          className="min-h-12 flex-1 rounded-xl bg-white px-4 text-sm font-medium text-gray-700 ring-1 ring-gray-200 ring-inset"
        >
          {t('keepIt')}
        </button>
        <button
          type="button"
          disabled={withdraw.isPending}
          onClick={() =>
            withdraw.mutate(id, {
              // Closed on failure too, so the refusal above is what the shop
              // reads rather than a dialog sitting over it.
              onSettled: () => setAsking(false),
            })
          }
          className="flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl bg-red-700 px-4 text-sm font-semibold text-white disabled:opacity-60"
        >
          {withdraw.isPending && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />}
          {t('withdraw')}
        </button>
      </div>
    </div>
  );
}
