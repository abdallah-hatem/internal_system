import { getTranslations, setRequestLocale } from 'next-intl/server';

import { AskForPart } from '../../../components/imports/import-form';
import { ImportList } from '../../../components/imports/import-list';

/**
 * Everything this shop has asked us to bring in.
 *
 * A server component so the heading is rendered and translated without waiting
 * for JavaScript; the list and the form underneath are client components,
 * because both read a bearer token held in `localStorage` that the server
 * cannot see. Nothing here takes a customer id — the API takes the shop from
 * the token, so there is no route on which one shop could ask for another's.
 *
 * Unlike the orders tab this is open to an account that has not been verified
 * yet. It holds no stock and promises nothing, and it is the one thing a shop
 * that signed up this morning can actually do.
 */
export default async function ImportsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('imports');

  return (
    <div className="mx-auto max-w-2xl py-4">
      <h1 className="px-4 pb-1 text-xl font-bold">{t('title')}</h1>
      <p className="px-4 pb-3 text-sm text-gray-600">{t('intro')}</p>

      <div className="px-4 pb-4">
        <AskForPart />
      </div>

      <ImportList />
    </div>
  );
}
