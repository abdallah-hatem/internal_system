'use client';

import { useTranslations } from 'next-intl';

/**
 * Say the API's refusal in the reader's language.
 *
 * The body is `{ error: { code, message, params } }`. Reading
 * `err.response.data.message` gets `undefined` — thirty-six call sites in the
 * internal app did exactly that, so every refusal fell through to a generic
 * toast and the explanation reached nobody, with the toast still appearing so
 * nothing looked broken.
 *
 * Branching on the message text is the other trap: `/not enough/.test(msg)`
 * stops matching the moment the reader is on Arabic, which here is the default.
 * Branch on `error.code`.
 */
export function useApiError() {
  const t = useTranslations('errors');

  return (err: any, fallback: string): string => {
    const error = err?.response?.data?.error;
    if (!error?.code) return fallback;

    try {
      return t(error.code as any, error.params ?? {});
    } catch {
      // A code this build has never heard of. The API's English sentence is
      // the fallback on purpose — untranslated beats blank.
      return error.message || fallback;
    }
  };
}
