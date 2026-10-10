# Plan — partial arrivals + the UX batch

Spec: `docs/specs/2026-10-10-partial-arrivals-and-ux.md` (**read its Amendments section — it overrides**) · Business doc §1 §2 §3 §4 §7 §8 §14 §16
(edits marked *Building*) · Decisions: `docs/build-log/decisions/arrivals-and-ux.md`.

Every task follows `CLAUDE.md`: break-it tests (rule 0), invariant tests in
`apps/web/tests/34-business-invariants.spec.ts` for every new rule (rule 1), a revert check on each
new guard (rule 2), validation on the server (rule 3), fixtures that build real states (rule 4),
coded refusals in `en.json` and `ar.json` (rule 9), one definition per rule (rule 11), and roles on
every money endpoint (rule 12).

New e2e spec numbers start at **73**. Subagents write e2e cases but only run unit tests. The main
thread runs e2e against the shared database.

## Waves

| Wave | Tasks (parallel) | Waits on |
|---|---|---|
| 1 | B1 · U0 · U3 · S1 · U4b | — |
| 2 | B2 · U1 · U4 | B1 (B2); U0 (U1, U4) |
| 3 | B3 · U2 | B2 (B3); U1 (U2 edits the sales page U1 owns) |
| 4 | B4 · F1a · F1b | B3 |
| 5 | U5 | everything (it sweeps every page) |

File ownership per wave: no two tasks in a wave create or modify the same file. The exception is
`en.json` / `ar.json`, where each task adds keys only under its own namespace and the main thread
resolves the merge.

---

### B1 — Deliveries and losses in the data model, and the one position function (backend · logic)
Depends on: —. Owns: `prisma/schema.prisma`, a new migration, `src/common/shipment-position.ts` (new),
`GET /cycles/:id/shipment` (cycles controller/service, a read method only).

- `ShipmentDelivery`, `ShipmentDeliveryLine`, `ShipmentLoss` as in the spec. `InventoryBatch`: drop
  `sourcePoItemId @unique`, add `sourceDeliveryLineId` (**not unique** — a delivery line can be
  received in several goes) and `arrivedOn`. Leg status gains
  `PARTLY_ARRIVED`.
- Migration backfill: a delivery for every dated leg; batches linked to their last-leg delivery
  line, with its date; short-received lines → a loss with `costEgp 0` and the "absorbed" reason.
- `shipmentPosition(cycle)` is a pure function: per leg and line, entered / delivered / received /
  lost / on the way, plus `accounted` per line and per cycle. Unit tests only, no database.

Edge cases:
- [ ] One leg, 40 ordered, deliveries 15+10+5+10 → delivered 40, on the way 0, leg accounted   (§1)
- [ ] One leg, 40 ordered, 15 delivered, 5 lost → on the way 20, not accounted   (§1)
- [ ] Two legs: leg 1 delivered 30 of 40 → leg 2 entered 30, not 40   (§1: a later leg carries what the one before delivered)
- [ ] Leg 2 delivered 30, leg 1 lost 10 → line accounted only when received + all losses = ordered   (§8)
- [ ] Received less than a last-leg delivery said → the difference is waiting to be received against that delivery, not on the way   (§3)
- [ ] Several order lines move independently on one leg   (§1)
- [ ] A cycle with no legs and every unit received → accounted; a cycle with nothing ordered → accounted   (§8)
- [ ] A last-leg delivery of 15 received 14 → 1 waiting to be received (not on the way); the leg reads arrived, the cycle is not accounted   (§1, §3)
- [ ] Backfill run twice → no duplicate deliveries or losses   (migration, the second time)
- [ ] Backfill: a legacy line with receivedQty 0 on a SELLING cycle → a delivery waiting to be received; the cycle is not accounted   (migration)
- [ ] Backfill: a last leg with batches but no arrivedOn → a delivery dated the first batch's receipt day (Cairo); check-data clean   (migration; §14)
- [ ] Backfill: a dated leg with no departure → backfilled anyway; check-data does not flag historical rows   (migration)
- [ ] UAE-direct cycle: one leg, entered = ordered   (§1)
- [ ] Backfill: a leg dated before the migration → one delivery of the full ordered qty on that date   (migration)
- [ ] Backfill: a line received 18 of 20 → a loss of 2 at cost 0, so check-data and settlement do not count it twice   (§2: never charged twice)
- [ ] Backfill on a database with no cycles → runs, changes nothing   (checklist)
- [ ] `GET /cycles/:id/shipment` for an unknown id → 404, not 500   (rule 1: things that do not exist)
- [ ] `GET /cycles/:id/shipment` as an investor or shop → refused with a code   (rule 12)

### B2 — Recording deliveries and losses (backend · logic)
Depends on: B1. Owns: `shipping.service/controller`, the cycle transition gates in
`cycles.service.ts` (`assertShippingReached`), `common/cycle-losses.ts` (new: `cycleLossesEgp`),
`scripts/check-data.sh`.

- `POST /shipping/legs/:id/deliveries`, `DELETE /shipping/deliveries/:id`,
  `POST /shipping/legs/:id/losses`, all CORE_PARTNER.
- The leg's `status` and `arrivedOn` are derived from `shipmentPosition` after every write.
- `PUT /shipping/legs/:id` with `arrivedOn` → a delivery of the remainder (compatibility).
- Gates per §1's new table.
- A loss is its own record (`ShipmentLoss`) valued at the line's landed unit cost. **No ledger row**
  (§9). `cycleLossesEgp(cycleId)` in `common/` is the one definition settlement and analytics both
  read (B3 wires them in). Use the costing service's per-unit figure; B3 makes it per ordered unit.
- check-data: 12.3 is replaced by "delivered more than entered", "received + lost > ordered",
  "a loss whose cost is not qty × its unit cost", and "a batch with no delivery line".

Edge cases:
- [ ] Delivery of 41 when 40 are on the way → `DELIVERY_EXCEEDS_IN_TRANSIT`, nothing written   (§1)
- [ ] Deliveries 15, 10, 5, 10 → all accepted; the fifth (1 more) → refused   (§1)
- [ ] Leg 2 delivery larger than leg 1 has delivered so far → refused   (§1)
- [ ] Delivery dated tomorrow → `DATE_IN_FUTURE`   (rule 1: backwards in time)
- [ ] Delivery dated before the leg departed → `DELIVERY_BEFORE_DEPARTURE`   (§1)
- [ ] Delivery on a leg not yet departed → `LEG_NOT_DEPARTED`   (§1)
- [ ] Delivery or loss on a SETTLEMENT or CLOSED cycle → `CYCLE_SETTLING`; on a CANCELLED cycle → `CYCLE_CLOSED`   (§1)
- [ ] qty 0 or negative → `QTY_NOT_POSITIVE`   (rule 1)
- [ ] A line from another cycle's order → 404 `purchaseOrderItem`, not 500   (rule 1: the wrong owner)
- [ ] The same line twice in one delivery → `VALIDATION_FAILED`   (contract)
- [ ] No lines → `VALIDATION_FAILED`   (contract)
- [ ] Unknown leg id → 404   (rule 1)
- [ ] Two deliveries sent at once that together exceed what is on the way → exactly one succeeds   (the second time / race — use a transaction with row locking or a serializable re-check)
- [ ] Loss of more than is on the way → `LOSS_EXCEEDS_IN_TRANSIT`   (§1)
- [ ] Loss of 5 → a loss record at 5 × unit cost; profit falls by that in settlement and analytics alike; **cash, Collected and account balances unchanged; no ledger row**   (§2, §9; rule 11)
- [ ] Take a loss back → the units are on the way again; on a SETTLEMENT / CLOSED cycle → `CYCLE_SETTLING`   (§1)
- [ ] A delivery, loss or loss take-back on a cycle in SETTLEMENT → `CYCLE_SETTLING`; after the settlement is reversed to SELLING → allowed   (§1)
- [ ] Loss of units a last-leg delivery brought but that were never received → allowed; it clears the waiting quantity   (§1)
- [ ] A delivery dated today at 00:37 Cairo → accepted; dated tomorrow in Cairo → refused   (§7a timezone)
- [ ] `PUT` leg with a future arrivedOn → refused; with `arrivedOn: null` or a `status` → ignored, no change   (contract)
- [ ] Moving a leg's departure after a delivery so the delivery predates it → refused   (§1)
- [ ] Deleting a leg-1 delivery that leg 2 has drawn on → `DELIVERY_IN_USE`; deleting the only last-leg delivery of a cycle in ARRIVED_EGYPT → `DELIVERY_IN_USE`   (§1)
- [ ] Deleting a delivery as an investor, or on a closed cycle → refused   (rule 12, §1)
- [ ] Changing a leg's cost after a receipt or loss → `LEG_COST_LOCKED`   (§2)
- [ ] A delivery on a cycle with no order lines → `VALIDATION_FAILED` (nothing can be delivered)   (contract)
- [ ] Loss then a delivery: on the way shrinks by both, and a delivery for the lost units is refused   (§1)
- [ ] Delete a delivery whose lines were received into stock → `DELIVERY_IN_USE`   (§3)
- [ ] Delete a delivery that was not received → removed, and the leg status is re-derived   (the second visit)
- [ ] `PUT` leg with `arrivedOn` and 25 still on the way → one delivery of 25; again with the same date → no new delivery   (compatibility; the second time)
- [ ] Cycle → ARRIVED_UAE after leg 1's first delivery of 15/40 → allowed; with no delivery → `LEG_NOT_ARRIVED`   (§1 gates)
- [ ] Cycle → ARRIVED_EGYPT with the last leg partly arrived → allowed   (§1)
- [ ] Investor or shop token on each endpoint, including `DELETE /shipping/losses/:id` → refused with a code   (rule 12)
- [ ] A late freight charge after the cost lock → recorded as an ordinary ledger expense on the cycle; counted once in settlement and analytics; no batch's cost changes   (§2)
- [ ] check-data after a correct partial flow → all zeros; after a forced bad row → its check counts it   (rule 7)

### B3 — Receiving per delivery, fixed unit cost, settlement gate (backend · logic)
Depends on: B2. Owns: `inventory.service/controller` (verify), `costing.service.ts`,
`settlements.service.ts`, `purchases.service.ts` (`receivedQty`), the inventory read (arrival per
batch), the seeds (they must build deliveries, rule 4), and `tests/support/fixtures.ts`
(`giveStock` / `stockedProduct` keep working through the compatibility path).

- `POST /receipts/verify` with `deliveryId` + `deliveryLineId`s, allowed in ARRIVED_EGYPT /
  VERIFICATION / SELLING. The first receipt walks the cycle on to SELLING. A batch per delivery line.
- The old body shape works when exactly one last-leg delivery is waiting; otherwise
  `DELIVERY_REQUIRED`.
- Landed cost per ordered unit. `receivedQty` = the sum of the batches. `PUT /purchases/items/:id`
  rejects `receivedQty`.
- Settlement `approve` → `SHIPMENT_NOT_ACCOUNTED` while anything is on the way.
- Inventory and product page: Arrived = the batch's own `arrivedOn`.

Edge cases:
- [ ] Deliveries 15 then 10 received → two batches, same landed unit cost, both sellable   (§2, §3)
- [ ] The first delivery received and **sold** before the second arrives → the sale's COGS is unchanged after the second delivery and after a loss   (§3 invariant: COGS never re-priced)
- [ ] Unit cost: 40 ordered, goods 4,000, shipping 400 → 110.00 per unit for every batch, not 4,400 / received   (§2)
- [ ] Received 14 of a delivery of 15 → batch 14; 1 is waiting to be received against that delivery, and can be received later or marked lost   (§3)
- [ ] Receive 16 of a delivery of 15 → `RECEIVED_EXCEEDS_DELIVERED`   (§3)
- [ ] Receive 14 of a delivery of 15, then the 1 later → a second batch on the same delivery line; a third receipt → `STOCK_ALREADY_VERIFIED`   (§3)
- [ ] Receipt on a cycle still IN_TRANSIT → `CYCLE_NOT_ARRIVED`   (§3)
- [ ] An investor or shop token on `POST /receipts/verify` → refused with a code   (rule 12)
- [ ] Settlement and analytics both subtract `cycleLossesEgp`, and agree   (§9, rule 11)
- [ ] The first receipt walks ARRIVED_EGYPT → VERIFICATION → SELLING through `planTransition` (each step's checks run; a refused step stops the walk with its own code, nothing received)   (§3, §15)
- [ ] With 5 on the way, the plain transition SELLING → SETTLEMENT → `SHIPMENT_NOT_ACCOUNTED`, as approve is   (§8)
- [ ] Rounding: 3 ordered, 100 shipping → batches + losses re-sum to the line's landed total exactly; the final event takes the residual   (§2)
- [ ] FIFO: batch A arrived 1 Oct and received 20 Oct, batch B arrived 10 Oct and received 11 Oct → B sells first; COGS stable after more deliveries   (§3)
- [ ] Receiving 0 → no batch; negative qty or negative landed cost → refused   (§15, rule 1)
- [ ] Two receipts of one delivery line at once that exceed it together → one succeeds, the other gets a coded refusal, not a 500   (race)
- [ ] Receive a leg-1 (UAE) delivery into stock → `NOT_LAST_LEG_DELIVERY`   (§3: stock exists only in Egypt)
- [ ] A delivery from another cycle → 404   (the wrong owner)
- [ ] Receive in SELLING (a later delivery) → allowed   (§3: selling while the rest is on the way)
- [ ] Receive on a SETTLEMENT / CLOSED cycle → refused with a code   (§8)
- [ ] The old body with two deliveries waiting → `DELIVERY_REQUIRED`; with one → works   (compatibility)
- [ ] `receivedQty` after 15 + 10 → 25 (a sum, not overwritten)   (B3 contract)
- [ ] `PUT /purchases/items/:id` with `receivedQty` → refused   (rule 3)
- [ ] Manual landed-cost override still applies to that batch only   (§2)
- [ ] Settlement approve with 5 on the way → `SHIPMENT_NOT_ACCOUNTED` with the count; after marking them lost → allowed   (§8)
- [ ] Settlement profit with a loss of 5 × 110 → profit is 550 lower than without the loss   (§2; rule 10: a non-zero total)
- [ ] `markPaid` / CLOSE still refuses unsold stock without saying so (existing TC-CYCLE-08 still passes)   (regression)
- [ ] Inventory shows each batch's own Arrived date; two deliveries → two dates; never leg 1's date   (§14)
- [ ] The `giveStock` fixture still produces stock, and the whole suite stays green   (regression)
- [ ] The demo seed builds cycles with deliveries; `db:reset:demo` + check-data → all zeros   (rule 4, rule 7)

### B4 — The assistant learns deliveries (backend · logic)
Depends on: B3. Owns: `modules/assistant/tools/cycle.ts`, `tools/read.ts`, `instructions.ts`.

- `record_delivery` (preview → confirm). `verify_stock` takes a delivery. `get_cycle` returns the
  position. No loss tool. Descriptions updated.

Edge cases:
- [ ] `record_delivery` preview writes nothing; confirm writes exactly the previewed delivery   (§16 confirmation)
- [ ] A delivery recorded by someone else between preview and confirm, so the preview's quantity no longer fits → `PREVIEW_CHANGED` or `DELIVERY_EXCEEDS_IN_TRANSIT`, nothing written   (§16: a confirmation binds what the preview showed)
- [ ] `verify_stock` with a delivery: preview shows the unit cost; confirm books it; replay → `CONFIRMATION_USED`   (§16)
- [ ] `verify_stock` on a second delivery while SELLING → works (it used to be `CYCLE_NOT_IN_VERIFICATION`)   (§3)
- [ ] There is no tool for marking goods lost (`tools/list`)   (§16)
- [ ] `add_shipping_leg` with an arrival date → the preview lists the units it will deliver   (§16: the preview shows what is written)
- [ ] `verify_stock` after the landed cost changed since the preview → `PREVIEW_CHANGED`   (§16)
- [ ] An `mcp` token on the REST delivery endpoints → `WRONG_SURFACE`   (§16)
- [ ] Update the old assistant specs that pinned "verify once" or "VERIFICATION only" (cycle.spec.ts :946, :1025; e2e 69 TC-MCP-CYC-31) to the new rule, each with a reason   (regression)

### F1a — The cycle's Shipment panel, receiving and losses on screen (frontend · logic)
Depends on: B3. Owns: `cycles/[cycleId]/**` pages, new `components/shipment/*`,
`inventory/page.tsx`, `shipments/page.tsx`.

- The Shipment panel (per leg, per product: ordered / delivered / received / lost / on the way). The
  Record delivery, Receive into stock and Mark lost dialogs. The inventory page "Receive stock" list.
  The cycle details shipping card with status and deliveries. A profit card on the cycle page (UX #7,
  from the analytics figure). The shipments edit form no longer sends `status` or clears a date.

Interaction cases:
- [ ] Record delivery prefills what is on the way; typing over a prefilled value is kept on re-render   (CLAUDE.md §0: a typed value is never overwritten)
- [ ] A quantity above what is on the way shows the server's refusal in the reader's language; the dialog stays open with the values   (rule 9)
- [ ] Mark lost shows the EGP loss before the confirm   (§2)
- [ ] The dialogs' buttons are `type="button"` except submit; the modals portal out of any form   (CLAUDE.md §13)
- [ ] After a delivery or a receipt, the panel and the inventory list refresh without a reload — reached by clicking, not `page.goto`   (CLAUDE.md §2: the stale cache)
- [ ] Double-click on Receive → one receipt   (double submit)
- [ ] Future dates are disabled in the delivery date picker, using Cairo's today   (§1, §7a)
- [ ] The EGP figure in Mark lost comes from the server's preview, not a client recompute; the shown and booked amounts are equal   (rule 11)
- [ ] Take a loss back from the panel → the units return to on the way   (§1)
- [ ] An empty "Receive stock" list says there is nothing waiting   (empty state)

### F1b — Wizard ends at "in transit"; the cycle list shows profit (frontend · logic)
Depends on: B3. Owns: `components/cycles/CycleWizard.tsx`, `stores/cycle-wizard-draft.ts`,
`cycles/page.tsx` (the list).

- Remove step 4 (Receive); finishing walks the cycle only as far as the recorded dates allow, then
  opens the cycle page. The PO order date defaults to today and starts with one item row. Resume
  handles every order and leg, not only `[0]`. Cycle list: profit and ROI columns, "All" chip,
  translated "Click to resume".

Interaction cases:
- [ ] Finish with no dates on step 3 → the cycle is saved and opens in PURCHASING with the order still DRAFT; no "has not arrived" refusal   (UX #5, §15)
- [ ] Finish with a departure date → IN_TRANSIT and the order CONFIRMED   (§15)
- [ ] Finish with a departure date → the cycle is In transit   (§1)
- [ ] Resume a cycle with two orders and two legs → both shown   (the second visit)
- [ ] Leave the wizard at step 3 and come back by clicking → the typed values are still there   (the second visit)

### U0 — Shared UI pieces (frontend · surface)
Depends on: —. The date picker's "today" is **Cairo's** today (§7a), not the browser's. Owns: `components/ui/empty-state.tsx` (new), the date picker component, `lib/dates.ts`,
`lib/labels.ts` (new: `useCodeLabel(kind, code)`, which translates statuses, roles, methods and
cost bases), and their keys in the `common` / `codes` namespaces.

### U1 — The sale form and list (fullstack · logic)
Depends on: U0. Owns: `modules/sales/*` (the `confirm: true` create), `sales/page.tsx`.

- Phone item cards, a running total and line totals, one starting row, clickable rows,
  "Create & confirm", drafts showing "—" (not confirmed), the "All" chip, an empty state.

Edge cases:
- [ ] Create & confirm with enough stock → one confirmed order, stock reduced, in one request   (§4)
- [ ] Create & confirm for more than is in stock → refused `NOT_ENOUGH_STOCK`, **no draft left behind**, the form stays open with its lines   (§4: both happen or neither)
- [ ] Create & confirm with a discount larger than the line → refused, nothing saved   (§4, the −9,899 bug)
- [ ] Create & confirm for a customer id that does not exist → 404, not 500   (rule 1)
- [ ] Create & confirm as an investor → refused with a code   (rule 12)
- [ ] Two lines of one product (40 + 40) against 60 in stock on Create & confirm → refused as a sum   (§4)
- [ ] Double-click Create & confirm → one order   (the second time)
- [ ] A draft's outstanding shows "—", and the customer balance is unchanged by it   (§4)
- [ ] The running total equals the server's order total for the same lines, discounts included   (one definition)
- [ ] At 390px in Arabic every input shows its full value (assert the input's width, not a screenshot)   (UX #1)

### U2 — Payments against a chosen order (fullstack · logic)
Depends on: U1 (it adds a button to the sales page's order dialog). Owns: `modules/payments/*`,
`payments/page.tsx`, `customers/[id]/page.tsx`, new `components/payments/RecordPaymentDialog.tsx`,
and the one button in `sales/page.tsx`.

Edge cases:
- [ ] Pay 500 on an order owing 800 → allocated to that order only, even when an older order is unpaid   (§7)
- [ ] Pay 900 on an order owing 800 → `PAYMENT_EXCEEDS_ORDER`, nothing saved   (§7; rule 1: too much)
- [ ] Pay on another customer's order → refused (404)   (rule 1: the wrong owner)
- [ ] Pay on a draft → refused (a draft owes nothing)   (§4)
- [ ] Pay on a cancelled or fully paid order → refused   (§7)
- [ ] Payment dated tomorrow → refused   (the existing rule, now reached from a new path)
- [ ] Without an `orderId` → oldest-first as before (the existing tests still pass)   (§7)
- [ ] An investor records a payment → refused   (rule 12)
- [ ] The cap is the order's outstanding net of returns   (§5, §7)
- [ ] A chosen-order payment still counts toward the shop's payment plan   (§7)
- [ ] Amount 0 or negative with an orderId → refused   (rule 1)
- [ ] The dialog opened from an order shows that order's outstanding and defaults the amount to it, and the date to today   (UX #3)
- [ ] The payments page form and the customer page form are the same component   (rule 11)
- [ ] Double submit → one payment   (the second time)

### U3 — App shell: no search, a phone bottom bar (frontend · surface)
Depends on: —. Owns: `components/layout/app-shell.tsx`, the nav config, the back-link component.

- Remove the search box. Phone (< 768px): a bottom bar with Dashboard, Sales, Customers,
  Inventory, Cycles, More; the rest of the 22 items live under More. The back link is at least 44px.

### U4 — Dashboard you can act from (frontend · ui)
Depends on: U0. Owns: `dashboard/page.tsx` and its components.

- Quick actions. Tiles link to their lists (Receivables → customers by balance, Low stock →
  inventory). Two columns on a phone.
Interaction cases:
- [ ] Each tile navigates to its list, filtered as labelled   (UX #8)
- [ ] Recent activity lists the latest sale after one is confirmed, reached by clicking   (the stale cache)

### U4b — Why "Recent activity" is empty (backend · logic)
Depends on: —. Owns: the dashboard/analytics recent-activity query only.

Edge cases:
- [ ] Confirming a sale → it appears in recent activity; a draft does not   (§4)
- [ ] An investor sees only what their role may see   (rule 12)


### U4c — The audit log is open to every role; the menu ignores roles (fullstack · logic)
Depends on: U3. Owns: the audit-logs controller, `components/layout/nav-model.ts`.

Found by U4b and U3. `/audit-logs` has no RolesGuard (rule 12: silence means open), so a temporary
investor reads every before/after row. The menu shows all 22 entries to every role. The menu should
show a role exactly the pages whose list endpoint that role may call, read from the existing
`@Roles` declarations, so it is not a second definition (rule 11).

Edge cases:
- [ ] Investor or shop token on `GET /audit-logs` → refused with a code; core partner → allowed   (rule 12, both directions)
- [ ] For each role, every menu entry it sees opens a page whose data loads (no 403); every entry hidden is one whose endpoint refuses it   (rule 11, rule 12)
- [ ] The phone bar and More follow the same filter   (U3)

### S1 — The demo seed's paid orders with no payments (backend · logic)
Depends on: —. Owns: the demo seed files only (B3 later adds deliveries to them).

Edge cases:
- [ ] `db:reset:demo` then check-data → all zeros, including "an order marked paid with no payment"   (rule 4, rule 7)
- [ ] Every PAID / PARTIALLY_PAID order in the demo has payments allocated that total its paid amount   (rule 4)
- [ ] Order numbers: one style across the seed and the app, or the difference written down   (the review)

### U5 — Arabic everywhere (fullstack · logic)
Depends on: all others. Owns: success toasts across pages, `noValidate` on forms, notifications (the
server stores code + params; the web translates). Locale files `en.json` / `ar.json`.

Edge cases:
- [ ] A new notification renders in Arabic for an Arabic reader   (UX #10)
- [ ] An **old** notification (stored English text, no code) still renders   (the second visit: data already stored)
- [ ] Submitting an empty required field shows the app's translated message, not the browser's   (UX #10)
- [ ] `41-error-messages` passes: every thrown code translated, no orphan keys   (rule 9)
- [ ] Every status, role, method and basis code on every page goes through `useCodeLabel` (grep finds no raw `{order.status}` render)   (UX #10)

---

## Verify (after wave 5)

- api jest, web lint, web typecheck, and the full e2e in 4 groups with the storefront up.
- Every case above ticked against a test named for it.
- `ui-auditor` over every changed screen. `break-ui` on the Shipment panel, the sale form and the
  dashboard.
- check-data all zeros after `db:reset:demo`.
- The release alignment review over `master..HEAD`, then the business doc's *Building* marks become
  *built*.

## Ship

The migration runs first, against Neon (it is additive and backfills). Then
`scripts/ship-prod.sh status|migrate`, push `master`, a READY check on all three projects, `smoke`,
and `check-data` against production (read-only). The session must be in manual mode.
