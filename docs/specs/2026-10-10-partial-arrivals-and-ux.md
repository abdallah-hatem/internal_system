# Partial arrivals + the UX batch

2026-10-10 · feature mode · fully autonomous (decisions: `docs/build-log/decisions/arrivals-and-ux.md`)

Two pieces of work. **A** is the UX review's twelve recommendations and its quick wins, with the
search box removed. **B** is a change to the business: a shipment's goods arrive in several
deliveries, over weeks, and nobody can control that. B changes stock, cost and settlement, so it is
the part this spec spends its words on. Roles do not change: everything here is core partners only,
as receiving, shipping and settlement already are.

---

## B. Partial arrivals

### What happens in the business

A cycle orders 40 of a product. The goods are handed to the shipping company in one go, and they
reach the other end in pieces: 15, then 10, then 5, then 10, over about forty days. This can happen
on **either leg**: China → UAE (the merchant's leg) and UAE → Egypt (the shipping company's). Each
delivery that reaches Egypt is counted, checked into stock, and **can be sold straight away**. Some
goods may never come. The partner decides, each time, whether the missing ones are **lost** or
**still on the way**.

### The rules (the exact edit to `docs/BUSINESS_LOGIC.md`)

§1 gains this, after the leg-cost table and replacing the paragraph "A leg's status is a reading of
its dates…" and its table:

> **DECIDED 2026-10-10 — a leg's goods arrive in deliveries.** Goods leave in one shipment, but they
> arrive in pieces, weeks apart, and nobody here controls the split. So a leg records each
> **delivery**: the date it arrived and how many of each ordered product it brought. One leg can
> have any number of deliveries.
>
> What a leg can deliver is what entered it: everything ordered, for the first leg; for a later
> leg, what the leg before it delivered. A delivery that would bring more than that is refused.
>
> A leg's status is still a reading of what was recorded, never a field anyone sets:
>
> | Recorded | Leg reads |
> |---|---|
> | nothing | pending |
> | a departure | in transit |
> | a departure and at least one delivery, with goods still unaccounted for | partly arrived |
> | every unit that entered it delivered or marked lost | arrived |
>
> **Goods that have not come are still on the way until a partner says otherwise.** At any point a
> partner can mark some or all of what is still on the way as **lost**, on any leg. Nothing is
> marked lost by itself, however long it has been: goods have turned up late before, and the
> partner is the one who knows.
>
> The cycle can move on as soon as **some** goods reach a point, not only once all of them have:
>
> | Cycle step | Requires |
> |---|---|
> | In transit (China) | leg 1 has departed |
> | Arrived UAE (China) | leg 1 has at least one delivery |
> | In transit to Egypt | the last leg has departed |
> | Arrived Egypt | the last leg has at least one delivery |
>
> A delivery cannot be dated in the future, before its leg departed, or on a cycle that is cancelled
> or closed.

§2 (landed cost) gains:

> **DECIDED 2026-10-10 — a unit costs the same whichever delivery brought it.** Landed cost is
> worked out per unit **ordered**: the goods' price plus each leg's cost spread over everything the
> leg was charged for. Every batch from the same order line gets that same unit cost, whether it
> came in the first delivery or the fifth. It used to be worked out over what was received, so a
> short delivery made every unit dearer, and quietly charged the missing goods to the ones that came.
>
> **Lost goods are a loss, not a dearer batch.** Marking units lost records their landed cost as a
> loss on the cycle. It counts against the cycle's profit, and it never re-prices a batch: earlier
> deliveries may already be sold, and a sale's cost is never changed after the fact (§3).

§3 (inventory) gains:

> **DECIDED 2026-10-10 — stock is received one delivery at a time.** Each delivery that reaches
> Egypt is counted and checked into stock as its own batch, with its own arrival date. It can be
> sold the moment it is checked in, while the rest of the shipment is still on the way. A count
> lower than the delivery said leaves the difference on the way: it can be checked in when it turns
> up, or marked lost. Receiving more than a delivery brought is refused. The units ever received or
> lost on an order line can never total more than were ordered.

§8 (settlement) gains:

> **DECIDED 2026-10-10 — a cycle settles only once every unit is accounted for.** Every unit ordered
> must be received into stock or marked lost before the settlement can be approved. Goods still on
> the way make the cycle's profit a guess.

§14 (arrival) changes:

> **Arrived** is the date of the delivery that brought the batch into Egypt. Each batch has its
> own, so two batches of one product from the same cycle can show two dates. It is no longer the
> cycle's last leg date.

§16 (the assistant) gains: "It can record a delivery on a leg. Marking goods lost is done in the
office app only: it books a loss, and a partner should decide that on screen."

### The data model

- **New: delivery** (`ShipmentDelivery`): leg, `arrivedOn`, `createdBy`, `createdAt`, `note`.
  Its lines (`ShipmentDeliveryLine`): delivery, purchase order item, `qty` (> 0). A delivery
  has at least one line, and the same order line at most once per delivery.
- **New: loss** (`ShipmentLoss`): leg, purchase order item, `qty` (> 0), `unitCostEgp` (the
  line's landed unit cost when it was marked), `costEgp`, `reason` (optional), `createdBy`,
  `createdAt`. Each one books a ledger OUTFLOW, category **`loss`**, with the cycle id. `loss` is
  NOT a capitalised category, so settlement and analytics both count it as an expense, through the
  single definition in `common/ledger-categories.ts` (rule 11).
- **Inventory batch**: drop `sourcePoItemId @unique` (one batch per order line). Keep
  `sourcePoItemId`, add `sourceDeliveryLineId @unique` (one batch per delivery line on the last
  leg), and add `arrivedOn` (copied from the delivery).
- **Shipping leg**: `arrivedOn` and `status` stay as stored columns, but the service now derives
  them. `arrivedOn` is the date of the delivery that completed the leg, or null while anything is
  unaccounted. `status` can also be `PARTLY_ARRIVED`.
- **Purchase order item `receivedQty`**: kept, and from now on always the **sum** of its batches'
  received quantities. It is never set directly. `PUT /purchases/items/:id` stops accepting it.
- **One pure function, `shipmentPosition(cycle)`**, owns the arithmetic. For each order line and
  each leg it gives: entered, delivered, received (last leg only), lost, and on the way. Every
  screen, guard, check and tool reads this one function and never re-derives it (rule 11).

**Migration (additive, plus a backfill).** For every leg with an `arrivedOn`, one delivery on that
date, carrying each order line's full ordered quantity. Existing batches are linked to the last-leg
delivery line of their order line, and get its `arrivedOn`. Where a line was received short
(`receivedQty < orderedQty`), the shortfall is recorded as lost with `costEgp = 0` and the reason
"absorbed into the batch cost before 2026-10-10". It was already charged to the batch the old way,
so it must not be charged twice. `check-data` runs before and after the migration.

### API

| Endpoint | Does | Refuses |
|---|---|---|
| `GET /cycles/:id/shipment` | the shipment position: per leg and line, entered / delivered / received / lost / on the way, plus each delivery | 404 for an unknown cycle |
| `POST /shipping/legs/:id/deliveries` `{arrivedOn, lines:[{purchaseOrderItemId, qty}], note?}` | records a delivery; re-derives the leg's status and arrivedOn | `DELIVERY_EXCEEDS_IN_TRANSIT` (with params: line, onTheWay, asked), `LEG_NOT_DEPARTED`, `DATE_IN_FUTURE`, `DELIVERY_BEFORE_DEPARTURE`, `CYCLE_CLOSED`, `QTY_NOT_POSITIVE`, a line from another cycle → `notFound('purchaseOrderItem')`, the same line twice → `VALIDATION_FAILED`, no lines → `VALIDATION_FAILED` |
| `DELETE /shipping/deliveries/:id` | removes a delivery recorded by mistake | `DELIVERY_HAS_STOCK` once any line has been received into stock |
| `POST /shipping/legs/:id/losses` `{lines:[{purchaseOrderItemId, qty}], reason?}` | marks units on the way as lost and books the loss | `LOSS_EXCEEDS_IN_TRANSIT`, `QTY_NOT_POSITIVE`, `CYCLE_CLOSED` |
| `POST /receipts/verify` `{cycleId, deliveryId, items:[{deliveryLineId, receivedQty, landedUnitCostEgp?}]}` | receives one last-leg delivery into stock, one batch per line, at the fixed unit cost. The first receipt moves the cycle through Arrived Egypt and Verification to Selling | `RECEIVED_EXCEEDS_DELIVERED`, `STOCK_ALREADY_VERIFIED` (that delivery line), `NOT_LAST_LEG_DELIVERY`, `CYCLE_CLOSED`, plus the existing checks |
| `PUT /shipping/legs/:id` with `arrivedOn` | **kept for compatibility** (the shipments page, the old wizard, the fixtures): "everything still on the way arrived on this date", i.e. one delivery of the remainder. With nothing remaining, a no-op | as for deliveries |
| `POST /settlements/:id/approve` | unchanged, plus the gate | `SHIPMENT_NOT_ACCOUNTED` (params: units on the way, lines) |
| `GET /costing/cycles/:id/landed-cost` | now per ordered unit | — |

Receiving is allowed while the cycle is Arrived Egypt, Verification or Selling. It used to need
exactly Verification, which is why a second delivery could never be received.

`POST /receipts/verify` with the old body shape (`purchaseOrderItemId`, no `deliveryId`) keeps
working when the line has exactly one last-leg delivery waiting. Otherwise it is refused with
`DELIVERY_REQUIRED`. That keeps the fixtures and the old callers working.

### The assistant (MCP)

- New tool **`record_delivery`**: preview, then confirm, like every write. It takes leg, date and
  lines.
- `verify_stock` takes a delivery. Its description loses "each order line can be verified once"
  and "a cycle in VERIFICATION".
- `get_cycle` returns the shipment position.
- There is no tool for marking goods lost (office app only, §16).

### Screens

- **Cycle page, new "Shipment" panel.** One block per leg, and in each a row per product: ordered,
  delivered, received, lost, on the way, with a small progress bar. The buttons are:
  - **Record delivery**: date (defaults to today; no future dates), then the quantity per product,
    prefilled with what is still on the way.
  - **Receive into stock** on each last-leg delivery that is waiting: a table of its lines with the
    quantity prefilled and the landed cost shown. This replaces both the inventory page's
    product-ID dialog (UX #4) and the wizard's step 4.
  - **Mark lost**: the quantity per product, up to what is on the way, with an optional reason. A
    confirm step shows the loss in EGP.
- **Inventory page**: "Verify Stock" becomes **"Receive stock"**. It lists the deliveries waiting to
  be received, across cycles, each opening the same receive dialog. No more typed IDs.
- **Cycle wizard (UX #5)** finishes at **ordered / in transit**. The dates on step 3 stay optional,
  and step 4 "Receive Inventory" is removed. Receiving happens on the cycle page, when deliveries
  come. The money step stays.
- **Cycle details**: the shipping card shows each leg's status and its deliveries, which fixes
  "arrival not shown".
- **Shipments page**: the edit form can no longer clear an arrival date, and sends no `status`.

---

## A. The UX batch (from the 2026-10-10 review)

| # | Change | Rule? |
|---|---|---|
| 1 | Sale form on a phone: each item becomes a card (product, then qty / price / discount on a second row). No clipped inputs in either language | no |
| 2 | Sale form: a running order total and per-line totals; starts with one empty item row; whole rows clickable in the list; **"Create & confirm"** beside "Create draft" | **yes**, decided "do all": `POST /sales/orders` takes `confirm: true` and drafts and confirms in **one transaction**. If confirming is refused (not enough stock…), nothing is saved and the form stays open with the refusal |
| 3 | **"Record payment"** on a confirmed order with something owed, and on the customer card. The Payments page uses the customer page's form (outstanding shown, date = today) | **yes**: `POST /payments` takes an optional `orderId` and puts the money on that order. It must be that customer's order, confirmed, with something owed, and the amount cannot exceed what that order owes (`PAYMENT_EXCEEDS_ORDER`). Without `orderId`, oldest-first as today |
| 4 | Verify Stock dialog → covered by B ("Receive stock") | yes (B) |
| 5 | Wizard dead end → covered by B | yes (B) |
| 6 | **Remove** the top-bar search box | no |
| 7 | Cycle list: profit and ROI columns; cycle page: a profit card, both from the analytics figure (one definition) | no |
| 8 | Dashboard: "New sale / Record payment / New cycle" buttons; tiles link to their lists (Receivables → customers sorted by balance, Low stock → inventory); 2 columns on a phone | no |
| 9 | Phone: a bottom bar (Dashboard, Sales, Customers, Inventory, Cycles), with the rest under "More" | no |
| 10 | Arabic: dates in the reader's locale; every status, role, method and basis code shown through translations; success toasts translated; forms `noValidate`, so the app's own messages show; notifications sent as code + params and translated by the app | no |
| 11 | A draft shows no amount owed in the sales list or on the customer page: "—" and "not confirmed" | **yes** (display only), decided "do all", and it follows §4: a draft counts for nothing |
| 12 | Empty lists: one line saying what goes there, plus the main button | no |

**Quick wins:**
- the first filter chip reads "All", not "Filter"
- "Click to resume" is translated
- the payment date defaults to today
- the wizard's order date defaults to today, and the order starts with one item row
- date pickers grey out future days where the server refuses them
- payment method shown the same way everywhere
- the back link is at least 44px tall
- check the two order-number styles

**Also in scope:** the review saw demo orders marked Paid with no payment records. A task checks
whether the demo seed builds orders that way (rule 4: fixtures must build states the business
recognises) and fixes the seed if so.

---

## Out of scope

- Splitting a shipment's **departure**. Goods leave in one go; only arrival is split.
- Moving goods between cycles, and returning goods to a supplier for anything lost in transit.
- Insurance or carrier claims for lost goods. If money comes back for a loss later, it is a
  supplier refund (§6), recorded as today.
- Selling on Amazon (§17).
- Search. It is removed, not rebuilt.
