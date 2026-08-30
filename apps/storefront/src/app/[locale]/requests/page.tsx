import { getTranslations, setRequestLocale } from 'next-intl/server';

import { BasketLauncher } from '../../../components/requests/basket-sheet';
import { RequestList } from '../../../components/requests/request-list';

/**
 * Everything this shop has asked for.
 *
 * The page itself is a server component so the heading is rendered and
 * translated without waiting for JavaScript; the list underneath is a client
 * component because it reads a bearer token held in `localStorage`, which the
 * server cannot see. Nothing here takes a customer id — the API takes the shop
 * from the token, so there is no route on which one shop could ask for
 * another's.
 */
export default async function RequestsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('requests');

  return (
    <div className="mx-auto max-w-2xl py-4">
      <h1 className="px-4 pb-3 text-xl font-bold">{t('title')}</h1>
      <RequestList />

      {/* A basket half built in the catalogue does not disappear because the
          shop came here to check on an earlier order. The launcher renders
          nothing while the basket is empty, which is most of the time. */}
      <BasketLauncher />
    </div>
  );
}
