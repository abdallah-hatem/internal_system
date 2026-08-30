import { badRequest } from './api-error';

/**
 * A customer nobody has looked at yet cannot be given money to owe.
 *
 * Signing up on the storefront creates a `Customer` immediately, with
 * `verificationStatus = UNVERIFIED` — the owner's decision of 2026-08-30, taken
 * knowing it lets a stranger put a row in the table that orders, payments and
 * balances hang off.
 *
 * This is the containment, and it is one function rather than three copies
 * because three copies is how one of them ends up missing the check and a spam
 * signup acquires a balance. An unverified shop may browse and may ask for
 * something imported. It may not be sold to, paid by, or given a payment plan.
 */
export function assertVerified(customer: { verificationStatus: string; displayName: string }) {
  if (customer.verificationStatus === 'VERIFIED') return;

  throw badRequest(
    'CUSTOMER_NOT_VERIFIED',
    `${customer.displayName} has not been verified yet, so nothing can be recorded against them.`,
    { customer: customer.displayName },
  );
}
