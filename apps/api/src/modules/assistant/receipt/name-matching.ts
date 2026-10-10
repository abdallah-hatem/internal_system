/**
 * Name comparison — the one matcher for receipts (suppliers and products) and
 * for recording a sale (products and customers). Pure and deterministic;
 * `matchByName` at the bottom is the entry point.
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

// ── The shared matcher ────────────────────────────────────────────────────

/**
 * A word as the matcher compares it: a plural turned singular, so "pads" and
 * "pad" are one word. Deliberately simple — the words on a parts invoice are
 * English nouns, and a wrong singular costs only a weaker score, never a
 * match: nothing but an exact name or SKU is ever taken without asking.
 */
export function singular(token: string): string {
  if (token.length <= 3 || /\d/.test(token)) return token;
  if (token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (/(ss|sh|ch|x|z)es$/.test(token)) return token.slice(0, -2);
  if (token.endsWith('s') && !token.endsWith('ss') && !token.endsWith('us'))
    return token.slice(0, -1);
  return token;
}

export type MatchKind = 'product' | 'supplier' | 'customer';

/** The words of a name, singular. Legal-form words dropped for a supplier. */
export function matchTokens(
  value: string | null | undefined,
  kind: MatchKind = 'product',
): string[] {
  const tokens = nameTokens(value);
  const kept =
    kind === 'supplier'
      ? tokens.filter((t) => !COMPANY_SUFFIXES.has(t))
      : tokens;
  return (kept.length ? kept : tokens).map(singular);
}

/** The exact-match key for a kind of name. */
export function keyFor(
  kind: MatchKind,
): (v: string | null | undefined) => string {
  return kind === 'supplier' ? supplierKey : nameKey;
}

/** Two words are alike when equal, or — four letters and up — one slip apart. */
function wordsAlike(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 4) return false;
  return similarity(a, b) >= SIMILARITY_THRESHOLD;
}

/** How many of `a`'s words have a partner in `b`, each partner used once. */
function sharedWords(a: string[], b: string[]): number {
  const free = b.slice();
  let shared = 0;
  for (const word of a) {
    const i = free.findIndex((w) => wordsAlike(word, w));
    if (i >= 0) {
      shared++;
      free.splice(i, 1);
    }
  }
  return shared;
}

/**
 * The share of the shorter name's words the other must also have before it is
 * offered. Two in three: "Honda CBR brake pads (front)" offers "Honda CBR
 * Brake Pad" (all four of its words), while "Moto Parts" (one word of two)
 * does not offer "Auto Parts".
 */
export const WORD_COVERAGE_THRESHOLD = 2 / 3;

/**
 * How alike two names are, 0–1, for ranking candidates. The better of the
 * whole-name similarity (a misread letter: "Sparck plug") and the words in
 * common (word order, plurals, extra descriptors: "matt black, size L"),
 * each counted only past its threshold. 0 means "not worth offering".
 */
export function nameScore(
  query: string | null | undefined,
  name: string,
  kind: MatchKind = 'product',
): number {
  const key = keyFor(kind);
  const whole = similarity(key(query), key(name));
  const q = matchTokens(query, kind);
  const n = matchTokens(name, kind);
  const shorter = Math.min(q.length, n.length);
  const shared = shorter ? sharedWords(q, n) : 0;
  const byWords =
    shorter && shared / shorter >= WORD_COVERAGE_THRESHOLD
      ? (2 * shared) / (q.length + n.length)
      : 0;
  const byWhole = whole >= SIMILARITY_THRESHOLD ? whole : 0;
  return Math.max(byWords, byWhole);
}

export type MatchVia = 'id' | 'sku' | 'name' | 'name-similar';

export interface Matchable {
  id: string;
  name: string;
  sku?: string | null;
}

export interface Ranked<T> {
  item: T;
  via: MatchVia;
  /** 1 for an exact id, SKU or name; below 1 for anything merely close. */
  score: number;
}

/**
 * - `matched`: exactly one exact id, SKU or name — taken without a question.
 * - `several`: two or more exact, or two or more close — "which one?".
 * - `close`: exactly one close name — "is it this one, or not?".
 * - `unknown`: nothing close at all.
 */
export type NameMatch<T> =
  | { status: 'matched'; match: Ranked<T> }
  | { status: 'several'; candidates: Ranked<T>[] }
  | { status: 'close'; candidates: Ranked<T>[] }
  | { status: 'unknown'; candidates: [] };

export const MAX_CANDIDATES = 5;

/**
 * The one matcher — receipts' products and suppliers, and the sale tool's
 * products and customers (BUSINESS_LOGIC §16: a close name is never the same
 * thing until the partner says so).
 *
 * Settled only by: the id itself, one exact SKU (case, spaces, dashes
 * ignored), or one exact name (case, spacing, punctuation ignored, and for a
 * supplier its legal-form words). Everything weaker comes back as ranked
 * candidates. Plurals, word order and extra descriptors widen what is
 * OFFERED, never what is TAKEN.
 */
export function matchByName<T extends Matchable>(
  query: { id?: string | null; name?: string | null; sku?: string | null },
  items: readonly T[],
  kind: MatchKind = 'product',
): NameMatch<T> {
  const decide = (found: Ranked<T>[]): NameMatch<T> | null =>
    found.length === 1
      ? { status: 'matched', match: found[0] }
      : found.length > 1
        ? { status: 'several', candidates: found.slice(0, MAX_CANDIDATES) }
        : null;

  const id = query.id?.trim().toLowerCase();
  if (id) {
    const byId = items.find((i) => i.id.toLowerCase() === id);
    if (byId)
      return { status: 'matched', match: { item: byId, via: 'id', score: 1 } };
  }

  const sku = skuKey(query.sku);
  if (sku) {
    const bySku = decide(
      items
        .filter((i) => skuKey(i.sku) === sku)
        .map((item) => ({ item, via: 'sku' as const, score: 1 })),
    );
    if (bySku) return bySku;
  }

  const key = keyFor(kind);
  const wanted = key(query.name);
  if (!wanted) return { status: 'unknown', candidates: [] };

  const exact = decide(
    items
      .filter((i) => key(i.name) === wanted)
      .map((item) => ({ item, via: 'name' as const, score: 1 })),
  );
  if (exact) return exact;

  const close = items
    .map((item) => ({
      item,
      via: 'name-similar' as const,
      // Never 1: 1 reads as "the same", and this is not.
      score: Math.min(
        Math.round(nameScore(query.name, item.name, kind) * 100) / 100,
        0.99,
      ),
    }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
    .slice(0, MAX_CANDIDATES);
  if (close.length > 1) return { status: 'several', candidates: close };
  if (close.length === 1) return { status: 'close', candidates: close };
  return { status: 'unknown', candidates: [] };
}
