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
 *   ORD number), dated the decision day. Its lines keep only the units bought,
 *   at the price agreed; the allocations keep only the bought units, from the
 *   oldest batch first, as a sale would draw them; the rest go back on the
 *   shelf, to the batch each came from.
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

// ─── The decision ─────────────────────────────────────────────────────

/** One line of a samples order, as it stands: what is out at the shop. */
export interface SampleLine {
  saleItemId: string;
  productId: string;
  /** For the refusal's words. */
  product: string;
  outQty: Prisma.Decimal.Value;
}

/** What the partner entered for one line. */
export interface DecisionInput {
  saleItemId: string;
  buyQty: unknown;
  returnQty: unknown;
  unitPrice?: unknown;
}

export interface DecidedLine {
  saleItemId: string;
  productId: string;
  product: string;
  out: Prisma.Decimal;
  buy: Prisma.Decimal;
  back: Prisma.Decimal;
  /** Set for every line with something bought; null otherwise. */
  unitPrice: Prisma.Decimal | null;
}

const shape = (field: string, message: string) =>
  badRequest('VALIDATION_FAILED', message, { fields: field });

/** A quantity or a price: a finite number or a numeric string, else null. */
function numeric(value: unknown): Prisma.Decimal | null {
  if (typeof value === 'number' && Number.isFinite(value)) return D(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return D(value.trim());
  }
  return null;
}

/**
 * Check a shop's decision against what is out, line by line, and say what
 * each line becomes. Every line out must be decided, once; for each,
 * buying + returned must equal what is out exactly; nothing negative; and a
 * line with anything bought needs its price (0 or more — a free unit is a
 * choice, as on any sale).
 *
 * The quantities are compared in Decimal, so 0.1 + 0.2 is 0.3.
 */
export function planSamplesDecision(
  orderNo: string,
  lines: readonly SampleLine[],
  input: unknown,
): DecidedLine[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw shape('lines', 'lines must list every product left at the shop.');
  }
  const byItem = new Map<string, DecisionInput>();
  for (const raw of input as unknown[]) {
    if (!raw || typeof raw !== 'object') {
      throw shape(
        'lines',
        'Each line must be { saleItemId, buyQty, returnQty }.',
      );
    }
    const entry = raw as DecisionInput;
    const line = lines.find((l) => l.saleItemId === entry.saleItemId);
    if (!line) {
      throw badRequest(
        'SAMPLES_LINE_NOT_IN_ORDER',
        `That line is not one of the samples left on ${orderNo}.`,
        { order: orderNo },
      );
    }
    if (byItem.has(entry.saleItemId)) {
      throw badRequest(
        'SAMPLES_LINE_TWICE',
        `${line.product} is decided twice on ${orderNo}.`,
        { order: orderNo, product: line.product },
      );
    }
    byItem.set(entry.saleItemId, entry);
  }

  return lines.map((line) => {
    const entry = byItem.get(line.saleItemId);
    if (!entry) {
      throw badRequest(
        'SAMPLES_LINE_MISSING',
        `Say what happened to ${line.product}: how many they are buying and how many came back.`,
        { order: orderNo, product: line.product },
      );
    }
    const buy = numeric(entry.buyQty ?? 0);
    const back = numeric(entry.returnQty ?? 0);
    if (!buy || !back) {
      throw shape('lines.buyQty', 'buyQty and returnQty must be numbers.');
    }
    if (buy.isNeg() || back.isNeg()) {
      throw badRequest(
        'SAMPLES_QTY_NEGATIVE',
        `A quantity cannot be negative (${line.product}).`,
        { product: line.product },
      );
    }
    const out = D(line.outQty);
    if (!buy.add(back).eq(out)) {
      throw badRequest(
        'SAMPLES_DECISION_MISMATCH',
        `${out.toString()} of ${line.product} are at the shop: buying ` +
          `${buy.toString()} and returning ${back.toString()} must add up to it.`,
        {
          product: line.product,
          out: out.toString(),
          buying: buy.toString(),
          returned: back.toString(),
        },
      );
    }
    let unitPrice: Prisma.Decimal | null = null;
    if (buy.gt(0)) {
      const price =
        entry.unitPrice === undefined ||
        entry.unitPrice === null ||
        entry.unitPrice === ''
          ? null
          : numeric(entry.unitPrice);
      if (price === null) {
        throw badRequest(
          'SAMPLES_PRICE_REQUIRED',
          `Enter the price they are paying for ${line.product}.`,
          { product: line.product },
        );
      }
      if (price.isNeg()) {
        throw badRequest(
          'PRICE_NEGATIVE',
          `Invalid unitPrice for ${line.product}: must be 0 or greater`,
        );
      }
      unitPrice = price;
    }
    return {
      saleItemId: line.saleItemId,
      productId: line.productId,
      product: line.product,
      out,
      buy,
      back,
      unitPrice,
    };
  });
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
    // planSamplesDecision makes buying ≤ what is out; reaching here means the
    // allocations do not add up to the line, which the order never allows.
    throw new Error(
      'Samples allocations hold fewer units than are being bought.',
    );
  }
  return out;
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
