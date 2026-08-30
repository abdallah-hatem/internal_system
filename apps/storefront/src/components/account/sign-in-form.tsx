'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Link, useRouter } from '../../i18n/navigation';
import { useSignIn } from '../../lib/session';
import { useRefusal } from '../requests/use-refusal';
import { FormAlert, PasswordField, SubmitButton, TextField } from './fields';
import { collect, emailError, passwordError, type FieldErrors } from './validate';

/**
 * The shop door.
 *
 * Four refusals can come back and each one asks for something different of the
 * reader: a wrong password is retyped, an office account goes to the internal
 * system, an inactive or unlinked account needs a phone call. All four are
 * already worded in both languages under `errors`, so nothing here writes an
 * English sentence of its own — `useRefusal` resolves the code and falls back
 * to the server's English only for a code this build has never heard of.
 */
export function SignInForm() {
  const t = useTranslations('auth');
  const refusal = useRefusal();
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});

  const signIn = useSignIn();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (signIn.isPending) return;

    const found = collect({
      email: emailError(email, t),
      password: passwordError(password, t),
    });
    setErrors(found);
    if (Object.keys(found).length) return;

    signIn.mutate(
      { email: email.trim(), password },
      {
        onSuccess: () => {
          // Dropped the moment it is no longer needed. It was never anywhere
          // but this state and the request body, and it does not stay here to
          // sit in a component that a back navigation might remount.
          setPassword('');
          signIn.reset();
          router.replace('/');
        },
      },
    );
  };

  return (
    /* `noValidate` so the messages the reader sees are these ones. The browser's
       own bubble is in the browser's language, which on an Arabic screen is
       whatever the phone was set up in — not what this reader chose. */
    <form onSubmit={submit} noValidate className="space-y-4">
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

      <PasswordField
        label={t('password')}
        autoComplete="current-password"
        value={password}
        onChange={setPassword}
        error={errors.password}
      />

      {signIn.isError ? <FormAlert message={refusal(signIn.error, t('loginFailed'))} /> : null}

      <SubmitButton pending={signIn.isPending} pendingLabel={t('signingIn')}>
        {t('signIn')}
      </SubmitButton>

      <p className="text-center text-sm text-gray-600">
        {t('noAccount')}{' '}
        <Link
          href="/signup"
          className="font-semibold text-brand-700 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
        >
          {t('signUp')}
        </Link>
      </p>
    </form>
  );
}
