import { defineRouting } from 'next-intl/routing';

/**
 * Arabic, for everyone, until they choose otherwise.
 *
 * The internal system defaults to English because the office reads it. The
 * store is read by shop owners in Egypt, so the default is theirs and English
 * is the alternative — not the other way round with Arabic bolted on.
 *
 * `localeDetection: false` is the part that makes that true rather than
 * nearly true. next-intl otherwise honours `Accept-Language`, which makes
 * `defaultLocale` only a fallback: a phone set to English would land on `/en`
 * and its owner might never see the Arabic store. Plenty of phones here are
 * set to English by whoever sold them, and that is not the same as a person
 * choosing to read English.
 *
 * So the store opens in Arabic for everybody and English is one tap away.
 * Decided by the owner 2026-08-31; see docs/business-rules.md §13.
 */
export const routing = defineRouting({
  locales: ['ar', 'en'],
  defaultLocale: 'ar',
  localeDetection: false,
});
