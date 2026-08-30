'use client';

import { useTranslations } from 'next-intl';

import { useApiError } from '../../lib/api-error';

/**
 * A refusal, said once, the same way on every screen in this flow.
 *
 * This carried three cases when it was written. Two of them — a code whose
 * message comes back as the dotted key path, and `NOT_FOUND` pasting an English
 * `entity` noun into an Arabic sentence — were worked around here because
 * `lib/api-error.ts` held a shorter copy of the resolver than the internal
 * system's, and that copy trusted `t()` to throw on a missing key when
 * next-intl returns the key path instead.
 *
 * That copy has been replaced with the real one, which handles both. Handling
 * them again here would be a third definition of the same rule, and the one
 * most likely to drift — so what is left is only the case the resolver cannot
 * see from where it sits.
 *
 * A 401 from the passport guard arrives as Nest's bare `Unauthorized`: a string
 * rather than a coded body, so the exception filter labels it `ERROR` and there
 * is nothing to translate. A shop whose session has lapsed should be told that,
 * not shown a raw code.
 *
 * The branch is on the status and the code, never on the English text — that
 * stops matching the moment the reader is on Arabic, and Arabic is the default
 * here.
 */
export function useRefusal() {
  const toMessage = useApiError();
  const tErrors = useTranslations('errors');
  const tCommon = useTranslations('common');

  return (err: unknown, fallback?: string): string => {
    const response = (err as { response?: { status?: number; data?: unknown } })?.response;
    const code = (response?.data as { error?: { code?: string } } | undefined)?.error?.code;
    const generic = fallback ?? tCommon('somethingWentWrong');

    if (response?.status === 401 && (!code || code === 'ERROR')) return tErrors('AUTH_REQUIRED');

    return toMessage(err, generic);
  };
}
