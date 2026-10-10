# F1a — The cycle's Shipment panel, receiving and losses on screen

Branch `feature/arrivals-f1a`, based on `866ca7a`. Rules: BUSINESS_LOGIC §1, §2, §3, §6, §14
(DECIDED 2026-10-10, including "one meaning of low stock"). Spec B "Screens", amendments 1–13.

## What was built

New `apps/web/src/components/shipment/`:

- **`shipment-model.ts`** — the `GET /cycles/:id/shipment` types and small pure readings of them:
  `fieldValue` (a typed value is kept; an untouched field follows the server), the prefills
  (`onTheWayByLine`, `losableByLine`, `receivableByLine` = min(delivery line qty − received from it,
  the line's waiting) — the server's own receipt cap), `waitingDeliveries`, `lossRecovery` (reads
  `refundedEgp`/`unrecoveredEgp`, treats them as 0 / cost while B5 is not merged). Nothing here works
  out where goods are; every quantity is `shipmentPosition`'s.
- **`ShipmentDialog`** — the shared frame: portals to `<body>` (§13), fixed header/footer, scrolling
  body, `dvh` cap, Escape/scrim/X blocked while a request runs. `useRefreshShipment()` invalidates
  `shipment`, `cycle`, `cycles`, `inventory`, `inventoryBatches`, `landedCost`, `analytics`,
  `shipments` after every write.
- **`ShipmentPanel`** — per leg: status (`useCodeLabel('legStatus')`), departure, arrival; a row per
  product (ordered / delivered / received / waiting / lost / on the way + a progress bar), cards on a
  phone; the deliveries (Receive, Delete) and the losses (Record refund, Take back). Hides writes on a
  frozen cycle (SETTLEMENT / CLOSED / CANCELLED); Record refund stays (allowed in any status).
  One `open` state for every dialog, so each close path clears all of it.
- **`RecordDeliveryDialog`** — Cairo today, `disableFuture`, qty per product prefilled with what is on
  the way, optional note. No client cap: over the limit is the server's `DELIVERY_EXCEEDS_IN_TRANSIT`.
- **`ReceiveDeliveryDialog`** — one component for the panel and the inventory page. Qty prefilled with
  what can still be received, landed unit cost shown from `GET /costing/…/landed-cost` (display only),
  optional per-line override sent only when typed. Ref guard against a double submit.
- **`MarkLostDialog`** — quantities + reason → confirm step → done step (see "the loss figure").
- **`RecordRefundDialog`** — loss / refunded so far / unrecovered; payer is the leg's provider or the
  order's supplier (nobody pre-chosen when there are two); amount, `CurrencyRateFields` (rate filled
  from the app's FX rates), Cairo-today date, reason. Built against B5's contract.
- **`ConfirmActionDialog`** — delete a delivery, take a loss back; refusals translated inside it.
- **`ReceiveStockList`** — the inventory page's "Receive stock": every last-leg delivery with something
  waiting, across cycles, oldest first, each opening the Receive dialog; `EmptyState` when none.

Pages:

- **Cycle details** — the Shipment panel; a profit card from `GET /analytics/cycle-profitability`
  (profit, ROI, revenue, cost, losses; the same query key as the list and Analytics); the shipping card
  shows each leg's derived status and its deliveries; the status line is translated.
- **Inventory** — "Verify Stock" (typed product IDs) is gone; "Receive stock" toggles the list. The
  low-stock highlight now uses `isBelowMinStock` (the helper the filter and the dashboard rule already
  share) instead of "any batch under 10"; "Low" is translated.
- **Shipments** — the edit form sends neither `status` nor `arrivedOn`; the arrival shows read-only
  with a link to the cycle's panel. Leg statuses go through `useCodeLabel` (PARTLY_ARRIVED included).
  Saving invalidates the shipment caches too.
- Locale keys: new `shipment` namespace; additions under `cycles`, `inventory`, `shipments` (en + ar).
  Removed keys nothing reads any more: `inventory.verifyStock/receivedQty/unitCost`,
  `shipments.pending/inTransit/arrived`.

## The loss figure (rule 11)

There is no preview endpoint, and F1a owns no API file. So the confirm step shows **qty × the costing
endpoint's landed cost per ordered unit, labelled "Estimated loss"** with a line saying the last units
of a line take the rounding residual. Once booked, the dialog shows **the `costEgp` the server returned**
— the amount on the books — and the panel shows that figure from then on. The client defines no loss
cost of its own; the plan's "shown = booked" holds for the done step and the panel, not the estimate.

## Tests

- Vitest, 45 new (all web: 12 files, 152 passing; node:test 43/43):
  `shipment-model.test.ts` 19, `shipment-dialogs.test.tsx` 22, `inventory-receive.test.tsx` 4.
- Revert checks (each failed, then passed once restored):
  - `fieldValue` ignoring what was typed → 8 fail (prefill kept, refusal keeps values…);
  - receipt ref guard removed → "a double click sends one receipt" fails;
  - done step showing the estimate → "shows the amount the server booked" fails;
  - the Continue-then-confirm guard removed → "a double click on Continue does not book" fails;
  - take-back offered on a refunded loss → "a refunded loss offers no take-back" fails;
  - inventory highlight back to "< 10" → both low-stock tests fail.
- Playwright, **written, not run**: `tests/85-shipment-panel.spec.ts`, 14 cases, login then clicks only
  (`page.goto` only for the login page):

| Plan interaction case | Test |
|---|---|
| prefill; typed value kept on re-render | TC-SHP-02; vitest "prefills… survives a refetch" |
| over on the way → translated refusal, dialog keeps values | TC-SHP-03 (Arabic); vitest |
| Mark lost shows the EGP loss before confirm | TC-SHP-01, vitest "confirm step shows an estimate" |
| buttons `type="button"` except submit; portals out of forms | TC-SHP-04; vitest "renders in <body>" |
| panel + inventory refresh without reload, by clicking | TC-SHP-01 (panel after each write, inventory list, back to the cycle) |
| double-click Receive → one receipt | TC-SHP-06; vitest |
| future dates disabled, Cairo's today | TC-SHP-05; vitest "Cairo's today" |
| shown loss = booked (rule 11) | TC-SHP-01 (booked = API `costEgp`); vitest "server booked — not the estimate" |
| take a loss back → on the way again | TC-SHP-07 |
| record refund: loss / refunded / unrecovered; REFUND_EXCEEDS_LOSS translated, values kept | TC-SHP-01, TC-SHP-08; vitest |
| empty "Receive stock" list | TC-SHP-10 (cycles list stubbed empty); vitest |
| low-stock highlight + filter = the dashboard rule | TC-SHP-11 (dashboard tile → filter → highlight); vitest |
| also: DELIVERY_IN_USE translated; shipments form sends no status/arrival; profit card = analytics; phone cards | TC-SHP-09, 12, 13, 14 |

- `npm run test:unit`, `npm run lint` (0 errors; suppressions pruned for the three pages, whose counts
  fell), `npm run typecheck`: clean.
- Not checked in a browser: no API or database was run (no Docker). Light/dark, RTL and 390px are
  covered only by tokens, logical utilities and TC-SHP-14.

## Guesses (open until confirmed)

1. **"Move to Arrived Egypt" on the panel.** Receiving needs Arrived Egypt (amendment 6) and a delivery
   does not move the cycle, so a cycle In transit to Egypt with a delivery could not be received from
   anywhere but the cycle list's status dialog. The panel offers the walk, through `statusesToWalk`
   (F1b's one definition) — the server checks every step. The inventory list shows such deliveries with
   "Open cycle" instead of Receive.
2. **The "Receive stock" list reads each open cycle's shipment** (N requests), since no endpoint lists
   waiting deliveries across cycles. Fine for a handful of cycles; an endpoint would be better later.
3. **Mark lost starts empty**, not prefilled — marking goods lost should be a typed decision.
4. **The progress bar** is the share of what entered the leg that is no longer on the way.
5. **Two payers → none pre-chosen**; one payer → chosen.
6. **The refund currencies** are EGP / USD / AED / CNY.
7. `CurrencyRateFields` (shared, not F1a's) still has English hints ("Current rate…"); left for U5.
8. Products with a minimum and **no batch at all** are counted low by the dashboard but cannot appear in
   the inventory list (`GET /inventory` is built from batches). Not changed here (API).
9. `REFUND_EXCEEDS_LOSS` and `LOSS_REFUNDED` have no translation until B5 adds them to `errors`; until
   then the server's English shows. TC-SHP-08 asserts the translation exists.
