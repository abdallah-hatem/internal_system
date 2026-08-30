'use client';

import { CircleAlert, Eye, EyeOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';

/**
 * The two inputs and the one alert that both auth forms are made of.
 *
 * Written once rather than twice: the sign-in and sign-up forms ask for the
 * same email and the same password, and two copies drift on the first change to
 * either — a `type` or an `autoComplete` fixed on one screen and not the other.
 *
 * Every control is at least 44px tall. This is used one-handed, standing up, in
 * a workshop, and a 32px input is a control that takes three attempts.
 */

const CONTROL =
  'block min-h-11 w-full rounded-xl border bg-white px-3 py-2.5 text-base text-start ' +
  'placeholder:text-gray-400 focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-brand-600';

export function TextField({
  label,
  value,
  onChange,
  error,
  hint,
  type = 'text',
  autoComplete,
  inputMode,
  name,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
  type?: 'text' | 'email' | 'tel';
  autoComplete?: string;
  inputMode?: 'text' | 'email' | 'tel';
  name?: string;
}) {
  const id = useId();
  const describedBy = [error ? `${id}-error` : null, hint ? `${id}-hint` : null]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-gray-700">
        {label}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        inputMode={inputMode}
        // `dir="auto"` and not the page direction: an email address and a phone
        // number are Latin text, and forcing them right-to-left puts the cursor
        // and the punctuation in the wrong place on an Arabic screen.
        dir="auto"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={`${CONTROL} ${error ? 'border-red-400' : 'border-gray-300'}`}
      />
      <FieldNotes id={id} error={error} hint={hint} />
    </div>
  );
}

export function PasswordField({
  label,
  value,
  onChange,
  error,
  hint,
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
  autoComplete: 'current-password' | 'new-password';
}) {
  const t = useTranslations('auth');
  const id = useId();
  const [shown, setShown] = useState(false);
  const describedBy = [error ? `${id}-error` : null, hint ? `${id}-hint` : null]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-gray-700">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          type={shown ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          dir="auto"
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          className={`${CONTROL} pe-12 ${error ? 'border-red-400' : 'border-gray-300'}`}
        />
        {/* Inside a form, and a bare button defaults to submitting it — which
            here would send a half-typed password to be refused. */}
        <button
          type="button"
          onClick={() => setShown((s) => !s)}
          aria-label={shown ? t('hidePassword') : t('showPassword')}
          aria-pressed={shown}
          className="absolute inset-y-0 end-0 flex w-12 items-center justify-center text-gray-500 hover:text-gray-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
        >
          {shown ? (
            <EyeOff className="h-5 w-5" aria-hidden />
          ) : (
            <Eye className="h-5 w-5" aria-hidden />
          )}
        </button>
      </div>
      <FieldNotes id={id} error={error} hint={hint} />
    </div>
  );
}

function FieldNotes({ id, error, hint }: { id: string; error?: string; hint?: string }) {
  return (
    <>
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-gray-500">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-xs font-medium text-red-700">
          {error}
        </p>
      ) : null}
    </>
  );
}

/** What the API refused, said once, above the button that caused it. */
export function FormAlert({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-xl bg-red-50 p-3 text-sm text-red-800"
    >
      <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{message}</span>
    </p>
  );
}

export function SubmitButton({
  children,
  pending,
  pendingLabel,
}: {
  children: React.ReactNode;
  pending: boolean;
  pendingLabel: string;
}) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="min-h-12 w-full rounded-xl bg-brand-600 px-4 text-base font-semibold text-white hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:opacity-60"
    >
      {pending ? pendingLabel : children}
    </button>
  );
}
