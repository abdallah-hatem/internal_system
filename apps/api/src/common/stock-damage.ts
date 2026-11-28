// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; quantities and costs must not become floats
import { Prisma } from '@prisma/client';
import { badRequest } from './api-error';
import { formatQty } from './money';

/**
 * Units found damaged in storage and written off (BUSINESS_LOGIC §3, §8 —
 * owner 2026-11-28: "a damaged product or two from cycle CYC-2026-0001").
 *
 * The rules, written once: the service, the cycle page's "Mark damaged" and
 * the losses list read these, so the button is offered exactly when the
 * server would accept (rule 11). Pure except `damagedInStorageEgp`, which
 * reads.
 *
 * What a damage is NOT: not a ledger row (no money moves — the cash left when
 * the goods were bought, §9), not a cost of goods sold (nothing was sold), not
 * an operating expense a person paid. It is the same kind of figure as goods
 * lost on the way and samples written off — goods the cycle paid for that will
 * never sell — and every profit figure subtracts it through
 * `cycleWriteOffsEgp` (common/cycle-losses.ts).
 */

const D = (v: Prisma.Decimal.Value | null | undefined) =>
  new Prisma.Decimal(v ?? 0);
const ZERO = new Prisma.Decimal(0);
const money = (v: Prisma.Decimal) =>
  v.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

/** What a damage's movements point back at (`referenceType`). */
export const STOCK_DAMAGE_REFERENCE = 'STOCK_DAMAGE';

/**
 * Its line among the costs (payout breakdown, Analytics' expenses by
 * category): "Damaged in storage" — its own label, the one loss definition
 * underneath (GUESS 2026-11-28, decided by the assistant).
 */
export const DAMAGED_IN_STORAGE_CATEGORY = 'damaged_in_storage';

/** The longest note a damage or its undo keeps. */
export const DAMAGE_NOTE_MAX = 500;

/** A damage that stands: not undone. Undone ones count nowhere (§9 pattern). */
export const STANDING_DAMAGE = {
  undoneAt: null,
} satisfies Prisma.StockDamageWhereInput;

/**
 * The damages `damagedInStorageEgp` sums, as a filter: one definition for the
 * sum and for Analytics, which reads the same rows one by one to put each on
 * its day (the day entered, `damagedOn`).
 */
export function stockDamageWhere(
  cycleId: string | null,
  damagedOn?: { gte?: Date; lte?: Date },
): Prisma.StockDamageWhereInput {
  return {
    ...STANDING_DAMAGE,
    ...(cycleId === null ? {} : { batch: { cycleId } }),
    ...(damagedOn ? { damagedOn } : {}),
  };
}

/**
 * What a cycle wrote off as damaged in storage, in EGP: the cost stored on
 * each damage that stands, charged to the cycle the batch belongs to (a batch
 * moved in from another cycle is the receiving cycle's — it funded it).
 * `cycleId` null is every cycle at once.
 */
export async function damagedInStorageEgp(
  db: {
    stockDamage: Pick<Prisma.TransactionClient['stockDamage'], 'aggregate'>;
  },
  cycleId: string | null,
  damagedOn?: { gte?: Date; lte?: Date },
): Promise<Prisma.Decimal> {
  const { _sum } = await db.stockDamage.aggregate({
    where: stockDamageWhere(cycleId, damagedOn),
    _sum: { costEgp: true },
  });
  return D(_sum?.costEgp);
}

/**
 * The quantity asked for, as whole units more than zero (GUESS 2026-11-28:
 * a part is whole; half a brake pad is not a thing that breaks).
 */
export function damageQty(value: unknown): Prisma.Decimal {
  let qty: Prisma.Decimal;
  try {
    qty =
      typeof value === 'number' || typeof value === 'string' ? D(value) : ZERO;
  } catch {
    qty = ZERO;
  }
  if (!qty.isFinite() || qty.lte(0)) {
    throw badRequest(
      'STOCK_DAMAGE_QTY_NOT_POSITIVE',
      'Say how many units were damaged: a whole number more than zero.',
    );
  }
  if (!qty.isInteger()) {
    throw badRequest(
      'STOCK_DAMAGE_QTY_NOT_WHOLE',
      `${qty.toString()} is not a whole number of units.`,
      { qty: qty.toString() },
    );
  }
  return qty;
}

/** A note or a reason: trimmed, at most `DAMAGE_NOTE_MAX` characters. */
export function damageText(value: unknown, field: 'note' | 'reason') {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length > DAMAGE_NOTE_MAX) {
    throw badRequest(
      'VALIDATION_FAILED',
      `The ${field} is longer than ${DAMAGE_NOTE_MAX} characters.`,
      { fields: field },
    );
  }
  return text;
}

/** One batch as `damageableOn` reads it. */
export interface DamageableBatch {
  verificationStatus: string;
  /** Sellable on the shelf. Samples at a shop and sold units are not on it. */
  saleableQty: Prisma.Decimal.Value;
  /** Units on this batch held for a shop's request right now. */
  heldQty: Prisma.Decimal.Value;
}

/**
 * What can be marked damaged on a batch: what is on the shelf less what is
 * held for a shop's request — a hold is a promise (as Move leftovers reads
 * it). Units sold, out at a shop as samples (broken samples go through the
 * samples order's Write off) or back on a damaged return are not on the shelf
 * at all. A batch not yet checked has nothing on the shelf.
 */
export function damageableOn(b: DamageableBatch): Prisma.Decimal {
  if (b.verificationStatus !== 'VERIFIED') return ZERO;
  const free = D(b.saleableQty).sub(D(b.heldQty));
  return free.isNegative() ? ZERO : free;
}

/**
 * Why nothing can be marked damaged, or undone, on this cycle now — or null.
 *
 * Refused once the settlement is approved (the cycle is in Settlement), paid
 * (Closed), or the cycle cancelled: "nothing is recorded on a cycle being
 * settled" (§1). A draft settlement does not refuse it; the draft goes stale
 * instead and cannot be approved until calculated again
 * (`SETTLEMENT_STALE_WRITE_OFFS`).
 */
export function damageCycleRefusal(
  cycle: { code: string; status: string },
  standingSettlement: 'APPROVED' | 'PAID' | null = null,
) {
  if (cycle.status === 'CANCELLED') {
    return badRequest(
      'CYCLE_CLOSED',
      `Cycle ${cycle.code} was cancelled, so nothing can be recorded on its shipment.`,
      { cycle: cycle.code, status: cycle.status },
    );
  }
  if (
    cycle.status === 'SETTLEMENT' ||
    cycle.status === 'CLOSED' ||
    standingSettlement
  ) {
    return badRequest(
      'CYCLE_SETTLING',
      `Cycle ${cycle.code} is ${cycle.status}. Nothing is recorded on a cycle being settled; reverse the settlement first.`,
      { cycle: cycle.code, status: cycle.status },
    );
  }
  return null;
}

/** Refuse more than is on the shelf (`available` in whole units). */
export function assertDamageable(
  qty: Prisma.Decimal,
  available: Prisma.Decimal,
  product: string,
) {
  if (qty.gt(available)) {
    throw badRequest(
      'STOCK_DAMAGE_MORE_THAN_ON_SHELF',
      `Only ${formatQty(available)} of ${product} are on the shelf to mark damaged; ${formatQty(qty)} was asked for.`,
      {
        product,
        available: formatQty(available),
        requested: formatQty(qty),
      },
    );
  }
}

/** Goods cannot break on a shelf before they were on it. */
export function assertNotBeforeReceived(day: string, receivedDay: string) {
  if (day < receivedDay) {
    throw badRequest(
      'STOCK_DAMAGE_BEFORE_RECEIVED',
      `The damage is dated ${day}, before this batch was received on ${receivedDay}.`,
      { day, received: receivedDay },
    );
  }
}

/**
 * What the damaged units cost: the batch's landed unit cost × the units, to
 * the piastre, half up (§11), never re-pricing the batch.
 *
 * When the damage accounts for the last units of its order line — every batch
 * of the line empty afterwards, nothing of it moved to another cycle — it takes
 * the rounding residual, as the last receipt or loss of a line does (§2): the
 * line's purchase rows less everything already drawn from its batches at cost
 * (sales and samples, net of what returns put back, and the other damages that
 * stand), so the line re-sums to what it cost exactly (GUESS 2026-11-28).
 *
 * The residual is taken only when it is a rounding residual — within a
 * piastre plus a ten-thousandth a unit of the plain figure. Anything further
 * off is data this rule does not describe (a cost typed at receipt, a line
 * re-costed oddly), and the plain figure is the honest one.
 */
export function damageCostEgp(input: {
  qty: Prisma.Decimal.Value;
  unitCostEgp: Prisma.Decimal.Value;
  /** Set when the damage takes the line's last units. */
  final?: { bookedEgp: Prisma.Decimal.Value; drawnEgp: Prisma.Decimal.Value };
}): Prisma.Decimal {
  const qty = D(input.qty);
  const plain = money(qty.mul(D(input.unitCostEgp)));
  if (!input.final) return plain;
  const residual = money(D(input.final.bookedEgp).sub(D(input.final.drawnEgp)));
  const slack = new Prisma.Decimal('0.01').add(qty.mul('0.0001'));
  if (residual.isNegative() || residual.sub(plain).abs().gt(slack)) {
    return plain;
  }
  return residual;
}

/** Why a damage cannot be undone, or null. */
export function undoDamageRefusal(damage: { undoneAt: Date | null }) {
  if (damage.undoneAt) {
    return badRequest(
      'STOCK_DAMAGE_ALREADY_UNDONE',
      'This damage has already been undone.',
    );
  }
  return null;
}
