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
- B5 merged: loss refunds through one writer (`bookRefund`), `loss_refund` cost recovery; fixed profitability matching
  `supplier_refund` by name and the dashboard leaving out all refunds; future-dated plain refunds now refused.
  B5's guess "a refund cannot be undone" contradicts §6 → new task B5b (reverse a refund).
- B4 merged: `record_delivery`, `verify_stock` by delivery, `add_shipping_leg` previews delivered units, `get_cycle`
  returns the position. Merge fix: B4's get_cycle fixture predated B5's refunds-per-loss read. api 679 + 7 skipped.
- Wave 5 (part): R1 ‖ B5b dispatched; U5 waits on F1a. Spec numbers: R1 → 87, B5b → 88.
- F1a merged: ShipmentPanel and dialogs (record delivery, receive, mark lost, take back, record refund), inventory
  "Receive stock", one low-stock rule (`isBelowMinStock`), profit card, shipments form no longer edits arrival.
  The loss figure before booking is labelled an estimate (qty × the server's per-ordered-unit cost); after booking
  the server's costEgp is shown (rule 11). web 152 + 43, en/ar key parity exact.
  Accepted guesses (F1a.md): a "Move to Arrived Egypt" button on the panel; the Receive list fetches each open
  cycle's shipment (no cross-cycle endpoint); Mark lost starts empty.
- Wave 5 dispatched from master: R1 ‖ B5b ‖ U5. Spec numbers: R1 → 87, B5b → 88, U5 → 86.
- B5b merged: `POST /purchases/refunds/:id/reverse` (balancing OUTFLOW with `reversalOfId`), one `counts()` for every
  refund sum, recovery read signed everywhere (fixed: cycle profitability counted inflows only, so an undone refund
  stayed in profit); take-back unlinks undone refunds past the RESTRICT key; "Undo refund" on the panel; check-data 12.9.
  api 691 + 9 skipped, web 158. Guesses accepted (written into §6 by B5b). B5b left Docker running; quit by main thread.
- R1 merged: `cyclesVisibleTo` (null for partner/support, the investor's participant cycles, [] otherwise) on every read
  path; business-wide reads refused, cycle reads filtered (404 outside), settlements opened to investors with their own
  line only. Security fixes found: `/cycles/:id/participants` sent password hashes; product photo upload/delete was
  open to any account. Investor menu: 12 entries. api 777 + 9 skipped, web 162 + 43.
  Follow-up R1b (after U5): hide write actions from investors on the cycle/settlement/shipment screens, and stop the
  cycle details page calling `GET /users` for them.
- U5 merged: ~40 raw codes → `useCodeLabel` (8 new kinds), 14 files on `useDateFormat`, 34 toasts/fallbacks translated,
  29 forms on `ValidatedForm` (translated required messages), 16 empty states, notifications stored as code + params
  (push: shops Arabic, office English until a user language is stored). Guard test `no-raw-codes`. Migration renamed
  to `20261010190000_notification_code_params` (it collided with B5b's timestamp). api 789 + 9 skipped, web 172 + 45.
- R1b dispatched: hide write actions from investors; stop `GET /users` for them; ledger refusal param `owner: 'sale return'`
  is English inside an Arabic message (rule 9); prune stale lint suppressions. Spec number 89.
- R1b merged: `lib/permissions.ts` + `useCan`, pinned to `@Roles` by `unit/can-roles.test.mjs`; investor sees no write
  actions on shipment/cycle/settlements/inventory/cycles list; wizard URLs gated; refusal params coded
  (`SALE_RETURN`, `DATE_FIELDS`, statuses) and translated via `PARAM_KINDS`. api 800 + 9 skipped, web 186 + 66.
- R1c dispatched (last build task): settlement `warnings` as codes (rule 9); catalogue pages hide partner-only actions
  via `useCan`. Spec number 90.
- R1c merged: settlement warnings are codes (`UNSOLD_STOCK`, `NO_REALISED_SALES`) translated on the web; 18 catalogue actions
  hidden from roles the endpoint refuses, pinned by `can-roles.test.mjs`. api 806 + 9 skipped, web 213 + 84.
  Left (R1c.md): ledger reasons the system writes are English (needs a migration — queued); a few English literals and
  `paddingLeft` in the categories tree (the UI audit will list them).
**All 20 build tasks merged. → Stage 5: Verify.**
- **Verify, first full e2e run:** group 1 193 passed / 6 failed; group 2 108 passed; group 3 131 / 10 failed; group 4 216 / 9 failed;
  group 5 105 / 19 failed. 44 failures in roughly 8 causes: fixtures in the new specs (participant already present; shop
  account creation), tests outdated by decisions (R1 404, F1b wizard, default dates), click timeouts on new screens,
  and a phone "More" reopen bug. One agent owns the fix-and-rerun loop (only one e2e run can hold the DB at a time).
- e2e fixes merged (see e2e-fixes.md). Product bugs fixed: the wizard draft restore broke under StrictMode (a reload of
  /cycles/new lost its draft); Mark lost ignored a confirm within 400ms; the shipments page loaded only the API's default
  20 legs in random order (records hidden). The rest were tests outdated by logged decisions, updated with reasons.
  Group re-runs: 00–19 199/0/1, 35–54 141/0, 55–79 225/0, 80–99 124/0; the shipments-list specs were re-run after the fix
  (64 passed). Open: purchases, products and providers lists load the same way as shipments did → task L1.
- L2 merged: one API low-stock definition (`common/low-stock.ts`, on hand = sum of remainingQty) used by the dashboard count and the receiving alert (inactive products no longer alert; one alert per product per receipt); one pinned web copy.
- L1 merged: ~17 screens fetched a page of a list and filtered it client-side (records silently hidden). One helper
  `lib/list-all.ts` (`useAllRecords`, cursor walk 200 at a time to 2,000, `ListCapNotice` past that). API paging fixed:
  `cursorPage()` adds `skip: 1` (each page repeated the last row) and every order ends on `id` (ties could skip a row).
  api 837 + 9 skipped, web 263 + 84. Spec 91 written, not run yet.
- UI audit: 19 major + 19 minor ([findings](../../notes/ui-audit-2026-10-10.md)); nits logged. Fixes UF1–UF6 dispatched in parallel by file ownership; then a re-audit of the fixed screens, then the final full e2e.
- UI fixes UF1–UF6 merged (+ an RTL toast slide-in fix). web vitest 324, node 84, typecheck clean, lint 0 errors.
  UF6 found what is left for one sweep now that the page owners are merged → UF7: pages still calling
  `toLocaleString(undefined)` (Arabic-Indic digits by browser) → `useNumberFormat`; bare "No data" text on ~25 page
  spots → `EmptyState`; `order-requests` forces ar-EG; `ar.json` photosHint holds "٨".
- UF7 merged: 23 number-format calls → useNumberFormat/Money, 30 empty states, guard test `unit/latin-digits.test.mjs`.
- UF8 merged: N1–N8 fixed and self-checked on screen (40 checks, no sideways scroll): one-line routes in the shipments table, shared LatinText (bidi isolation, end truncation) and NoMatch (clear search), consistent Arabic vocabulary (تسليمة/تشغيلة/دفعة). web 338 + 87.
- **Final full e2e (master after UF8):** group 1 199 passed / 1 skipped; group 2 108 / 2 skipped; group 3 141; group 4 225;
  group 5 129 / 3 failed → three specs asserting text a later UI fix replaced (no-match sentence; "Refunds" now also in an
  empty line; the ledger list never had a reason column). Updated to what is on screen; re-run 24/24.
  Unit: api 837 + 9 skipped, web 338 + 87, lint 0 errors, typecheck clean. **Verify done.**
- BUSINESS_LOGIC: every *Building* mark flipped to *Built 2026-10-11 (task)*.
