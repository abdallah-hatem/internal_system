/**
 * Name comparison for reading receipts. Pure and deterministic.
 *
 * Two names are the SAME when their letters and digits agree once case,
 * spacing and punctuation are ignored: "Guangzhou  Parts" and "GUANGZHOU-PARTS"
 * are one supplier.
 *
 * Two names are SIMILAR when their similarity — 1 − (edit distance ÷ length of
 * the longer), measured on those same letters and digits — is at least
 * SIMILARITY_THRESHOLD, 0.8. That is roughly one slip per five characters:
 * "Guangzou Parts" against "Guangzhou Parts" scores 0.93 and is offered as a
 * candidate, while "Moto Parts" against "Auto Parts" scores 0.78 and is not,
 * because two real businesses a letter or two apart are more common on short
 * names than a misreading is. A similar name is only ever offered — never
 * silently accepted — so the threshold decides what is asked, not what is
 * recorded.
 */
export const SIMILARITY_THRESHOLD = 0.8;

/** Lower-case words of letters and digits, accents folded. */
export function nameTokens(value: string | null | undefined): string[] {
  return (value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** The name with case, spacing and punctuation removed. */
export function nameKey(value: string | null | undefined): string {
  return nameTokens(value).join('');
}

/**
 * Words that say what kind of company it is, not which one. "Guangzhou Parts
 * Co., Ltd." on an invoice is "Guangzhou Parts" in the supplier list.
 */
const COMPANY_SUFFIXES = new Set([
  'co',
  'company',
  'corp',
  'corporation',
  'inc',
  'limited',
  'ltd',
  'llc',
  'fze',
  'fzco',
  'fzc',
  'trading',
]);

/** A supplier's key: the name key without legal-form words, unless that leaves nothing. */
export function supplierKey(value: string | null | undefined): string {
  const tokens = nameTokens(value);
  const kept = tokens.filter((t) => !COMPANY_SUFFIXES.has(t));
  return (kept.length ? kept : tokens).join('');
}

/** A SKU compared as printed codes are: case, spaces and dashes ignored. */
export function skuKey(value: string | null | undefined): string {
  return (value ?? '').toUpperCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** An invoice number as §15 compares it: trimmed and case-insensitive. */
export function invoiceKey(value: string | null | undefined): string {
  return (value ?? '').trim().toUpperCase();
}

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length];
}

/** 1 for identical keys, 0 for nothing in common. Keys must already be normalised. */
export function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (!longest) return 0;
  return 1 - editDistance(a, b) / longest;
}

/** Every token of `part` appears in `whole`. An empty `part` contains nothing. */
export function tokensWithin(part: string[], whole: string[]): boolean {
  if (!part.length) return false;
  const set = new Set(whole);
  return part.every((t) => set.has(t));
}
