import { getTranslations, setRequestLocale } from 'next-intl/server';

import { AccountPanel } from '../../../components/account/account-panel';

/**
 * The account tab.
 *
 * Reachable signed out as well as signed in — it is the fourth tab in the
 * bottom bar and the catalogue links to it as "sign in to see your trade
 * prices" — so the panel underneath decides which of the two screens this is,
 * once the browser has told it whether there is a token.
 */
export default async function AccountPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('account');

  return (
    <div className="mx-auto max-w-md px-4 py-6">
      <h1 className="pb-4 text-xl font-bold">{t('title')}</h1>
      <AccountPanel />
    </div>
  );
}
