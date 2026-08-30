'use client';

import { CircleAlert, CircleCheck, Clock, LoaderCircle, LogOut, Store } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Link } from '../../i18n/navigation';
import { useMe, useSession, useSignOut } from '../../lib/session';
import { useRefusal } from '../requests/use-refusal';
import { LanguageSwitch } from './language-switch';
import { Notifications } from './notifications';

/**
 * The shop's own screen: who it is, whether it has been let in, and the two
 * settings it can change.
 *
 * A client component because everything on it hangs off a token the server
 * cannot see. The language switch is here rather than in the shell because it
 * belongs with the account and because the shell is a bottom bar with four tabs
 * on a phone — a fifth control there costs more than it gives.
 */
export function AccountPanel() {
  const t = useTranslations('account');
  const tAuth = useTranslations('auth');
  const tCommon = useTranslations('common');
  const tNav = useTranslations('nav');
  const refusal = useRefusal();

  const { signedIn, ready } = useSession();
  const signOut = useSignOut();
  const { data, isPending, isError, error, refetch } = useMe();

  // The server renders this signed-out because it cannot read `localStorage`.
  // Deciding before hydration would flash "you are not signed in" at a shop
  // that is, on every single visit.
  if (!ready) {
    return <Waiting label={tCommon('loading')} />;
  }

  if (!signedIn) {
    return (
      <section className="space-y-4 rounded-2xl bg-white p-5 text-start shadow-sm ring-1 ring-gray-200/70 ring-inset">
        <p className="text-base font-semibold text-gray-900">{t('signedOut')}</p>
        <p className="text-sm text-gray-600">{t('signedOutBody')}</p>

        <div className="space-y-2">
          <Link
            href="/login"
            className="flex min-h-12 w-full items-center justify-center rounded-xl bg-brand-600 px-4 text-base font-semibold text-white hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
          >
            {tAuth('signIn')}
          </Link>
          <Link
            href="/signup"
            className="flex min-h-12 w-full items-center justify-center rounded-xl border border-gray-300 bg-white px-4 text-base font-semibold text-gray-800 hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
          >
            {tAuth('signUp')}
          </Link>
        </div>
      </section>
    );
  }

  if (isPending) return <Waiting label={tCommon('loading')} />;

  if (isError) {
    // A 401 never lands here: the interceptor clears the token, the session
    // hook hears it, and this component has already re-rendered as signed out.
    // What reaches this branch is the network being down or the API being
    // unhappy, and both are worth a retry rather than a sign-out.
    return (
      <div className="flex flex-col items-start gap-3 rounded-2xl bg-red-50 p-4 text-start">
        <p role="alert" className="flex items-start gap-2 text-sm text-red-800">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {refusal(error)}
        </p>
        <button
          type="button"
          onClick={() => refetch()}
          className="inline-flex min-h-11 items-center rounded-lg bg-white px-4 text-sm font-semibold text-red-800 ring-1 ring-red-200 ring-inset"
        >
          {tCommon('retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <section className="space-y-3 rounded-2xl bg-white p-5 text-start shadow-sm ring-1 ring-gray-200/70 ring-inset">
        <p className="flex items-start gap-2">
          <Store className="mt-0.5 h-5 w-5 shrink-0 text-gray-400" aria-hidden />
          <span className="text-lg font-bold text-gray-900">{data.displayName}</span>
        </p>

        <VerificationLine verified={data.verified} />

        <dl className="space-y-2 border-t border-gray-100 pt-3 text-sm">
          <Row label={tAuth('email')} value={data.email} fallback={tCommon('none')} />
          <Row label={tAuth('phone')} value={data.phone} fallback={tCommon('none')} />
        </dl>
      </section>

      {/* No key, no section. Push is not configured on this API and a button
          that cannot subscribe is worse than none at all. */}
      {data.pushPublicKey ? <Notifications pushPublicKey={data.pushPublicKey} /> : null}

      <LanguageSwitch />

      <button
        type="button"
        onClick={signOut}
        className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border border-gray-300 bg-white px-4 text-base font-semibold text-gray-800 hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
      >
        <LogOut className="h-4 w-4" aria-hidden />
        {tNav('signOut')}
      </button>
    </div>
  );
}

/**
 * Whether this shop may order yet, said here rather than at the basket.
 *
 * An unverified shop can browse and can ask for an import, and finds out about
 * the rest by being refused when it tries to send a request — after picking
 * the parts. `account.unverified` says the same thing, in the same words, on
 * the screen a shop comes to when it wonders.
 */
function VerificationLine({ verified }: { verified: boolean }) {
  const t = useTranslations('account');

  if (verified) {
    return (
      <p
        data-verification="verified"
        className="flex items-start gap-2 text-sm font-medium text-emerald-700"
      >
        <CircleCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        {t('verified')}
      </p>
    );
  }

  return (
    <p
      data-verification="unverified"
      className="flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-sm font-medium text-amber-900"
    >
      <Clock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      {t('unverified')}
    </p>
  );
}

function Row({
  label,
  value,
  fallback,
}: {
  label: string;
  value: string | null;
  fallback: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-gray-500">{label}</dt>
      <dd className="min-w-0 truncate font-medium text-gray-900" dir="auto">
        {value || fallback}
      </dd>
    </div>
  );
}

function Waiting({ label }: { label: string }) {
  return (
    <p className="flex items-center justify-center gap-2 py-16 text-sm text-gray-500">
      <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
      {label}
    </p>
  );
}
