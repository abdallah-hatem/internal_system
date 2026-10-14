/**
 * Who may create a category (CLAUDE.md §12) — the one list.
 *
 * The office app's `POST /categories` and the assistant's `create_category`
 * (BUSINESS_LOGIC §16, 2026-10-15) both read it, so a role added to one is
 * added to the other: the assistant is never allowed what the office app is
 * not.
 */
export const CATEGORY_CREATE_ROLES = ['CORE_PARTNER'] as const;
