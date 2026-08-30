import { setRequestLocale } from 'next-intl/server';

import { CatalogueList } from '../../components/catalogue/catalogue-list';

/**
 * The catalogue.
 *
 * A thin server shell: the list itself has to run in the browser, because the
 * price on every card depends on the token in `localStorage` and a server
 * render would quote the anonymous one to a signed-in shop.
 */
export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  return <CatalogueList />;
}
