import { getTranslations, setRequestLocale } from 'next-intl/server';

import { SignInForm } from '../../../components/account/sign-in-form';

/**
 * The sign-in screen.
 *
 * A server component around a client form, the same shape as every other page
 * here: the heading is rendered and translated without waiting for JavaScript,
 * and only the part that must read and write a token in `localStorage` runs in
 * the browser.
 */
export default async function LoginPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('auth');

  return (
    <div className="mx-auto max-w-md px-4 py-6">
      <h1 className="pb-4 text-xl font-bold">{t('signIn')}</h1>
      <SignInForm />
    </div>
  );
}
