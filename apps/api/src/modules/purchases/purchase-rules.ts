import type { CycleStatus } from '@prisma/client';

/**
 * The cycle statuses in which a purchase order can still be created or gain
 * lines. Past PURCHASING the goods are moving and the order is confirmed
 * (BUSINESS_LOGIC §15), so nothing more can be bought on it.
 *
 * One definition (CLAUDE.md rule 11): the purchases service refuses with it,
 * and the assistant's `match_receipt` offers exactly these cycles. Two copies
 * would let the assistant suggest a cycle the service then refuses.
 */
export const OPEN_FOR_PURCHASING: readonly CycleStatus[] = [
  'PLANNING',
  'FUNDING',
  'PURCHASING',
];

export function isOpenForPurchasing(status: string): boolean {
  return (OPEN_FOR_PURCHASING as readonly string[]).includes(status);
}
