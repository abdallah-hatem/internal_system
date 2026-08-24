import { Prisma } from '@prisma/client';

type Numeric = Prisma.Decimal | number | string | null | undefined;

/**
 * Format an amount for a message a person will read.
 *
 * `toFixed(2)` alone produces "91698.00", which nobody parses at a glance —
 * these strings surface in toasts, warnings and notifications, so they get the
 * same grouping the UI gives every other amount.
 */
export function formatMoney(value: Numeric): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '0.00';
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Format a quantity the same way, minus the trailing zeros.
 *
 * Quantities are stored with decimal places for the rare fractional unit, but
 * "360.000 units" reads like a precision claim; whole counts print whole.
 */
export function formatQty(value: Numeric): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  });
}
