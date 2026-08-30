import { defineRouting } from 'next-intl/routing';

/**
 * Arabic first.
 *
 * The internal system defaults to English because the office reads it. The
 * store is read by shop owners in Egypt, so the default is theirs and English
 * is the alternative — not the other way round with Arabic bolted on.
 */
export const routing = defineRouting({
  locales: ['ar', 'en'],
  defaultLocale: 'ar',
});
