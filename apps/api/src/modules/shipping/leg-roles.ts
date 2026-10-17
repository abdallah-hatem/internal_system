/**
 * Who may edit a shipping leg (CLAUDE.md §12) — the one list.
 *
 * The office app's `PUT /shipping/legs/:id` and the assistant's
 * `update_leg_cost` (BUSINESS_LOGIC §16, 2026-10-17) both read it, so a role
 * added to one is added to the other: the assistant is never allowed what the
 * office app is not. A leg's cost re-costs the cycle's stock and every sale
 * from it, so it is a core partner's.
 */
export const LEG_EDIT_ROLES = ['CORE_PARTNER'] as const;
