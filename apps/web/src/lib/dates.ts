import { useMemo } from 'react';
import { useLocale } from 'next-intl';

/**
 * The timezone the business runs in — the web twin of the API's
 * `BUSINESS_TIMEZONE` (`apps/api/src/common/dates.ts`, BUSINESS_LOGIC §7a).
 *
 * "Today" means today in Cairo, not in the reader's browser: the server refuses
 * a date after Cairo's today, so a picker that used the browser's clock would
 * offer days the server rejects (or hide one it accepts) for anyone abroad or
 * on a misconfigured laptop.
 */
export const BUSINESS_TIMEZONE = 'Africa/Cairo';

/** Today's calendar day in Cairo as `YYYY-MM-DD`. Pass `now` to pin the clock in tests. */
export function businessToday(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD — the wire format used everywhere here.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * The Intl locale for an app locale. Arabic gets Arabic month names with Latin
 * digits — the same choice the date picker's header and every money figure
 * already make, so a date never reads in a different script from the amount
 * beside it.
 */
function intlFor(locale: string | undefined): { tag: string; numberingSystem?: string } {
  return locale === 'ar' ? { tag: 'ar-EG', numberingSystem: 'latn' } : { tag: 'en-US' };
}

export interface FormatDateOptions {
  includeTime?: boolean;
  /** App locale (`'en'` | `'ar'`). Defaults to `'en'`; components should use `useDateFormat()`. */
  locale?: string;
}

/**
 * Format an ISO date string for a reader.
 *
 * Examples (en):
 *   formatDate("2026-08-19T00:00:00.000Z") => "Aug 19, 2026"
 *   formatDate("2026-08-19T14:30:00.000Z", { includeTime: true }) => "Aug 19, 2026, 2:30 PM"
 *   formatDate(null) => "—"
 * In Arabic: "19 أغسطس 2026".
 */
export function formatDate(iso: string | null | undefined, opts?: FormatDateOptions): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';

  const { tag, numberingSystem } = intlFor(opts?.locale);

  if (tag !== 'en-US') {
    return new Intl.DateTimeFormat(tag, {
      numberingSystem,
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      ...(opts?.includeTime ? { hour: 'numeric', minute: '2-digit', hour12: true } : {}),
    }).format(d);
  }

  // English is unchanged from before the locale existed.
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  if (opts?.includeTime) {
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    return `${date}, ${time}`;
  }
  return date;
}

/**
 * Relative time ("5m ago", "2h ago"…). English keeps its compact form; Arabic
 * uses Intl's own relative wording ("قبل 5 دقائق", "الآن").
 */
export function timeAgo(iso: string | null | undefined, opts?: { locale?: string }): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';

  const diffMs = Date.now() - d.getTime();
  const seconds = Math.max(0, Math.floor(diffMs / 1000));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const months = Math.floor(days / 30);
  const years = Math.floor(months / 12);

  const { tag, numberingSystem } = intlFor(opts?.locale);
  if (tag !== 'en-US') {
    const rtf = new Intl.RelativeTimeFormat(tag, { numeric: 'auto', numberingSystem } as Intl.RelativeTimeFormatOptions);
    if (seconds < 60) return rtf.format(0, 'second');
    if (minutes < 60) return rtf.format(-minutes, 'minute');
    if (hours < 24) return rtf.format(-hours, 'hour');
    if (days < 30) return rtf.format(-days, 'day');
    if (months < 12) return rtf.format(-months, 'month');
    return rtf.format(-years, 'year');
  }

  if (seconds < 60) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 30) return `${days}d ago`;
  if (months < 12) return `${months}mo ago`;
  return `${years}y ago`;
}

/**
 * `formatDate` and `timeAgo` bound to the reader's locale from next-intl.
 *
 *   const { formatDate } = useDateFormat();
 *   formatDate(order.createdAt)            // "Aug 19, 2026" / "19 أغسطس 2026"
 *
 * Same signatures as the plain functions, minus the `locale` option.
 */
export function useDateFormat() {
  const locale = useLocale();
  return useMemo(
    () => ({
      formatDate: (iso: string | null | undefined, opts?: { includeTime?: boolean }) =>
        formatDate(iso, { ...opts, locale }),
      timeAgo: (iso: string | null | undefined) => timeAgo(iso, { locale }),
    }),
    [locale],
  );
}
