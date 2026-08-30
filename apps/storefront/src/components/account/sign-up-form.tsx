'use client';

import { CircleCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Link } from '../../i18n/navigation';
import { useSignUp } from '../../lib/session';
import { useRefusal } from '../requests/use-refusal';
import { FormAlert, PasswordField, SubmitButton, TextField } from './fields';
import {
  collect,
  emailError,
  passwordError,
  shopNameError,
  PASSWORD_MIN,
  type FieldErrors,
} from './validate';

/**
 * A shop asking to be let in.
 *
 * What this does NOT do is sign them in afterwards. The API returns no token
 * from signup on purpose — an account nobody has looked at yet can browse and
 * ask for an import, and nothing else — and inventing a session here would have
 * the store behaving as though the review had already happened, which the shop
 * would then discover at the basket instead.
 *
 * So the honest end of this flow is a sentence saying the account is waiting,
 * and the way to the sign-in screen.
 */
export function SignUpForm() {
  const t = useTranslations('auth');
  const tCommon = useTranslations('common');
  const refusal = useRefusal();

  const [shopName, setShopName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [created, setCreated] = useState<string | null>(null);

  const signUp = useSignUp();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (signUp.isPending) return;

    const found = collect({
      shopName: shopNameError(shopName, t),
      email: emailError(email, t),
      password: passwordError(password, t),
    });
    setErrors(found);
    if (Object.keys(found).length) return;

    signUp.mutate(
      {
        shopName: shopName.trim(),
        email: email.trim(),
        password,
        // Omitted rather than sent empty: the column is nullable and "" is not
        // a phone number anybody could ring.
        phone: phone.trim() ? phone.trim() : undefined,
      },
      {
        onSuccess: (result) => {
          setPassword('');
          signUp.reset();
          setCreated(result.displayName);
        },
      },
    );
  };

  if (created) {
    return (
      <div
        role="status"
        className="space-y-3 rounded-2xl bg-white p-5 text-start shadow-sm ring-1 ring-gray-200/70 ring-inset"
      >
        <p className="flex items-center gap-2 text-base font-semibold text-gray-900">
          <CircleCheck className="h-5 w-5 shrink-0 text-emerald-600" aria-hidden />
          {t('accountCreated')}
        </p>
        <p className="text-sm font-medium text-gray-700">{created}</p>
        <p className="text-sm text-gray-600">{t('awaitingReview')}</p>
        <Link
          href="/login"
          className="flex min-h-12 w-full items-center justify-center rounded-xl bg-brand-600 px-4 text-base font-semibold text-white hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
        >
          {t('signIn')}
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <TextField
        label={t('shopName')}
        name="shopName"
        autoComplete="organization"
        value={shopName}
        onChange={setShopName}
        error={errors.shopName}
      />

      <TextField
        label={t('email')}
        name="email"
        type="email"
        inputMode="email"
        autoComplete="email"
        value={email}
        onChange={setEmail}
        error={errors.email}
      />

      <TextField
        label={`${t('phone')} — ${tCommon('optional')}`}
        name="phone"
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        value={phone}
        onChange={setPhone}
      />

      <PasswordField
        label={t('password')}
        autoComplete="new-password"
        value={password}
        onChange={setPassword}
        error={errors.password}
        hint={t('passwordHint', { count: PASSWORD_MIN })}
      />

      {signUp.isError ? <FormAlert message={refusal(signUp.error, t('signUpFailed'))} /> : null}

      <SubmitButton pending={signUp.isPending} pendingLabel={t('creatingAccount')}>
        {t('signUp')}
      </SubmitButton>

      <p className="text-center text-sm text-gray-600">
        {t('haveAccount')}{' '}
        <Link
          href="/login"
          className="font-semibold text-brand-700 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
        >
          {t('signIn')}
        </Link>
      </p>
    </form>
  );
}
