/**
 * Who may move leftovers between cycles, and undo it (BUSINESS_LOGIC §8, L5;
 * CLAUDE.md rule 12) — the one list, for the office endpoints now and the
 * assistant's tool when it comes (§16, planned).
 */
export const TRANSFER_WRITE_ROLES = ['CORE_PARTNER'] as const;
