/**
 * Who may read and who may change a friend's loan (BUSINESS_LOGIC §18,
 * CLAUDE.md §12) — the one list.
 *
 * The office app's lender endpoints and the assistant's lender tools
 * (§16, 2026-10-11) both read it, so the assistant is never allowed what the
 * office app is not.
 */
export const LENDER_READ_ROLES = ['CORE_PARTNER', 'ADMIN_SUPPORT'] as const;

/** Every write on a friend's loan moves money: a core partner's. */
export const LENDER_WRITE_ROLES = ['CORE_PARTNER'] as const;
