'use client';

import { useTranslations } from 'next-intl';
import { useCodeLabel, type CodeKind } from './labels';

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
/** Says one code of one kind in the reader's language — `useCodeLabel`'s shape. */
export type CodeLabel = (kind: CodeKind, code: string) => string;

/**
 * Params that are codes, by refusal: which `codes.<kind>` says each one. The
 * API sends `owner: 'SALE_RETURN'`, never "sale return" — an English noun in
 * a param lands verbatim inside the Arabic sentence (R1b, rule 9). A list
 * param (`allowed`) is comma-separated codes, each said on its own.
 */
export const PARAM_KINDS: Record<string, Record<string, CodeKind>> = {
  ENTRY_OWNED_ELSEWHERE: { owner: 'referenceType' },
  DATE_IN_FUTURE: { label: 'dateField' },
  BAD_STATUS_TRANSITION: { from: 'cycleStatus', to: 'cycleStatus', allowed: 'cycleStatus' },
  CYCLE_STATUS_CHANGED: { status: 'cycleStatus', expected: 'cycleStatus' },
  CYCLE_NOT_ARRIVED: { status: 'cycleStatus' },
  CYCLE_STATUS_BLOCKS_PO: { status: 'cycleStatus' },
  CYCLE_FINAL_NO_LEGS: { status: 'cycleStatus' },
  SETTLEMENT_LOCKED: { status: 'settlementStatus' },
  ONLY_CONFIRMED_RETURNABLE: { status: 'orderStatus' },
  CYCLE_CLOSED_FOR_FINANCING: { status: 'cycleStatus' },
  TRANSFER_SOURCE_NOT_SELLING: { status: 'cycleStatus' },
  TRANSFER_TARGET_CLOSED: { status: 'cycleStatus' },
};

export function resolveApiError(
  err: unknown,
  t: Translate,
  fallback: string,
  codeLabel?: CodeLabel,
): string {
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
  const kinds = PARAM_KINDS[body.code];
  if (kinds && codeLabel) {
    for (const [name, kind] of Object.entries(kinds)) {
      const value = params[name];
      if (typeof value !== 'string' || !value) continue;
      params[name] = value
        .split(',')
        .map((c) => safeLabel(codeLabel, kind, c.trim()))
        .join(', ');
    }
  }

  const said = lookup(t, body.code, serverMessage, params);
  // A calendar day ("2026-10-11") inside an Arabic sentence is reordered by
  // the bidi algorithm into "11-10-2026" — a different-looking date (I1,
  // 2026-10-11, seen on the date-range refusal). In an Arabic sentence each
  // one is isolated as its own left-to-right run; English is left exactly as
  // it was, invisible marks and all.
  if (!/[\u0600-\u06FF]/.test(said)) return said;
  let isolated = false;
  for (const [name, value] of Object.entries(params)) {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      params[name] = `\u2066${value}\u2069`;
      isolated = true;
    }
  }
  return isolated ? lookup(t, body.code, serverMessage, params) : said;
}

/** A code's words, or the code itself — a missing label must not crash an error. */
function safeLabel(codeLabel: CodeLabel, kind: CodeKind, code: string): string {
  try {
    return codeLabel(kind, code) || code;
  } catch {
    return code;
  }
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
  const codeLabel = useCodeLabel();
  return (err: unknown, fallback: string) => resolveApiError(err, t, fallback, codeLabel);
}
