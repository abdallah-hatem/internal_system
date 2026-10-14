import { useLocale } from 'next-intl';

/**
 * Which name a category or product is shown by (BUSINESS_LOGIC §3, owner
 * 2026-10-14) — the one place the office decides it.
 *
 * A reader on /ar sees the Arabic name when someone entered one and the
 * English otherwise, never a blank. A reader on /en always sees the English.
 * The API sends both and leaves the choice here, because only the app knows
 * which language the reader picked (the URL).
 *
 * Every list, picker, line and invoice calls this rather than writing
 * `nameAr ?? name` itself: a second copy would drift — the first time someone
 * stored an empty Arabic name it would show a blank row on one screen only.
 *
 * Mirrors `apps/api/src/common/arabic-names.ts`; the unit test pins both.
 */

export interface Named {
  name?: string | null;
  nameAr?: string | null;
}

export interface Described {
  description?: string | null;
  descriptionAr?: string | null;
}

const present = (v: string | null | undefined): v is string =>
  typeof v === 'string' && v.trim() !== '';

/** The name a reader of `locale` sees. */
export function localName(record: Named | null | undefined, locale: string): string {
  if (!record) return '';
  if (locale === 'ar' && present(record.nameAr)) return record.nameAr.trim();
  return record.name ?? '';
}

/** The description a reader of `locale` sees; '' when neither exists. */
export function localDescription(record: Described | null | undefined, locale: string): string {
  if (!record) return '';
  if (locale === 'ar' && present(record.descriptionAr)) return record.descriptionAr.trim();
  return present(record.description) ? record.description : '';
}

/**
 * The name in the other language, for a second line or a search keyword —
 * '' when there is no other name worth showing.
 */
export function otherName(record: Named | null | undefined, locale: string): string {
  if (!record) return '';
  const shown = localName(record, locale);
  const other = locale === 'ar' ? record.name ?? '' : record.nameAr?.trim() ?? '';
  return other && other !== shown ? other : '';
}


/** Vowel marks, shadda, sukun, madda and hamza marks, superscript alef, tatweel. */
const ARABIC_MARKS = /[\u064B-\u065F\u0670\u0640]/g;

/**
 * The Arabic search key (BUSINESS_LOGIC §3, owner 2026-10-15): أ إ آ read as
 * ا, ؤ as و, ئ as ي, ة as ه, ى as ي; vowel marks, shadda, sukun and the
 * tatweel dropped; case ignored; trimmed. Spelling only — Latin text is only
 * lower-cased, so an English search behaves as it always has.
 *
 * A copy of `arabicSearchKey` in `apps/api/src/common/arabic-names.ts` (this
 * app cannot import the API at build time). Both sides of every comparison go
 * through it. The unit test runs this copy over the API's own case table,
 * `apps/api/src/common/arabic-search-cases.json`.
 */
export function arabicSearchKey(text: string | null | undefined): string {
  return (text ?? '')
    .replace(ARABIC_MARKS, '')
    .replace(/[\u0622\u0623\u0625]/g, '\u0627')
    .replace(/\u0624/g, '\u0648')
    .replace(/\u0626/g, '\u064a')
    .replace(/\u0629/g, '\u0647')
    .replace(/\u0649/g, '\u064a')
    .toLowerCase()
    .trim();
}

/** Does `text` contain `search`, compared as a search compares (above)? */
export function searchFinds(text: string | null | undefined, search: string): boolean {
  return arabicSearchKey(text).includes(arabicSearchKey(search));
}

/**
 * Does a search typed in either language find this record? The English name,
 * the Arabic name and the SKU, ignoring case and Arabic spelling differences
 * (2026-10-15) — the same three the API's search reads
 * (`bilingualProductSearch`), so a list filtered here and one filtered by the
 * server never disagree.
 */
export function matchesName(
  record: Named & { sku?: string | null },
  search: string,
): boolean {
  const term = arabicSearchKey(search);
  if (!term) return true;
  return [record.name, record.nameAr, record.sku].some(
    (v) => typeof v === 'string' && arabicSearchKey(v).includes(term),
  );
}

/** `localName` bound to the page's locale. */
export function useLocalName() {
  const locale = useLocale();
  return (record: Named | null | undefined) => localName(record, locale);
}
