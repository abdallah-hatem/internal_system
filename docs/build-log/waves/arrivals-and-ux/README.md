# Waves — partial arrivals + UX

- Wave 1: B1 ‖ U0 ‖ U3 ‖ S1 ‖ U4b, each in its own worktree. B2 U1 U4 wait on wave 1.
- S1 merged `f5002aa`: demo orders paid through the payment service; check-data 13.1.
- U0 merged `5fe27c6`: EmptyState, DatePicker disableFuture (Cairo), useDateFormat, useCodeLabel + `codes` namespace, Vitest (test:unit). Lockfile: +151 dev packages, 3 patch bumps, no core change.
- Wave 2 (early): U1 ‖ U4 dispatched from `d62a531` (they needed only U0). B2 waits on B1.
- U3 merged `7b580b7` (+ `0dec50b`: one `test:unit` runs Vitest and node:test). Bottom bar, no search, BackLink.
  Open: the sidebar has no role filtering — every role sees all 22 entries. Which ones investors see is
  a business question → logged.
- U4b merged: recent activity comes from `GET /analytics/recent-activity` (confirmed sales, unreversed
  payments, receipts; core partner + admin support). Root cause: it read the audit log, which seeds never
  write and which counts drafts. Found: `/audit-logs` has no RolesGuard → task U4c.
- B1 merged `45decba`: deliveries/losses model, migration `20261010120000_shipment_deliveries` (only destructive
  line: the intended drop of the one-batch-per-line unique index), `shipmentPosition`, `GET /cycles/:id/shipment`.
  Backfill is a **separate script** (`scripts/ship-prod.sh backfill`, `npm run db:backfill:deliveries`), so the
  ship order becomes migrate → backfill → env → push. api jest on master: 469/469, typecheck clean.
  Guesses B1 made (accepted, logged): a loss on the last leg comes out of on-the-way first, then waiting; the
  backfill also dates an undated earlier leg to the first batch's day; legless cycles' batches stay unlinked.
  Carried to B3: receipts must also cap at the line's waiting quantity, and must guard concurrency now that the
  unique index is gone.
- U4c merged `14a1695`: `/audit-logs` → core partner + admin support. The menu is filtered by the existing `@Roles`,
  pinned by a test that reads the controllers (an investor sees 14 of 22). Shop owners never reach the office
  app (USE_PORTAL_LOGIN + SurfaceGuard).
  **Waiting on the user:** an investor can read analytics (revenue, cash, profit), customers, payment plans,
  returns, costing and more — those list endpoints name no roles. Doc marks it Open.
- U4 merged `30e7c12`: actionable dashboard; edited sales/payments/customers/inventory pages for the URL params (one hook each).
- U1 merged `0cd7117`: create & confirm in one transaction (`confirmWithin`), SaleOrderForm component, one total
  formula (`common/sale-totals.ts`, a web copy pinned by an 891-line equality test). Conflict with U4 on the sales
  page resolved (re-added `?new=1` against `createFor`). api jest 509/509, web vitest 75/75.
- Wave 3: U2 dispatched from `7076e51` (U1 merged), with the two U1 follow-ups (stored idempotency key, DISCOUNT_NEGATIVE).
