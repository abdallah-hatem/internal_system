import type { Prisma } from '@prisma/client';

import { badRequest } from './api-error';

/**
 * The walk-in buyer (BUSINESS_LOGIC §4, DECIDED 2026-10-11).
 *
 * A buyer who is not a shop does not get a customer record of their own. Every
 * walk-in sale hangs off one shared record the system keeps — `isWalkIn` true,
 * at most one row, enforced by the partial unique index
 * `customers_one_walk_in`. It cannot sign in, cannot be edited, and never owes
 * anything, because a walk-in sale is paid in full the moment it is made.
 */
export const WALK_IN_NAME = 'Walk-in';

/**
 * What a list's `customerId` filter says for the walk-in buyer (Sales list,
 * owner 2026-10-25). The record's id differs from one database to the next,
 * and the customers list leaves it out, so a picker names it by this instead.
 */
export const WALK_IN_FILTER = 'walk-in';

/**
 * How money can arrive. The same four the Record payment dialog offers
 * (`RecordPaymentDialog.PAYMENT_METHODS` in the web app); cash when unsaid.
 */
export const PAYMENT_METHODS = [
  'CASH',
  'BANK_TRANSFER',
  'CHEQUE',
  'MOBILE_WALLET',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

type Db = Pick<Prisma.TransactionClient, 'customer' | '$executeRaw'>;

/**
 * The walk-in record — found, or made the first time it is needed.
 *
 * Runs inside the sale's transaction, so a sale that is refused takes a
 * just-made record down with it and leaves nothing behind.
 *
 * Made with INSERT … ON CONFLICT DO NOTHING against the partial unique index,
 * not with a read-then-create: two first walk-in sales can both read "none
 * yet", and a plain create from each would leave two records — or, inside a
 * transaction, abort the loser with a unique violation it cannot recover from.
 * Here the second insert waits on the first transaction, then does nothing, and
 * the read after it (a new statement under READ COMMITTED) sees the winner's
 * row.
 */
export async function walkInCustomer(db: Db) {
  const found = await db.customer.findFirst({ where: { isWalkIn: true } });
  if (found) return found;

  await db.$executeRaw`
    INSERT INTO customers
      (id, type, display_name, verification_status, is_walk_in, updated_at)
    VALUES
      (gen_random_uuid(), 'B2C'::"CustomerType", ${WALK_IN_NAME}, 'VERIFIED', true, now())
    ON CONFLICT (is_walk_in) WHERE is_walk_in DO NOTHING`;

  const made = await db.customer.findFirst({ where: { isWalkIn: true } });
  // Unreachable while the index exists: either this insert made the row or
  // the one it collided with committed it.
  if (!made) throw new Error('The walk-in record could not be found or made.');
  return made;
}

/**
 * Refuse to change the walk-in record. Editing it would rename every walk-in
 * sale at once; it carries no details anyone typed, so there is nothing of
 * the buyer's to correct.
 */
export function assertNotWalkIn(customer: { isWalkIn: boolean }) {
  if (!customer.isWalkIn) return;
  throw badRequest(
    'WALK_IN_RESERVED',
    'The walk-in record is kept by the system and cannot be changed.',
  );
}
