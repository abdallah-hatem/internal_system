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
export function displayName(record: Named, locale: string): string {
  return locale === 'ar' && present(record.nameAr)
    ? record.nameAr.trim()
    : record.name;
}

/** The same choice for a description. Null only when neither exists. */
export function displayDescription(
  record: Described,
  locale: string,
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

/** Vowel marks, shadda, sukun, madda and hamza marks, superscript alef, tatweel. */
const ARABIC_MARKS = /[\u064B-\u065F\u0670\u0640]/g;

/**
 * The Arabic search key (§3, owner 2026-10-15): the text as a search compares
 * it, so that the spellings people type for one word find each other.
 *
 *   - أ إ آ  read as ا
 *   - ة      reads as ه
 *   - ى      reads as ي
 *   - ؤ ئ    read as و ي — the hamza on them is a mark, as Unicode has it,
 *            and the assistant's matcher has always read them so
 *   - the vowel marks (U+064B–U+065F: fatha, damma, kasra, their tanween,
 *     shadda, sukun, and the madda and hamza marks), the superscript alef
 *     (U+0670) and the tatweel ـ (U+0640) are dropped
 *   - case is ignored; surrounding space is trimmed
 *
 * Spelling only: no synonyms, no typo forgiveness, no meaning. Latin text
 * passes through lower-cased and otherwise untouched, so an English search
 * behaves as it always has.
 *
 * Defined once. The assistant's matcher folds Arabic through it; the stored
 * `products.name_ar_search` holds it; Postgres has the same rule as
 * `arabic_search_key()` (migration `20261015100000_arabic_search_key`) for the
 * backfill and `scripts/check-data.sh`, and 99-arabic-search pins the two
 * together. The office and the storefront carry copies, each pinned to this
 * one by a unit test over `arabic-search-cases.json`.
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

/**
 * What `products.name_ar_search` holds for an Arabic name, in the shape the
 * write takes: `undefined` leaves it alone (the name was not sent), `null`
 * when there is no Arabic name — or nothing of it left to search.
 */
export function nameArSearchFor(
  nameAr: string | null | undefined,
): string | null | undefined {
  if (nameAr === undefined) return undefined;
  return arabicSearchKey(nameAr) || null;
}

/**
 * The `where` that matches a search typed in either language: the English
 * name as typed, the Arabic name through its search key, and the SKU. One
 * definition for the office lists and pickers, the storefront catalogue and
 * the assistant's `find_products`, so a search that finds "خوذه" in one place
 * finds "خوذة" in all of them.
 *
 * Prisma's `contains` cannot fold, so the Arabic side reads the stored key
 * (`nameArSearch`) against the key of the term. A term that is nothing but
 * marks has no key and searches the English name and SKU only.
 */
export function bilingualProductSearch(term: string) {
  const key = arabicSearchKey(term);
  return [
    { name: { contains: term, mode: 'insensitive' as const } },
    ...(key
      ? [{ nameArSearch: { contains: key, mode: 'insensitive' as const } }]
      : []),
    { sku: { contains: term, mode: 'insensitive' as const } },
  ];
}
