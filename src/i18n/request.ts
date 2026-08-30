import { getRequestConfig } from 'next-intl/server';
import { routing } from './routing';

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = routing.locales.includes(requested as any)
    ? (requested as (typeof routing.locales)[number])
    : routing.defaultLocale;

  return { locale, messages: (await import(`./locales/${locale}.json`)).default };
});
