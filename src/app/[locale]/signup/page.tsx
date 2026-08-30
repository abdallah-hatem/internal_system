import { getTranslations, setRequestLocale } from 'next-intl/server';

import { SignUpForm } from '../../../components/account/sign-up-form';

/**
 * Creating a shop account.
 *
 * What comes back from this is an account waiting to be looked at, not a
 * session — so the screen ends on a sentence saying so and a way to the sign-in
 * form, rather than dropping the shop into a catalogue that will refuse its
 * first order without explanation.
 */
export default async function SignUpPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('auth');

  return (
    <div className="mx-auto max-w-md px-4 py-6">
      <h1 className="pb-4 text-xl font-bold">{t('signUp')}</h1>
      <SignUpForm />
    </div>
  );
}
