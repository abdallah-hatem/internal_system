'use client';

import { useTranslations } from 'next-intl';

/**
 * Turns whatever the API refused with into a sentence the reader can act on.
 *
 * Two things were wrong before this existed.
 *
 * The shape: the API answers `{ error: { code, message, … } }`, but most call
 * sites read `err.response.data.message` — one level too shallow, so it was
 * always undefined and every refusal fell through to a generic "Failed to save"
 * written at the call site. The API's careful explanations reached nobody.
 *
 * The language: those messages are English sentences thrown from services. The
 * API does not translate them and should not — it cannot know which language
 * the reader picked, and this app already knows, from the URL.
 *
 * So the API names the refusal with a stable code and this resolves it against
 * the `errors` namespace. A code with no translation yet falls back to the
 * server's English rather than to nothing, which keeps a new refusal merely
 * untranslated instead of invisible.
 *
 * Copied verbatim from the internal system rather than rewritten. The first
 * version here was a shorter one of my own that trusted `t()` to throw on a
 * missing key — next-intl returns the dotted key path instead, so the `catch`
 * never ran and `errors.NOT_ENOUGH_STOCK` would have reached a shop's screen
 * looking like a broken template. Two apps translating the same codes is one
 * rule; it does not get two definitions.
 */

interface ApiErrorShape {
  response?: {
    data?: {
      error?: {
        code?: string;
        message?: string;
        params?: Record<string, string | number>;
      };
    };
  };
  message?: string;
}

type Translate = (key: string, values?: Record<string, string | number>) => string;

export function resolveApiError(err: unknown, t: Translate, fallback: string): string {
  const e = err as ApiErrorShape;
  const body = e?.response?.data?.error;
  const serverMessage = body?.message || e?.message || fallback;

  if (!body?.code || body.code === 'ERROR') return serverMessage;

  // A NOT_FOUND names the missing thing in `entity`, which is itself a key —
  // pasting an English noun into an Arabic sentence is what this avoids.
  const params: Record<string, string | number> = { ...body.params };
  if (typeof params.entity === 'string') {
    params.entity = lookup(t, `entity.${params.entity}`, params.entity);
  }

  return lookup(t, body.code, serverMessage, params);
}

/**
 * One translation attempt that cannot take the screen down.
 *
 * A missing key must never throw here: the reader is already looking at an
 * error, and turning a refusal they could have acted on into a blank page or a
 * crash is strictly worse than showing them the English. Depending on config,
 * next-intl either throws or returns the dotted key path, so both count as a
 * miss.
 */
function lookup(
  t: Translate,
  key: string,
  fallback: string,
  values?: Record<string, string | number>,
): string {
  try {
    const value = t(key, values);
    const missing = value === key || value.endsWith(`.${key}`);
    return missing ? fallback : value;
  } catch {
    return fallback;
  }
}

/** The hook form, for components. */
export function useApiError() {
  const t = useTranslations('errors');
  return (err: unknown, fallback: string) => resolveApiError(err, t, fallback);
}
