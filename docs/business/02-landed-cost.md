> Part of the [business rules](../BUSINESS_LOGIC.md) — the index there lists every section. Moved here verbatim 2026-11-01.

## 2. Landed cost

**Shipping is part of what the goods cost.** Each leg's cost is spread across
the goods it moved — by weight for a weight-charged leg, by piece otherwise —
and lands on the batch. So cost of sale includes freight, and a cycle's profit
is not overstated by the amount it paid to ship.

A weight-based leg where products have no unit weight falls back to
per-piece allocation and says so in a warning rather than failing silently.

Allocation gives the last line the residual, so the parts always re-sum to the
leg total exactly.

**Landed cost is computed, not typed.** Verification suggests it; a manual value
still overrides.

**DECIDED 2026-10-10 — a unit costs the same whichever delivery brought it.**
*Built 2026-10-11 (B3).* Landed cost is worked out per unit **ordered** — the goods' price plus
each leg's cost spread over everything the leg was charged for — and every batch
from the same order line gets that same unit cost, whether it came in the first
delivery or the fifth. It used to be worked out over what was received, so a
short delivery made every unit dearer and quietly charged the missing goods to the
ones that came.

**Lost goods are a loss, not a dearer batch.** Marking units lost records their
landed cost as a loss on the cycle. It counts against the cycle's profit and never
re-prices a batch: earlier deliveries may already be sold, and a sale's cost is
never changed after the fact (§3).

A lost unit is valued at the **full** landed unit cost, on whichever leg it was
lost. That way everything a line cost lands exactly once: in its batches, or in
its losses.

The unit cost is the line's landed total over the units ordered, to four places.
So that the line still re-sums exactly, the event that accounts for its last
units (the final receipt or loss) takes the rounding residual.

**A leg's cost is fixed once any unit of the cycle has been received or marked
lost.** Changing it after that would cost the next delivery differently from the
last one. A late or corrected freight charge after that point is a cycle expense,
recorded in the ledger. *Amended 2026-10-17, below: a correction now re-costs the
whole cycle instead, within limits.*

**DECIDED 2026-10-17 (owner) — a per-piece leg is charged for the pieces that went on it.** Once the
shipment knows what entered a leg (leg 1: what was ordered; a later leg: what reached it), a `PER_PIECE` cost's
piece count IS that number: the server sets it on every save, from the office form, the assistant's
`update_leg_cost` or any caller, and the form shows it read-only. A typed count is still checked (negative is
refused) but never kept. Before any goods are on a later leg, the typed count stands. Why: leg 2 of
CYC-2026-0001 was saved at 20 AED × 100 pieces while 230 travelled on it ("why not force the 230?").
Forwarders that bill by carton: use a flat amount.

**2026-10-17, owner: per-product cost matters — a leg's cost can be corrected after
arrival, and the whole cycle is re-costed. The limits are a guess — OPEN.** *Built
2026-10-17.* The owner's case: CYC-2026-0001's Dubai → Cairo leg was entered at 0
and the real fee comes later. As a cycle expense it keeps the cycle's profit right
but leaves every product's landed cost, every sale's COGS and every per-product
margin without the freight, and "per-product cost is very important".

So after goods were received a leg's cost may still be changed, and the change
re-costs everything of the cycle in one go, as if the right figure had been there
at every receipt: every batch's unit cost (each order line's batches replayed in
the order they were received, so the last carries the rounding residual exactly as
a fresh receipt would), every purchase row the receipts booked, every sale
allocation drawn from those batches (and so the dashboard's COGS, the cycle's
profit and the per-product margins), and every return of them. **Units already
sold are re-priced** — the edit form says so before it is saved. This is the one
exception to "a sale's cost is never changed after the fact" (§3): the sale's cost
was wrong, not changed.

It is refused, each with its own reason, when a re-cost would undo or silently
overwrite something that already stands — and then the late charge goes in as a
cycle expense, as before:

| Refused when | Code | Why |
|---|---|---|
| The cycle has a settlement in draft, approved or paid (a reversed one is ignored), or is being settled, closed or cancelled | `LEG_COST_LOCKED_SETTLEMENT` | The figures were agreed on the old cost. Recalculating is not possible once a settlement exists; record it as a cycle expense. |
| Anything of the cycle was marked lost | `LEG_COST_LOCKED_LOSSES` | The loss was booked at the old unit cost, and refunds may hang off it. |
| Units of the cycle were marked damaged in storage and the damage stands (2026-11-28) | `LEG_COST_LOCKED_DAMAGED` | Like a loss, the damage was booked at the old unit cost. Undoing the damage lifts it. **GUESS** (decided by the assistant 2026-11-28; owner can change). |
| Stock was moved into or out of the cycle and the transfer stands | `LEG_COST_LOCKED_TRANSFERS` | The other cycle took the units at the old cost (§8). Undoing the transfer lifts it. |
| A batch is not at the cost the legs compute today | `LEG_COST_LOCKED_OVERRIDE` | That is a cost typed by hand at receipt, which a re-cost would silently replace. |
| An order line's purchase rows do not pair one-to-one with its batches, at their costs | `LEG_COST_LOCKED_LEDGER` | Re-costing would have to guess which row is which. |

Nothing received or lost: the cost moves freely, exactly as before. Open: whether
the owner wants any of these limits lifted (a loss re-costed with its batches, a
draft settlement recalculated automatically), and whether sold units should be
re-priced at all after some date — the guess is yes, always, until a settlement.

The same correction is the assistant's `update_leg_cost` (2026-10-17, §16), through the same
`updateLeg`. Since 2026-10-17 the service itself also refuses a negative cost, rate, piece count or
weight (`LEG_COST_NEGATIVE`) and a rate to EGP of zero or less (`RATE_NOT_POSITIVE`) — only the
form's DTO said so before, so any other caller could write a negative leg or turn a USD bill into
0 EGP (CLAUDE.md rule 3).

**DECIDED 2026-10-20 (owner) — a new leg starts from where it leaves.** *Built 2026-10-22.* A leg leaving
China (a China cycle's leg 1) starts in **USD**, **charged by a flat amount**; a leg leaving the UAE (a China
cycle's leg 2, a UAE-direct cycle's only leg) starts in **AED**, per piece as before. The currency's rate is
filled in from the Exchange rates page (§22) and stays editable. One helper, `legCostStart` in
`apps/web/src/components/cycles/leg-plan.ts`, for the wizard's shipping step and the cycle page's Add leg form.
Starting values only: a leg already saved keeps its own currency and basis (an EGP leg stays EGP), and a
currency or basis picked in the form is never put back — not on going back a step, not on a reload of the draft.
The API is unchanged; this is what a form offers, not a rule a caller must follow.
GUESS: the Shipments page's own New leg form, where the cycle is picked in the form, still starts on EGP per
piece — it does not know where the leg leaves from until a cycle is chosen.

---

**DECIDED 2026-10-23 (owner) — a leg's cost is shared equally per piece, whatever the product.** Raised by CYC-2026-0001's
correction: on a mixed shipment a 20.31 AED pack of screws carries the same ~383 EGP of freight as a helmet headset, so
its default price comes out at 797 EGP. Sharing by value or by weight was offered; the owner: "I guess a landed cost is a
landed cost whatever the product". Unchanged: every piece on a leg carries an equal share of it; a price the owner
sets replaces the default where the default is too high.

**DECIDED 2026-11-20 (owner) — a UAE leg in handovers costs the freight of its handovers.** *Built 2026-11-20,
`feature/leg-handovers`, not merged.* The leg's cost is never typed: it is worked out from its handovers on every
handover, arrival, All arrived, freight correction and undo (`common/leg-handovers.ts`, `HandoversService.syncFreight`).

| Rule | Now | Status |
|---|---|---|
| Freight a piece | Every unit on the leg costs the same freight, whichever batch brought it (2026-10-10). While any handover is open it is an **estimate**: freight paid so far ÷ pieces covered so far, where a handover with a count covers its count and one without covers what has arrived from it so far. The owner's example: 6,000 AED for 150 + 4,200 AED for a lot with no count of which 40 arrived = 10,200 ÷ 190 = **53.68 AED a piece**. | DECIDED (the estimate rule) |
| The leg's cost | Freight paid (in pounds at each handover's rate) × the cycle's pieces ÷ pieces covered — the costing spreads every leg over every piece ordered, so each piece carries exactly paid ÷ covered. Stored on the leg as a flat EGP amount. Nothing covered yet (no count, nothing arrived): the leg carries what was paid. Everything covered: exactly the freight paid. | GUESS (stored as flat EGP) |
| Re-costing | A change re-costs the cycle through the existing leg re-cost (batches, purchase rows, sale allocations / COGS, returns — the same `planRecost`/`recost`, not a copy). When it is refused (`LEG_COST_LOCKED_SETTLEMENT`, `_LOSSES`, `_TRANSFERS`, `_OVERRIDE`, `_LEDGER`) the handover, arrival or undo is refused with that code and nothing is written — **never booked as an expense instead**. So once anything of the cycle is lost (a handover's missing pieces included), later handovers that would move the rate are refused until the loss is taken back; a cycle with a leg-1 loss cannot use handovers that move its cost at all. | DECIDED (surface the code); the consequence is the existing lock's |
| Final | Every handover All arrived and every piece of the cycle accounted on the leg. Then the cost is exactly the freight paid. | DECIDED |
| The profit while it is not final | `freightEstimate: true` on the cycle's shipment, its line in `GET /analytics/cycle-profitability`, `GET /settlements/preview/:cycleId` and `GET /cycles/:id/take`; the cycle page's Profit card shows a pill "Estimate" with "A leg's freight is not final yet: handovers are still open." | GUESS (wording) |
| Weight | A leg in handovers is per piece only; switching it to weight is refused (`LEG_HANDOVERS_PER_PIECE`). | GUESS |

**DECIDED 2026-11-20 (owner, mockup "Freight still to pay" approved) — a handover's freight is paid in parts.**
*Built 2026-11-20 on `feature/handover-freight-payments` (migration `20261120180000_handover_freight_payments`), PR to
`dev`, not merged.* CYC-2026-0002 leg 2, Handover 1: 400 pieces, freight 8,000 AED; Mohammed Youssef paid 4,000 at
14.8 on 20 November, the other 4,000 is paid to the forwarder later at a rate nobody knows yet.

| Rule | Now | Status |
|---|---|---|
| The model | A handover holds its **freight in full** (`freightAmount`, its currency) and its **payments** (`handover_freight_payments`): each a day, an amount in the handover's currency, the rate got, the pounds (half up) and who paid. Paid ≤ the freight; the rest is **to pay**. | DECIDED (mockup) |
| The cost | Freight in pounds = Σ payments' pounds + to pay × the rate it is counted at, stored on the handover (`freightRateToEgp`, `freightAmountEgp`). The leg's cost is then the existing estimate (§2 above) over that figure. CYC-2026-0002: 59,200 + 4,000 × 15.2 = **120,000 EGP**, 20 AED a piece; after the second 4,000 at 15.5: **121,200**. | DECIDED |
| Which rate counts what is to pay | The Exchange rates page's (§22, the rate the forms prefill from), taken again on every **change to the leg's freight**: a handover recorded, its freight corrected, a payment recorded, corrected or undone, or **Count at today's rate**. Not on a change to the page itself — §22 says a rate change restates nothing — and not on an arrival or All arrived. When the page has moved since, the card says so ("The Exchange rates page now says 1 AED = 15.4 EGP; the rest to pay is still counted at 15.2") with **Count at today's rate** (`POST /shipping/legs/:id/freight/recount`). No page rate for that currency: refused, `NO_RATE_RECORDED`, never costed at 0. | GUESS (follow on the next freight change, say so on the card) |
| An estimate | While any of a leg's freight is to pay, its cost is an estimate: `final` is false and `freightEstimate` true on the shipment, cycle profitability, settlement preview and Take money, even with every piece arrived. | DECIDED |
| Re-costing | A payment re-costs through the same leg re-cost as any freight change (`syncFreight` → `planRecost`/`recost`), sold units' COGS included; a locked re-cost refuses it with its `LEG_COST_LOCKED_*` code and nothing is written. Tested: 400 pieces, 50 sold at 1,000 — the second 4,000 at 15.5 instead of the estimate's 15.2 puts 1,200 more on the leg, 3 a piece, 150 off the profit, exactly. | DECIDED |
| Hand over goods | "Freight for this lot" (amount, currency), then a **Paid now** block: amount (the full freight until changed), the rate (page's, editable, the shipped hint "4000 AED × 14.8 = 59,200.00 EGP · Exchange rates page: 1 AED = 15.2 EGP"), Paid by. Paying less: "4,000.00 AED left to pay later. Its rate is asked when you pay it." Paid now 0: no rate, no payer. API: `paidAmount` (left out = all of it, as before). | DECIDED (mockup) |
| Record freight payment | `POST /shipping/handovers/:id/freight-payments` {paidOn, amount, rateToEgp?, paidByUserId?}: the day (not future, `DATE_IN_FUTURE`; not before the handover, `FREIGHT_PAYMENT_BEFORE_HANDOVER`), the amount (the rest until changed; > 0, `AMOUNT_NOT_POSITIVE`; ≤ what is to pay, `FREIGHT_PAYMENT_EXCEEDS_UNPAID`), the rate got (the page's until changed), who paid. | DECIDED (mockup); codes the agent's |
| Correcting a payment | `PUT /shipping/freight-payments/:id` (any of the four; the amount judged against what is to pay with it taken off); `DELETE /shipping/freight-payments/:id` undoes it and its amount is to pay again. No edit screen: undo and record again (Undo on each green row). | GUESS |
| The handover's own freight | `PUT /shipping/handovers/:id` changes the freight in full (never below what is paid, `HANDOVER_FREIGHT_BELOW_PAID`; its currency only with nothing paid, `HANDOVER_FREIGHT_CURRENCY_HAS_PAYMENTS`). Moving its day moves the payments made on the old day with it; a later payment dated before the new day refuses the move. Rate and payer are no longer the handover's. | GUESS |
| The card | Per handover a **Freight** list: a green row per payment "Paid Nov 20, 2026 · by Mohammed Youssef · 4,000.00 AED × 14.80 · 59,200.00 EGP" (Undo), an amber row "To pay · rate not known yet · 4,000.00 AED × 15.20 (today) · ≈ 60,800.00 EGP" with **Record payment**; once all is paid a pill "Freight paid · 8,000.00 AED". The leg header: "4,000.00 AED paid · 4,000.00 AED to pay" and "≈ 120,000.00 EGP so far · to pay counted at 15.20 until paid"; fully paid, the old "paid · EGP" line. In Arabic a payment of freight is «سداد» (a handover stays «إرسالية», never «دفعة»). | DECIDED (mockup); Arabic GUESS |
| Existing handovers | The migration gives every handover with freight one payment of exactly its stored amount, rate, day and payer (a free lot gets none) and points a partner's debt at it, so every existing handover reads fully paid and every cost is unchanged to the piastre (tested; harmless if run twice). | DECIDED |
