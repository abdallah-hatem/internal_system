import { getTranslations, setRequestLocale } from 'next-intl/server';

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('catalogue');

  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      <p className="mt-2 text-gray-500">{t('searchPlaceholder')}</p>
    </main>
  );
}
