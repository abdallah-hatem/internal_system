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

/**
 * Does a search typed in either language find this record? The English name,
 * the Arabic name and the SKU, ignoring case — the same three the API's
 * search reads (`bilingualProductSearch`), so a list filtered here and one
 * filtered by the server never disagree.
 */
export function matchesName(
  record: Named & { sku?: string | null },
  search: string,
): boolean {
  const term = search.trim().toLowerCase();
  if (!term) return true;
  return [record.name, record.nameAr, record.sku].some(
    (v) => typeof v === 'string' && v.toLowerCase().includes(term),
  );
}

/** `localName` bound to the page's locale. */
export function useLocalName() {
  const locale = useLocale();
  return (record: Named | null | undefined) => localName(record, locale);
}
