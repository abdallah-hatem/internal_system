'use client';

import { AlertCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useApiError } from '../../lib/api-error';

/**
 * What the API refused, in the reader's language.
 *
 * Everything goes through `useApiError`, which reads `error.code` out of
 * `{ error: { code, message, params } }`. Reaching for `response.data.message`
 * gets `undefined`, and branching on the English sentence stops matching the
 * moment the reader is on Arabic — which here is the default.
 */
export function QueryError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const t = useTranslations('common');
  const tErrors = useTranslations('errors');
  const describe = useApiError();

  return (
    <div
      role="alert"
      className="flex flex-col items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-start"
    >
      <p className="flex items-start gap-2 text-sm text-red-800">
        <AlertCircle aria-hidden className="mt-0.5 h-5 w-5 shrink-0" />
        <span>{describe(error, tErrors('generic'))}</span>
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex min-h-11 items-center rounded-lg border border-red-300 bg-white px-4 text-sm font-semibold text-red-800 hover:bg-red-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
      >
        {t('retry')}
      </button>
    </div>
  );
}
