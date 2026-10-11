// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; money in EGP must not become a float
import { Prisma } from '@prisma/client';
import { badRequest } from '../../common/api-error';
import { assertDay, assertNotFuture, businessToday } from '../../common/dates';
import {
  CYCLE_REQUIRED_CATEGORIES,
  MANUAL_ENTRY_KINDS,
  type ManualEntryKind,
  manualKindOf,
} from '../../common/manual-ledger-categories';

/** What a manual entry may be sent as; the DTO checks the shape. */
export interface ManualEntryInput {
  kind?: string;
  category?: string;
  direction?: string;
  type?: string;
  amount?: unknown;
  currency?: string;
  fxRateToEgp?: unknown;
  occurredOn?: string;
  cycleId?: string;
  note?: string;
}

export interface CheckedManualEntry {
  kind: ManualEntryKind;
  type: string;
  category: string;
  direction: 'INFLOW' | 'OUTFLOW';
  /** Always pounds — what the settlement and the dashboard sum. */
  amountEgp: Prisma.Decimal;
  /** The rate used; null for pounds. */
  rate: Prisma.Decimal | null;
  /** What was paid, when it was not pounds. */
  original: { amount: Prisma.Decimal; currency: string } | null;
  occurredOn: string;
  note: string | null;
}

/** Large enough for any real entry, small enough for Decimal(18,2). */
const MAX_AMOUNT = 1_000_000_000;
const MAX_RATE = 100_000;

const invalid = (field: string, english: string) =>
  badRequest('VALIDATION_FAILED', english, { fields: field });

const num = (v: unknown): number =>
  typeof v === 'number'
    ? v
    : typeof v === 'string' && v.trim() !== ''
      ? Number(v)
      : NaN;

/**
 * Every rule a manual entry must keep that does not need the database
 * (BUSINESS_LOGIC §9, L6). The cycle is the service's — it has to be looked
 * up.
 *
 * Pure, so the rules are tested without a database and read in one place.
 */
export function checkManualEntry(input: ManualEntryInput): CheckedManualEntry {
  const kind = input.kind as ManualEntryKind;
  if (!kind || !Object.hasOwn(MANUAL_ENTRY_KINDS, kind)) {
    throw invalid('kind', 'kind must be EXPENSE or OTHER_INCOME');
  }
  const rule = MANUAL_ENTRY_KINDS[kind];

  // The kind fixes these; sent anyway, they must agree.
  if (input.direction !== undefined && input.direction !== rule.direction) {
    throw badRequest(
      'LEDGER_DIRECTION_MISMATCH',
      `${kind === 'EXPENSE' ? 'An expense is money going out' : 'Income is money coming in'}; it cannot be recorded as ${input.direction}.`,
      { kind, direction: String(input.direction) },
    );
  }
  if (input.type !== undefined && input.type !== rule.type) {
    throw badRequest(
      'LEDGER_TYPE_NOT_MANUAL',
      `A ${String(input.type)} entry is written by its own flow, not by hand.`,
      { type: String(input.type) },
    );
  }

  const category = typeof input.category === 'string' ? input.category : '';
  const belongsTo = manualKindOf(category);
  if (belongsTo === null) {
    // `purchase`, `settlement`, `contribution`, a refund, a friend's loan, or
    // free text: none of them is something a person records by hand.
    throw badRequest(
      'LEDGER_CATEGORY_NOT_MANUAL',
      `"${category}" is not a category a manual entry can use. Choose one from the list.`,
      { category },
    );
  }
  if (belongsTo !== kind) {
    throw badRequest(
      'LEDGER_CATEGORY_WRONG_KIND',
      `"${category}" is not ${kind === 'EXPENSE' ? 'an expense' : 'income'}.`,
      { category, kind },
    );
  }

  const amount = num(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw badRequest(
      'LEDGER_AMOUNT_NOT_POSITIVE',
      'An amount must be more than zero.',
    );
  }
  if (amount > MAX_AMOUNT) {
    throw invalid('amount', `amount must not be more than ${MAX_AMOUNT}`);
  }

  const currency = typeof input.currency === 'string' ? input.currency : '';
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw invalid(
      'currency',
      'currency must be a three-letter code such as EGP',
    );
  }

  let rate: Prisma.Decimal | null = null;
  const sentRate = input.fxRateToEgp;
  if (currency === 'EGP') {
    // Pounds at 2 would double the amount without anyone seeing why.
    if (sentRate !== undefined && sentRate !== null && num(sentRate) !== 1) {
      throw badRequest(
        'LEDGER_EGP_RATE',
        'An amount in pounds converts to pounds at 1.',
      );
    }
  } else {
    const r = num(sentRate);
    if (!Number.isFinite(r) || r <= 0) {
      throw badRequest(
        'LEDGER_RATE_NOT_POSITIVE',
        `The rate from ${currency} to EGP must be more than zero.`,
        { currency },
      );
    }
    if (r > MAX_RATE) {
      throw invalid(
        'fxRateToEgp',
        `fxRateToEgp must not be more than ${MAX_RATE}`,
      );
    }
    rate = new Prisma.Decimal(r);
  }

  const occurredOn = input.occurredOn ?? businessToday();
  assertDay(occurredOn);
  assertNotFuture(occurredOn, 'LEDGER_ENTRY');

  if (CYCLE_REQUIRED_CATEGORIES.includes(category) && !input.cycleId) {
    throw badRequest(
      'LEDGER_CYCLE_REQUIRED',
      `"${category}" is a cost of one cycle's goods — choose the cycle it belongs to.`,
      { category },
    );
  }

  const original = new Prisma.Decimal(amount);
  const amountEgp = rate
    ? original.mul(rate).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
    : original.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

  return {
    kind,
    type: rule.type,
    category,
    direction: rule.direction,
    amountEgp,
    rate,
    original: rate ? { amount: original, currency } : null,
    occurredOn,
    note: input.note?.trim() || null,
  };
}
