import { badRequest } from './api-error';

/**
 * Arabic names for categories and products (BUSINESS_LOGIC §3, owner
 * 2026-10-14). The one place the API decides what an Arabic name is, how it is
 * searched, and which name a reader of a language is shown.
 *
 * The API itself mostly sends both names and lets the client choose, because
 * it does not know which language the reader picked (CLAUDE.md §9). Where it
 * does have to pick — a message rendered for a known locale — it calls
 * `displayName` here, never `nameAr ?? name` inline.
 */

export type Locale = 'en' | 'ar';

/** As long as the English fields may be (the assistant's limits, §16). */
export const NAME_AR_MAX = 200;
export const DESCRIPTION_AR_MAX = 1000;

export interface Named {
  name: string;
  nameAr?: string | null;
}

export interface Described {
  description?: string | null;
  descriptionAr?: string | null;
}

const present = (v: string | null | undefined): v is string =>
  typeof v === 'string' && v.trim() !== '';

/**
 * The name a reader of `locale` is shown: the Arabic when the reader is on
 * Arabic and there is one, otherwise the English. Never blank — a product with
 * no Arabic name is shown in English, not as an empty line.
 */
export function displayName(record: Named, locale: Locale | string): string {
  return locale === 'ar' && present(record.nameAr)
    ? record.nameAr.trim()
    : record.name;
}

/** The same choice for a description. Null only when neither exists. */
export function displayDescription(
  record: Described,
  locale: Locale | string,
): string | null {
  if (locale === 'ar' && present(record.descriptionAr))
    return record.descriptionAr.trim();
  return present(record.description) ? record.description : null;
}

/**
 * An optional Arabic text field as a request sent it.
 *
 *   undefined  not sent — on an update, leave what is stored alone
 *   null / ''  cleared — stored as null, so "no Arabic" has one spelling
 *   string     trimmed; refused past `max`
 *
 * Anything else (a number, an object) is a malformed request, not a name.
 */
export function arabicText(
  value: unknown,
  field: 'nameAr' | 'descriptionAr',
  max: number,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw badRequest('VALIDATION_FAILED', `${field} must be text.`, {
      fields: field,
    });
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) {
    throw badRequest(
      field === 'nameAr' ? 'NAME_AR_TOO_LONG' : 'DESCRIPTION_AR_TOO_LONG',
      `The Arabic ${field === 'nameAr' ? 'name' : 'description'} can be at most ${max} characters (it has ${trimmed.length}).`,
      { max, length: trimmed.length },
    );
  }
  return trimmed;
}

/**
 * The `where` that matches a search typed in either language: the English
 * name, the Arabic name, and the SKU. One definition for the office lists and
 * pickers, the storefront catalogue and the assistant's `find_products`, so a
 * search that finds "تيل" in one place finds it in all of them.
 */
export function bilingualProductSearch(term: string) {
  return [
    { name: { contains: term, mode: 'insensitive' as const } },
    { nameAr: { contains: term, mode: 'insensitive' as const } },
    { sku: { contains: term, mode: 'insensitive' as const } },
  ];
}
