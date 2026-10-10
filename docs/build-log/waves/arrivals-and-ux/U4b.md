# U4b — Why "Recent activity" is empty

Branch `fix/recent-activity`, from `b571e63`. Code commit `f47b80f`.

## Root cause

The panel on `dashboard/page.tsx` reads `GET /audit-logs?limit=5`. Nothing was
wrong with the query; the source was wrong.

- The audit log holds only what was done through the API's services. The seeds
  (demo included) insert with Prisma directly and write no audit rows, so on
  the demo database the panel is empty however many confirmed sales exist.
- What it does hold is every change, so a draft being saved (`CREATE
  SaleOrder`) shows as activity, as do product and supplier edits. A draft
  counts for nothing (BUSINESS_LOGIC §4).
- Two smaller faults on the web side, for U4: the page renders
  `timeAgo(item.createdAt)`, but an audit row has `occurredAt`, so every time
  read "undefined"; and `/audit-logs` carries no `RolesGuard`, so any signed-in
  internal account (a temporary investor included) can read every audit row
  with its full before/after JSON. Not fixed here — outside this task's files.

## Fix

`GET /analytics/recent-activity?limit=` (`AnalyticsService.getRecentActivity`).
Merged newest first from the records themselves:

| kind | source | included | dated by |
|---|---|---|---|
| `SALE` | sale orders | CONFIRMED, PARTIALLY_PAID, PAID (the existing `REALISED_SALE_STATUSES`) | `orderedAt`, then `createdAt` |
| `PAYMENT` | payments | `RECORDED` (a reversed payment is excluded) | `receivedOn`, then `createdAt` |
| `RECEIPT` | inventory batches | `VERIFIED` (the point stock exists) | `createdAt` |

Each source is read to the same depth before merging, so a busy one cannot push
the others out. `limit` defaults to 10, capped at 50; zero, negative or nonsense
fall back to 10. `kind` and `status` are codes for the web to translate.

Roles: `CORE_PARTNER` and `ADMIN_SUPPORT` — the roles that may list sales and
payments themselves. A temporary investor or a shop gets 403
`ROLE_NOT_ALLOWED`.

**Guess, written down (rule 5):** a sale is dated by its order date, not the
moment it was confirmed (no confirmation timestamp is stored). A draft created
last week and confirmed today sits at last week's position. A cancelled order
and a fully returned one (`RETURNED`) are not listed — the same set the revenue
figures count.

## Tests

`apps/api/src/modules/analytics/recent-activity.spec.ts`, 17 cases: a confirmed
sale appears with no audit rows at all; a draft does not; the same draft appears
once confirmed; cancelled excluded, part-paid and paid included; reversed
payment excluded; only verified batches; merge order; empty; the limit (default,
cap, 0 / negative / NaN, a busy source not crowding out); investor and shop
refused with the code, partner and support let through, the guard attached.

- Before the fix: the suite fails (there is no such feed to call).
- Mutant, draft filter removed: 3 fail (draft, draft→confirmed, cancelled).
- Mutant, `@Roles` removed: 2 fail (investor, shop).
- After: 17 pass. Whole api jest 433/433, lint 0 errors, typecheck clean.

`apps/web/tests/75-recent-activity.spec.ts` — 8 API cases and one UI case marked
`fixme` until U4 wires the page. Not run (per the task).

## For U4

- Switch the panel to `GET /analytics/recent-activity?limit=5`. Body is
  `{ data: [{ kind, id, occurredAt, recordedAt, reference, status?, amount?,
  currency?, quantity?, customer?, product?, cycleId? }] }`. `reference` is
  the order number for a sale, the method for a payment, the SKU for a receipt.
- An investor gets 403 — hide the panel for that role rather than showing an
  error, and translate `kind`.
- Invalidate its query key when a sale is confirmed or a payment recorded (the
  stale-cache case), then remove `fixme` from TC-RECENT-09.
