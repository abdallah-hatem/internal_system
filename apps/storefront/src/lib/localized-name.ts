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
