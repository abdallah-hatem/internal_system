/**
 * Who may record money coming in (CLAUDE.md §12) — the one list.
 *
 * The office app's `POST /payments` and the assistant's `record_payment`
 * (BUSINESS_LOGIC §16, 2026-10-11) both read it, so a role added to one is
 * added to the other: the assistant is never allowed what the office app is
 * not.
 */
export const PAYMENT_ROLES = ['CORE_PARTNER', 'ADMIN_SUPPORT'] as const;

/** Reversing a payment is a partner's, not the office's. */
export const PAYMENT_REVERSE_ROLES = ['CORE_PARTNER'] as const;
