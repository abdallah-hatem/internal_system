/**
 * Which name and description a shop is shown (BUSINESS_LOGIC §3, owner
 * 2026-10-14) — the one place the storefront decides it.
 *
 * The store opens in Arabic for everyone (§13), so this is the common case,
 * not a translation layer: on /ar a product shows its Arabic name when someone
 * entered one and its English name otherwise — never a blank card. On /en it
 * shows the English.
 *
 * The API sends both and leaves the choice here, because only the app knows
 * which language the reader picked (the URL). Every card, filter, basket line
 * and request line calls this rather than writing `nameAr ?? name` itself.
 *
 * The same rule as `apps/api/src/common/arabic-names.ts` and the office's
 * `lib/localized-name.ts` (whose unit test compares itself with the API's);
 * `unit/localized-name.test.mjs` pins this copy over the same table. No
 * imports, so that test can load this file directly.
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

/** The description a reader of `locale` sees; null when neither exists. */
export function localDescription(
  record: Described | null | undefined,
  locale: string,
): string | null {
  if (!record) return null;
  if (locale === 'ar' && present(record.descriptionAr)) return record.descriptionAr.trim();
  return present(record.description) ? record.description : null;
}

/** The name in the other language — for a filter to match on — or ''. */
export function otherName(record: Named | null | undefined, locale: string): string {
  if (!record) return '';
  const shown = localName(record, locale);
  const other = locale === 'ar' ? (record.name ?? '') : (record.nameAr?.trim() ?? '');
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
