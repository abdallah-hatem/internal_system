import { createHash } from 'node:crypto';

/**
 * One spelling for one request, so a confirmation can be bound to it.
 *
 * The client sends the same arguments twice — once for the preview, once to
 * commit — and nothing promises it will send the keys in the same order the
 * second time. Hashing `JSON.stringify` as-is would then refuse a request that
 * is exactly the one previewed. So keys are sorted at every depth; array order
 * is kept, because the order of an order's lines is part of what was shown.
 *
 * A key whose value is `undefined` is left out, the same as JSON leaves it
 * out: an optional field sent as nothing and not sent at all are one request.
 */
function canonical(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;

  const json = (value as { toJSON?: () => unknown }).toJSON;
  if (typeof json === 'function') return canonical(json.call(value));

  if (Array.isArray(value)) return value.map(canonical);

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined) sorted[key] = canonical(v);
  }
  return sorted;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value)) ?? 'null';
}

/** SHA-256 of the canonical form. What a confirmation token carries. */
export function inputHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('base64url');
}
