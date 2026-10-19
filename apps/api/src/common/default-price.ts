import type { Prisma } from '@prisma/client';

/**
 * A product's selling price on a channel — the one definition (BUSINESS_LOGIC
 * §3 "A default price", owner 2026-10-18; CLAUDE.md rule 11).
 *
 *     price = the price the owner set on that channel, when there is one
 *           = otherwise landed cost × (1 + DEFAULT_MARKUP_PCT / 100),
 *             rounded to the nearest whole pound (half up), in EGP
 *           = otherwise none (null) — the product was never costed
 *
 * "Landed cost" is the weighted average landed unit cost of the units on the
 * shelf now (remaining quantity across every batch). With nothing on the shelf
 * it is the landed cost of the most recently received batch. Never received,
 * or landed at nothing, and there is no basis for a default: null, never a
 * price of 0 that a sale line would quietly take (rule 10).
 *
 * Every reader of a product's price asks here — the products list and detail,
 * the sale form's prefill (which reads the list), the assistant's
 * `find_products` and `record_sale`, and the storefront's catalogue, product
 * page and request. Each price says whether it was SET or is the DEFAULT, so a
 * screen can say so; nothing stores a default as if it had been typed.
 *
 * Exact arithmetic: quantities (3 places) and costs (4 places) are read as
 * whole numbers of their smallest unit, so no float and no rounded average
 * ever decides which way a .5 goes.
 */

/** The markup a default price adds to landed cost, in percent. */
export const DEFAULT_MARKUP_PCT = 20;

export const PRICE_CHANNELS = ['B2B', 'B2C'] as const;
export type PriceChannel = (typeof PRICE_CHANNELS)[number];

export type PriceSource = 'SET' | 'DEFAULT';

export interface ListPrice {
  /** Two decimals, as the price columns store it. */
  amount: string;
  currency: string;
  source: PriceSource;
  /** On a DEFAULT only: the markup it was worked out with, for the hint. */
  markupPct?: number;
}

export type ListPrices = Record<PriceChannel, ListPrice | null>;

/** A number as Prisma (a Decimal), the wire (a string) or a test (a number) carries it. */
type Numeric = Prisma.Decimal | number | string;

export interface PriceRow {
  channel: string;
  currency?: string | null;
  amount: Numeric;
  effectiveTo: Date | string | null;
}

export interface CostBatch {
  remainingQty: Numeric;
  landedUnitCostEgp: Numeric;
  /** When it was received; the latest one is the fallback with none on the shelf. */
  createdAt: Date | string;
  id?: string;
}

const QTY_PLACES = 3;
const COST_PLACES = 4;

/** `v` in units of 10^-places, exactly; anything unreadable is 0. */
export function scaled(v: Numeric, places: number): bigint {
  const text =
    typeof v === 'number'
      ? v.toFixed(places)
      : typeof v === 'string'
        ? v.trim()
        : v.toFixed(places);
  const m = /^(-)?(\d*)(?:\.(\d*))?$/.exec(text);
  if (!m || (!m[2] && !m[3])) return 0n;
  const frac = (m[3] ?? '').padEnd(places + 1, '0');
  let n = BigInt((m[2] || '0') + frac.slice(0, places));
  if (Number(frac[places]) >= 5) n += 1n; // half up, past the column's places
  return m[1] ? -n : n;
}

/** Two decimals, as the price columns hold them. */
function money(v: Numeric): string {
  const cents = scaled(v, 2);
  const sign = cents < 0n ? '-' : '';
  const abs = cents < 0n ? -cents : cents;
  return `${sign}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

/** The open (current) price row on a channel, or undefined. */
export function setPriceOn(
  prices: readonly PriceRow[] | null | undefined,
  channel: PriceChannel,
): PriceRow | undefined {
  return (prices ?? []).find(
    (p) => p.channel === channel && p.effectiveTo === null,
  );
}

/**
 * The default price in whole pounds for a product with these batches, or null
 * when there is no basis for one. Worked out as Σ(qty × cost) × (100 + markup)
 * / (Σqty × 100) and rounded once, half up, so a figure that lands exactly on
 * .5 is seen as .5 and goes up, rather than 0.4999… from a rounded average.
 */
export function defaultPriceFor(
  batches: readonly CostBatch[] | null | undefined,
  markupPct: number = DEFAULT_MARKUP_PCT,
): number | null {
  const all = batches ?? [];
  const onShelf = all.filter((b) => scaled(b.remainingQty, QTY_PLACES) > 0n);

  let costTimesQty = 0n; // 10^-(QTY_PLACES + COST_PLACES) pounds
  let qty = 0n; // 10^-QTY_PLACES units
  if (onShelf.length) {
    for (const b of onShelf) {
      const q = scaled(b.remainingQty, QTY_PLACES);
      costTimesQty += q * scaled(b.landedUnitCostEgp, COST_PLACES);
      qty += q;
    }
  } else {
    if (!all.length) return null;
    const latest = [...all].sort((a, b) => {
      const t =
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      if (t !== 0) return t;
      return (b.id ?? '').localeCompare(a.id ?? '');
    })[0];
    const one = 10n ** BigInt(QTY_PLACES);
    costTimesQty = one * scaled(latest.landedUnitCostEgp, COST_PLACES);
    qty = one;
  }

  // Landed at nothing is a batch not yet costed, not free goods.
  if (costTimesQty <= 0n || qty <= 0n) return null;

  const num = costTimesQty * BigInt(100 + markupPct);
  const den = qty * 100n * 10n ** BigInt(COST_PLACES);
  return Number((2n * num + den) / (2n * den));
}

/** The price on one channel: the set one, else the default, else null. */
export function listPriceOn(
  prices: readonly PriceRow[] | null | undefined,
  batches: readonly CostBatch[] | null | undefined,
  channel: PriceChannel,
): ListPrice | null {
  const set = setPriceOn(prices, channel);
  if (set) {
    return {
      amount: money(set.amount),
      currency: set.currency ?? 'EGP',
      source: 'SET',
    };
  }
  const fallback = defaultPriceFor(batches);
  if (fallback === null) return null;
  return {
    amount: `${fallback}.00`,
    currency: 'EGP',
    source: 'DEFAULT',
    markupPct: DEFAULT_MARKUP_PCT,
  };
}

export function listPricesOf(
  prices: readonly PriceRow[] | null | undefined,
  batches: readonly CostBatch[] | null | undefined,
): ListPrices {
  return {
    B2B: listPriceOn(prices, batches, 'B2B'),
    B2C: listPriceOn(prices, batches, 'B2C'),
  };
}

/**
 * Every product's prices, with its batches read in one query. The only way a
 * price reader loads them — the products carry their own `prices` rows.
 */
export async function listPricesFor(
  db: Pick<Prisma.TransactionClient, 'inventoryBatch'>,
  products: readonly { id: string; prices?: readonly PriceRow[] | null }[],
): Promise<Map<string, ListPrices>> {
  const ids = [...new Set(products.map((p) => p.id))];
  const batches = ids.length
    ? await db.inventoryBatch.findMany({
        where: { productId: { in: ids } },
        select: {
          productId: true,
          remainingQty: true,
          landedUnitCostEgp: true,
          createdAt: true,
          id: true,
        },
      })
    : [];
  const byProduct = new Map<string, CostBatch[]>();
  for (const b of batches) {
    const list = byProduct.get(b.productId) ?? [];
    list.push(b);
    byProduct.set(b.productId, list);
  }
  return new Map(
    products.map((p) => [
      p.id,
      listPricesOf(p.prices, byProduct.get(p.id) ?? []),
    ]),
  );
}
