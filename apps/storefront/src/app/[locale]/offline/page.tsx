import { getTranslations, setRequestLocale } from 'next-intl/server';

/**
 * What the service worker shows when a navigation cannot reach the network.
 *
 * Deliberately says the store is unreachable rather than showing a cached
 * catalogue: a stale price is a figure a shop quotes to a customer, and a stale
 * "in stock" is a promise they act on.
 */
export default async function Offline({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('common');

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-xl font-semibold">{t('appName')}</h1>
      <p className="text-gray-500">{t('somethingWentWrong')}</p>
    </main>
  );
}
