'use client';

import { ChevronLeft, ChevronRight, CircleAlert, Clock, LoaderCircle } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';

import { Link } from '../../i18n/navigation';
import { Money } from '../ui/money';
import { isZero, sameDecimal, trimQuantity } from './decimal';
import { StatusPill, useDates } from './format';
import { useRequest, useWithdrawRequest, type PortalRequest, type RequestItem } from './queries';
import { useRefusal } from './use-refusal';

/**
 * One request, and what the owner did to it.
 *
 * The line-by-line comparison is the reason this screen exists. An approval is
 * rarely a plain yes: quantities get cut to what is actually on the shelf and
 * lines get dropped altogether, and a shop that reads only the new order has no
 * way to see that the forty it asked for became six. Asked-for and approved sit
 * next to each other, labelled, wherever they disagree.
 */
export function RequestDetail({ id }: { id: string }) {
  const t = useTranslations('requests');
  const tCommon = useTranslations('common');
  const locale = useLocale();
  const refusal = useRefusal();

  const { data, isPending, isError, error, refetch } = useRequest(id);

  const Back = locale === 'ar' ? ChevronRight : ChevronLeft;

  const back = (
    <Link
      href="/requests"
      className="inline-flex items-center gap-1 text-sm font-medium text-gray-600"
    >
      <Back className="h-4 w-4" aria-hidden />
      {tCommon('back')}
    </Link>
  );

  if (isPending) {
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

  if (isError) {
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
            className="rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-red-800 ring-1 ring-red-200 ring-inset"
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
          <h1 className="font-mono text-lg font-semibold">{data.requestNo}</h1>
          <StatusPill status={data.status} />
        </div>
        <Timestamps request={data} />
      </header>

      {data.status === 'PENDING' && <HoldBanner request={data} />}

      <ItemLines items={data.items} />

      {data.order && <OrderCard order={data.order} />}

      {data.note && <NoteCard title={t('yourNote')} body={data.note} />}
      {data.decisionNote && <NoteCard title={t('ourNote')} body={data.decisionNote} />}

      {/* Only a request nobody has answered can be taken back. The API says the
          same thing with REQUEST_ALREADY_DECIDED, which is what a second tab
          left open on a stale copy will get. */}
      {data.status === 'PENDING' && <Withdraw id={data.id} />}
    </div>
  );
}

function Timestamps({ request }: { request: PortalRequest }) {
  const t = useTranslations('requests');
  const dates = useDates();

  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
      <div className="flex gap-1">
        <dt>{t('submitted')}</dt>
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

function HoldBanner({ request }: { request: PortalRequest }) {
  const t = useTranslations('requests');
  const dates = useDates();

  const held = request.hold.live && dates.has(request.hold.expiresAt);

  return (
    <p
      data-hold={held ? 'live' : 'expired'}
      className={`flex items-start gap-2 rounded-xl p-3 text-sm ${
        held ? 'bg-amber-50 text-amber-900' : 'bg-gray-100 text-gray-600'
      }`}
    >
      <Clock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>
        {held ? (
          t('heldUntil', { date: dates.moment(request.hold.expiresAt) })
        ) : (
          <>
            {/* Lapsed, not refused. The units went back on the shelf because
                nobody had answered yet, and the owner can still say yes — so
                this is grey and says so, rather than red and final. */}
            {t('holdExpired')} {t('stillOpen')}
          </>
        )}
      </span>
    </p>
  );
}

function ItemLines({ items }: { items: RequestItem[] }) {
  const locale = useLocale();
  const t = useTranslations('requests');

  return (
    <ul className="divide-y divide-gray-100 overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-gray-200/70 ring-inset">
      {items.map((item) => {
        // Three different states, and they are not interchangeable. `null` is
        // "nobody has answered yet"; a value that matches is "yes, as asked";
        // `"0"` is a line the owner dropped, which a nullish check would fold
        // into the first and show as still open.
        const answered = item.qtyApproved !== null;
        const changed = answered && !sameDecimal(item.qtyApproved, item.qtyRequested);
        const dropped = answered && isZero(item.qtyApproved);

        return (
          <li key={item.productId} className="flex items-start gap-3 p-4">
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="text-sm font-medium text-gray-900">{item.name}</p>
              <p className="font-mono text-xs text-gray-500">{item.sku}</p>
              <p className="text-xs text-gray-500">
                {t('unitPrice')}{' '}
                <Money amount={item.unitPrice} locale={locale} className="text-gray-700" />
              </p>
            </div>

            {changed ? (
              <div className="grid shrink-0 grid-cols-2 gap-x-4 text-end">
                <div>
                  <p className="text-[11px] text-gray-500">{t('requested')}</p>
                  <p className="text-sm text-gray-400 line-through tabular-nums">
                    {trimQuantity(item.qtyRequested)}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] text-gray-500">{t('approvedQty')}</p>
                  <p
                    className={`text-sm font-semibold tabular-nums ${
                      dropped ? 'text-red-700' : 'text-gray-900'
                    }`}
                  >
                    {trimQuantity(item.qtyApproved)}
                  </p>
                  {dropped && <p className="text-[11px] text-red-700">{t('dropped')}</p>}
                </div>
              </div>
            ) : (
              <div className="shrink-0 text-end">
                <p className="text-[11px] text-gray-500">
                  {answered ? t('approvedQty') : t('requested')}
                </p>
                <p className="text-sm font-semibold text-gray-900 tabular-nums">
                  {trimQuantity(answered ? item.qtyApproved : item.qtyRequested)}
                </p>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function OrderCard({ order }: { order: NonNullable<PortalRequest['order']> }) {
  const t = useTranslations('requests');
  const locale = useLocale();

  return (
    <div className="flex items-center justify-between gap-3 rounded-xl bg-green-50 p-4">
      <span className="text-sm font-medium text-green-900">
        {t('orderNo', { orderNo: order.orderNo })}
      </span>
      {/* The one figure on this screen that is not an estimate: the server put
          it on the order. Nothing here recomputes it from the lines above. */}
      <Money amount={order.total} locale={locale} className="text-base font-semibold text-green-900" />
    </div>
  );
}

function NoteCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl bg-white p-4 shadow-sm ring-1 ring-gray-200/70 ring-inset">
      <p className="text-xs font-medium text-gray-500">{title}</p>
      <p className="mt-1 text-sm whitespace-pre-line text-gray-800">{body}</p>
    </div>
  );
}

/**
 * Taking it back, which gives the held stock back too.
 *
 * Confirmed in place rather than with `window.confirm`: the native dialog is
 * suppressed outright in some in-app browsers, and this app is opened from
 * WhatsApp more often than from a browser's address bar. A confirmation that
 * silently never appears is a confirmation nobody gave.
 */
function Withdraw({ id }: { id: string }) {
  const t = useTranslations('requests');
  const refusal = useRefusal();

  const [asking, setAsking] = useState(false);
  const withdraw = useWithdrawRequest();

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
          className="w-full rounded-lg bg-white px-4 py-3 text-sm font-medium text-red-700 ring-1 ring-red-200 ring-inset"
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
          className="flex-1 rounded-lg bg-white px-4 py-2.5 text-sm font-medium text-gray-700 ring-1 ring-gray-200 ring-inset"
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
          className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-red-700 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
        >
          {withdraw.isPending && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />}
          {t('withdraw')}
        </button>
      </div>
    </div>
  );
}
