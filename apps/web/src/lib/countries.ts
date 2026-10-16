import { useCallback } from 'react';
import { useLocale } from 'next-intl';
import { searchFinds } from './localized-name';

/**
 * A supplier's country (BUSINESS_LOGIC §21, 2026-10-16): stored as an ISO
 * 3166-1 alpha-2 code, shown as the country's name in the reader's language.
 *
 * COPY of the codes in `apps/api/src/common/countries.ts`, which is the list —
 * the server refuses any code not on it. Next cannot import across apps, so
 * `countries.test.ts` compares the two and fails the moment they differ.
 * Change the API's file first, then this.
 *
 * The names are not stored anywhere: `Intl.DisplayNames` knows every country in
 * English and Arabic, so "China" on /en and "الصين" on /ar cost nothing to keep.
 */
export const COUNTRY_CODES: readonly string[] = (
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ ' +
  'BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR ' +
  'CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR ' +
  'GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ' +
  'ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ ' +
  'LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ ' +
  'MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF ' +
  'PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI ' +
  'SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR ' +
  'TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
).split(' ');

/** Offered first, in this order; the rest follow A–Z in the reader's language. */
export const PREFERRED_COUNTRIES: readonly string[] = ['CN', 'AE', 'EG', 'TR', 'IN'];

const KNOWN = new Set(COUNTRY_CODES);

export function isCountryCode(value: unknown): value is string {
  return typeof value === 'string' && KNOWN.has(value);
}

const displayNames = new Map<string, Intl.DisplayNames>();
function namesIn(locale: string): Intl.DisplayNames {
  let names = displayNames.get(locale);
  if (!names) {
    names = new Intl.DisplayNames(locale, { type: 'region' });
    displayNames.set(locale, names);
  }
  return names;
}

const other = (locale: string) => (locale === 'ar' ? 'en' : 'ar');

/**
 * A stored country as a reader of `locale` sees it.
 *
 *   countryLabel('CN', 'ar')     // "الصين"
 *   countryLabel('AE', 'en')     // "United Arab Emirates"
 *   countryLabel('Narnia', 'ar') // "Narnia" — free text from before the
 *                                // codes that the migration could not read
 *
 * Never the raw code, never blank: nothing stored → '—'.
 */
export function countryLabel(value: string | null | undefined, locale: string): string {
  const v = (value ?? '').trim();
  if (!v) return '—';
  if (!isCountryCode(v)) return v;
  return namesIn(locale).of(v) ?? v;
}

/** What a search box matches a stored country against: both names and the code. */
export function countrySearchText(value: string | null | undefined): string {
  const v = (value ?? '').trim();
  if (!isCountryCode(v)) return v;
  return `${v} ${namesIn('en').of(v) ?? ''} ${namesIn('ar').of(v) ?? ''}`;
}

/** Does a search typed in either language (or a code) find this country? */
export function countryMatches(value: string | null | undefined, search: string): boolean {
  return searchFinds(countrySearchText(value), search);
}

/**
 * The picker's options: the business's own countries first, then every other
 * A–Z by its name in the reader's language. Labelled in that language; found
 * by its name in the other one and by its code too, so "مصر" finds Egypt on /en
 * and "EG" finds it anywhere.
 */
export function countryOptions(locale: string) {
  const names = namesIn(locale);
  const otherNames = namesIn(other(locale));
  const option = (code: string) => ({
    value: code,
    label: names.of(code) ?? code,
    keywords: `${otherNames.of(code) ?? ''} ${code}`,
  });
  const collator = new Intl.Collator(locale);
  const preferred = new Set(PREFERRED_COUNTRIES);
  const rest = COUNTRY_CODES.filter((c) => !preferred.has(c))
    .map(option)
    .sort((a, b) => collator.compare(a.label, b.label));
  return [...PREFERRED_COUNTRIES.map(option), ...rest];
}

/** `countryLabel` bound to the page's locale. */
export function useCountryLabel(): (value: string | null | undefined) => string {
  const locale = useLocale();
  return useCallback((value: string | null | undefined) => countryLabel(value, locale), [locale]);
}
