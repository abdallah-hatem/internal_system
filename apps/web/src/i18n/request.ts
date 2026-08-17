import { getRequestConfig } from 'next-intl/server';
import type { GetRequestConfigParams } from 'next-intl/server';

export default getRequestConfig(async ({ requestLocale }: GetRequestConfigParams) => {
  // Use the locale from the URL segment, fallback to 'en'
  let locale = await requestLocale;
  if (!locale || !['en', 'ar'].includes(locale)) {
    locale = 'en';
  }

  return {
    locale,
    messages: (await import(`./locales/${locale}.json`)).default,
  };
});
