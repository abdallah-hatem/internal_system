'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useMemo } from 'react';

import type { RequestStatus } from './queries';

/**
 * Dates the reader can read, and the status pill that labels a request.
 *
 * An ISO timestamp on screen — `2026-08-13T00:00:00.000Z` — is a bug the owner
 * has complained about before, and it is worse here than in the office: a shop
 * reading Arabic gets a Latin-digit string in a format nobody in Egypt writes
 * dates in. Every date goes through `Intl.DateTimeFormat` at the active locale,
 * which also picks the numbering system.
 */

function intlLocale(locale: string): string {
  return locale === 'ar' ? 'ar-EG' : 'en-EG';
}

export function useDates() {
  const locale = useLocale();

  return useMemo(() => {
    const day = new Intl.DateTimeFormat(intlLocale(locale), { dateStyle: 'medium' });
    // The hold runs out at an hour of the day, not on a day. Telling a shop it
    // expires "13 August" when it goes at 09:40 that morning is telling them
    // they have a day they do not have.
    const moment = new Intl.DateTimeFormat(intlLocale(locale), {
      dateStyle: 'medium',
      timeStyle: 'short',
    });

    const read = (value: string | null | undefined): Date | null => {
      if (!value) return null;
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    };

    return {
      /** A calendar day. Empty string when there is no usable date. */
      day: (value: string | null | undefined) => {
        const parsed = read(value);
        return parsed ? day.format(parsed) : '';
      },
      /** A day and a time, for deadlines. */
      moment: (value: string | null | undefined) => {
        const parsed = read(value);
        return parsed ? moment.format(parsed) : '';
      },
      /** Whether a date is usable at all, for deciding whether to show a label. */
      has: (value: string | null | undefined) => read(value) !== null,
    };
  }, [locale]);
}

const STATUS_STYLE: Record<RequestStatus, string> = {
  PENDING: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  APPROVED: 'bg-green-50 text-green-700 ring-green-600/20',
  DECLINED: 'bg-red-50 text-red-700 ring-red-600/20',
  CANCELLED: 'bg-gray-100 text-gray-500 ring-gray-500/20',
};

const STATUS_KEY: Record<RequestStatus, 'pending' | 'approved' | 'declined' | 'cancelled'> = {
  PENDING: 'pending',
  APPROVED: 'approved',
  DECLINED: 'declined',
  CANCELLED: 'cancelled',
};

export function StatusPill({ status }: { status: RequestStatus }) {
  const t = useTranslations('requests');

  return (
    <span
      data-status={status}
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_STYLE[status]}`}
    >
      {t(STATUS_KEY[status])}
    </span>
  );
}
