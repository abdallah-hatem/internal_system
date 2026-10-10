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
- B2 merged: deliveries / losses / take-back endpoints (`deliveries.service.ts`), cycle-row lock `FOR UPDATE` on
  every write (race verified on a throwaway DB: 5/5 with, 3/3 fail without), gates via
  `common/shipment-load.ts`, `cycleLossesEgp`, cost lock, check-data 12.3–12.6. api jest 558 + 3 skipped (DB suite).
  B2's guesses are accepted and logged in B2.md. Carried to B3: (1) check-data 12.6 flags old-path receipts until per-delivery
  receipts land; (2) 12.5 is strict, so it must allow the final-event residual (Amendment 9); (3) `transition` does not take
  the cycle lock — it must for → SETTLEMENT (gate race); (4) receipts cap at the line's waiting quantity too.
  B2 left Docker running; the main thread quit it.
- U2 merged: payments on a chosen order in one transaction (`allocateWithin`, shared with Allocate);
  RecordPaymentDialog is the one form (customer page, Payments page, order); stored sale idempotency key
  (migration `20261010140000_sale_order_idempotency_key`); `DISCOUNT_NEGATIVE`. api 583 + 3 skipped, web 86 + 43.
  **Overruled one guess:** U2 had dropped CHEQUE because it had no label; it is restored and labelled.
  Accepted guesses (U2.md): 404 for another customer's order; payments in the order's currency or EGP;
  oldest-first still one request per order from the client (as before); the dialog relies on a ref
  guard for double submit (the payment key would show in `reference`).
- F1b dispatched early from `c292c78` (needs B2, not B3; owns no B3 file).
- F1b merged: wizard ends at in-transit (`wizard-walk.ts`), resume reads every order and leg, list shows profit and ROI from analytics. Guesses accepted (F1b.md). Fixed B2's 3 `any` lint errors in spec 78.
- B3 merged `ddfb3cb`: receipts per delivery under `lockCycle`, the first receipt walks to SELLING through
  `transitionIn`/`planTransition`; per-ordered-unit cost with the residual on the final event (`lineEventCost`);
  `assertShipmentAccounted` in planTransition → SETTLEMENT and in approve; losses subtracted in settlement,
  analytics and dashboard net profit; batches carry their own `arrivedOn`; demo seed builds deliveries
  (check-data all zero on both resets). api 625 + 5 skipped, web 107 + 43, lint/typecheck clean.
  Merge fixes: locales key-merged; spec 29 TC-RT-08 stays fixme (the re-entry it pinned no longer exists);
  spec numbers collided (78/79 twice) → B2's is now 81, B3's 82. From wave 4 on, briefs assign spec numbers.
  B3 left Docker running; the main thread quit it.
- Wave 4: B4 ‖ B5 ‖ F1a from master. Spec numbers: B4 → 83, B5 → 84, F1a → 85 (U5 → 86, R1 → 87 later).
