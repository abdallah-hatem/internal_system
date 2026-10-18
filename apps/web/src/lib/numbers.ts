import { useMemo } from 'react';
import { useLocale } from 'next-intl';

/**
 * The one place a number becomes text for a reader.
 *
 * Arabic screens use Latin digits everywhere (decision log, "Arabic uses Latin
 * digits everywhere", 2026-10-10): dates already did, while `Money` followed the
 * browser and printed Arabic-Indic, so one screen mixed "30" with "٣٠". Dates
 * (`lib/dates.ts`) and numbers both take their Intl locale from `intlFor`, so
 * the two cannot drift apart again (CLAUDE.md rule 11).
 */

/** The Intl locale for an app locale: Arabic words, Latin digits. */
export function intlFor(locale: string | undefined): { tag: string; numberingSystem?: string } {
  return locale === 'ar' ? { tag: 'ar-EG', numberingSystem: 'latn' } : { tag: 'en-US' };
}

/** The currency every amount is shown in unless it says otherwise. */
export const DEFAULT_CURRENCY = 'EGP';

/**
 * Directional marks Intl adds around signs (LRM, RLM, ALM). Callers isolate the
 * figure themselves, and a stray ALM inside an LTR run is an RTL character that
 * can drag the minus sign away from the digits.
 */
const BIDI_MARKS = /[‎‏؜]/g;

export interface FormatNumberOptions {
  /** App locale (`'en'` | `'ar'`). Defaults to `'en'`; components use `useNumberFormat()`. */
  locale?: string;
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
}

/**
 * A number as a reader sees it: grouped, Latin digits, a plain ASCII minus
 * directly before the first digit. Not finite gives an em dash.
 *
 *   formatNumber(-1529.234, { maximumFractionDigits: 2 }) => "-1,529.23"
 */
export function formatNumber(value: number | string | null | undefined, opts: FormatNumberOptions = {}): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '—';
  const { tag, numberingSystem } = intlFor(opts.locale);
  return new Intl.NumberFormat(tag, {
    numberingSystem,
    minimumFractionDigits: opts.minimumFractionDigits,
    maximumFractionDigits: opts.maximumFractionDigits,
  })
    .format(n)
    .replace(BIDI_MARKS, '')
    .replace(/−/g, '-');
}

/** An amount with two decimals, as `Money` shows it: "-1,529.23". */
export function formatAmount(value: number | string | null | undefined, locale?: string): string {
  return formatNumber(value, { locale, minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * The app's one order for money as plain text: number, then currency —
 * "-1,529.23 EGP" in both languages. Rendered inside an LTR isolate (`Money`)
 * it reads the same way in RTL.
 */
export function formatMoney(
  value: number | string | null | undefined,
  opts: { locale?: string; currency?: string } = {},
): string {
  const text = formatAmount(value, opts.locale);
  return text === '—' ? text : `${text} ${opts.currency ?? DEFAULT_CURRENCY}`;
}

/**
 * A figure shortened for a tile or an axis: "1.34M", "385.7K", "950" — and
 * "1.34 مليون" in Arabic, Latin digits in both. Millions keep two decimals,
 * thousands one, so a tile still tells 1.34M from 1.35M. Always shown with the
 * exact amount a hover away (`formatMoney`), never instead of it.
 */
export function formatCompact(value: number | string | null | undefined, locale?: string): string {
  const { number, unit } = compactParts(value, locale);
  if (!unit) return number;
  return locale === 'ar' ? `${number} ${unit}` : `${number}${unit}`;
}

/**
 * `formatCompact` in its two pieces: the figure ("-1.34", Latin digits, the
 * minus before them) and the word or letter for its size ("M", "مليون", or
 * none under a thousand). Arabic needs them apart: the figure is an LTR run
 * and the word an RTL one, and set as one LTR string the word lands on the
 * wrong side for a right-to-left reader ("ألف 293" read as "thousand 293").
 */
export function compactParts(value: number | string | null | undefined, locale?: string): { number: string; unit: string } {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return { number: '—', unit: '' };
  const { tag, numberingSystem } = intlFor(locale);
  const parts = new Intl.NumberFormat(tag, {
    numberingSystem,
    notation: 'compact',
    maximumFractionDigits: Math.abs(n) >= 1_000_000 ? 2 : 1,
  }).formatToParts(n);
  const clean = (s: string) => s.replace(BIDI_MARKS, '').replace(/−/g, '-');
  return {
    number: clean(parts.filter((p) => p.type !== 'compact' && p.type !== 'literal').map((p) => p.value).join('')),
    unit: clean(parts.filter((p) => p.type === 'compact').map((p) => p.value).join('')).trim(),
  };
}

/**
 * Read back a figure that was formatted for display — Latin or Arabic-Indic
 * digits, grouping commas, a trailing currency code. Returns null when the text
 * is not a single number (so it can be shown as it is).
 *
 *   parseDisplayedMoney("1,234.50 EGP")    => { value: 1234.5, currency: "EGP" }
 *   parseDisplayedMoney("-٥٢٩٫٢٣ EGP")     => { value: -529.23, currency: "EGP" }
 *   parseDisplayedMoney("12")              => { value: 12, currency: null }
 */
export function parseDisplayedMoney(text: string): { value: number; currency: string | null } | null {
  const cleaned = text
    .replace(BIDI_MARKS, '')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.')
    .replace(/[٬,]/g, '')
    .replace(/[\s  ]+/g, ' ')
    .replace(/−/g, '-')
    .trim();
  const m = /^(?:([A-Z]{3})\s*)?(-?\d+(?:\.\d+)?)(-?)(?:\s*([A-Z]{3}))?$/.exec(cleaned);
  if (!m) return null;
  const [, before, digits, trailingMinus, after] = m;
  if (before && after) return null;
  if (trailingMinus && digits.startsWith('-')) return null;
  const value = Number(digits) * (trailingMinus ? -1 : 1);
  if (!Number.isFinite(value)) return null;
  return { value, currency: before ?? after ?? null };
}

/**
 * The formatters bound to the reader's locale from next-intl.
 *
 *   const { formatNumber } = useNumberFormat();
 *   formatNumber(units)   // "1,284" in both languages
 */
export function useNumberFormat() {
  const locale = useLocale();
  return useMemo(
    () => ({
      locale,
      formatNumber: (value: number | string | null | undefined, opts?: Omit<FormatNumberOptions, 'locale'>) =>
        formatNumber(value, { ...opts, locale }),
      formatAmount: (value: number | string | null | undefined) => formatAmount(value, locale),
      formatMoney: (value: number | string | null | undefined, currency?: string) =>
        formatMoney(value, { locale, currency }),
      formatCompact: (value: number | string | null | undefined) => formatCompact(value, locale),
    }),
    [locale],
  );
}
