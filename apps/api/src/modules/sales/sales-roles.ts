import { PAYMENT_ROLES } from '../payments/payment-roles';

/**
 * Who may sell and who may undo a sale (CLAUDE.md §12) — the one list.
 *
 * The office app's `SalesController` and the assistant's samples tools
 * (BUSINESS_LOGIC §4 "Samples at shops", §16) both read it, so the assistant
 * is never allowed what the office app is not.
 */
export const SALES_ROLES = ['CORE_PARTNER', 'ADMIN_SUPPORT'] as const;

/**
 * Cancelling a sale and writing samples off move cost onto a cycle: a core
 * partner's call, not the office's (§4).
 */
export const SALES_PARTNER_ROLES = ['CORE_PARTNER'] as const;

/**
 * Confirm & paid (§4, owner 2026-10-27) both sells and receives money, so it
 * is open only to whoever may do both: the two lists' common roles, worked
 * out from them, so narrowing either one narrows this too.
 */
export const CONFIRM_AND_PAY_ROLES = SALES_ROLES.filter((role) =>
  (PAYMENT_ROLES as readonly string[]).includes(role),
);
