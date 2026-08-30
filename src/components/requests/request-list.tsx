'use client';

import { ChevronLeft, ChevronRight, CircleAlert, Clock, LoaderCircle } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

import { Link } from '../../i18n/navigation';
import { Money } from '../ui/money';
import { StatusPill, useDates } from './format';
import { useRequests, type PortalRequest } from './queries';
import { useRefusal } from './use-refusal';

/**
 * Everything this shop has asked for, newest first.
 *
 * Each row answers the question the shop actually has, which differs by status:
 * a pending one is asked "how long do I have", an approved one "what is the
 * order and what does it come to", a declined one "why". Showing the same three
 * fields for all four statuses would answer none of them.
 */
export function RequestList() {
  const t = useTranslations('requests');
  const tCommon = useTranslations('common');
  const refusal = useRefusal();

  const { data, isPending, isError, error, refetch } = useRequests();

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
          className="rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-red-800 ring-1 ring-red-200 ring-inset"
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
        <li key={request.id}>
          <RequestRow request={request} />
        </li>
      ))}
    </ul>
  );
}

function RequestRow({ request }: { request: PortalRequest }) {
  const t = useTranslations('requests');
  const locale = useLocale();
  const dates = useDates();

  // The chevron points the way the reader travels, which is the other way in
  // Arabic. Chosen here rather than left to a CSS flip so the icon is right
  // even where the direction variant is not applied.
  const Chevron = locale === 'ar' ? ChevronLeft : ChevronRight;

  return (
    <Link
      href={`/requests/${request.id}`}
      data-request={request.requestNo}
      className="flex items-center gap-3 rounded-xl bg-white p-4 shadow-sm ring-1 ring-gray-200/70 ring-inset"
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-semibold text-gray-900">{request.requestNo}</span>
          <StatusPill status={request.status} />
        </div>

        <p className="text-xs text-gray-500">
          {dates.day(request.createdAt)} · {t('items', { count: request.items.length })}
        </p>

        <RequestSummary request={request} />
      </div>

      <Chevron className="h-5 w-5 shrink-0 text-gray-400" aria-hidden />
    </Link>
  );
}

/** The one line that differs by status. */
function RequestSummary({ request }: { request: PortalRequest }) {
  const t = useTranslations('requests');
  const locale = useLocale();
  const dates = useDates();

  if (request.status === 'PENDING') {
    // A lapsed hold is not a dead request. The units went back on the shelf
    // because nobody had answered yet, and the owner can still approve it — so
    // this is said plainly and in a neutral colour, not as a failure.
    if (request.hold.live && dates.has(request.hold.expiresAt)) {
      return (
        <p className="flex items-center gap-1.5 text-xs font-medium text-amber-800">
          <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {t('heldUntil', { date: dates.moment(request.hold.expiresAt) })}
        </p>
      );
    }
    return (
      <p className="text-xs text-gray-500">
        {t('holdExpired')} {t('stillOpen')}
      </p>
    );
  }

  if (request.status === 'APPROVED' && request.order) {
    return (
      <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-gray-600">
        <span className="font-medium">{t('orderNo', { orderNo: request.order.orderNo })}</span>
        <Money
          amount={request.order.total}
          locale={locale}
          className="font-semibold text-gray-900"
        />
      </p>
    );
  }

  if (request.status === 'DECLINED' && request.decisionNote) {
    return <p className="line-clamp-2 text-xs text-gray-600">{request.decisionNote}</p>;
  }

  return null;
}
