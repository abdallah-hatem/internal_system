# B5b — Undo a refund

Branch `feature/b5b-reverse-refund`, code commit `49a6619` (based on `5bb65b0`).

## What was built

- **Migration `20261010180000_refund_reversal`** (written with `prisma migrate diff`, applied only
  to a throwaway database; a diff against it afterwards reports no difference): `supplier_refunds`
  gains nullable `reversed_at`, `reversed_by`, `reversal_reason` and `reversal_transaction_id`
  (unique, FK → `financial_transactions`, `ON DELETE RESTRICT`). Purely additive: every existing
  refund reads as not undone.
- **`POST /purchases/refunds/:id/reverse`** `{reason}`, `RolesGuard` + CORE_PARTNER, DTO
  `ReverseSupplierRefundDto` (string, not empty, ≤ 500). `PurchasesService.reverseRefund`, under
  `lockCycle`: re-reads the refund, finds its own inflow (`relatedType SUPPLIER_REFUND`,
  `relatedId`, `reversalOfId null`), writes the mirror row the ledger's own reversal writes
  (same type, category, cycle, related, `reversalOfId` → the inflow, reason `Refund undone: …`),
  and marks the refund with a conditional `updateMany … reversedAt: null`. Audited as `REVERSE`.
  Plain supplier refunds and loss refunds alike; any cycle status.
- **Refusals**: blank/whitespace/non-string/over-500 reason → `VALIDATION_FAILED {fields: reason}`
  (in the service too, rule 3); undone already → `ENTRY_ALREADY_REVERSED {date}` (the ledger's
  code), checked three ways — the refund's flag, an existing reversal of the inflow, and the
  conditional update; unknown or non-uuid id → 404 `supplierRefund`.
- **One definition of which refunds count**: `COUNTING_REFUND` / `counts()` in
  `common/loss-refunds.ts`. Used by the order cap (`loadRefundOrder`), the loss cap, the take-back
  guard (`assertLossNotRefunded`), the cycle page's `refundedEgp`/`unrecoveredEgp`, and check-data
  12.8. The shipment read still lists undone refunds, with `reversedAt` and `reversalReason`.
- **Profit**: recovery is now read signed through `recoveredEgp` / `netRecoveredEgp` in
  `common/ledger-categories.ts` — a refund's INFLOW adds, its reversal's OUTFLOW takes away — and
  recovery categories are excluded from operating expenses (`NOT_OPERATING_EXPENSE`).
  **Found on the way:** settlement and the dashboard happened to net an undo out (they saw the
  OUTFLOW as an expense), but analytics' cycle profitability counted only inflows, so an undone
  refund would have stayed in that cycle's profit. All three now read the one helper, and the
  dashboard's `totalExpenses` / `totalRecoveredEgp` are not inflated by an undo.
- **Take-back after the undo**: `DELETE /shipping/losses/:id` refuses `LOSS_REFUNDED` only while an
  un-undone refund names the loss. The `RESTRICT` key from B5 would still refuse the delete, so
  the take-back detaches the loss's undone refunds (`shipmentLossId → null`) in the same
  transaction and records their ids in its audit entry. Un-undone refunds keep the key's
  protection.
- **Ledger endpoint**: already refuses a refund's row alone (`ENTRY_OWNED_ELSEWHERE`, it has a
  `relatedType`) and the balancing row (`ENTRY_IS_A_REVERSAL`). Unchanged; now tested.
- **check-data 12.9** "an undone refund whose ledger inflow was not balanced".
- **Web**: the Shipment panel lists each loss's refunds (amount, payer, date); a standing one has
  "Undo refund" (`type="button"`), an undone one is struck through and badged with its reason.
  `UndoRefundDialog` is the confirm step: says what happens, requires a reason, one request per
  submit (in-flight ref, which also stops Enter pressed twice), refusals through `useApiError()`,
  refresh through `useRefreshShipment()` plus the ledger list. `lossRecovery().hasRefunds` counts
  only standing refunds, so take-back reappears once all are undone.
- **Locales**: `shipment.refundsOnLoss`, `refundLine`, `undoRefund`, `undoRefundTitle`,
  `undoRefundConfirm`, `undoRefundReason`, `undoRefundReasonPlaceholder`,
  `undoRefundReasonRequired`, `undoRefundFailed`, `refundUndone`, `refundUndoneBadge`;
  `errors.entity.supplierRefund`; `errors.LOSS_REFUNDED` now says to undo the refund first. Both
  en.json and ar.json. No new error code.

## Edge case → test (`apps/api/src/modules/purchases/refund-reversal.spec.ts`, same names)

- Reverse a loss refund → balancing OUTFLOW at the original; loss unrecovered; profit falls in
  settlement, cycle profitability and dashboard alike (expenses and investment unchanged).
- After every refund on a loss is reversed → the loss can be taken back (one left → still
  `LOSS_REFUNDED {refunds: 1}`); the refunds and both ledger pairs stay.
- Reverse twice → refused; twice at once → one balancing entry.
- Reverse without a reason → refused (absent, empty, blank, a number, 501 chars).
- A reversed refund no longer counts toward the loss cap or the order cap.
- The refund's own ledger row cannot be reversed alone through the ledger endpoint (and nor can
  the balancing row).
- Investor or shop → refused with a code (`ROLE_NOT_ALLOWED`; CORE_PARTNER allowed).
- Unknown refund → 404.
- Extra: a plain supplier refund undone; an undo on a CLOSED cycle; a refund with no ledger row.
- `refund-reversal.db.spec.ts` (opt-in `INTEGRATION_DATABASE_URL`): take-back past the real FK
  after undoing every refund; two undos racing through real `FOR UPDATE`.
- Vitest `components/shipment/undo-refund.test.tsx` (6): reason required; a double click → one
  request; the form submitted twice → one request; `ENTRY_ALREADY_REVERSED` translated with the
  reason kept; undone refund badged with take-back back; a standing refund hides take-back.
- Playwright `apps/web/tests/88-undo-refund.spec.ts` (TC-UR-01…09 API, TC-UR-20/21 on screen,
  reached by clicking). **Written, not run.**

## Revert checks (each failed, then passed once restored)

- Loss cap counting undone refunds → "A reversed refund no longer counts toward the loss cap…".
- Double-reversal guards off (all three) → "Reverse twice" and "twice at once".
- Take-back guard counting every refund → "After every refund on a loss is reversed…".
- Cycle profitability counting only inflows → both profit tests.
- Take-back detach off → the DB test fails on the foreign key against Postgres.
- Web: in-flight guard off → "submitted twice"; reason check off → "a reason is required". (The
  double-click case alone passes without the guard — the disabled button stops it — which is why
  the submit-twice case exists.)

## Runs

- api: jest 36 suites + 4 skipped (DB), 691 passed, 9 skipped; lint 0 errors (the pre-existing
  `files/storage.ts` warning); typecheck clean.
- Throwaway `postgres:16` (port 55466, tmpfs, all migrations): the four DB suites 9/9;
  check-data all zeros; 12.9 counted 1 after a refund was hand-marked undone with no reversal.
- web: `test:unit` 158 vitest + 43 node passed; lint 0 errors (46 existing warnings, none in
  these files); typecheck clean.

## Guesses (open until confirmed; also in BUSINESS_LOGIC §6)

1. An undo is allowed in any cycle status, settled or closed included, as recording one is.
2. On take-back, undone refunds stop naming the loss (kept in the take-back's audit).
3. A refund with no ledger inflow (from before refunds reached the ledger) is only marked.
4. The undo is dated when done; no separate "handed back on" date.
5. Missing reason is `VALIDATION_FAILED {fields: reason}` (the brief), not the ledger's
   `REVERSAL_REASON_REQUIRED`; double reversal reuses `ENTRY_ALREADY_REVERSED`.

## Docker

Docker Desktop was not running; started and left running. Container
`b5b_refund_reversal_scratch_pg` was used for the DB suites, the FK revert and check-data, then
removed. `motorcycle_parts_db` and the shared database were not touched.
