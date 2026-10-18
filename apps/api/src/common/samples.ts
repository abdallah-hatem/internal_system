// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; quantities and costs must not become floats
import { Prisma } from '@prisma/client';

import { badRequest } from './api-error';
import { businessDay } from './dates';

/**
 * Samples left at shops (BUSINESS_LOGIC §4, "Samples at shops", owner
 * 2026-10-18): the rules, with nothing read or written.
 *
 * A samples order is an ordinary sale order in status SAMPLES. Its units left
 * the shelf from real batches (FIFO, as a sale draws) and each draw is a
 * `SaleItemAllocation` carrying the batch's landed cost — exactly what a sale
 * records — so the cost of the units at the shop is known, and a leg re-cost
 * (§2) re-costs them with everything else. What keeps them from being a sale
 * is the status: every reader of revenue, COGS, receivables and balances
 * counts only CONFIRMED / PARTIALLY_PAID / PAID (and RETURNED for a return's
 * netting), and none of these is one of them.
 *
 * When the shop decides:
 * - **buying** — the order becomes a normal CONFIRMED sale, in place (same
 *   ORD number), dated the day of the decision, with exactly the lines the
 *   New Order popup was saved with (owner 2026-10-18, round 2): sample units
 *   kept are the ones that went out (oldest batch first, at the cost they left
 *   at), units not kept go back to the batch each came from, and anything more
 *   — a larger quantity or a product that never went out — is drawn FIFO from
 *   the shelf like any sale (`planSamplesConversion`).
 * - **returned** — everything back on the shelf; the order ends
 *   SAMPLES_RETURNED. Its allocations stay as the record of what went out, as
 *   a cancelled sale's do, and count for nothing.
 * - **written off** — the units never come back; the order ends
 *   SAMPLES_WRITTEN_OFF and the cost on its allocations is a cost of the
 *   cycle each batch came from (`samplesWrittenOffEgp`, common/cycle-losses).
 *
 * Pure: no Nest, no Prisma client.
 */

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

/** Samples still at the shop. */
export const SAMPLES_OPEN_STATUS = 'SAMPLES' as const;

/** How a samples order ends, other than by being bought. */
export const SAMPLES_CLOSED_STATUSES = [
  'SAMPLES_RETURNED',
  'SAMPLES_WRITTEN_OFF',
] as const;

/**
 * Every status a samples order can hold while it is not a sale. None of them
 * ever owed anything or sold anything: the statement, the balance, revenue
 * and COGS leave them out.
 */
export const SAMPLES_STATUSES = [
  SAMPLES_OPEN_STATUS,
  ...SAMPLES_CLOSED_STATUSES,
] as const;

export function isSamplesStatus(status: string): boolean {
  return (SAMPLES_STATUSES as readonly string[]).includes(status);
}

/**
 * Samples written off, as a line among a payout's costs and Analytics' P&L
 * expenses: a cost with no ledger row, like goods lost on the way, so not a
 * ledger category — the web names it itself.
 */
export const SAMPLES_WRITTEN_OFF_CATEGORY = 'samples_written_off';

/** Days after samples were left that every partner is reminded (DECIDED). */
export const SAMPLES_REMINDER_DAYS = 14;

/** The day `days` after `day`, both YYYY-MM-DD. */
export function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** The Cairo day the reminder for samples left at `leftAt` is due. */
export function samplesReminderDay(leftAt: Date | string): string {
  return addDays(businessDay(leftAt), SAMPLES_REMINDER_DAYS);
}

/** Whole Cairo days since the samples were left (0 on the day itself). */
export function daysAtShop(leftAt: Date | string, now = new Date()): number {
  const from = Date.parse(`${businessDay(leftAt)}T00:00:00Z`);
  const to = Date.parse(`${businessDay(now)}T00:00:00Z`);
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

export interface ReminderCandidate {
  id: string;
  status: string;
  samplesLeftAt: Date | null;
  samplesRemindedAt: Date | null;
}

/**
 * The samples orders whose reminder is due now: still open, left 14 or more
 * Cairo days ago, and never reminded. Once per order, ever — a decided order
 * is never reminded, and one reminded is never reminded again.
 */
export function samplesRemindersDue<T extends ReminderCandidate>(
  orders: readonly T[],
  now = new Date(),
): T[] {
  const today = businessDay(now);
  return orders.filter(
    (o) =>
      o.status === SAMPLES_OPEN_STATUS &&
      o.samplesLeftAt !== null &&
      o.samplesRemindedAt === null &&
      samplesReminderDay(o.samplesLeftAt) <= today,
  );
}

// ─── Which units are bought, which come back ──────────────────────────

/** One draw of a samples line from a batch, oldest received first. */
export interface SampleAllocation {
  id: string;
  batchId: string;
  qty: Prisma.Decimal.Value;
  unitCostEgp: Prisma.Decimal.Value;
}

export interface AllocationSplit {
  /** Allocations that stay, cut to the units bought, with their COGS. */
  keep: { id: string; qty: Prisma.Decimal; cogsEgp: Prisma.Decimal }[];
  /** Allocations with nothing bought from them: removed. */
  remove: string[];
  /** Units going back on the shelf, to the batch they came from. */
  back: { batchId: string; qty: Prisma.Decimal }[];
}

/**
 * Split a line's draws between what was bought and what came back. The
 * bought units are the oldest-received ones — the units a sale would have
 * drawn first (§3 FIFO) — so the sale's COGS is what FIFO would have charged;
 * the returned units go back to the newer batches they left.
 *
 * `allocations` must be the line's draws in FIFO order (oldest batch first),
 * which is the order they were written in.
 */
export function splitSampleAllocations(
  allocations: readonly SampleAllocation[],
  buy: Prisma.Decimal.Value,
): AllocationSplit {
  let toBuy = D(buy);
  const out: AllocationSplit = { keep: [], remove: [], back: [] };
  for (const a of allocations) {
    const qty = D(a.qty);
    const bought = Prisma.Decimal.min(qty, Prisma.Decimal.max(toBuy, 0));
    toBuy = toBuy.sub(bought);
    if (bought.gt(0)) {
      out.keep.push({
        id: a.id,
        qty: bought,
        cogsEgp: bought.mul(a.unitCostEgp).toDecimalPlaces(2),
      });
    } else {
      out.remove.push(a.id);
    }
    const returned = qty.sub(bought);
    if (returned.gt(0)) out.back.push({ batchId: a.batchId, qty: returned });
  }
  if (toBuy.gt(0)) {
    // planSamplesConversion keeps at most what is out; reaching here means the
    // allocations do not add up to the line, which the order never allows.
    throw new Error(
      'Samples allocations hold fewer units than are being bought.',
    );
  }
  return out;
}

// ─── Completing the sale from samples ─────────────────────────────────

/** One draw of a samples order from a batch: units that went out. */
export interface SampleDraw {
  productId: string;
  batchId: string;
  qty: Prisma.Decimal.Value;
  unitCostEgp: Prisma.Decimal.Value;
}

/** One line of the sale as the popup was saved: a product and its quantity. */
export interface WantedLine {
  productId: string;
  quantity: Prisma.Decimal.Value;
}

/** Units of one sale line taken from what went out, at the cost they left at. */
export interface KeptDraw {
  batchId: string;
  qty: Prisma.Decimal;
  unitCostEgp: Prisma.Decimal;
  cogsEgp: Prisma.Decimal;
}

export interface ConversionPlan {
  /** Per product on either side: what went out, what the sale keeps of it, and what it needs beyond that. */
  products: {
    productId: string;
    out: Prisma.Decimal;
    kept: Prisma.Decimal;
    /** More than went out: drawn from the shelf, FIFO, like any sale. */
    extra: Prisma.Decimal;
    /** Units not kept, back to the batch each left. */
    back: { batchId: string; qty: Prisma.Decimal }[];
  }[];
  /** Per sale line, in the order given: its units from the samples, and how many more from the shelf. */
  lines: { fromSamples: KeptDraw[]; fromShelf: Prisma.Decimal }[];
}

/**
 * The shop is buying, with the lines the popup was saved with (BUSINESS_LOGIC
 * §4, owner 2026-10-18 round 2). Per product:
 *
 * - **kept** = the lesser of what went out and what the sale has. Those units
 *   are the oldest-received of what went out — the units FIFO would have
 *   drawn first — so the sale's COGS is what a sale of them would have cost.
 * - **back** = what went out and is not kept: to the newer batches it left.
 * - **extra** = what the sale has beyond what went out (a raised quantity, or
 *   a product that never went out): the caller draws it FIFO from the shelf,
 *   after checking the shelf has it.
 *
 * Each line of a product takes its kept units first, in the order given, then
 * the rest from the shelf. Shelf + samples + sold therefore never counts a
 * unit twice: a unit is either kept (sold), back (shelf), or drawn (sold).
 *
 * `draws` must be in FIFO order (oldest batch first) within each product;
 * quantities are positive and checked by the caller.
 */
export function planSamplesConversion(
  draws: readonly SampleDraw[],
  lines: readonly WantedLine[],
): ConversionPlan {
  const productIds = [
    ...new Set([
      ...draws.map((d) => d.productId),
      ...lines.map((l) => l.productId),
    ]),
  ];
  const pools = new Map<string, KeptDraw[]>();
  const products = productIds.map((productId) => {
    const own = draws.filter((d) => d.productId === productId);
    const out = own.reduce((s, d) => s.add(d.qty), D(0));
    const wanted = lines
      .filter((l) => l.productId === productId)
      .reduce((s, l) => s.add(l.quantity), D(0));
    const kept = Prisma.Decimal.min(out, wanted);
    const split = splitSampleAllocations(
      own.map((d, i) => ({
        id: String(i),
        batchId: d.batchId,
        qty: d.qty,
        unitCostEgp: d.unitCostEgp,
      })),
      kept,
    );
    pools.set(
      productId,
      split.keep.map((k) => {
        const d = own[Number(k.id)];
        return {
          batchId: d.batchId,
          qty: k.qty,
          unitCostEgp: D(d.unitCostEgp),
          cogsEgp: k.cogsEgp,
        };
      }),
    );
    return {
      productId,
      out,
      kept,
      extra: wanted.sub(kept),
      back: split.back,
    };
  });

  const planned = lines.map((line) => {
    const pool = pools.get(line.productId)!;
    let need = D(line.quantity);
    const fromSamples: KeptDraw[] = [];
    while (need.gt(0) && pool.length > 0) {
      const head = pool[0];
      const take = Prisma.Decimal.min(head.qty, need);
      fromSamples.push({
        batchId: head.batchId,
        qty: take,
        unitCostEgp: head.unitCostEgp,
        cogsEgp: take.mul(head.unitCostEgp).toDecimalPlaces(2),
      });
      need = need.sub(take);
      if (take.eq(head.qty)) pool.shift();
      else
        pool[0] = {
          ...head,
          qty: head.qty.sub(take),
          cogsEgp: head.qty.sub(take).mul(head.unitCostEgp).toDecimalPlaces(2),
        };
    }
    return { fromSamples, fromShelf: need };
  });
  return { products, lines: planned };
}

// ─── Settling a cycle with samples out ─────────────────────────────────

/** Units of one cycle out at one shop. */
export interface SamplesOutAtShop {
  shop: string;
  units: Prisma.Decimal.Value;
}

/**
 * A cycle cannot be settled while any of its units are out as samples
 * (DECIDED, owner 2026-10-18): they are neither sold nor on the shelf, so the
 * cycle's profit would be a guess. The refusal names how many, at which shops.
 */
export function assertNoSamplesOut(
  cycleCode: string,
  out: readonly SamplesOutAtShop[],
) {
  const rows = out.filter((r) => D(r.units).gt(0));
  if (rows.length === 0) return;
  const units = rows.reduce((s, r) => s.add(r.units), D(0));
  const shops = rows
    .map((r) => `${r.shop} (${D(r.units).toString()})`)
    .join(', ');
  throw badRequest(
    'CYCLE_HAS_SAMPLES_OUT',
    `${units.toString()} unit(s) of cycle ${cycleCode} are out as samples at ${shops}. ` +
      'Record what the shops decided — bought, returned or written off — before settling.',
    { cycle: cycleCode, units: units.toString(), shops },
  );
}
