# Business rules

What the system actually does, and why. This is the agreed record — if a rule
here is wrong, the code is wrong and should change to match.

The BRD describes what the business wants. This describes what was decided when
the BRD left a choice open, and every such decision is marked **DECIDED** with
the date. Anything still open is marked **OPEN** and the code's current guess is
stated plainly, so nobody mistakes a guess for a decision.

Last updated 2026-10-25 (§10: a sale, payment, return, reversal or cancel notifies the other partners — built, a guess marked). Before that 2026-10-25 (§16: the office chat — guesses marked). Before that 2026-10-23 (§7b: the statement's Profit column — guesses marked). Before that 2026-10-22 (§12: the tabs' cards reshaped — products and units in stock on Products and Inventory, customers and who paid the most, the largest payment, an icon on every card; the ledger's By column — guesses marked). Before that 2026-10-21 (§8: the Partners page asks only the cycles that can have earned; §3: a default price is a "Default" tag in the Products list; §4: the invoice wears the contract's header and has no signature lines). Before that 2026-10-20 (§4/§16: the assistant's samples tools — guesses marked; §12: summary cards on Cycles, Products and Sales — guesses marked; §12: an investor cannot sign in to the office — built, guesses marked; Profit and loss opens on This month; §8: the Settlement button carries its cycle, Calculate and Approve no longer race; §3: the product page lost its Suppliers and Compatibility cards). Before that 2026-10-19 (§18 and §8: the partners repay a friend who paid for a cycle — his payment is a loan to them, no longer taken off what they fund; the equal split for a cycle a friend paid for entirely is gone; any split, 30/30/40, on the cycle page — owner decision, details GUESSED). Before that 2026-10-19 (docs brought up to date with the code at `299fba9`: §4 a cancelled order owes nothing; §10 the push tag and VAPID keys; §12 the audit log made readable, only the partners use the office app, the P&L's v1 lines marked superseded by Option A and This year's buckets corrected; §18 editing and deleting a lender; "Not yet safe" items superseded). Before that 2026-10-18 (§8 the wizard ends at the shipping, a funding note on the cycle page, funding locked once the settlement is approved — guesses marked). Before that 2026-10-17 (§16 the assistant's `update_leg_cost`; §2 a leg's cost is refused negative or at a zero rate by the service). Before that 2026-10-16 (§21 a supplier's country is an ISO code, chosen from a list — guesses marked). Before that 2026-10-14 (money accounts removed by the owner — §9, §18, Still open). Before that 2026-10-12 (L8: goods can leave in parts — built, guesses OPEN; the wizard stops when the goods leave; Add next leg and a leg's cost on the cycle page). Before that 2026-10-11 (§8 leftover stock moved to another cycle at its cost — L5, guesses OPEN; L3: a cycle's status follows its shipment; §18: a friend's repayment asks no money account (accounts removed altogether 2026-10-14); §18 purchases paid by a friend, repaid in pounds — guesses OPEN; walk-in, assistant sales; where a cycle opens and where its status is changed; I1: daily overdue alerts, low stock after a sale, who owes what; I3: departures and deliveries from the cycle page, where the goods are).

---

## 1. Import cycles

A cycle is one physical shipment and may contain several supplier orders.

**Two route shapes.** A China cycle has two legs — China→UAE handled by the
merchant, then UAE→Egypt handled by the shipping company. A UAE-direct cycle has
only the UAE→Egypt leg. A China cycle is limited to sequences 1 and 2; a
UAE-direct cycle to sequence 1. Anything else is refused.

**Each leg carries its own cost.** A leg is charged one of three ways:

| Basis | What is recorded | Total |
|---|---|---|
| Per piece | Rate per piece × number of pieces | Derived |
| Per weight | Rate per kg × total kilograms | Derived |
| Flat | One agreed amount | As entered |

**DECIDED 2026-08-24 — the shipment's dates decide where a cycle can get to,
and stock exists only once the goods have arrived.**

Completing the wizard used to walk a cycle from planning to verification in one
click and receive the stock, so goods departed, arrived and became sellable in
the same instant with no date recorded anywhere. A cycle approved a moment ago
had inventory.

~~A leg's status is a reading of its dates~~ — superseded 2026-10-10 by the
rule below: a leg's goods arrive in deliveries, not on one date.

**DECIDED 2026-10-10 — a leg's goods arrive in deliveries.** *Built 2026-10-11 (B1, B2).* Goods
leave in one shipment but arrive in pieces, weeks apart, and nobody here controls
the split — ship 40 and they come 15, then 10, then 5, then 10. So a leg records
each **delivery**: the date it arrived and how many of each ordered product it
brought. One leg can have any number of deliveries, on either leg.

What a leg can deliver is what entered it: everything ordered, for the first leg;
for a later leg, what the leg before it delivered. A delivery that would bring
more than that is refused.

A leg's status is still a reading of what was recorded, never a field anyone sets:

| Recorded | Leg reads |
|---|---|
| nothing | pending |
| a departure, with goods still waiting at the leg's origin (L8) | partly departed |
| a departure, everything that entered it left | in transit |
| a departure and at least one delivery, with goods still unaccounted for | partly arrived |
| every unit that entered it delivered or marked lost | arrived |

**DECIDED 2026-10-12 (owner) — goods can also leave in parts.** *Built 2026-10-12 (L8, phase 1; e2e in phase 2).* Supersedes "goods leave in one
shipment" above for departures. A supplier may ship part of an order now and the rest later, and Dubai may forward
only part of what arrived. So a leg records each **departure** the way it records each delivery: the date it left and
how many of each product left on it (the form starts every product at "everything still waiting here"). A leg can
have any number of departures.
- What can leave on a departure is what is waiting at the leg's origin: ordered (first leg) or delivered by the leg
  before (later legs), less what already left on this leg. More is refused.
- What a delivery can bring is what has **left** on that leg, less what was already delivered or marked lost — not
  what entered the leg. Goods still waiting at origin cannot be delivered or marked lost on the way.
- A leg reads **partly departed** while some goods have left and some still wait at origin.
- The cycle's status still follows the record (§1, L3): the first departure moves it on; later ones move nothing.
- The goods cards split each place in two: waiting at origin vs on the way.
- The leg's freight cost stays one figure for the leg; a second freight bill for a later departure is recorded as an
  expense charged to the cycle (§9).
- Existing legs with one departure and no lines are read as "everything that entered it left on that day", so old
  data keeps its meaning.

Guesses made while building L8, open until confirmed (autonomous run, 2026-10-12):
- **The backfill is SQL in the migration** (`20261012140000_shipment_departures`), so there is one model: every leg
  with a departure date gets one departure on that day (its Cairo day) carrying what had entered it when the
  migration ran — the order, for the first leg; what the leg before delivered, for a later leg (a later leg whose
  leg before had delivered nothing gets a departure with no lines, so it still reads as left). Goods already delivered
  in Dubai when the migration ran stay "on the way" on leg 2 even if delivered after leg 2's date, exactly as
  before; only goods delivered in Dubai *after* the migration wait **in the UAE** until a departure carries them
  (the I3 guess below said the system could not tell; from now on it can). The rule is also written as `planDepartureBackfill` (unit-tested) for the fixtures and the demo seed.
- **When the goods could have left.** The first leg: not before the day the product's order was placed. A later
  leg, on day D: only what the leg before had delivered by D, less what already left on this leg
  (`DEPARTURE_BEFORE_ORDER`, `DEPARTURE_BEFORE_ARRIVAL`). A departure date with no quantities (the old forms, the
  wizard, the assistant's `add_shipping_leg`, the fixtures) means everything waiting that could have left by that
  day; with nothing waiting it is refused (`DEPARTURE_NOTHING_WAITING`) — **so leg 2 can no longer be marked as
  left before anything reached Dubai**, which used to be accepted.
- **A delivery on day D brings only what had left by D** (`DELIVERY_BEFORE_GOODS_LEFT`), beside the existing "not
  before the leg's first departure".
- **Losses come only from what left** (on the way, and on the last leg delivered-but-not-received). A loss
  recorded before L8 on a leg that had not left is read as coming off what waited at its origin, so nothing is
  counted twice. A leg backfilled in B1 with deliveries but no departure date has its delivered goods read as left.
- **Undo** is refused (`DEPARTURE_IN_USE`) once goods from the departure were delivered or marked lost —
  deliveries and losses are matched to departures in the order they left (first in, first out), so the latest
  departures are the ones free to undo — or when it is the leg's only departure and the cycle's status says the
  leg has left (the L3 rule deleting a delivery follows). Undoing never moves the cycle back. Deleting a leg-1
  delivery whose goods leg 2 already sent on is refused like one leg 2 delivered (`DELIVERY_IN_USE`, carried).
- **Delete delivery is offered only where it would work** (owner 2026-10-20, built 2026-10-22). The shipment marks
  each delivery `deletable` with the reason it is not (`deleteBlockedBy`: received / carried / status) from
  `deliveryDeleteBlock` in `modules/shipping/departure-rules.ts` — the same check `deleteDelivery` refuses with, so
  the mark and the refusal cannot disagree. The cycle page shows the button switched off with that reason beside
  it, as Undo departure is offered only where it is `undoable`. Production's CYC-2026-0001 showed Delete on both
  deliveries and neither could go.
- **Partly departed and partly arrived at once** reads PARTLY_ARRIVED (the furthest thing that happened) and the
  leg header shows a second "Partly departed" badge. A leg that has sent on everything that entered it so far
  reads in transit, and partly departed again when more reaches its origin.
- **The status walk (L3)**: only a leg's *first* departure moves the cycle; a later one moves nothing even when the
  cycle is behind its shipment.
- **No departure on a cycle being settled, closed or cancelled** — including a leg added in settlement with a
  departure date (before L8 that was accepted and moved nothing); a leg without one can still be added there.
- **The Shipments page** records a leg's first departure in its create and edit forms, per product, starting at
  everything waiting. Changing the date of a leg with exactly one departure moves that departure (its goods are
  checked again for the new day); a leg with several cannot be re-dated there (`LEG_HAS_SEVERAL_DEPARTURES`) — undo
  the wrong one on the cycle page and record it again. Supersedes the I3 guess that correcting a departure stays on
  the edit form.
- `shipping_legs.departed_on` stays, as the stored reading of the first departure's day (`syncLegStatuses`), like
  `arrived_on`; `scripts/check-data.sh` 12.91–12.93 look for a leg that sent more than entered it, delivered more
  than left on it, or whose date is not its first departure.

**Goods that have not come are still on the way until a partner says
otherwise.** At any point a partner can mark some or all of what is still on the
way as **lost**, on any leg. Nothing is marked lost by itself, however long it
has been — goods have turned up late before, and the partner is the one who knows.
Anything not yet received can be marked lost: units on the way on any leg, and
units a last-leg delivery brought but that were never found when it was counted.

**A loss can be taken back** while the cycle is not settled, for when the goods
turn up after all. Taking it back puts the units on the way again. A loss that has been
refunded cannot be taken back (§6).

**Nothing is recorded on a cycle being settled.** No delivery, receipt or loss
while the cycle is in settlement or closed; reversing the settlement reopens it.

**Correcting a delivery** (2026-10-10). A delivery recorded by mistake is deleted
and recorded again — there is no edit. Deleting is refused once anything depends
on it: stock was received from it, a later leg carried its goods on, or it is the
only delivery that lets the cycle stand where it is. A cycle's arrival points
(§1 table) are re-checked for every move forward, not only the one they name.
Deliveries can be recorded on any open cycle, from planning on, as soon as the leg
has departed; a loss does not need the leg to have departed. Setting a leg's
arrival date the old way (one date for the whole leg) records one delivery of
everything still on the way.

**The one exception to "nothing is marked lost by itself"** is the move to
deliveries on 2026-10-10. Before it, a line counted short at verification had its
whole cost spread over the units that came. Those shortfalls were recorded as lost
at **zero** cost, because they were already charged to the batch once.

The cycle can move on as soon as **some** goods reach a point, not only once all
of them have:

| Cycle step | Requires |
|---|---|
| In transit (China) | leg 1 has departed |
| Arrived UAE (China) | leg 1 has at least one delivery |
| In transit to Egypt | the last leg has departed |
| Arrived Egypt | the last leg has at least one delivery |

A UAE-direct cycle's single leg is UAE→Egypt, so arriving in the UAE asks
nothing of it — the goods are sitting at its origin and it has not started.

A departure or a delivery cannot be dated in the future; a delivery cannot be
dated before its leg departed, and none can be recorded on a cancelled or closed
cycle.

**DECIDED 2026-10-11 (owner, L3) — the cycle's status follows its shipment.**
*Built 2026-10-11.* The owner expects recording that goods left or arrived to
move the cycle by itself, without a second visit to Change status. So
**recording a departure or a delivery moves the cycle forward to the furthest
status the shipment then proves**, one step at a time through the same
transition Change status makes — each step's own check runs, and leaving
Purchasing confirms the cycle's draft orders exactly once (§15), with the same
audit row and notification per step. What proves what is the table above, read
the other way round:

| Recorded | China cycle moves to | UAE-direct cycle moves to |
|---|---|---|
| leg 1 departed | In transit | In transit to Egypt, through Arrived UAE (which asks nothing of its one leg) |
| leg 1 has a delivery | Arrived UAE | Arrived Egypt |
| the last leg departed | In transit to Egypt | — |
| the last leg has a delivery | Arrived Egypt | — |

- **Never backward, never past Arrived Egypt.** A cycle already at or beyond
  what the record proves stays where it is; verifying and selling belong to
  receiving (§3). A cycle in settlement, closed or cancelled is never moved
  (and nothing can be recorded on one but a leg added in settlement, which
  moves nothing — and since L8, 2026-10-12, carries no departure).
- **A step whose own check refuses stops the walk there, and the record still
  saves.** The response names the step and the refusal; the office app shows it
  as a warning beside the success.
- **A cycle still in Planning or Funding** when a departure or delivery is
  recorded is walked through Funding and Purchasing too, each through its own
  checks (recommended option, chosen in the autonomous run 2026-10-11): the
  goods have left, so the money and the order already happened in the world.
- **A China cycle whose second leg is not recorded** is proved no further than
  Arrived UAE, although the transition check lets a missing leg through.
- **Every entry point:** Record departure and Record delivery on the cycle's
  page, the fix offered by a refused Change status, the Shipments page's
  create and edit forms, the wizard's legs step, and the assistant's
  `add_shipping_leg` (a departure or an arrival) and `record_delivery`. Each
  response carries `cycleStatus` (from, to, the steps taken, the step that
  refused if one did, the orders it confirmed); the office app says it in the
  success toast — "Delivery recorded — cycle is now Arrived Egypt" — and
  refetches the cycle. The assistant's previews say where the record will
  move the cycle and which orders it will confirm, and that is bound to the
  confirmation: a cycle moved in between needs a fresh preview.
- **Deleting a delivery** keeps its guard: refused while the cycle's status
  depends on it. The cycle is not moved back by itself.
- Guesses, open until confirmed (autonomous run, 2026-10-11):
  - Only a change is news. The Shipments page's edit form sends a leg's
    departure back with every save; an unchanged departure moves nothing, so a
    cycle a partner kept behind its recorded shipment before this rule is not
    moved by an unrelated edit — only by the next real departure or delivery.
  - When a fix offered by a refused Change status moves the cycle by itself,
    the status dialog closes instead of offering the move again.
  - Receiving into stock reports its own walk to Selling the same way
    ("Received into stock — cycle is now Selling").

Rate-based legs derive their total rather than asking for it, so the per-piece
rate itself stays on the record. A leg can be priced in another currency with an
FX rate; everything lands in EGP.

**DECIDED 2026-10-11 (owner) — opening a cycle opens its page, and its status
is changed there.** Clicking a cycle on the list, as a table row or a phone card,
always opens the cycle's details page, whatever its status. A cycle still being
set up (planning through purchasing, since 2026-10-12 — see below) is resumed in the wizard by a separate
**Continue setup**, shown on the row, the card and the details header, and only
to a role that may write a cycle (a core partner); the wizard links back to the
cycle. Moving a cycle to another status is a **Change status** button on the
details page, shown only to a core partner and only while the status has
somewhere to go; it offers exactly the moves the server allows (the table in
`apps/api/src/common/cycle-transitions.ts`), and the server still refuses a move
the shipment's dates do not support (table above). The list has no status
control: the slide-over that held it could no longer be reached once a row
opened the details page, and was removed.

**DECIDED 2026-10-12 (owner) — the wizard is for setting a cycle up; it stops
when the goods leave.** *Built 2026-10-12.* The wizard's statuses are Planning,
Funding and Purchasing (`WIZARD_STATUSES`, `components/cycles/wizard-walk.ts`) — cycle statuses,
unchanged; its steps are three since 2026-10-18, with no Funding step (§8).
Continue setup is shown only in those, and a wizard opened on a cycle past
them — from a bookmark, a typed address, an old link — sends the reader to
the cycle's page and writes nothing. From In transit on, departures,
deliveries, another leg and a leg's cost are the cycle page's work (below).
Guess, open until confirmed (autonomous run, 2026-10-12): a cycle moved back
into Purchasing by Change status is set up again, so Continue setup returns.

**DECIDED 2026-10-12 (owner) — Add next leg, and a leg's cost, on the cycle
page.** *Built 2026-10-12.* The Shipment panel offers **Add leg N** for the
route's first leg not yet recorded — a China cycle's Dubai → Egypt leg added
after leg 1 left, or any leg never added (the empty panel offers leg 1) — and
**Edit leg** on each leg. Both are the Shipments page's own forms, defined once
(`components/shipment/LegForm.tsx`, CLAUDE.md §13): route, provider with its
`+`, tracking, the first departure (L8), cost basis, amount or rate, currency
and FX. The cost is editable there only while the rule allows (§2: nothing of
the cycle received or marked lost); after that the form says why and points to
recording the late charge as a cycle expense in the ledger, and sends no cost.
Same roles as the Shipments page (`shippingLeg.create`, `shippingLeg.edit`);
hidden on a cycle being settled, closed or cancelled. Guesses, open until
confirmed (autonomous run, 2026-10-12): the route's places are offered and
editable; a third China leg or a second UAE-direct leg is never offered; the
Shipments page's edit form shows the same cost lock; the web's copy of the
route (`components/cycles/leg-plan.ts`, also the wizard's) is pinned to the
API's `cycle-routes.ts` by a test.

**DECIDED 2026-10-11 (owner, I3) — a leg's departure and its deliveries are
recorded from the cycle's page.** Each leg's header in the details page's
Shipment panel carries **Record departure** while it has not left, and **Record
delivery** once it has left and still has goods on the way, beside Mark lost;
the header also says when it left, who carries it and what it cost. The page
lists each leg once — the separate Shipping card that repeated the legs with a
second Record delivery was removed (2026-10-11). The departure is the date the
Shipments page's edit form sets (`PUT /shipping/legs/:id`, one field definition
used in both places), and both follow the same roles (a core partner). After
this the wizard is only for setting a cycle up. Guesses, open until confirmed (autonomous run, 2026-10-11):
- Neither button is shown on a cycle being settled, closed or cancelled — the
  same statuses in which the server refuses a delivery. Recording a departure
  there is now refused by the server too (`CYCLE_SETTLING` / `CYCLE_CLOSED`); it
  used to be accepted. Re-sending the departure a leg already has (the edit form
  does, on every save) is not a change and is still accepted.
- ~~Record departure is offered only on a leg with no departure yet.~~ Superseded
  2026-10-12 (L8): it is offered while anything waits at the leg's origin. Correcting a
  departure stays on the Shipments page's edit form.
- The departure starts at Cairo's today and cannot be a later day, like a
  delivery.

**DECIDED 2026-10-11 (owner, I3) — a refused status change offers its fix.**
When Change status is refused because a leg has not left (`LEG_NOT_DEPARTED`)
or has had nothing delivered (`LEG_NOT_ARRIVED`), the dialog shows the reason
with a button that opens Record departure or Record delivery for the leg the
server named; the refusal carries the leg's id (`params.legId`) beside its route
for that. After a save the dialog comes back and the move can be tried again.
Guesses, open until confirmed (autonomous run, 2026-10-11): a `LEG_NOT_ARRIVED`
on a leg that has not even left offers the departure first, since a delivery
on it would be refused; no fix is offered to a role that cannot take it, nor
when the refusal names no leg. Every refusal of a status change is now shown
inside the dialog rather than as a toast, so the reason sits beside the
choices it refers to.

**DECIDED 2026-10-11 (owner, I3; layout A) — where a cycle's goods are.** The
top of a cycle's page shows how many units are **in China** (ordered, the leg
out of China has not left), **on the way to the UAE**, **in the UAE** (reached
Dubai, not yet on a leg that has left — on a UAE-direct cycle, ordered and not
yet shipped), **on the way to Egypt**, **in Egypt** (on the shelf plus
delivered but not yet checked in, the latter named underneath) and **sold**;
**lost** only when something was. Then the same per product — a table, or a
card per product on a phone. A UAE-direct cycle has no China or To-UAE place.
Every unit ordered is in exactly one place, so the places add up to what was
ordered. All of it is read from the shipment's figures (§1) and the cycle's
batches; nothing new is entered. One function: `components/cycles/goods-location.ts`.
Guesses, open until confirmed (autonomous run, 2026-10-11):
- ~~A leg has one departure~~ — superseded 2026-10-12 (L8): what has not left a leg's
  origin is at that origin, and only what left is on the way. Was: A leg has one departure, so once it has left, everything that has entered it
  counts as on the way — including goods that reached Dubai after leg 2 left and
  are physically still there. The system holds no record that tells them apart.
- **Sold** is what left this cycle's shelves through a sale: received less what
  remains, so a cancelled sale or a return to stock puts units back, and a unit
  returned damaged (not restocked) stays counted as sold — it is not on the
  shelf and did not come back to it. This differs from Analytics' units sold,
  which nets every return; the cards need every unit in exactly one place.
- A unit marked lost after reaching Egypt (never found at the count) is in Lost,
  not in Egypt.

---

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

## 3. Inventory

**Stock is tracked in batches, and this is the one rule the BRD marks CRITICAL.**
The same product bought in three cycles at three costs stays three batches. A
batch keeps its own landed cost forever.

**FIFO.** A sale draws from the oldest verified batch first. A sale spanning two
batches records a separate allocation per batch, each with the cost that batch
was bought at. That allocation is the COGS for that sale and is never
re-priced — not by a later purchase, not by a supplier refund, not by anything —
except by correcting the cycle's own leg cost before it is settled (§2,
2026-10-17), which re-costs the batch and every sale drawn from it together.

**DECIDED 2026-08-21 — confirming a sale is when the goods leave.** These are
counter sales to shops and marketplace sales; there is no separate dispatch
step in the business, so there is none in the system. Confirming reduces the
stock physically held. Cancelling or returning restores it.

**Reservations are not in use.** `InventoryReservation` exists in the schema for
holding stock against a quote, which is a real future feature, but nothing
drives it today and reserved quantity is honestly zero.

**DECIDED 2026-10-18 (owner), built 2026-10-20 — the product page has no Suppliers or Compatibility card.** Both
cards are gone from a product's page; the data stays where it is (a product's suppliers and motorcycle models are still
stored and still read by the API) — only the cards were removed. TC-PROD-CARDS-01.

**DECIDED 2026-10-19 (owner) — no "Reserved" on screen; a product shows its stock value instead.**
The product page's Reserved tile and the Inventory table's Reserved column read the batch field
above, which nothing writes, so they always said 0; both are removed. Storefront order-request holds
are a separate table (`available-stock.ts`) and were never shown there. In the tile's place:
**Stock value** = each batch's remaining units × its landed unit cost, summed and rounded once, half
up, to the piastre — one definition (`common/stock-value.ts`) shared with the dashboard's Inventory
Value, so the products' values add up to it.

**DECIDED 2026-10-10 — stock is received one delivery at a time.** *Built 2026-10-11 (B3, F1a).*
Each delivery that reaches Egypt is counted and checked into stock as its own
batch, with its own arrival date, and can be sold the moment it is checked in —
while the rest of the shipment is still on the way. A count lower than the
delivery said leaves the difference **waiting to be received** against that
delivery: it is checked in when it is found, or marked lost. Receiving more than
a delivery brought is refused, and the units ever received or lost on an order
line can never total more than were ordered.

Stock can only be received once the cycle has reached Arrived Egypt. The first
receipt moves the cycle on to Selling, through each step's own checks, as the
wizard used to. Since L3 (§1, 2026-10-11) the delivery that reaches Egypt
has already moved the cycle to Arrived Egypt by itself, so a cycle in transit
holding a last-leg delivery exists only in data from before that rule; the
refusal (`CYCLE_NOT_ARRIVED`) stays for it. Selling then continues while later deliveries come in.

FIFO still means the oldest **received** batch first: the day it was checked
in, not the day it landed.

**DECIDED 2026-10-16 (owner asked for the capability; details a GUESS, the
recommended option) — received stock carries the day it was received.** The
owner is entering a cycle that already happened: goods received in Cairo weeks
ago. Receiving takes a **Received on** day (`receivedOn` on
`POST /receipts/verify`), optional, today when left out.
- Never in the future (`DATE_IN_FUTURE`), never a non-date (`BAD_DATE`), and
  never before the delivery that brought the goods reached Egypt
  (`RECEIVED_BEFORE_ARRIVAL`, naming both days).
- That day is the batch's received instant (`createdAt`), which FIFO orders by
  and a back-dated sale is cut off at (§4): today is now, to the second, as
  before; an earlier day is stored at midday Cairo time, so the stored instant
  is that day in Cairo and in UTC alike, on either side of a clock change.
- The office dialog prefills it with the delivery's arrival day (today if it
  arrived today), greys out days before arrival and after today, and keeps the
  counts prefilled with what was delivered (owner: they will not count per
  model).
- GUESS: the arrival day, not today, is the prefill — opening the dialog late
  is the usual reason the day matters. A part of a delivery received on another
  day is its own batch on its own day.
- `check-data` 25.3 and 25.4 watch for a batch received before its delivery
  arrived, or on a day that has not come.

**DECIDED 2026-10-10 — one meaning of "low stock".** A product is low when it is
active, has a minimum set, and the stock on hand is below that minimum. A product
with no minimum is never low. The dashboard count, the inventory filter and the
inventory highlight all use this one rule; the inventory page used to colour any
batch under 10 instead, so the two screens could disagree. *Stock on hand* is
what is on the shelf — every batch's remaining quantity summed — not what is left
after holds: a held unit is still on the shelf, and a minimum is a reorder point
(L2, 2026-10-10). The alert raised on receiving uses the same rule. Defined once
in `apps/api/src/common/low-stock.ts`, with one pinned web copy.

**DECIDED 2026-10-11 (I1, autonomous run) — a sale that takes a product into low
stock raises the alert too.** *Built 2026-10-11.* The low-stock alert used to be
raised only on receiving, so the sale that actually emptied the shelf said
nothing. Now every confirmed sale — a shop's order (in one step or confirmed
from a draft), a walk-in sale, a sale the assistant records, an approved
storefront request — raises the same alert to every active core partner when
it takes a product from not low to low, by the one rule above (below the
minimum; left exactly at the minimum is not low). **No repeat while it stays
low:** a sale of a product that was already low raises nothing. It can alert
again only once stock has been back at or above its minimum — a receipt, a
cancelled sale, a return — and a sale takes it under once more. Sent after the
sale is saved; a refused sale, a draft, or an assistant preview raises nothing.
The brief for this asked for "to or below the minimum"; the decided rule of
2026-10-10 (at the minimum is not low) was kept, so the alert, the dashboard
and the inventory page cannot disagree. Guess, open until confirmed: receiving
stock still alerts whenever the product is low after the receipt, even if it
was already low before (unchanged from 2026-10-10).

**DECIDED 2026-10-14 by the owner — a product is switched off, never deleted.**
*Built 2026-10-14 (`feature/product-deactivate`).* Its orders, batches, receipts,
returns and settlements all point at it, so it is never removed. A core partner
**deactivates** it and can **reactivate** it — from the product page and from the
row's actions on the products list, each after a short confirm that says what it
does. `PUT /products/:id/status` with `{ status }`, core partners only; the status
is ACTIVE or INACTIVE and nothing else, checked on the server on every way in
(that endpoint, `PUT /products/:id`, `POST /products`) — `PRODUCT_STATUS_INVALID`.
Defined once in `apps/api/src/common/product-status.ts` (web reading:
`apps/web/src/lib/product-status.ts`). Any stored value other than ACTIVE reads
as off. Switching to the status it already has changes nothing and logs nothing.
The audit log records DEACTIVATE / REACTIVATE.

**DECIDED 2026-10-14 by the owner — switched off means no more is BOUGHT; what is
on the shelf is still SOLD.**
- *Blocked:* a new purchase-order line, on a new order or added to a draft — from
  the Purchases form, the wizard, or the assistant (`create_purchase_order`) —
  refused as `PRODUCT_INACTIVE`, naming the product (en + ar). The Purchases
  form, the wizard and the assistant's receipt matching (`match_receipt`) stop
  offering it. A product created through quick-create is always active.
- *Allowed while there is stock:* the sale form (shop and walk-in) and the
  assistant's `record_sale`. The sale picker tags it "Inactive" and lists it only
  while some is available; once its stock reaches zero it drops out of every sale
  picker and the assistant no longer matches it. A sale beyond what is on the
  shelf is refused as for any product (`NOT_ENOUGH_STOCK`).
- *Never touched:* orders already made, drafts holding it (confirming one still
  works), a shop's pending request for it (approving still works), stock on the
  shelf, receipts, returns, settlements, history, its prices, and the product
  page, which keeps showing its stock and batches with a note that it is off.
- The low-stock rule above already skips it. The products list filters
  Active / Inactive / All, opening on Active.

Guesses made while building it, open until confirmed (2026-10-14):
- **The storefront keeps showing it while stock remains, and hides it at zero**
  (the owner's recommendation, taken). A shop can still ask for it while there is
  some; asking for more than is left is refused as for any product. "Stock" for
  the catalogue is verified units on the shelf, held ones included, so a product
  whose every unit is held by another shop's request still shows, as "out of
  stock", until the hold ends or the sale empties the shelf. An *active* product
  with nothing on the shelf stays listed as before — it will be bought again.
- **An import request cannot be answered with a switched-off product**
  (`PRODUCT_INACTIVE`): answering one says "we stock this now", and no more of it
  will be bought. The office's answer picker does not offer it.
- "The price list" in the brief was read as the storefront catalogue, which is
  the shops' price list; the office has no separate one. Setting a price on an
  inactive product is still allowed — it is still sold from the shelf.
- On a receipt, a switched-off product's printed SKU is not matched; creating a
  new product under the same SKU is then refused as `PRODUCT_SKU_TAKEN`, naming
  the product — the cue to reactivate it rather than duplicate it.

### Arabic names for categories and products  — DECIDED 2026-10-14 (owner), details GUESSED

The owner, 2026-10-14: categories and products get an Arabic name, products an Arabic description too, and
a reader on Arabic sees them. Migration `20261014150000_arabic_names` (additive, nullable).

**DECIDED (owner's brief):**
- A category has an optional Arabic name; a product an optional Arabic name and Arabic description.
- **Fallback:** wherever the reader's language is Arabic, the Arabic value is shown when there is one, the English
  one otherwise — never a blank. The office follows its URL locale (`/ar`, `/en`); the storefront opens in Arabic
  for everyone (§13), so a shop sees the Arabic unless it switches to English.
- **Search in both languages:** a search matches the English name, the Arabic name and the SKU — the office's
  product and category lists and every product or category picker, the storefront catalogue (plus the barcode, as
  before), and the assistant (`find_products`, receipt matching, `record_sale`).
- **The assistant never invents a translation.** `create_product`, and a new product inside
  `create_purchase_order`, take `nameAr`/`descriptionAr` only when the partner gave them, and leave them empty
  otherwise (§16).

| Question | What the code does | Status |
|---|---|---|
| Is a category's Arabic name unique? | **Yes, when present** — compared ignoring case and surrounding space, the same question the English name answers. Refused as `CATEGORY_NAME_AR_TAKEN`, naming the category that has it. Any number of categories may have none. Enforced twice: the service asks first (so the refusal names itself), and a partial unique index on `lower(name_ar)` stops two at once. | **GUESS** (recommended option, taken) |
| Is a product's Arabic name unique? | **No** — English product names are not unique either (the SKU is what identifies a product). | **GUESS** |
| What is stored | Trimmed. An empty or blank value is stored as **null**, so "no Arabic" has one spelling. Not sent on an edit leaves what is stored; sent empty clears it. A number or object is `VALIDATION_FAILED`. | **GUESS** |
| How long | Arabic name ≤ **200** characters (`NAME_AR_TOO_LONG`), Arabic description ≤ **1000** (`DESCRIPTION_AR_TOO_LONG`) — the limits the assistant's tools already set for the English fields. The office's own English fields still have none; not changed here. | **GUESS** |
| Which name the API sends | **Both.** Responses carry `name` and `nameAr` (and `description`/`descriptionAr`; an invoice line `product`/`productAr`; shipment and stock lines `productName`/`productNameAr`) and the client picks, because only the client knows which language the reader chose (CLAUDE.md §9). One helper per app picks: `apps/api/src/common/arabic-names.ts`, `apps/web/src/lib/localized-name.ts`, `apps/storefront/src/lib/localized-name.ts`; the office's unit test runs its copy against the API's. | DECIDED |
| What a list shows on the other language | The office's category list and product page also show the name in the *other* language (the Arabic under the English on `/en`, and the reverse), so a partner can see whether one was entered. | **GUESS** |
| How the assistant matches an Arabic name | The same matcher, against both names: an exact Arabic name (case, spacing, punctuation, short vowels and the tatweel ignored; أ إ آ read as ا, ة as ه, ى as ي) is a match; anything weaker is offered as a candidate, never taken. Its outputs carry both names (`nameAr`, `categoryAr`, `productAr`; null when none — never a guess). | **GUESS** (the folding) |
| Screens that still show only the English | Stock transfers between cycles, the leftovers dialog, the import-request queue's own text, and the products named inside refusal messages (those are English params the client interpolates). | Recorded, not built — not in the brief's list of screens. |

**Arabic search forgives spelling — DECIDED 2026-10-15 (owner), one detail GUESSED.** Every search over product
and category names, in the office and the storefront, compares Arabic as people type it:

- **ة counts as ه** (خوذه finds خوذة), **ى counts as ي** (هوندي finds هوندى), and **أ إ آ count as ا** (اطار finds
  إطار).
- **Vowel marks and the tatweel are ignored:** fatha, damma, kasra and their tanween, shadda, sukun (U+064B–U+0652),
  the madda and hamza marks above and below (U+0653–U+065F), the superscript alef (U+0670) and the tatweel ـ
  (U+0640). تَيْل فـرامل is found by تيل فرامل.
- **Case is ignored, as before. Nothing else:** no synonyms, no typo forgiveness, no search by meaning. A different
  letter is a different word — ه is not ح, ة is not ت, ء is not ا. English search is unchanged: case only, accents
  and punctuation still count.
- **Where:** the office's Products list and every picker (sale lines, purchase lines, categories, the `+` forms'
  pickers, and every other searchable list built on the shared select), the Categories list, the Inventory list,
  `GET /products?search=` (and so the assistant's `find_products`), the storefront catalogue search and its category
  filter. The assistant's receipt and sale matching already folded the same way and now uses the same definition.
- **How:** one definition, `arabicSearchKey` in `apps/api/src/common/arabic-names.ts`; the office and storefront
  carry copies pinned to it by unit tests over `arabic-search-cases.json`. Prisma's `contains` cannot fold, so each
  product stores the key of its Arabic name in `products.name_ar_search` (migration
  `20261015100000_arabic_search_key`, additive; existing rows backfilled). It is written with every write of the
  Arabic name, never shown, and left out of every API response. Postgres has the same rule as
  `arabic_search_key()`; `scripts/check-data.sh` (check 23) counts any product whose stored key disagrees with it.

| Question | What the code does | Status |
|---|---|---|
| أ / إ / آ as ا | **Folded.** The owner's list of 2026-10-15 named ة, ى and the marks; the alef line was very likely lost in copying — the assistant has folded the alef forms since 2026-10-14, and a search that found إطار in the assistant but not in the office would be the drift §11 warns about. | **GUESS** (kept; owner to confirm) |
| ؤ and ئ | **Read as و and ي.** Unicode writes them as و and ي with a hamza *mark*, and the assistant's matcher has always folded them so (it decomposes text first); search follows it rather than the two disagreeing. So رييس finds رئيس. A standalone ء is a letter and is not folded. | **GUESS** (consistency with the assistant) |
| Customer, supplier and other names | ~~Not folded in their own lists or the API.~~ **Folded since 2026-10-25**, when every list's search moved to the server (below). | Built 2026-10-25 |

**Every office list searches, filters, sorts and pages on the server — 2026-10-25 (owner: "this is the purpose of
pagination, how can you do it client from the first place"), details GUESSED.** The fourteen lists that loaded every
row and worked in the browser — Sales, Payments, Customers, Ledger, Inventory, Notifications, Suppliers, Providers,
Cycles, Purchases, Shipments, Categories, Products, Audit log — now send what their URL says (`page`, `pageSize`,
`q` as `search`, `sort`, and their filters) to their endpoint, which filters, counts and pages in the query. One
definition, `apps/api/src/common/list-query.ts`.

- **The search is this section's, on every list.** Each list's search goes through `arabic_search_key()` in SQL
  (the same rule as `arabicSearchKey`), so the folding above now reaches customer, supplier, provider and buyer
  names, references and order numbers too. What each list searches: Sales — order number, buyer; Payments — shop,
  reference, amount; Customers — name, phone, email; Suppliers — name, phone, email, and the country by part of its
  name in either language or its code; Providers — name, contact, phone, email; Ledger — type, category, reason,
  amount; Purchases — reference, supplier, cycle code; Shipments — cycle code, provider, tracking, either place;
  Cycles — code; Products, Inventory, Categories — the product rule above; Notifications — the text; Audit log — who
  (name or email), the record as written before and after, and the action and record-type codes, plus the codes
  whose names in the reader's language contain the search (the office sends those, as only it knows the words).
- **What a search no longer finds (GUESS):** words only the browser knew — the Ledger's category *in words* (its
  category filter remains), the walk-in buyer by its Arabic name "زبون عابر" (English "Walk-in" still finds it; the
  customer filter's Walk-in choice is the way), and an audit row by a record name its own before/after does not
  carry.
- **Refused, with a code (validate on the server):** a page that is not a whole number from 1
  (`LIST_PAGE_INVALID`), a page size outside 1–200 (`LIST_PAGE_SIZE_INVALID`), an order the list does not offer
  (`LIST_SORT_UNKNOWN`), a filter value the list does not offer — an order status, a ledger direction, a type that
  is not a code (`LIST_FILTER_INVALID`), a search over 100 characters (`LIST_SEARCH_TOO_LONG`). A page past the
  end is not refused: it is empty, with the total, and the office moves to the last page.
- **Customers by what they owe** (`?sort=balance`, the dashboard tile): worked out over every match on the server,
  then paged — the whole list in that order, not each page sorted on its own.
- **Notifications:** the page lists every notification, a page at a time; it used to page the bell's 50 newest.
- **The Sales list filters by customer** (owner 2026-10-25): a searchable picker beside status and dates, every shop
  and **Walk-in** as its own choice; `?customer=<id>` (`walk-in` for the walk-in buyer) in the URL, sent as
  `customerId`. A `customerId` that cannot be an id is a 400 and one that is nobody a 404 — never an empty list
  that reads as "no orders". A shop's **New Order** button now opens `/sales?new=1&customer=<id>` (`?customer=`
  alone used to mean "open the form"): the form opens on that shop, and the list underneath shows that shop's
  orders (GUESS).
- **Still loaded whole, on purpose:** pickers (they list every choice), the CSV exports (every match of the filters
  showing, walked a page at a time), and screens that sum or rank everything they show (a shop's own orders and
  payments, Contracts, Settlements) — not lists that search or page.

### A default price: landed cost + 20%  — DECIDED 2026-10-18 (owner), details GUESSED

The owner: "The default of any product price — B2B and B2C — is landed cost + 20% of its landed cost. Landed 100 →
default price 120 EGP. So I don't have to enter the price manually on the product details page."

| Rule | What the code does | Status |
|---|---|---|
| The default | **landed cost × 1.20**, for B2B and for B2C, in EGP. The 20 is `DEFAULT_MARKUP_PCT`, once, in `apps/api/src/common/default-price.ts`. | **DECIDED** (owner) |
| A set price wins | A price the owner set on a channel is that channel's price; the default applies only to a channel with no open price row. Each channel on its own: B2B set and B2C default is normal. | **DECIDED** (owner) |
| Which landed cost | The **weighted average landed unit cost of the units on the shelf now** — `remainingQty` × `landedUnitCostEgp` over every batch with some left, divided by the units left (verified or not, as "stock on hand" counts them, §3). Nothing on the shelf → the landed cost of the **most recently received batch** (newest `createdAt`). Never received → **no default** (null, shown "—", as an unpriced product was before). | **GUESS** (owner was told and did not object) |
| Rounding | To the **nearest whole pound, half up**, on the price, not on the cost: worked as Σ(qty × cost) × 120 / (Σqty × 100), so an exact .5 is seen as .5 (11 at 50 and 1 at 55 → 60.5 → 61). | **GUESS** |
| Landed at nothing | A cost of 0 is a batch not yet costed, not free goods: when the cost the default would use is 0, there is **no default** rather than a price of 0 (CLAUDE.md §10). A zero-cost batch beside costed ones is averaged in like any other. | **GUESS** |
| It moves | A default is worked out whenever it is read, so it follows the shelf: sell the cheap batch and the default rises. Nothing is stored, and the price history shows only prices the owner set. | **GUESS** (follows from "default") |
| Switched-off products | Unchanged: an inactive product still on the shelf is priced as any other (set, else default). | Follows §3 2026-10-14 |

**Who reads it — one function.** `listPricesFor` / `listPriceOn` in `common/default-price.ts` answer every reader:
`GET /products` and `GET /products/:id` (as `listPrices: { B2B, B2C }`, each `{ amount, currency, source: 'SET' |
'DEFAULT', markupPct? }` or null; the raw `prices` rows stay for the history), the New Order popup and the samples
"They're buying" dialog (both prefill from the products list), the assistant's `find_products` (the same objects) and
`record_sale` (a line without a stated price takes it, marked `priceSource: 'default'` and "default price (landed cost
+ 20%) … confirm or give the price" in the preview), and the storefront's catalogue, product page and request.

**A default is never saved as typed.** A sale line starts from it, and what is saved is the line's price, as for any
list price; a typed price is never overwritten. **2026-10-21 (owner):** in the Products list a default price carries a small
"Default" tag on its own line, the full "Default (landed + 20%)" on hover, so every row is one line. The product page shows the default under whichever of the B2B and B2C fields
is empty (as its placeholder, with "Default (landed + 20%)"; the B2C field was missed until 2026-10-19) and Save stays
off until a price is typed — the default never becomes a set
price by itself. The products list shows the default with the same muted hint.

**The storefront.** It already listed products with no price, as unpriced, and refused a request for one
(`PRODUCT_NOT_PRICED`). It now follows the office: a product with a default shows that figure on its card, its page and
the request, and only a product with neither a set price nor a default is unpriced. A shop is shown **the figure only,
never that it is a default** — "landed + 20%" beside a price would hand any shop the landed cost. **GUESS**, the same
rule as the office.

Open: whether the markup should differ by channel (retail above trade) — the owner said one figure for both.

---

## 4. Sales

A sale is drafted, then confirmed. Confirming allocates stock by FIFO and is the
point the goods and the revenue are real. A draft reserves nothing and counts
for nothing — it appears in no revenue, profit or top-product figure.

**DECIDED 2026-08-22 — an order cannot be created for more than is in stock.**
Only confirming used to check, so an order for 600 units against 60 on the
shelf was built, priced at 720,000 and saved, and nothing objected until the
last step. The quantity available is shown in the product picker and the line
turns red as it is exceeded, so the limit is visible before it is reached
rather than explained afterwards.

Quantities are summed per product across the order: two lines of 40 against 60
in stock is 80, and checking each line alone would let it through. A product
with no stock cannot be put on an order at all.

Selling more than is available is refused, and the whole confirmation rolls
back: no partial allocation is ever left behind.

**DECIDED 2026-08-23 — an order that has been paid against cannot be
cancelled.** Cancelling put the stock back and did nothing about the money: the
payment stayed allocated to the cancelled order, so it cleared nothing, could
not be used anywhere else, and still read as collected — while the order
dropped out of what the shop owed. The screen even offered Cancel specifically
on partially paid orders, the one state where money had certainly arrived.

Cancelling is for an order that never happened. Money coming back is a refund,
and a refund is a return (§5), where the goods, the cost and the cash move
together. Cancelling also asks before acting, since it cannot be undone and the
button sits beside Confirm.

**A cancelled order owes nothing — fixed 2026-10-18.** Cancelling put the stock
back and set the status, but left `outstanding` at the full total, so every
cancel made through the app produced exactly the record check-data 12.2
("cancelled order still showing a balance") exists to find; found when the
history seed cancelled an unpaid order. Now (`POST /sales/orders/:id/cancel`,
core partners only) the stock comes back through a RELEASE movement, the status
becomes CANCELLED and `outstanding` is **0**; `total` stays as the record of what
the order was. Refused: an order already CANCELLED or RETURNED
(`ORDER_ALREADY_CLOSED`), anything paid against it (`ORDER_PAID_CANNOT_CANCEL`,
above). Cancel on samples still at a shop is "Returned" (§4 "Samples at shops").
Checked by `apps/api/src/modules/sales/sales.cancel.db.spec.ts`. Orders cancelled
before the fix keep their old balance until corrected; check-data 12.2 lists them.


**DECIDED 2026-10-10 — an order can be created and confirmed in one step.**
*Built 2026-10-11 (U1).* Both happen together or neither does: if confirming is refused (not
enough stock, say), nothing is saved and the order stays on screen to fix. Saving
a draft first is still possible. A draft shows no amount owed anywhere — it counts
for nothing until it is confirmed.

Saving the same new order twice (a double click, a retry after a dropped
connection) creates it once: the second request is answered with the first
order. This holds per person, across the server's instances.

**DECIDED 2026-10-11 by the owner — a walk-in sale is paid on the spot.**
*Built 2026-10-11 (W1, W2).* A buyer who is not a shop does not need a customer record. A
walk-in sale is created, confirmed and paid in full in one step, at retail
(B2C) prices, by the method chosen (cash by default), dated now. It cannot be a
draft and never leaves anything owed. Behind it is one shared "Walk-in" record
the system keeps: it cannot sign in, cannot be edited or deleted, and never
shows a balance. Stock, discount and price rules are the same as any sale. A
walk-in return is refunded in money, not as credit — there is no account to
hold it.

*Server built 2026-10-11 (W1); the sale form built 2026-10-11 (W2); the assistant (W3) to come.*
On the form, a **Walk-in** switch beside Customer replaces the customer with a
payment method (cash first) and offers one button, *Sell & take payment*. Lists
and the order show such a sale as "Walk-in" with no balance, and its return
offers a money refund only.
Guesses made while building it, open until confirmed:
- A walk-in sale whose lines are all free (total 0) takes no payment — a zero
  payment would say money moved when none did.
- Asking for a credit-note refund on a walk-in return is refused
  (`WALK_IN_REFUND_IN_MONEY`), not quietly turned into cash; leaving the
  method out gives cash.
- The walk-in record cannot be named as the customer of an ordinary sale
  (`WALK_IN_RESERVED`): that sale could be a draft or owe money.
- The dashboard's customer count leaves the walk-in record out; its sales
  count in revenue as any sale does.
- A payment method on a sale that is not a walk-in is refused, not ignored.

**Built 2026-10-11 (I2) — a confirmed sale prints as an invoice / delivery note.**
From the order, *Invoice* opens a page in the reader's language and direction
with a *Print* button (the browser's print onto A4; no menu, buttons or chrome on
the paper). It shows the business name, "Sales invoice / Delivery note", the order
number and date, the shop (name, phone), every line (product and SKU, quantity,
unit price, discount, line total), subtotal, discounts, order total, what has been
paid on this order and what it still owes. **2026-10-21 (owner):** no "Received by /
Delivered by" lines to sign any more, and its header is the contract's — the logo, the
title, "S&F — Motorcycle parts and accessories", the number and date, over a heavy rule
(one `DocumentHeader`, `components/ui/document-header.tsx`; the tagline once in
`document-tagline.ts`). A draft and a cancelled order have no invoice (`INVOICE_DRAFT`,
`INVOICE_CANCELLED`) and offer no button. Guesses, open until confirmed (2026-10-11):
- **The shop's balance on the invoice is its balance at the moment of this sale**:
  "balance before this sale", "this invoice", "balance after this sale" — the
  running balance from the shop's statement (§7b) right after this sale's row, so
  a reprint next month shows the same figures. "Paid" and "still owed" on the order
  are as of printing. The alternative — today's balance — changes every reprint.
- What returns took off the order is shown as "Returns credited", so total − paid −
  returns = still owed on paper; a fully returned order says so and owes nothing.
- The business name printed is "MotoParts"; no address, tax number or logo is
  printed — none is on file. A walk-in sale prints "Walk-in customer", "paid in
  full on the spot", and no account box.
- The invoice number is the order number; there is no separate invoice sequence.

**DECIDED 2026-10-11 by the owner — selling below cost warns, and never refuses.**
*Built 2026-10-11 (L4).* He sold 90 helmets at 1,000 EGP each when each had landed
at 2,616.67, and nothing told him. Now every place a selling price is set says so
before the sale is made — and the sale still goes through if he chooses it: a
clearance or a favour to a shop is his decision, not the system's.

- **What "cost" means.** The landed cost (§2) of the units this sale would actually
  draw under FIFO (§3): the oldest received batch first, each at its own cost.
  A line that spans two batches costs exactly those units, so 3 units drawn as
  2 at 900 and 1 at 1,100 cost 2,900 together (966.67 each) — selling them at
  1,000 is *not* below cost though it is under the newer batch. Two lines of one
  product draw in order, the second after the first, as confirming does.
- **What it is compared with.** The line's total *after its line discount* — the
  figure the order stores — against the cost of its units, each batch's share
  rounded to the cent exactly as confirming records the COGS. It is compared per
  line, in cents, never per unit: a price that is at cost to the cent across the
  line is not flagged because a four-place unit cost rounds differently. Exactly
  at cost is not below it. The warning is that line's cost, the price per unit
  after the discount, and the loss on the line; the order shows the losses added.
- **No stock, no warning.** A line the shelf cannot cover in full is not costed —
  confirming refuses it (`INSUFFICIENT_STOCK` / `NOT_ENOUGH_STOCK`) and that is
  the message. A line still being filled in (no product, no quantity) is not
  costed either.
- **One rule, one definition** (CLAUDE.md §11). `apps/api/src/common/below-cost.ts`
  computes it; `POST /sales/price-check` answers every surface; the batch
  list it reads is the same function confirming allocates from (`fifoBatches`).
  Nothing is written and nothing is refused by it.
- **Where it shows.** The office sale form, shop and walk-in, under each line and
  under the order total, as price, quantity or discount change; a draft's order
  view above Confirm (the cost is read again — stock may have moved since it was
  written); approving a storefront request (§12); setting a product's B2B or B2C
  price; and the assistant's `record_sale` preview (§16).
- **A product's price** is checked against the oldest batch on the shelf — what
  the next unit sold at that price would draw, which is the same check as a sale
  of one unit. No stock, no warning.
- **Who sees it.** The roles that sell — core partners and admin support, who
  already read landed costs on the inventory page and a sale's allocations. A
  temporary investor or a shop never reaches the check (the endpoint carries the
  sales roles and refuses anyone else), and a product's price warning is shown
  only to whoever may set the price (core partners).
- Coded (`BELOW_COST`) and said in the reader's language; the amber warning
  style, not the red of a refusal.

Guesses made while building it, open until confirmed (2026-10-11):
- A sale in a currency other than EGP is not compared: the cost is in pounds and
  the order records no rate to convert at. (The assistant and storefront requests
  are always EGP.)
- A free line (price 0) on stock that cost something is a loss and warns.
- The warning sits beside the buttons rather than asking "are you sure?" first:
  it is on screen before Confirm is pressed, and a second click to get past it
  would make a decided price slower to enter every time.

**DECIDED 2026-10-16 (owner asked for the capability; details a GUESS, the
recommended option) — a sale has a date.** Entering a cycle that already
happened means entering sales made weeks ago (B2B, some paid in instalments).
A sale takes a **Sale date** (`orderedOn`, YYYY-MM-DD, a Cairo day) on
`POST /sales/orders`, the walk-in sale and `POST /sales/price-check`;
optional, today when left out, never in the future (`DATE_IN_FUTURE`), never a
non-date (`BAD_DATE`). It is stored in `orderedAt` so that the sale's Cairo day
is the day chosen (today: now, as before; an earlier day: midday in Cairo).
- **Stock that day.** A sale dated before the day it is entered draws only
  from batches received on or before the end of its day (§3), FIFO among them,
  at creation and at confirm. Short of that: `NOT_ENOUGH_STOCK_ON_DATE`
  (product, day, what there was, what was wanted) — it never draws stock that
  arrived later. A sale entered for its own day draws the whole shelf exactly
  as before.
- GUESS: **a draft keeps its day.** A draft saved on Monday for Monday and
  confirmed on Wednesday was never back-dated, so it draws the whole shelf as
  before (confirming is when the goods leave, §3). A draft saved for an
  earlier day is held to that day's stock when confirmed. There is no endpoint
  that edits a draft, so a draft's day is chosen when it is saved; to change
  it, cancel and enter it again.
- GUESS: **back-dated sales are drawn from what is left in those batches now.**
  Entering history out of order — today's sales first, then last month's — can
  find the early batches already sold and refuse; enter a past cycle's sales in
  date order.
- Everything that reads a sale's date reads `orderedAt`: revenue by month
  (bucketed by the Cairo month, which also fixes a sale at 00:30 on the 1st
  being charted a month early), the dashboard, the customer statement, the
  invoice, To collect's oldest unpaid order, the sales list and the customer's
  pages. Settlement reads allocations, not dates. The below-cost warning of a
  back-dated sale is costed from the stock of its day.
- **The assistant** (`record_sale`) sends `orderedOn` only when the partner
  says the sale was on an earlier day; the preview names the day, shows that
  day's stock and binds the day.
- The office form: "Sale date", the shared date picker, today prefilled,
  future days greyed out; an earlier day says only stock received by then can
  be sold.
- `check-data` 25 and 25.1 watch for a sale dated forward and a back-dated sale
  that drew stock received after its day.

### Samples at shops (owner 2026-10-18)

The owner, 2026-10-18 (mockup approved): "Sometimes we leave samples at shops with no money; when they like it they
say ok let's make a deal, or they send them back." Built the same day as the smallest flow, from the screen he already
uses (LEARNINGS "Keep flows small"). Migration `20261018200000_samples_at_shops` (additive: order statuses
`SAMPLES`, `SAMPLES_RETURNED`, `SAMPLES_WRITTEN_OFF`; movement types `SAMPLE_OUT`, `SAMPLE_BACK`; nullable
`sale_orders.samples_left_at`, `samples_decided_at`, `samples_reminded_at`). The rules are in
`apps/api/src/common/samples.ts` (pure) and `common/samples-out.ts` (what is out, read from the database).

**Round 2 (owner 2026-10-18, after testing it locally).** "At shops" reads **"Samples"** everywhere; "They're buying"
opens the **normal New Order popup pre-filled** instead of its own dialog, so lines can be changed, removed and added;
a product's page shows its **Samples**, and its B2C price stat card is gone. The rules below are updated in place and
marked "round 2".

**Leaving samples.** The New Order popup has one amber switch, **"Samples — no charge yet"** ("Units leave the shelf.
No sale, nothing owed, until the shop decides."). With it on there is no draft, no discount, no total, prices are
optional, and the one button reads **Leave samples** (`POST /sales/orders` with `samples: true`).

- DECIDED (owner): **the price is optional until the shop decides.** A price given is kept on the line as a note
  (the decision starts from it); the line and the order total **0** and owe **0** whatever was noted.
- The units leave the shelf from real batches, **FIFO like a sale** (the same `drawFifo` confirming uses), each draw a
  `SaleItemAllocation` at that batch's landed cost, with a `SAMPLE_OUT` movement. Stock rules are a sale's: more than
  is on the shelf is `NOT_ENOUGH_STOCK` (summed per product), a quantity of 0 or less `QTY_NOT_POSITIVE`, and a
  back-dated leave draws only the stock of its day (`NOT_ENOUGH_STOCK_ON_DATE`).
- Same ORD- numbering, same idempotency key (a double click leaves the samples once).
- **A real customer only:** walk-in, the walk-in record, or `walkIn: true` with `samples: true` → `SAMPLES_NEED_SHOP`;
  no customer → `CUSTOMER_REQUIRED`; an id that is not a customer → 404.
- **It is not a sale.** A samples order (open, returned or written off) counts in no revenue, COGS, receivable,
  customer balance or statement, dashboard, Analytics, P&L, settlement profit, invoice (`INVOICE_SAMPLES`) or
  contract (`SALE_CONTRACT_NOT_OPEN`), and cannot be returned (`ONLY_CONFIRMED_RETURNABLE`). Every reader already
  counts only CONFIRMED / PARTIALLY_PAID / PAID (and RETURNED for a return's netting); the customer statement used to
  read "not DRAFT, not CANCELLED" and now leaves the samples statuses out too.
- **No payment against it:** a payment sent with the samples order itself → `VALIDATION_FAILED`; one recorded or
  allocated against it afterwards → `SAMPLES_NOT_PAYABLE`. A discount sent on a samples line is set to 0, not refused.
- GUESS: leaving samples that take a product below its minimum raises the low-stock alert, as a sale does — the
  shelf is what low stock means (§3).

**On Sales.** The order shows an amber **"Samples · N units"** badge (round 2: the owner asked for "Samples" wherever
the screens said "At shops"; Arabic عينات), and when opened: the shop and the day
left, how many days ago, and the day the reminder is due (or "Reminder sent"). The list's status filter has
**Samples**. Three actions, and nothing else (no invoice, payment, contract, return or cancel):

- **"They're buying"** — DECIDED (owner 2026-10-18, round 2, replacing the first round's per-product
  Buying / Returned dialog): **opens the normal New Order popup, pre-filled**, because the shop may take more, take
  less, or add products. Title "Complete sale from samples ORD-…", and one line above the fields: "N units were out as
  samples; anything you remove goes back to the shelf." Pre-filled: the shop (fixed — the samples were left with it;
  the server refuses another with `SAMPLES_OTHER_SHOP`), today, the order's channel and currency, and every line that
  went out at its quantity and price — the price noted when left (a typed price: it stays when the channel changes),
  else the product's price for the channel, else 0. In the popup everything a sale allows: lower a quantity (the
  rest goes back to the shelf), remove a line (all of it back), raise one, add products, set prices and discounts. A
  product's units out on this order count as available to it in the popup. No draft, no walk-in, no samples switch;
  one button, **Complete sale** (`POST /sales/orders/:id/samples/convert`, the body a new order sends). The
  below-cost warning is not shown there (GUESS: it costs from the shelf's FIFO, which is not what the kept units cost).
- **"Returned"** — everything back on the shelf; the order ends **SAMPLES_RETURNED** (not a cancelled sale, not a
  return of a sale). **Cancel on samples is "Returned"** (`POST …/cancel` does the same, for core partners — cancel
  is theirs alone, while `POST …/samples/return` is open to the sales roles; the screen does not offer Cancel at all).
- **"Write off"** (core partners only, like Cancel) — the shop kept them or they were lost. Asks first, showing the
  cost written off; an optional note goes to the audit log.

**DECIDED (built) — the shop buying converts the order in place.** Same order, same ORD number, becomes a
**CONFIRMED sale dated the day chosen** in the popup (`samples_left_at` keeps the day left, and the order says "Began
as samples left on …"), with **exactly the lines the popup was saved with** — revenue, COGS, the receivable and the
shop's debt start that day. Chosen over a linked sale because nothing reads it differently from any other sale: a
payment, a return, a contract and the invoice work on it as they are. Per product (`planSamplesConversion` in
`common/samples.ts`, owner 2026-10-18 round 2):
- **Kept** = the lesser of what went out and what the sale has. Those units **are the units that went out** — same
  batches, same cost — and they do not move again (no second movement; they left with `SAMPLE_OUT`).
- **Back** = what went out and is not kept: back to the batch each unit left (`SAMPLE_BACK`).
- **Extra** = what the sale has beyond what went out — a raised quantity, or a product that never went out — drawn
  FIFO from the shelf exactly as confirming a sale draws (`drawFifo`, movement `SALE`). Checked first, on the shelf of
  the sale's day: for a product that went out the refusal is **`SAMPLES_EXTRA_NOT_IN_STOCK`** ("5 of X went out as
  samples; selling 9 needs 4 more from the shelf, and only 1 is there"), for one that never went out it is the sale's
  own `NOT_ENOUGH_STOCK` / `NOT_ENOUGH_STOCK_ON_DATE`. Nothing moves on a refusal.
- Every line is checked as a new order's are, by the same code (`checkLines`, `saleLines`): a real product,
  quantity above 0, price 0 or more, no negative discount, no discount above its line.
- So a unit is counted once: kept (sold), back (shelf) or drawn (sold) — shelf + samples + sold always equals what
  was received.
- GUESS (kept from round 1): **which units are kept** — the oldest-received of what went out, as FIFO would have drawn
  them (§3); the units put back are the newer ones. When one product has two lines, they take the kept units in the
  order of the lines, the later line taking the shelf for its rest.
- DECIDED by me, round 2 (the owner said "treat as Returned, or refuse with a code — pick one"): **a sale with no
  lines at all is refused, `SAMPLES_NOTHING_KEPT`, pointing at "Returned"** — saving a sale should never quietly
  record a return, and "Returned" is one click beside it. Removing every sample line but adding another product is a
  sale (of the new product) with every sample back on the shelf.
- GUESS, round 2 (replaces "always dated today"): **the sale's day is today unless an earlier day is entered**, as on
  any sale — never in the future (`DATE_IN_FUTURE`) and **never before the samples were left**
  (`SAMPLES_SALE_BEFORE_LEFT`; the picker greys those days out). Extra units come from the stock of that day.
- Converting twice, or after Returned / Write off, is `SAMPLES_ALREADY_DECIDED`; two saves at once make one sale (the
  claim on the order is a conditional update only one wins).

**Returned and written off — how stock and money move.**

| Outcome | Stock | Money |
|---|---|---|
| Left (SAMPLES) | Off the shelf (`remainingQty`/`saleableQty` fall), counted under **Samples** | Nothing: no sale, no ledger row |
| Bought (CONFIRMED) | Kept units stay out (sold, same batches); units not kept back to their own batch (`SAMPLE_BACK`); extra drawn FIFO (`SALE`) | A normal sale on its day, with the popup's lines: revenue, COGS, receivable |
| Returned (SAMPLES_RETURNED) | Every unit back to the batch it left (`SAMPLE_BACK`) | Nothing. Its lines and allocations stay as the record of what went out and count in nothing, as a cancelled sale's do |
| Written off (SAMPLES_WRITTEN_OFF) | Gone for good: never back on the shelf, not at a shop | Their landed cost is a cost of the cycle each unit came from |

**The write-off is costed like goods lost on the way (§2, §9; CLAUDE.md §11).** `samplesWrittenOffEgp` in
`common/cycle-losses.ts` sums the cost on the written-off orders' allocations, per cycle (by batch) or for all
cycles, dated the day it was written off; `cycleWriteOffsEgp` gives goods lost on the way and samples written off
apart and together, and settlement, the dashboard's net profit, Analytics' P&L and the cycle comparison all subtract
the total — one definition. It is **not** a ledger row (no money moved — the cash left when the goods were bought),
**not** a cost of goods sold (nothing was sold, so it is neither in COGS nor in revenue), **not** an operating expense
in the ledger's sense and **not** a cost recovery. It shows as its own line: **"Samples written off"** in the P&L's
expenses by category, and in a payout's cycle costs. A leg re-cost (§2) re-costs those allocations with the rest, so
the write-off follows a corrected cost while the cycle is unsettled.
- GUESS: a write-off is the **whole order** and cannot be undone — there is no mix of returned and written off on
  one order. OPEN for the owner: a shop that sends some back and keeps the rest free can today only be recorded as
  "They're buying" the kept units at a price of 0 (their cost then lands in that sale's COGS rather than on a
  "Samples written off" line — the cycle's profit is the same). Round 2: that is a line at price 0 in the popup.

**Inventory.** A **Samples** column (named "At shops" until the owner's round 2, 2026-10-18; Arabic عينات) (units out on open samples orders, per product and per batch), beside
**On shelf** (was "Total Stock": every batch's remaining units) and **Total** = on shelf + at shops. **Low stock still
means the shelf** (§3, `common/low-stock.ts` reads `remainingQty`): units at shops are not on it and are counted once,
from the open samples orders' allocations (`common/samples-out.ts`) — never twice. Shelf + at shops + sold always adds
up to what was received (net of returns and losses).

**Settlements.** DECIDED (owner): **a cycle cannot be settled while any of its units are out as samples** — calculate,
approve, pay, and the plain move to Settlement all refuse with `CYCLE_HAS_SAMPLES_OUT`, naming how many units at which
shops, sorted by name, and what to do ("3 unit(s) of cycle CYC-… are out as samples at Delta Bikes (1), Nile
Motors (2). Record what the shops decided — bought, returned or written off — before settling."). Unsold-stock figures
(`common/unsold-stock.ts`, the cycle's projection and the cycle comparison) count units at shops as **unsold**, at
the cost they left at — never as sold.

**The reminder.** DECIDED (owner): **14 days after samples were left** and while they are still at the shop, every
active core partner gets "Samples at <shop> for 14 days" (`SAMPLES_AT_SHOP_REMINDER`, en + ar in
`common/notification-messages.ts`, with the units and the order on the push's second line), linking to the order
(`/sales?order=<id>`, which opens it). Once per order, ever: `samples_reminded_at` is claimed by an update only one run
can win. Never before the 14th Cairo day, never for decided samples. It rides the daily job: Vercel's cron
`GET /jobs/overdue-payments` (05:00 UTC) and the `@Cron` in `OverdueScheduler`. Through `NotificationsService`, so it is
pushed to phones too (§10).
- GUESS: a partner who joins after the reminder went out is not told again (once per order, not per partner — unlike
  overdue instalments).

**Editing.** A samples order's lines cannot be edited while open — there is no edit path for any order (§4); to change
what is out, record "Returned" and leave the samples again. Changing the lines **when the shop buys** is what the
"They're buying" popup is for (round 2).

**On a product's page** (owner 2026-10-18, round 2). A **Samples** card: the units of the product out on open samples
orders in all, and per order the shop, the units, how long ago they were left, linking to the order
(`/sales?order=<id>`); "No samples out" when there are none. The stat card that showed the B2C price is now the
Samples total — the prices card below it still shows and sets both B2B and B2C prices (only the card was removed;
B2C pricing is unchanged everywhere else).

**New Order warns when the shop holds samples** (owner 2026-10-25; built 2026-10-25). Why: a new order for 5 helmets
when 1 is the sample the shop already has draws 5 more from the shelf while the sample still counts as out — stock
reads one low and the cycle cannot settle until the samples order is closed.
- Picking a shop in New Order shows, **above the lines**, an amber hint per open samples order: "This shop holds 1
  Helmet as a sample (ORD-…, left …)" — each product and its units (Arabic: "هذا المحل لديه … كعينة"), and under it
  "If those are what they're buying, complete that samples order instead…". Each order has a link, **"They're buying
  — open ORD-…"**, which closes New Order and opens that samples order's "They're buying" popup (above), read fresh.
- **A hint only — DECIDED (owner): it never blocks the new order**; a separate purchase while a sample is on trial is
  valid. Neither button looks at it, and the API refuses nothing because of it.
- **One definition of "samples out at a shop"** (CLAUDE.md §11): `samplesAtShop` in `common/samples-out.ts` reads the
  same open-samples allocations as Inventory's Samples column, the cycle's unsold stock and the settlement gate, filtered
  to the shop — so returned, written-off and bought samples are not in it (they are no longer `SAMPLES`), nor another
  shop's. `GET /sales/orders/samples-at-shop?customerId=` (sales roles): no shop `CUSTOMER_REQUIRED`, an id that is not
  a customer 404. A samples order is never a draft, so there is no draft state to show.
- Not shown for a walk-in (no shop) nor in "They're buying" itself (it is that order). Switching shop never leaves the
  last shop's hint: it is read per shop and not kept once nothing shows it, so it never shows samples since decided.
- **The assistant:** `record_sale`'s preview to a shop holding samples ends with "Samples at this shop: …", each order
  with its products and units, pointing at `complete_samples_sale`; its data carries `samplesAtShop`. It binds nothing
  — the sale still goes through. **The office chat** shows the same hint, translated, under the preview card, its link
  opening "They're buying" (`/sales?buying=<id>`); the English note is cut from the card so it is not said twice (the
  model still reads it).
- GUESS: the hint lists units out per product on each order (all units of a product summed across the batches they
  left), oldest order first; no price is shown (a noted price is not a decision).

**The assistant** (§16; tools built 2026-10-20, owner's queue of 2026-10-18): `list_sales` labels each order `kind:
"SALE"` or `"SAMPLES"` as before. Five tools carry the flow, each the office endpoint's own `SalesService` call,
previewed by that call rolled back and committed with the confirmation token (`tools/samples.ts`):
- `leave_samples` (= `POST /sales/orders` with `samples: true`): a shop on file only — walk-in `SAMPLES_NEED_SHOP`,
  none `CUSTOMER_REQUIRED`; a price is only noted.
- `list_samples`: open samples orders per order, per shop and per product, as the Sales list and a product's Samples
  card show them.
- `complete_samples_sale` (= `…/samples/convert`): the lines the shop buys, or none for "exactly what was left"; a
  line without a price takes the price noted when left, else the list price, marked for the partner to confirm; a
  `PRICE_NEEDED` question when neither exists.
- `return_samples` (= `…/samples/return`): always the whole order — quantities the partner names must be exactly what
  went out: more is `SAMPLES_RETURN_MORE_THAN_OUT`, less is `SAMPLES_RETURN_NOT_ALL` (which points at recording the
  rest as a sale).
- `write_off_samples` (= `…/samples/write-off`): the preview shows the cost written off.
Roles are the office endpoints', defined once in `modules/sales/sales-roles.ts` (`SALES_ROLES`; write-off
`SALES_PARTNER_ROLES`). Guesses, open until confirmed (2026-10-20):
- A noted price of 0 is read as "no price noted" (the service stores 0 when none was given).
- With no noted, list or default price the assistant asks (`PRICE_NEEDED`); the office popup falls back to 0.
- `complete_samples_sale` keeps the samples order's channel and currency; the assistant offers no channel change.
- The quantity check on `return_samples` and its two codes are the assistant's own; the service has no partial return.
- `list_samples` reads at most 20 pages of 100 open samples orders.
- `leave_samples` uses the B2B channel for a B2B customer and B2C otherwise, as `record_sale` does.

**Who.** Leaving samples, "They're buying" and "Returned": the sales roles (core partners and admin support), as
selling is. "Write off": core partners only (GUESS — it moves cost onto a cycle, like cancelling a sale).

**Checked by** `apps/api/src/common/samples.spec.ts` (the rules, `planSamplesConversion`),
`apps/api/src/modules/sales/samples.db.spec.ts` (against Postgres: every figure before and after, and each change the
popup can make), `apps/web/src/components/sales/samples-form.test.tsx` and
`samples-pages.test.tsx`, spec 34 TC-INV-72..74, and `scripts/check-data.sh` 26–26.2 (a samples order with a total,
a balance or money on it; an open one whose batches do not hold its lines; one with no day left).

---

### Lowering a price after the order is confirmed  — DECIDED 2026-10-22 (owner), details GUESSED, API built 2026-10-22, office screen built 2026-10-22 (branch `worktree-agent-a22fde29e831a71c8`, waiting for the owner's local test); the order's total as its value now DECIDED 2026-10-22 (Option A, branch `worktree-agent-a8504ef748f4d4272`)

**What happens in the business.** A shop's price is lowered after its order was confirmed — Koshary
(ORD-2026-00002) was given 100 EGP off per product on 2026-10-22, after two returns and a 5,000 cash payment.
Until this is built the only way is a hand correction in the database; cancelling and re-entering the order would
break its returns and payments. The owner: "do you think we should add a feature to update price after order
confirm?" — yes.

| Rule | Answer | Status |
|---|---|---|
| When the lower revenue counts | **On the day of the adjustment**, not the order's date — reports already looked at do not change (owner, 2026-10-22: "adjustment date"). | DECIDED |
| What it is | A dated **price adjustment** on a confirmed order line, recorded beside it, never an edit of the line's original price. The order shows "price lowered from 1,250 to 1,150 on 22 Oct by Abdallah"; the audit log keeps it. | GUESS |
| What it covers | Only the units the shop still holds on that line (sold less returned). Returned units keep the price they were refunded at; returns, payments and allocations are never rewritten. | GUESS |
| What moves | The order's total and outstanding drop by (old − new price) × units held; revenue and net profit drop on the adjustment's day; COGS, stock and batch costs do not change. No ledger row: the ledger records money received (§4 "the ledger records money as it is received"). | GUESS |
| Limits (server, coded refusals) | Lower only — never above the price it replaces; never below zero; never more than the order still owes (a lower price on a paid-up order would mean a refund, which is a return or a separate decision); not on a draft, cancelled order, or an order on a cycle whose settlement is approved or paid. | GUESS |
| Who | Core partners (rule 12). | GUESS |
| Where | An "Adjust price" action on the confirmed order's popup: pick a line, type the new price, see what the shop will owe before saving. | GUESS |

**As built (2026-10-22, API; the office screen below).** `POST
/sales/orders/:id/price-adjustments` (and `…/preview`, which writes nothing), core partners only;
`modules/sales/price-adjustments.service.ts`, table `sale_price_adjustments` with its per-batch shares in
`sale_price_adjustment_items` (migration `20261022100000_sale_price_adjustments`). Where it differs from, or adds
to, the table above:

- ~~GUESS (changed from the table): the order's total does not drop~~ — **superseded, DECIDED 2026-10-22 (owner,
  "Option A", from a rendered sample he picked; he found the Total staying at what was first sold "a bit
  misleading"): the office shows what the order is worth now, the sold total beneath it** — see "What the order is
  worth now" below. The stored `total` still stays what was sold (the line is never edited); the invoice and the
  statement are unchanged and still show the cut on its own line, "Price lowered" (total − paid − price lowered −
  returns credited = owes). Every revenue figure takes the cut off on the adjustment's day: dashboard,
  P&L, revenue by month, top products and top orders, each cycle's profit and its settlement, the shop's statement
  (an "ADJUSTMENT" row), `check-data` 13.1 (and 13.2: a cut's batch shares add up to it).
- **Per batch, so each cycle loses its own units' revenue** (§8): the held units are split by the batches they came
  from (each allocation less what came back to it), the last batch taking the rounding residual.
- **A unit handed back after its price was lowered is refunded at the lower price** — one definition,
  `common/held-price.ts`, used by the adjustment and by returns.
- **Refused, each with its code:** not lower than the price the held units are at now, or negative
  (`PRICE_ADJUSTMENT_NOT_LOWER`, `PRICE_ADJUSTMENT_BAD_PRICE`); more off than the order owes
  (`PRICE_ADJUSTMENT_EXCEEDS_OWED`; exactly what it owes is accepted and leaves it paid up); a draft, cancelled,
  paid-up or returned order (`PRICE_ADJUSTMENT_ORDER_NOT_OPEN`); a line with every unit returned
  (`PRICE_ADJUSTMENT_NOTHING_HELD`); a day before the sale or in the future (`PRICE_ADJUSTMENT_BEFORE_SALE`,
  `DATE_IN_FUTURE`); another order's line (`SALE_ITEM_NOT_IN_ORDER`).
- **GUESS: not while the sale is under an instalment contract** (`PRICE_ADJUSTMENT_UNDER_CONTRACT`): the contract
  covers what was owed when it was signed, so a cut under it would read as instalments paid. Cancel the contract,
  lower the price, draw a new one.
- **GUESS: not on units from a cycle being settled, closed or with its settlement approved or paid**
  (`PRICE_ADJUSTMENT_CYCLE_SETTLED`) — its figures are agreed.
- **Two at once lower it once:** the order's row is locked while the cut is checked and written.
- The audit log records `PRICE_ADJUSTED` on the order. No ledger row (no money moved).

**Office screen (built 2026-10-22, on its branch until the owner has tried it locally).** "Adjust price" in the
sale order popup's actions (`components/sales/adjust-price.tsx`): pick the line, type the new unit price, the day
and an optional note; the server's own preview (`…/preview`) shows units covered, what it takes off and what the
shop owes before → after as the person types (350 ms after the typing pauses), and Save sends exactly that. The
screen's own choices, each a GUESS until the owner says otherwise:

- GUESS: the button shows only on a confirmed or partly paid sale, for a core partner — the statuses the server
  takes (a draft, paid, returned, cancelled or samples order never shows it). A sale under an instalment contract
  still shows it, and the popup says why it cannot (`PRICE_ADJUSTMENT_UNDER_CONTRACT`) instead of a form.
- GUESS: the line picker lists only lines the shop still holds units of, each with units held and its price now;
  with one such line it is chosen already.
- GUESS: the price field starts empty and is never filled in for the person — the current price is shown under it.
- GUESS: the day starts on Cairo's today; days before the sale and after today cannot be picked.
- GUESS: the note is capped at 500 characters in the form (the server sets no limit).
- GUESS: Save is enabled only once the preview of exactly what is typed has come back without a refusal; every
  other refusal (cycle settled, more off than owed, not lower) is the server's, said in the reader's language.
- ~~The order's Items table still shows the price each line was sold at; the price now is in its History.~~
  Superseded 2026-10-22 (owner, Option A) — below.

**What the order is worth now — DECIDED 2026-10-22 (owner, Option A); built 2026-10-22 on branch
`worktree-agent-a8504ef748f4d4272`, waiting for the owner's local test.**

- **An order's Total is what it is worth now**: what was sold, less what came back at the price it was refunded at,
  less every price cut. The sold total is under it in small muted text, "sold at 30,300.00 EGP", only when the two
  differ; an order with no returns and no cuts shows one figure, as before. Where: the Sales list (table and phone
  card), the order popup's header, a shop's page (its orders), the Contract popup's "Sale total" (whose "Paid so far"
  is now value now − remaining: a return or a cut is not money paid).
- **In the order's Items**: a line whose price was cut shows the price now with "was 1,250.00" under it, and its line
  total is what it is worth now (units held × price now; nothing for returned units) with "sold at 5,000.00 EGP"
  under it. A line with a return but no cut: its price as sold, line total now with "sold at …". The quantity column
  keeps the sold quantity; under the product's name "1 returned · 3 held" once anything came back. On a phone the
  figures under the name read "4 × 1,250.00 → 1,150.00".
- **One definition, on the server** (CLAUDE.md §11): `apps/api/src/common/order-value-now.ts`, beside and using
  `held-price.ts`. Per order `valueNowEgp` = total − Σ return lines' `refundEgp` − Σ adjustments' `amountEgp`; per
  line `returnedQty`, `heldQty`, `soldUnitPrice` (line total ÷ quantity, as History's "sold at"), `unitPriceNow`
  (`heldUnitPrice`), `priceCut`, `lineValueNow`. Read from the stored figures the outstanding was moved by, so for an
  order still owed: **value now − payments standing + cash refunded = outstanding** (a cash refund hands the money
  back instead of lowering what is owed — §5). Returned by `GET /sales/orders` (each row, in the same queries as the
  page: no query per row), `GET /sales/orders/:id`, `GET /customers/:id` (its orders) and the assistant's sales and
  customer reads (`valueNow` beside `total`). The Sales list has no sort or filter by total.
- GUESS: "was" is the price per unit as sold after the line's discount (what History calls "sold at"), not the
  price before the discount; the Discount column still shows the discount given at the sale.
- GUESS: a credit note larger than what the order still owed is clamped at zero by the return (§5), so on such an
  order the value now can be below what was paid; the identity above then reads as a surplus nobody holds. Not
  changed here.

Koshary's 100 off is not applied yet: once the Adjust price button is in production, or through the API when the owner
says so.

### An order's full history  — DECIDED 2026-10-22 (owner), API built 2026-10-22, office screen built 2026-10-22 (branch `worktree-agent-a22fde29e831a71c8`, waiting for the owner's local test)

`GET /sales/orders/:id/history` (`modules/sales/order-history.service.ts`): one timeline, oldest first, each event
with its day and who recorded it — created and confirmed with its lines and prices, samples left / bought /
returned / written off, each payment allocated to it and any reversal, each return (reference, lines, refund,
method, reason), each price cut (line, old → new price, units), cancellation — and beside it, per product: started
with, returned, holds now, sold at, price now. Read from the records that already exist and the audit log (who
confirmed or cancelled); no second copy of the figures. What the order owed after each event is replayed in the
order things were recorded, as the statement replays it, and ends on the order's own outstanding (`replayedOwes`
beside `owes`, equal unless stored figures disagree). GUESS: a sale entered later is shown on its own day (its
`orderedAt`), created and confirmed alike.

**Office screen (built 2026-10-22).** A "History" tab beside "Order" in the sale order popup
(`components/sales/order-history.tsx`): the per-product table (started with, returned, holds now, sold at, price
now), then the timeline oldest first — each event's day, who, what (lines and prices, a return's reference, lines,
refund, method and reason, a price cut's old → new and units, a payment's method and reference) and what the order
owed after it — and under it both "history ends at" and "the order owes now", as the API sends them. Nothing is
summed in the browser. GUESS: when the two differ the tab says so in red and points at the data check, rather than
showing one of them. GUESS: on a phone the per-product table is one card per product (five columns do not fit).

## 5. Returns

**DECIDED 2026-08-21.**

**The original sale is never edited.** A return is its own record. What changes
is derived: the customer owes less, the stock is back, the COGS is reversed.
History survives, as BRD §9 and §10 require.

**Goods go back to the batch they came from, at the cost they left at.** Units
are traced through the original FIFO allocations, most recent first — the last
units to leave are the ones being handed back. Restocking into "the product"
would re-price inventory and misstate the profit of whichever cycle owns the
batch.

**Damaged goods are refunded but not restocked.** Their cost stays spent as a
write-off rather than returning to inventory.

**Credit note by default**, because most returns are from shops with a running
balance and no cash needs to move. A cash refund is available and reaches the
ledger as an outflow.

You cannot return more than remains returnable, counting earlier returns. A
reason is required.

**FIXED 2026-10-11 — returning part of an order leaves the rest owed.** An order
is RETURNED only when every sold unit has come back, and a RETURNED order owes
nothing. The check counted the return being recorded twice, so bringing back one
of two units marked the order RETURNED and what the shop still owed on the other
unit dropped out of its balance. Found by the customer statement's invariant
(§7b). `scripts/check-data.sh` check 18 lists any order already caught by it;
each needs its status put back by hand (CONFIRMED, PARTIALLY_PAID or PAID by what
it owes) — not done on production by this change.

**Returns net off every profit figure** — cycle profitability, the dashboard,
revenue by month, top products. Revenue by month nets the return in the month it
came back, not the month of the sale, so a month already reported does not move.

---

## 6. Supplier refunds

**DECIDED 2026-08-21.** A refund recovers cost. It reaches the ledger as an
inflow on the cycle and reduces that cycle's investment, improving its profit.

**It does not re-price batches.** Units already sold keep the cost they were
sold at, and a settlement may already have been agreed on those figures.

Refunding more than the order was worth, counting refunds already recorded, is
refused.

**DECIDED 2026-10-10 — goods lost on the way can be refunded.** *Built 2026-10-11 (B5, B5b).* Asked
for by the owner. Whoever lost them — the shipping company, or the supplier — may
pay some or all of it back. A refund is recorded against **the loss itself**, from
the leg's shipping company or the order's supplier, in any currency with its FX
rate, and works like any supplier refund: it is money arriving, so it reaches the
ledger as an inflow on the cycle and recovers cost, raising the cycle's profit by
what it brings in.

- Refunds on one loss can never total more than the loss cost, counting earlier
  ones — compensation is recovery, not a profit on losing goods.
- Like any supplier refund it can be recorded whenever the money arrives, even
  after the cycle is settled or closed.
- A loss that has been refunded cannot be taken back: the goods turning up after
  being paid for would be counted twice. If they do turn up, the refund is undone
  first — money handed back is a ledger correction — and then the loss.
- Neither kind of refund can be dated in the future. Left blank, it is dated
  today, Cairo time.
- The shipping company that pays must be that leg's own provider, as recorded on
  the leg; a leg whose company was typed in rather than chosen can only be
  refunded by the supplier.

**2026-10-10 — undoing a refund.** *Built (B5b).* A supplier refund or a loss
refund can be undone when the money is handed back, by a core partner, with a
reason. Nothing is edited away: the refund stays on record, marked undone, and
a balancing ledger outflow points back at its original inflow (§9). An undone
refund counts toward no cap and no profit, so the loss is unrecovered again
and the cycle's profit falls by it on every screen. Undoing twice is refused.
Once every refund on a loss is undone, the loss can be taken back.
Guesses, open until confirmed:
- An undo is allowed in any cycle status, settled or closed included, as
  recording a refund is — money moves when it moves.
- When a loss is taken back, its undone refunds stop naming it (the database
  would otherwise refuse the take-back); which loss they were for is kept in
  the take-back's audit entry.
- A refund recorded before refunds reached the ledger has no inflow to
  balance; undoing it only marks it.
- The undo is dated when it is done; there is no separate "handed back on"
  date.

---

## 7. Customer payments and instalments

**DECIDED 2026-08-21.**

**A plan is agreed per shop, against their running balance** — not per sale. A
shop thinks in terms of what it owes you in total and pays against that.

**Instalment amounts are whatever was agreed.** They need not be equal and there
is no fixed weekly figure. A 20,000 balance might be settled as 10,000 up front
then 1,000, 5,000 and 4,000 on the next three Sundays. An upfront payment is
simply the first instalment, dated the day the plan was agreed.

**Progress is cumulative, not instalment-by-instalment.** What matters on any
date is whether the shop has paid at least what it had promised by then. A shop
that pays 1,000 late but 5,000 early is square. Money is applied to the earliest
instalments first, and a surplus flows forward.

**Overdue means a genuine shortfall** — the cumulative amount promised by today,
less what has actually come in. Due today is not overdue until tomorrow.

**DECIDED 2026-10-10 — a payment can be put on a chosen order.** *Built 2026-10-11 (U2).*
Recorded from an order, the money goes on that order: it must be the same shop's,
confirmed, with something still owed, and the payment cannot be more than that
order owes. Recorded from the shop or the payments list, it goes on the oldest
unpaid orders first, as before.

*2026-10-11 (I2):* "oldest first" now happens on the server, in the same
transaction that records the payment (`applyOldestFirst`), for the office form and
the assistant alike. It was a loop in the browser after the payment was saved, so a
dropped connection could leave money recorded but applied to nothing; now it is all
of it or none of it. Oldest means the order created first — since 2026-10-16, the order sold first (its sale day), then created first (§7a).

A payment is in the order's currency or in Egyptian pounds; no other currency is
offered.

**DECIDED 2026-08-21 — overdue flags and notifies, nothing more.** It appears in
the overdue summary and raises a notification. It
does **not** block new sales, warn on the sale screen, or charge a penalty. This
matches the BRD's V1 scope, and each of those is a deliberate future choice
rather than an oversight.

**DECIDED 2026-10-11 (I1, autonomous run) — overdue is checked every morning and
every partner is told, once per instalment.** *Built 2026-10-11.* Until now overdue
was worked out only when someone opened the overdue summary, only that person was
notified, and nothing in the office app opens it — so in practice nobody was told.
A daily job (05:00 UTC, 07:00–08:00 in Cairo) now finds every instalment that has
fallen behind on an active plan and notifies **every active core partner** —
not investors, not admin support, not shops. Each partner hears about each
instalment **once, ever**: the job runs every day and an instalment stays overdue
until paid, and a daily repeat of the same figure teaches people to ignore the
bell. A later instalment of the same plan falling behind is new and is told. A
partner added after an instalment fell behind is told on the next run. The
notification names the shop, the plan, the instalment's due day and what is
still owed on it (money covers the earliest instalment first, as above). Reading
the overdue summary no longer notifies anyone. This replaces "at most one per
plan per day". **Confirmed by the owner 2026-10-11:** an alert fires once when an
instalment first goes overdue, and again only when a further instalment is
missed — no repeating daily reminder. Guesses, open until confirmed:
- An instalment that is paid and then falls behind again (a payment reversed)
  is not told a second time.
- Admin support can read plans but is not notified; the notification is for the
  partners whose money it is.

One active plan per customer. Agreeing a second while one is live is refused,
because two schedules would claim the same payments. Cancel and re-agree
instead.

A plan cannot promise more than the shop actually owes.

### A sale's instalment contract — DECIDED 2026-10-16 (owner), details GUESSED

The owner: *"On the sale order popup add a button Contract, it shows another
popup to create the plan, then it creates the contract — it should be that
simple."* A bigger first version (a settings page, stored contracts, new
customer fields, a button on the shop page) was rejected as too much and removed.

- **The button.** The sale order popup (Sales) has **Contract** for a sale that is
  confirmed or partly paid, in EGP, with something outstanding, not a walk-in, and
  with no plan yet — offered to core partners, who are the ones who may agree a
  plan. A sale that already has its plan shows Contract to the sales roles (core
  partner, admin support) and it opens the contract directly.
- **The plan popup.** Sale total, paid so far, remaining (= outstanding). Number of
  instalments (default 3, 1–36) and the first due date (default a month from
  today); rows a calendar month apart from the first date (the 31st falls back to
  a short month's last day, then returns), equal amounts with the last absorbing
  the rounding. Every row's date and amount can be changed. **Create contract**
  stays disabled until the rows add up to the remaining amount exactly; the
  difference shows as it is typed. Moving the first date re-dates only rows
  nobody touched; changing the count re-splits the amounts and keeps hand-typed
  dates *(guess)*.
- **A plan for each contract — owner, 2026-10-17.** *"In the installment plan popup
  I want to customize for each contract not a fixed 3 month plan."* Approved from a
  mock: beside the count and the first date, **Every** — week, 2 weeks, month,
  2 months, 3 months. Weeks are 7 days each; months are calendar months
  counted from the first date, clamped as above. Each row can be removed (the count
  drops to match) and **Add instalment** appends one dated one interval after the
  last row, amount 0 (a row after a hand-dated last row is dated from that date and
  keeps it). **Split remaining equally** re-splits the remaining amount over the rows
  there are, the last absorbing the rounding; adding or removing a row never
  re-splits on its own. Changing the interval, like the first date, re-dates only
  rows nobody re-dated. Create stays disabled until every row has a date, an amount
  above 0 and the rows add up exactly; a past date shows the server's own
  `INSTALMENT_DUE_IN_PAST` wording. *Decided (2026-10-17):* the server already
  sorts instalments by date and numbers them in that order, and does not mind two
  on the same day, so no rule was added there — the popup sends the rows sorted by
  date (same-day rows in the order on screen) and allows same-day rows, as the
  server does. Nothing on the server changed: 1–36 rows, each above 0, today or
  later, adding up to what is outstanding, all as before.
- **What has been paid toward a contract — 2026-10-17.** A contract covers exactly what its sale still owed
  when it was signed, so what has been paid toward it is its total less what the sale owes now — the same
  figure everywhere a plan is read (the Contracts list, a shop's page, overdue alerts, the assistant).
  It read the shop's payments since the agreed day before: a down payment made the same day, before the
  contract, was counted as paying it, and each of a shop's contracts was given all the shop's payments. A
  plan with no sale (made before contracts) keeps that older reading.
- **The popup's default — owner, 2026-10-17.** *"Make the default 2 installments on
  the next 2 saturdays."* The popup opens on two weekly instalments, the first on
  the first Saturday after today (Cairo) — never today itself, so a sale made on a
  Saturday is first due the Saturday after — the remaining split between them.
  Every field stays editable.
- **The plan.** An ordinary plan (`PaymentPlansService`, the same rules above —
  verified shop, one active plan per shop, never more than the shop owes, the
  cumulative reading of who is behind) that names the sale (`saleOrderId`, one
  plan per sale). `POST /sales/orders/:id/contract-plan`, core partners only, as
  `POST /payment-plans`. Refused with a code: not confirmed or partly paid
  (`SALE_CONTRACT_NOT_OPEN`), not EGP (`SALE_CONTRACT_NOT_EGP`), nothing
  outstanding or a walk-in (`SALE_CONTRACT_NOTHING_OWED`), the sale already has
  its plan (`SALE_HAS_PLAN`), instalments not adding up to the outstanding amount
  (`CONTRACT_SUM_MISMATCH`), an instalment due before today (`INSTALMENT_DUE_IN_PAST`;
  today is allowed — a payment taken at signing), and the existing
  `CUSTOMER_HAS_ACTIVE_PLAN`. `GET /sales/orders/:id` says whether the sale has
  its plan (`contractPlan`). *Guess:* a cancelled plan lets go of its sale, so the
  sale can be given a new one; the cancelled plan keeps no link.
- **The contract** is a print page (`/sales/[id]/contract`), built live from the
  sale and its plan — nothing about it is stored. Number `CT-` + the order number;
  dated the day the plan was agreed; Cairo. Seller S&F with blank lines for the
  representative and phone; buyer the shop's name and phone, blank lines for the
  address and ID / commercial registration; the sale's lines; three totals —
  total price, **paid at signing = total − the plan's total**, **remaining in
  instalments = the plan's total** (both fixed at signing, so a reprint says what
  was signed, not today's balance); the schedule with a receipt-signature column;
  the terms; two signature lines; "made in two copies". Arabic by default, whatever
  language the office is in, with a switch to English. One A4 sheet for a typical
  sale.
- **The terms are fixed text in code** (suggested wording, approved in the mock;
  the owner may change it later): the buyer received the goods sound and as
  specified; pays the instalments on their dates, cash or bank transfer;
  ownership stays with the seller until paid in full; two consecutive missed
  instalments make the rest due at once; the courts of Cairo decide any dispute.
- **Instalment plans moved into Payments** (owner, same day): a second tab,
  "Instalment plans" (`/payments?view=plans`), for following up — every shop's
  plan, behind, paid so far, remaining, next due, cancel. It has **no create
  button any more**: in the office a plan is agreed only from a sale's Contract
  button. A plan linked to a sale shows its order number and **Open contract**;
  an older plan shows neither. The old `/payment-plans` address redirects to the
  tab, the menu entry is gone, and an overdue-instalment notification opens the
  tab. `POST /payment-plans` stays in the API (the assistant and older callers).
- **Contracts replace payment plans — owner, 2026-10-17.** *"Remove payment plans
  and replace it with contracts, where I can see the contract for this shop."*
  Approved recommendation:
  - The Payments tab is now **Contracts** (`/payments?view=contracts`). The old
    `?view=plans` opens it and swaps the address for the new one; `/payment-plans`
    and the overdue notification land on it too. One row per contract: the shop,
    the order number, the contract total (the plan's total), paid so far against
    it, and the next due date and amount — or **Overdue** with the amount behind,
    or **All paid** when nothing remains. Whoever is behind comes first. The row
    opens that contract's page (`/sales/[id]/contract`, where it is printed,
    downloaded and shared). Cancelling the plan stays on the row.
  - Each shop's page has a **Contracts** section: the same list, that shop's only,
    each row opening its contract; "No contracts for this shop" when there are none.
    It replaces the old payment-plan section there.
  - **Plans with no sale.** Since 2026-10-16 nothing in the office or the
    assistant creates a plan without a sale; `POST /payment-plans` is still in the
    API, so one can be made by calling it directly, and plans agreed before
    contracts existed have no sale. *Decided (2026-10-17):* such a plan is **still
    listed** — it is money owed, and hiding it would hide a debt — labelled **"No
    contract (older plan)"**, with its figures, and its row opens nothing because
    there is no contract page to open. Production had no plans of any kind on that
    day, so today this case is empty.
  - Nothing on the server changed: `GET /payment-plans` (with `customerId` for a
    shop) already returned each plan's sale, totals and standing.
- *OPEN:* a plan reads every payment the shop makes from the agreed day on
  (cumulative, above) — so money paid on the day of signing, or on another of the
  shop's sales, counts toward the instalments. With one active plan per shop that
  is the rule as it stands; whether a sale contract should count only money on
  its own sale is the owner's to say.

---

### Dashboard: To collect — owner, 2026-10-15

The dashboard shows the five customers to chase first, beside Top products, for the roles that see
customer balances (core partner, admin support). **Order: anyone with something overdue on a payment
plan first, then the larger balance; ties by name.** Each row: the customer, their number of unpaid
orders, what they owe, the overdue part (only when there is one), and how long ago their oldest unpaid
order was placed. The headline totals everyone owing and the overdue part across all of them, so it
agrees with the Receivables tile. The figures are the same receivables (§7, `common/receivables.ts`)
and the same overdue rule (plans only, never above what is owed) the assistant's `list_receivables`
reads — `GET /customers/to-collect?limit=` (1–20, default 5). A row opens the customer; View all opens
Customers sorted by balance. Nobody owing shows "Nobody owes you anything right now". Owner chose the
card from a mock; "upcoming" by due date was not used because only plan shops have due dates.

## 7b. A customer's statement  — built 2026-10-11 (I2)

On the shop's page: pick a range of days and read the balance it opened at, every
sale, payment, return and payment reversal in date order with the balance after
each, and the balance it closed at. Printed on A4 from the browser, or taken out as
a CSV. Core partners and admin support only, as the shop's balance is.

**The rule: a statement running to today closes at the balance the app shows** —
the shop's page, the customers list, the payment form's "owes now". It is not a
second set of rules: it replays, order by order, exactly what each payment, return
and reversal did to what that order owed, so the rows add up to the stored figures
(34, TC-INV-26/27 check every customer in the system). Building it found a real bug:
a partial return marked the whole order returned (§5, fixed the same day).

Guesses, open until confirmed (2026-10-11):
- A draft never appears (it owed nothing), and **a cancelled order does not appear
  at all** — cancelling is for an order that never happened (§4) — rather than a sale
  and a cancellation.
- Each row is dated the day it happened in Cairo: a sale on the day it was placed, a
  payment on the day it was received (even if typed in later), a return on its
  return date, a reversal on the day it was reversed. Within a day, in the order they
  were recorded.
- A payment shows what it took off the balance. Money on no order (possible only
  from before 2026-10-11, when "oldest first" ran in the browser) is shown as "on no
  order" and changes nothing owed — the balance never counted it either.
- A cash refund of part of an order changes nothing owed (the money went back in
  cash); the return that brings back the last unit ends what the order owed, as the
  order itself does (§5).
- A reversed payment is shown as received and then reversed, two rows, not hidden.
- Everything is shown in EGP, as the balance tile is; an order in another currency is
  added in as its own figure, exactly as the balance adds it (both are a guess the
  day a shop is sold to in USD).
- The walk-in record has no statement (`WALK_IN_NO_STATEMENT`): it has no account.
- With no dates chosen the statement covers everything, opening at zero.

**FIXED 2026-10-11 (I3 run) — a payment is reversed once.** Reversing a payment
puts what it paid back on the orders it was allocated to. A second reversal of
the same payment used to do that again, so the shop owed more than it was ever
charged. Now it is refused (`PAYMENT_ALREADY_REVERSED`) and changes nothing; of
two reversals sent at once, one wins. Not a new rule — a reversal undoes a
payment, and there is only one payment to undo.

---

### The statement's Profit column — DECIDED 2026-10-23 (owner, picked from a rendered sample), built 2026-10-23, details GUESSED

A **Profit** column beside the balance, green for profit and red for a loss, with the shop's profit for the dates
on the closing row. From the server (`common/customer-statement.ts`, `profit` on each row and on the statement),
from the same costs the cycle's profit reads — never summed in the browser:

| Row | Profit |
|---|---|
| A sale | its total less the landed cost of the units it drew (its allocations' COGS); red if sold below cost |
| A return | the profit on the units given back, negative: their refund less the cost that came back with them — a damaged unit's cost stays spent, so its whole refund is given back |
| A price cut | the cut, negative (§4) |
| A payment, a reversal | "—" — cash moving, not profit |

The closing row's figure is the rows in the dates, summed; the opening history is not in it. For Koshary's order the
statement and the two cycles' profit agree to the piastre (`price-adjustment.db.spec.ts`). It is gross profit: the
shop's sales less what they cost, before any running cost or cycle expense.

- GUESS: **on screen only.** A printed statement, its PDF and its CSV may be handed to the shop, so none of them carry
  the column (DataTable's `screenOnly` column: `print:hidden sheet:hidden`).
- GUESS: everyone who may open a statement sees it (core partners and office support), as both already see the
  dashboard's profit.

## 7a. What cannot be recorded

**DECIDED 2026-08-22**, after each of these was found to be possible.

**A shop cannot pay more than it owes.** A payment is refused when it exceeds
the customer's total outstanding across confirmed orders. Taking 500 against a
300 balance leaves 200 attached to no order: it clears nothing, still reads as
collected, and overstates what has been received. In practice it is a typo, and
the moment to catch a typo is before it is written down.

An earlier version kept the surplus as unallocated credit. That was not agreed
with anyone and is reversed. If taking a genuine deposit before an order exists
is ever needed, it is a separate thing and needs its own decision — see below.

**Only confirmed orders owe anything.** A draft reserves nothing and counts for
nothing (§4), so it is not part of a balance and cannot be paid against.

**Money cannot be dated forward.** Judged in the business's timezone
(`Africa/Cairo`, overridable with `BUSINESS_TIMEZONE`), not the server's. At
00:37 on the 23rd in Cairo it is still the 22nd in UTC, so a payment entered
then was refused as future by a UTC check — correct on a machine in Cairo,
wrong the moment it runs anywhere else. A payment cannot be received, and a purchase
order cannot be placed, on a date that has not arrived. Dating either forward
puts revenue or cash into a period that has not happened, so a report run today
already contains next month. Instalment due dates are the exception and are
meant to be in the future.

**A discount cannot exceed what a line is worth.** A 100 line discounted by
9,999 produced an order totalling -9,899 — a sale owing money to the customer,
which would have counted as revenue.

**Nor can it be negative** (2026-10-10). A negative discount is a hidden price
rise; it is refused on every path that creates an order.

**A payment can only pay the customer who made it.** Allocation checks the
order belongs to the payer. It did not, and the picker offered every order in
the system by number, so one shop's money could clear another's debt.

**A record must point at something that exists.** A payment for an unknown
customer is a clear refusal, not a 500.

**DECIDED 2026-10-16 (with back-dated sales, §4; details a GUESS, the
recommended option) — money cannot pay for a sale that had not happened yet.**
A payment is not applied to an order sold after the day the payment was
received (`PAYMENT_BEFORE_ORDER`, naming the order, the day it was sold and the
day the money came in) — on a chosen order, oldest first and the Allocate
action alike. A payment the same day as the sale is fine. **Oldest first now
means sold first** (the sale's day), then written first: a sale back-dated to
the 1st is paid before one typed in earlier for the 8th; money left over that
could only go on a later sale is refused rather than applied. The payment
dialog's order list sorts the same way. `check-data` 25.2 watches for a payment
allocated to a sale made after it was received.

---


### A customer with branches — DECIDED 2026-10-25 (owner), built 2026-10-25, details GUESSED
Some shops now have several branches, each buying separately, with **one owner who pays for all**. Decided: one
customer with branches under it (option 2 of two offered; separate customers per branch was the other). Each branch
keeps its own orders, balance and statement; the customer shows the combined total; an owner's payment can go to one
branch or across several. Also decided (owner, 2026-10-25): credit and contract limits, the storefront login and the
invoice header are all the **owner's**, not each branch's. The owner picked the design from a rendered sample
(`docs/samples/branches/`), then (2026-10-25) "the branch shouldnt be required, in a sale order, it should auto
select the default branch" and "not required because default to the default".

- **A branch is not a customer.** It is a row under the customer (`customer_branches`): a name, an address, a phone,
  whether it is the default, whether it is archived. An order names its branch (`sale_orders.branch_id`); an order
  with none is on the owner. Payments, contracts, the storefront login and the invoice header stay on the customer.
- **Names**: once per customer, ignoring case and extra spaces ("LS2" and "ls2" are one branch;
  `BRANCH_NAME_TAKEN`). Required, at most 80 characters. Another customer may use the same name.
- **The default branch**: at most one per customer, held by the server and a unique index. Making one the default
  takes it off the other. An archived branch cannot be the default; archiving the default leaves none.
- **A sale order's branch** (one rule, `resolveSaleBranch`, for the office form, drafts, samples, walk-in, the
  assistant's `record_sale` and the office chat): a branch named must be this customer's (`BRANCH_NOT_THIS_CUSTOMER`)
  and not archived (`BRANCH_ARCHIVED`); none named means the customer's default branch.
  - GUESS (open): a customer with branches but **no default** — the order stays on the owner, with no branch. Ahmad
    Zogmar gets his branches with no default until the owner picks one.
  - GUESS: New Order offers a picker only when the customer has **two or more** open branches ("a customer with one
    branch picks none"); with one, the default rule decides.
  - GUESS: a sale completed from samples keeps the branch the samples were left at.
- **Balances**: a branch owes what its confirmed orders still owe (the `owedBy` rule, narrowed). The owner owes all of
  it — every branch plus the orders on no branch; the branch figures always add up to it (they are the same orders
  split one way). Nothing is stored twice.
- **Payments** (recorded once, for the owner): to **all branches**, oldest first across every order, never more than
  the combined owed (`PAYMENT_EXCEEDS_OWED`, as before); to **one branch**, oldest first on that branch's orders only,
  never more than it owes (`PAYMENT_EXCEEDS_BRANCH_OWED`, `BRANCH_OWES_NOTHING`); on a chosen order, as before. A
  branch and an order together are refused (the order already says its branch).
  - GUESS: an **archived** branch can still be paid — it keeps its balance until settled.
- **Statements**: the owner's is every row with its branch named (a payment spread over two branches names both). One
  branch's statement is the same history narrowed to its orders, with each payment shown as the part that went there;
  it closes at that branch's balance, and the branches' closing balances (plus the orders on no branch) add up to the
  owner's. The Profit column works the same way.
- **Contracts, samples, returns and price cuts** stay on their order, so on its branch.
- **The invoice**: billed to the owner; "Deliver to" the branch, with its address and phone. GUESS: the invoice's
  Account box (balance before and after) is the **owner's** combined balance, not the branch's.
- **Who**: core partners add, edit, make default, archive and restore branches (as they edit customers); the office
  roles read them.
- **Not built**: credit and contract **limits** — the app has none today (overdue does not block a sale, above), so
  there is nothing per branch to move. The storefront shows nothing new (the owner's login sees his orders as before).
- Open, for the owner: which of Mokattam, Master and LS2 is Ahmad Zogmar's default, and the names' spelling; an
  owner with no default (above). A return's credit note lowers what its own order owes (§5), so it stays on that
  order's branch.

## 8. Cycle profit and settlement

**Profit is revenue less the cost of what actually sold**, less goods lost on
the way (§2), plus anything a supplier gave back. Revenue and cost are attributed through batch allocations,
not through the cycle's own transactions — a FIFO sale can span batches from
several cycles, so a sale's revenue is deliberately recorded without a cycle.

**Unsold stock keeps its cost with the cycle.** Profit therefore covers sold
units only, and the settlement screen says so.

**DECIDED 2026-08-23 — the three partners fund a cycle equally by default.**
A new cycle starts with all active core partners on it. Their contributions
begin at zero because the capital is not known yet — a cycle costs what its
goods and shipping come to — and "Split equally" fills them in from the landed
cost once it is, to the piastre, with the last partner absorbing the residual
so capital returned matches capital put in. A temporary investor's own money is
excluded from that split; the partners cover the remainder.

Equal contributions produce an equal split by construction, which is why no
profit percentage is set: three explicit 33.33s total 99.99 and are rejected,
and choosing which partner absorbs the extra 0.01 is not worth encoding.

Naming participants when creating a cycle overrides the default entirely.

**Distribution defaults to actual contribution.** 80k / 100k / 120k gives
26.67% / 33.33% / 40%. A custom split can be agreed per cycle.

**SUPERSEDED 2026-10-19 by the owner — see the next paragraph and §18 "The
partners repay the friend".** What follows was the rule from 2026-10-11 to
2026-10-19; the code no longer does it.

~~**DECIDED 2026-10-11 (owner) — a cycle a friend paid for entirely splits its
profit equally among its core partners.**~~ *Built 2026-10-11 (L2), removed 2026-10-19.* When every
participant's contribution is zero and friends' payments cover the cycle's whole
cost to fund (§18: the costing's "to fund" is zero and a friend paid something),
the profit — or the loss — goes equally to the cycle's core partners. A temporary
investor on it put in nothing and takes nothing (no share, no fee). A custom split
still overrides it. Every other cycle with no contributions still refuses
(`CYCLE_NOT_FUNDED`): a cycle a friend paid for only partly, or one nobody paid
for at all — rounding must never decide who gets the money (working rules §10).
Settlement preview, calculate/approve and the partners page all read the one
projection, so they agree. Guess made while building it (2026-10-11, open until
confirmed): the rounding residual goes to the last participant whose share is
not zero — not to an investor on the cycle who takes nothing; for every split
that already existed this is the same last line as before unless that line's
share was zero. (The residual rule stays: it applies to any split.)

**DECIDED 2026-10-19 (owner) — the partners repay a friend who paid for a
cycle, in shares they choose, and profit follows those shares.** After a friend
paid for a whole cycle, Split equally set every partner to 0 EGP. The owner: "no
but I need to show that we split money among us to repay the lender which means
that we pay, it looks vague as if we payed nothing, and it does not have to be
equally maybe 30,30,40". A friend's payment is a loan to the partners, not
funding that replaces theirs: what they fund is the whole cycle, and each
partner's contribution is their share of it — directly, or by repaying him.
Profit is split by contribution as on every other cycle (`CONTRIBUTIONS`); with
nothing entered, settling refuses `CYCLE_NOT_FUNDED` whether or not a friend
paid (the `LENDERS` basis is gone). A custom split still overrides. Details in
§18, "The partners repay the friend".

**A temporary investor's fee comes out of their profit, never their capital.**
50,000 gross profit at 15% is a 7,500 fee; the investor keeps 42,500 and their
capital is returned in full. The fee line shown against the investor is a memo
of a deduction already inside their profit share — it must not be subtracted
again when totalling a payout.

**Capital and profit are separate settlement components.**

**Settling pays out and closes.** Approving moves the cycle to SETTLEMENT.
Paying writes one ledger entry per participant and closes the cycle.

**DECIDED 2026-08-21 — closing with stock remaining is refused unless
explicitly accepted.** That stock's cost stays with the cycle, so closing writes
it off. The refusal makes it a decision rather than an accident.

**DECIDED 2026-10-11 (owner) — leftover stock can move to another cycle at its cost.** *Built 2026-10-12 (L5): API, screens, unit and e2e tests (99-leftover-transfer, TC-INV-51..53).*
Instead of writing leftovers off when a cycle closes, the partners can move them to another cycle that is still
open (or to a new cycle started for them). Exactly how:

- **When:** from a cycle in Selling or Settlement (not yet paid out), once every unit is accounted for (received or
  lost). The settlement's "still holds N units" refusal offers it in place.
- **What moves:** per product, all or some of the units on the shelf. The rest can still be written off by closing
  as today. A damaged unit is written off, not moved.
- **At what price:** exactly its landed cost, never re-priced. The moved units keep their original check-in date, so
  they still sell first (§3).
- **Cycle A (the one giving):** the units leave its stock and it recovers their cost, so they make no profit and no
  loss for A. Its partners get their capital back in full; nothing is written off.
- **Cycle B (the one receiving):** the units join its stock at that cost, and its cost to fund rises by the same
  amount — its partners fund them. When they sell, the revenue and profit are B's.
- **Recorded:** a transfer record (date, from, to, product, units, unit cost, who, why). A's page shows "moved to B",
  B's shows "from A", the original batch in A records the units leaving and B gets a new batch pointing back at it,
  and two matching ledger entries mark it as a transfer between cycles — not cash, not income, not an expense. The
  dashboard's cash and profit do not change.
- **Undo:** only while none of the moved units has sold in B and A has not been paid out. After that it is permanent.
- **Who:** core partners.

Settled while building it (L5, autonomous run 2026-10-11) — **guesses, each OPEN until the owner confirms**:

| Question | Guess built | Why |
|---|---|---|
| "On the shelf" | Verified batches' sellable units, less units held for a shop's request (`availableQty`'s reading). A held unit stays where the shop was promised it. | Never more than is on the shelf; a hold is a promise. |
| Which batch the units come from | Oldest check-in first, as a sale would draw; one transfer line per source batch, each at that batch's own landed cost. | The units that would have sold first move first; nothing is re-priced (§3). |
| The moved batch's check-in | The source batch's own (`createdAt`) and its arrival day. So in B the moved units sell before B's own later stock (§3 FIFO). | "They keep their original check-in date." |
| Allowed targets | Any cycle that is not being settled, closed or cancelled — including one still in planning or on the way. Never the giving cycle. | Its partners fund them; a cycle settling has already counted its stock. |
| "Not yet paid out" | The giving cycle is SELLING or SETTLEMENT and has no PAID settlement. | §8. |
| The record's "why" | Required (500 characters at most), as for every undo. The date defaults to Cairo's today and cannot be later. | Records of things that happened (rule 1). |
| Ledger | Two `cycle_transfer` rows: an INFLOW on the giving cycle (cost recovered), an OUTFLOW on the taking cycle (cost taken on), both pointing at the transfer (`relatedType` `STOCK_TRANSFER`), so neither can be reversed on its own (§9). `cycle_transfer` is in `CAPITALISED_CATEGORIES` and in a new `NOT_CASH_CATEGORIES` (`common/ledger-categories.ts`): not income, not an expense, and not cash — the dashboard's cash in, cash out and cash on hand leave it out through `common/cash-position.ts`. It cannot be typed by hand in the ledger (`LEDGER_CATEGORY_RESERVED`). | No money moved; the goods were paid for once. |
| The taking cycle's cost to fund | `CostingService.fundingFor`: landed cost + stock moved in (transfers that stand). Until 2026-10-19 it also took off what friends paid; it no longer does (§18, "The partners repay the friend"). "Split equally" uses it. The giving cycle's cost to fund is unchanged: its partners did fund those goods and get that capital back at settlement. | §8: "its cost to fund rises by the same amount". |
| Analytics' cycle "investment" | Nets transfers, signed: lower on the giving cycle, higher on the taking one. Profit is not touched on either side. | So the two cycles' figures agree with each other. |
| Paying out after a move | Paying a settlement reads what the cycle holds **now**, not the figures from when it was calculated, so leftovers moved after approval leave nothing to write off. A move and its undo also refresh the unsold figures on either cycle's open (draft or approved) settlement; profit and payouts do not change. | Otherwise the "still holds N units" refusal would describe stock that has left. |
| "None of the moved units has sold in B" | Strict: undo is refused once any sale ever drew from the moved batch — even one since cancelled — or any hold, return, or onward move touched it. The taking cycle must also not be settling, closed or cancelled. | The batch then has history of its own; undoing would erase it. |
| What undo does | Units back on the giving cycle's batches (movement `TRANSFER_IN`), the moved batch and its movements removed (nothing depends on them — the gate above), two balancing ledger rows pointing at the originals, the transfer kept and marked undone with who, when and why. | §9: history is never rewritten; the record stays. |
| Cancelling the taking cycle | Refused while it holds stock moved in (`CYCLE_HAS_TRANSFERS_IN`); undo the move first. | A cancelled cycle "never ordered anything" (§15). |
| Where the goods are | The giving cycle gains a **Moved to another cycle** place, so its units still add up to what it ordered; the taking cycle lists **From CYC-A** apart, with how many are still on its shelf, sold, or moved on — not inside its own ordered total. Recent activity did not list a moved batch as a receipt (the feed was removed 2026-10-17). | §8. |
| "Start a new cycle for them" | Opens the cycle wizard (`?leftoversFrom=`); once the new cycle exists, a link goes back to the giving cycle's page with Move leftovers open and the new cycle chosen. There is one Move form. | A cycle has no honest minimal form (CLAUDE.md §13). |
| The dialog's default | Every product starts at all of it on the shelf; a number typed is never overwritten. | The usual case is moving everything. |

**DECIDED 2026-10-11 (owner) — general running costs are the three core partners', equally, and come out of
their payouts.** *Built 2026-10-12 (L7): API, screens, unit, component and browser tests (99-running-costs, 34 TC-INV-59..64, 79 TC-RP-10).* An expense recorded with no cycle (rent, salaries, utilities…) is shared equally by
the active core partners; temporary investors never share it. It does **not** change any cycle's profit — that stays
the shipment's own. Instead, when a settlement is paid out, each core partner's third of the running costs recorded
since they were last charged is taken from his payout, on its own line. Each cost is charged once and records which
payout took it; what a payout cannot cover carries to the next one; reversing the settlement puts its running costs
back to waiting. They live on the Partners page as **Running costs**: what was spent, what has been taken from
payouts, what is still waiting.

**DECIDED 2026-10-11 (owner) — a payout explains itself.** *Built 2026-10-12 (L7), as above.* The settlement screen (before approving),
and each partner's payout history, break the money down line by line: revenue; cost of the goods sold; each cycle
cost by kind (extra freight, customs, goods lost on the way, exchange difference on repaying friends, other charges
to the cycle); the investor's fee; the cycle's profit and this partner's share; capital back; his share of running
costs; what he was paid. No lump "expenses" line.

Settled while building it (L7, autonomous run 2026-10-12) — **guesses, each OPEN until the owner confirms**:

| Question | Guess built | Why |
|---|---|---|
| What a running cost is | An operating expense through the one definition (`operatingExpenseEgp`) recorded with **no cycle**, that is not itself a reversal; counted net of its reversal, so a reversed cost owes nothing. An old free-text expense with no cycle counts too. A cost charged to a cycle is that cycle's, inside its profit — never a running cost. | One definition (rule 11); §9 already says an entry with no cycle is a general cost. |
| Who shares it | **Revised 2026-10-12 after the alignment review — guess, OPEN.** Each running cost's shares are **fixed once**, over the core partners active on the cost's own day (`occurred_on`, else the Cairo day it was entered): a partner whose partner record is active, whose login is a core partner and active, and who had joined (his partner record's day) by then. A partner's share of a cost **never changes afterwards**. A temporary investor never shares, nor does a core partner's own money put in as an investor on a cycle — only his core-partner line is charged. His share comes out of the next payout **he** receives, from whichever cycle; a partner not on the cycle being paid waits for his own. | No one ever pays more than his own share, silently or otherwise. |
| His share, and the odd piastre | Each cost is split on its own, among that day's partners: every share rounded **down** to the piastre, the residual to the partner of that day who **joined last** (partner record oldest first, then id), so 100 is 33.33 / 33.33 / 33.34. The shares are stored (`running_cost_shares`), once. The Partners page names who takes the odd piastre on today's costs. | Working rules §10: rounding must never decide silently; mirrors "Split equally". |
| Which costs, in what order | Every running cost recorded by the time Mark paid is pressed and not yet charged to him, whatever day it was spent, **oldest first** (the day spent — `occurred_on`, else the Cairo day entered — then id). | "Since they were last charged" read as "not yet charged". |
| What caps it | His payout on that settlement: capital back + his profit share + any investors' fee he receives. **Capital counts**, so running costs can come out of capital handed back. A payout of nothing, or a loss, takes nothing; the rest waits. | "Capped at what his payout can cover"; a payout is capital and profit together (§8). |
| Charged once | A row per (cost, settlement, partner, amount) — `running_cost_charges`. What stands against a cost never exceeds it; check-data 22–22.3 watch for it. Two payouts at the same moment take turns (an advisory lock), and the second click on one Mark paid is refused. | The recommended shape. |
| What Mark paid leaves behind | The audit row of the payout (`PAY`) records `runningCostsCharged`: each charge's cost, partner and amount. A participant whose net payout comes to exactly zero — his running costs took all of it — is handed nothing, so **no payout row is written** for him; his `RUNNING_COSTS` line and his `running_cost_share` row still say what was taken. | The ledger records money that moved; the audit says what the payout took. |
| On the settlement | One `RUNNING_COSTS` line per charged partner, negative; what he is paid is the sum of the payable lines. | So the settlement's own lines say what he received. |
| In the ledger | The payout row (`settlement`) carries the cash actually handed over — net of his share. Beside it, a `running_cost_share` row (INFLOW, the settlement's cycle, pointing at the settlement) records the deduction. That category is in `CAPITALISED_CATEGORIES` and `NOT_CASH_CATEGORIES` (`common/ledger-categories.ts`): not income, not an expense — the cost was an expense the day it was recorded — and not cash. It cannot be typed by hand, and cannot be reversed on its own. | Cash and the partners' records agree; nothing counted twice. |
| Reversing the settlement | Mirrors the payout rows and the `running_cost_share` rows, and marks its charges released (`released_at`) — the rows stay. Those costs are waiting again and the next payout takes them. | §8: reversing puts its running costs back to waiting; §9: history is never rewritten. |
| Reversing a cost already taken from a payout | Refused (`RUNNING_COST_CHARGED`, naming the cycle) until the settlement that took it is reversed. | He was paid less for it; like a cost on a closed cycle (§9). |
| Before it is paid | Draft and approved settlements show what paying **today** would take, through the very plan Mark paid runs, marked "If paid today". Two approved settlements can both show the same waiting costs; whichever is paid first takes them. | The settlement screen explains the payout before approving (§8). |
| When the core partners change | **Revised 2026-10-12 (alignment review) — guess, OPEN.** A partner who **leaves** keeps owing his fixed share of every cost of his time; it is never moved onto the others. He is no longer charged from payouts (only an active core partner is), so his part **stays waiting**, shown on the Partners page as his, marked as no longer a partner. A partner who **joins** after a cost's day owes nothing of it. Two edges, stated: (1) the shares are stored the first time a cost is seen with write access — when it is recorded, or at the next Mark paid for costs recorded before this rule — over the partners active at that moment who had joined by the cost's day; nobody records when a partner left, so a partner who left before that moment is not among them. (2) A cost dated before any partner had joined (typed in from old books) is shared by all the active partners, rather than owed by nobody. How a leaving partner settles what he still owes is the owner's call. | The owner's rule as the review read it: a leaving partner's part is his, and nobody pays more than his share. |
| The Partners page | A **Running costs** section with a period picker (this month, this quarter — the default, in Cairo — last quarter, this year, all time): spent by category, taken from payouts, still waiting, each core partner's share / taken / waiting, the partner who takes the odd piastre, and what waits in all across every period. A period is the days the costs were **spent**; "taken" counts what payouts have taken of those costs, whenever. The totals row's new **Running costs** is what payouts have taken from the core partners so far, all time. | §8. |
| A payout explains itself | Calculating a settlement keeps its costs line by line (`settlements.cost_breakdown`), from the same rows the projection subtracts, adding up to its expenses exactly: each cycle-charged category (extra freight, customs, any other), goods lost on the way, the exchange difference on repaying friends, refunds and other income as gains. The settlement card drops the lump "Expenses"; under the participants each one's lines read: share of the cycle profit (%), investor's fee taken or received, capital back, share of running costs (period), paid. The Partners page lists each person's payouts with the same lines, read from the same settlement. Leftovers moved out are a note beside the figures (at cost: no profit, no loss), read live. A settlement calculated before this has no itemised costs and says so in one line until recalculated. | §8: no lump "expenses" line; every figure from the settlement's own projection. |

**Reversing a settlement writes balancing entries and reopens the cycle.** It
never rewrites history. A reason is required.

**Paying out is not a cycle expense.** It distributes profit already earned;
counting it as a cost re-charges the cycle for its own success.

**DECIDED 2026-10-10 — a cycle settles only once every unit is accounted for.**
*Built 2026-10-11 (B3).* Every unit ordered must be received into stock or marked lost before
the cycle can move to settlement or a settlement can be approved, by any route.
Goods still on the way make the cycle's profit a guess. A cycle with nothing
ordered has nothing to account for.

**DECIDED 2026-10-18 (owner) — nor while any of its units are out at shops as
samples** (`CYCLE_HAS_SAMPLES_OUT`, naming the units and the shops; §4 "Samples at
shops"). Units at shops count as unsold stock in every unsold figure.

### The wizard ends at the shipping; funding is asked for on the cycle page, and locks at approval — owner 2026-10-18

**DECIDED (owner, 2026-10-18):**

- **The new-cycle wizard has three steps** — Cycle info, Purchase order, Shipping leg.
  The Funding step is gone. Finishing the shipping step saves the legs, moves the
  cycle as far as its dates allow (§1, unchanged) and opens the cycle's details page.
  The cycle is created exactly as before: every active core partner on it with a
  contribution of 0 (§8 above).
- **A funding note on the cycle page.** While settling the cycle would be refused for
  want of a basis to split its profit on (`CYCLE_NOT_FUNDED`), an amber note near the
  top says "Funding not entered yet — needed to settle this cycle", with three actions:
  **Split equally** (the page's existing split), **Enter amounts** (each participant's
  contribution, edited in place on the Participants card) and **Paid by a lender** (the
  existing "a friend paid the supplier" form, §18). If a lender paid part and the
  partners nothing, it reads "A lender paid X of Y; enter the partners' share for the
  rest, or the settlement will be refused". It goes once the partners put money in, and
  never shows on a closed or cancelled cycle. (Until 2026-10-19 it also went once a
  lender paid the whole cost to fund; now it stays and asks who repays him — §18, "The
  partners repay the friend", for its wording.)
- **Funding locks once the settlement is approved.** From an APPROVED or PAID settlement,
  or a CLOSED cycle, a contribution or custom split cannot be edited (Split equally
  included), a participant cannot be added, and a friend's payment cannot be recorded or
  removed: `FUNDING_LOCKED_AFTER_SETTLEMENT`, naming why (`reason`: `SETTLEMENT_APPROVED`,
  `SETTLEMENT_PAID`, `CYCLE_CLOSED`). Reversing the settlement unlocks it (the cycle goes
  back to Selling). One definition, `apps/api/src/common/funding-lock.ts`; the cycle's
  `fundingLock` carries the reason to the page, whose controls stay visible, switched
  off, with the reason beside them.

**GUESSES (2026-10-18, built; open until the owner confirms):**

| Question | Guess built | Why |
|---|---|---|
| When the note shows | Exactly when settling would refuse: `profitBasis` on the landed-cost totals is `NONE`. That is `profitBasisOf` (settlement-math.ts) — the function the settlement's split itself branches on — over the participants (until 2026-10-19 also `fundingFor`'s `fundedByLenders`, removed with the `LENDERS` basis). A custom split on every participant is a basis, so no note. Hidden too while funding is locked. | One definition (CLAUDE.md §11): the note and the refusal can never disagree. |
| "Paid by a lender" with one order / several | One order: the form opens on it. Several: the order picker, nothing preselected. | The owner's rule. |
| Its prefilled amount | What friends may still pay of the cycle, the API's own `availableEgp` (the cap it enforces). In pounds as is; in another currency divided by the rate shown, **rounded down** to the piastre, so it is never above the cap. It follows the currency and rate until he types an amount; a typed amount is never overwritten. | Reuse the server's figure; never a second formula for the cap. In a foreign currency the rounded-down amount can leave a few piastres unfunded, so the note may stay with the partial text — the partners split those, or the amount is typed. |
| "Enter amounts" | There was no per-participant editing on the cycle page (only the wizard's Funding step had it), so it moved there: an **Edit amounts** button on the Participants card, the note's action opens it and scrolls to it. Save writes only what changed. | The smallest flow, on the screen where the person is. |
| Adding an investor | On the cycle page's existing Add participant (the wizard's own add-investor box went with the step). | Already there. |
| A closed cycle, adding a participant | Keeps its older refusal, `CYCLE_CLOSED_NO_PARTICIPANTS`; every other locked path says `FUNDING_LOCKED_AFTER_SETTLEMENT`. | Unchanged code for an unchanged case. |
| A friend's payment on a cycle in Settlement or Closed | Still `CYCLE_CLOSED_FOR_FINANCING` (unchanged, checked first); the lock catches what that misses — an approved settlement on a cycle not marked Settlement. Removing one, which had no status check at all, is now refused from approval on. | Removing one after the payout changed the basis the profit was split on. |
| A draft settlement calculated before funding changed | **Approval refuses it** (`SETTLEMENT_STALE_FUNDING`) when, since the draft's `calculatedAt`, a participant was added or edited (`createdAt`/`updatedAt`) or a friend's payment recorded or removed (`createdAt`/`removedAt`). Calculating again replaces the draft, as it always has. Nothing is marked or deleted when funding changes. | The smallest correct option: the settlement flow already supersedes drafts on recalculation; approval is the one moment a stale split would become agreed. An edit that writes the same value still counts as a change (re-calculate). |
| The wizard's other figures | The wizard's funded-versus-cost line, its "Cycle cost" and its Split equally are gone with the step (§18's rows above that name them describe the cycle page now). | — |


---

**What a partner has earned so far, on the Partners page — faster, same figures (2026-10-21).** The accrued profit
is still each open cycle's settlement projection (`project`), but only for the cycles where something can have moved
the profit — a sale or return on their stock, a ledger row in a category the projection reads, goods lost on the way, a
repayment to a friend (`cyclesWithProfitActivity`, beside `project`, which must name any new input). Every other open
cycle projects exactly zero, and is no longer asked. 6 s → 0.2 s with 200 open cycles.

**The Settlement button carries its cycle — built 2026-10-20 (owner 2026-10-19).** The Settlement button on a cycle's
page opens Partners → Settlements with that cycle already chosen in the Calculate picker
(`/partners?view=settlements&cycle=<id>`). The choice lives in the address, so a refresh keeps it; a cycle picked on
the tab replaces the address's; an address naming a cycle that is not in the list picks nothing (Calculate stays
disabled) rather than a blank picker.

**Calculate and Approve no longer race — fixed 2026-10-20** (seen 2026-10-11, L1). Approving a draft while a
recalculation replaced it answered 500 (Prisma P2025). Both now take the cycle's lock (`lockCycle`), so they run one
after the other: an Approve that waited finds its draft gone (`notFound('settlement')`) or already approved
(`ONLY_DRAFT_APPROVABLE`); a Calculate that waited for an Approve is refused `SETTLEMENT_LOCKED`. TC-SET-17.


### A running account per partner — DECIDED 2026-10-25 (owner: "a great idea an account"), built 2026-10-25 (phases 1 and 2), details GUESSED
Funding a cycle starts before anyone has contributed: partners pay suppliers from their own pockets, in different
amounts, and sometimes want to fund from profit instead of cash. Decided: each partner has a running account — his
advances ("paid so far") and payouts left in add to it, contributions and withdrawals take from it — and cycle
contributions are drawn from those accounts. Also decided (owner, 2026-10-25: "equal thirds, no negative, paid
straight to supplier"): contributions default to **equal thirds**; an account **never goes negative** (no
contributing from profit yet to come — phase 3 is dropped); an advance is **paid straight to a supplier**, not cash in
the business, so cash on hand does not move.

**The old example no longer holds.** The Next up item's example (Shady advanced 1,000, Fares 400, the owner 600; equal
thirds of 2,000 leave Shady +333.33 and Fares **−266.67**) is now **refused**: Fares's third (666.67) is more than his
400, so the contribution is refused `ACCOUNT_BALANCE_TOO_LOW` naming the 266.67 short — he records it as a payment
first (in practice, what he settles with Shady), then the thirds go through.

**Built 2026-10-25** (branch `agent-partner-accounts`; API, office screens, Postgres and unit tests; e2e written, not
run — owner said not for now):

- **The balance** — one definition, `apps/api/src/common/partner-account.ts` (`accountBalances`, `balanceOf`): the
  standing movements of his account, + advances, + payouts left in, − contributions, − withdrawals. The Partners page,
  the cycle's funding panel, every check below and a settlement's reversal read it there.
- **An advance** (`POST /partner-accounts/:partnerUserId/advances`): a cycle, an amount above zero, the currency he
  paid in and that day's rate (required for any currency but EGP; the page's rate only prefills), the day he paid (not
  in the future), a note. Refused on a cycle in Settlement, Closed or Cancelled (`CYCLE_CLOSED_FOR_ACCOUNTS`) or once
  its funding is locked (`FUNDING_LOCKED_AFTER_SETTLEMENT`, §8 2026-10-18).
- **Paid so far, by whom** and **the funding target** (`GET /cycles/:id/account-funding`, `PUT
  /cycles/:id/funding-target`): the cycle page's Funding panel says "1,600.00 USD of 2,000.00 USD paid so far" with a
  bar, then each partner's payments. The target is optional, in a currency at a rate; cleared with `amount: null`.
- **Contributing from the accounts** (`POST /cycles/:id/account-contributions`): a total, split equally among the
  cycle's core partners (the default), or one amount per partner. All or nothing: one account short refuses the lot
  (`ACCOUNT_BALANCE_TOO_LOW`, with `partner`, `balance`, `amount`, `short`). Each share raises that partner's
  contribution and posts the same `contribution` ledger row an entered contribution always has.
- **Money taken out** (`POST /partner-accounts/:partnerUserId/withdrawals`): never more than the account holds.
- **A mistake** (`POST /partner-accounts/:partnerUserId/movements/:id/reverse`): once, with a reason; the row stays,
  marked reversed. Never when it would leave the account below zero; a contribution reversed comes back to the account
  and out of the cycle (a `contribution` OUTFLOW).
- **Phase 2 — a payout left in**: Mark paid takes `leaveInPartnerUserIds`; each named core partner's net payout goes
  into his account (`PAYOUT_LEFT_IN`). Reversing the settlement takes it back out — refused while that would leave
  his account below zero.
- **Who**: core partners only, every endpoint (`PARTNER_ACCOUNT_ROLES`).
- **Who owes whom between us**: does not fall out of the balances. With no negative account, nobody owes another
  partner through the accounts; a positive balance is the partners' money the business holds for him. Settling
  between partners stays outside the system.

| Question | Guess built | Why |
|---|---|---|
| What an account movement is in the ledger (CLAUDE.md §11) | **Nothing.** No movement is a ledger row: not cash, not income, not an expense. The cash event is the contribution — his money entering the cycle — which posts the `contribution` INFLOW it always has; the supplier's purchase OUTFLOW at receipt is matched by it, exactly as when partners paid suppliers and entered their contributions before accounts existed. Cash on hand, the P&L, the dashboard and each cycle's profitability are unchanged by an advance or a withdrawal (tested). | "Paid straight to supplier … cash on hand does not move." |
| A payout left in, in cash | The settlement's payout row stands as written — the business paid him — and his account holds it. The account is his money, not the business's cash, so while it sits there cash on hand reads as if he took it; drawing it into a cycle posts the contribution inflow as any contribution. OPEN: if the owner wants cash on hand to keep payouts left in, the payout and the contribution both need a different row. | One reading of every account movement: none is cash. |
| A withdrawal, in cash | No ledger row: the money is his, held outside the business's cash (above). | Same reading. |
| Entering a contribution by hand | Still possible (Split equally, Enter amounts, Add participant): money he put in from his pocket for that cycle, which never touches his account. The panel's Contribute is the way through the accounts. OPEN: whether every contribution must come through an account. | Production's cycle already has contributions with no accounts; refusing them would strand it. |
| Equal shares | Among the cycle's core partners on it, in the order they joined it, each rounded down to the piastre, the last taking the residual (333.33 / 333.33 / 333.34 of 1,000) — the same rule as Split equally. A share that rounds to zero is skipped. A total of zero or less is refused. | CLAUDE.md §10. |
| Who an account is | A core partner with a partner record. An investor, or anyone else, has none (`NOT_FOUND`, `partner`). | "Per partner." |
| Recording for another partner | Any core partner may record an advance, a withdrawal or a reversal on any partner's account, as the office enters every partner's records today. A movement is only reachable under its own partner's address (another partner's is `NOT_FOUND`). | One person keeps the books. |
| An advance on someone not on the cycle | Allowed: advances only track who paid. Contributing needs him on the cycle (`PARTNER_NOT_ON_CYCLE`). | "Advances only track who paid." |
| A target's progress in its currency | An advance paid in the target's currency counts at face value; any other counts its pounds at the target's rate. | "1,600 of 2,000" should read in dollars when they paid in dollars. |
| When a cycle stops taking any of it | Settlement, Closed, Cancelled, or once the settlement is approved — as for a friend's payment (§18). | Its funding is agreed. |
| Two writers at once | Each account is locked (its partner row) for the transaction, cycle first, then accounts in one order; two withdrawals of 600 against 700 cannot both pass. | Doubles are the second-time bug. |
| A contribution lowered by hand, then its account entry reversed | Refused (`CONTRIBUTION_ALREADY_LOWERED`): the contribution would go below zero. | Never a negative contribution. |
| Dates | Today in Cairo when left out; never later. | §7a. |

## 9. The ledger

**Financial history is never rewritten** (BRD §10). A correction is a balancing
entry that points back at the original; nothing is edited or deleted.

- Reversing twice is refused — two balancing entries double-count the correction.
- A reversal cannot itself be reversed.
- An entry raised by a flow (a settlement payout, a sale's revenue, a payment)
  cannot be reversed on its own, or the ledger and the record it describes stop
  agreeing. Those have their own reversal paths.
- A reason is required, and every reversal is audited.

**Buying stock is not an expense.** It converts cash into inventory and becomes
a cost when the goods sell. Goods and shipping are already capitalised into
landed cost, so only other outflows count as period expenses — and goods lost
on the way (§2), which are not a ledger entry at all.

**DECIDED 2026-10-10 — a loss is not money moving.** *Built 2026-10-11 (B2, B3).* The cash for
the goods left when they were bought, so marking them lost moves no money and
writes no ledger entry. The loss is its own record, and profit — on the
settlement and on the dashboard, read through one shared definition — subtracts
it.

**Cash flow is reported separately from profit** (BRD §11).

**Guess 2026-10-11 (L5, open until confirmed) — a transfer of leftovers between
cycles is a ledger pair, not money.** Moving leftover stock to another cycle at
its cost (§8) writes a `cycle_transfer` INFLOW on the giving cycle and the same
OUTFLOW on the taking one. They net to zero across the
business and are left out of cash in, cash out and cash on hand
(`NOT_CASH_CATEGORIES`, `common/cash-position.ts`), and out of every expense and
profit figure (`CAPITALISED_CATEGORIES`). Undoing the move writes the mirror pair.

**DECIDED 2026-08-22 — the ledger records money as it is received, not as it
is earned.** Confirming a sale raises no ledger entry; a payment does. Revenue
was previously booked at both points, so 31,200 of orders produced 72,710 of
ledger revenue.

The sale is not lost by this — the order records it — and the difference
between the two is money still to come. The dashboard shows all three side by
side, because a strong month of selling and an empty till look identical if
only one figure is given:

| Figure | Means |
|---|---|
| Revenue | what has been sold |
| Collected | what has actually arrived |
| Receivables | the gap: sold, not yet paid for |

Note the two are separated by a step: a payment adds to Collected when it is
recorded, and reduces Receivables when it is **allocated** to an order. Both
the customer's page and a payment recorded against a chosen order (§7) do both
in one action.

**DECIDED 2026-10-11 (owner, mockup accepted) — a manual entry can't lie.**
*Built 2026-10-12 (L6): API, form, unit tests and the browser e2e (spec 99-ledger-entry, 34 TC-INV-54..58).*
The ledger's "New Entry" form offered system types like Purchase, a free-text
category, an Inflow/Outflow radio, a free-text cycle id and no date, and
`POST /ledger` saved whatever it was sent — a partner could write `purchase`,
`contribution` or `settlement` in either direction and silently move cash,
profit or a settlement. Now "Record money in or out":

- **Two kinds, and the kind sets the direction.** *An expense* (money we spent:
  out) or *other income* (money in that isn't a sale, a customer payment, a
  contribution or a refund: in). There is no direction to choose.
- **Categories come from one fixed list**, `common/manual-ledger-categories.ts`,
  which the API validates against and the web form and the ledger's category
  filter offer (the web holds a copy only because Next cannot import across apps;
  a test fails if they differ).
  - Expense: rent, salaries, utilities, transport and delivery, fuel, packaging,
    marketing, bank fees, customs and clearance, extra freight (for a cycle), other.
  - **Fuel** (added 2026-10-17, owner: fuelling the delivery car is a regular expense). A **Fuel** quick-action
    button (core partners, who alone may write the ledger) opens this same form in place already on Expense → Fuel,
    dated today, no cycle; only the amount (and a note, if wanted) is typed. No cycle means it is a running cost,
    shared by the partners at settlement like rent (§8, L7); charge it to a cycle by picking one. Not automatic:
    fuel is a different amount each time, so a schedule would record figures nobody paid.
    **It lives on the Ledger page only** (owner 2026-10-18: "remove fuel from dashboard"): a labelled "Quick
    actions" strip under the page title — set apart from Add entry and Export, which stay the page's toolbar —
    shown to core partners only, same form, same refresh. History: it began on the dashboard (2026-10-17), was
    added to the ledger page on 2026-10-18, and left the dashboard the same day.
  - Other income: other income, interest, other.
- **Refused by the server**, each with a code in both languages: any other
  category (`LEDGER_CATEGORY_NOT_MANUAL` — every system category, free text,
  wrong case), a category of the other kind (`LEDGER_CATEGORY_WRONG_KIND`), a
  direction or type that disagrees with the kind (`LEDGER_DIRECTION_MISMATCH`,
  `LEDGER_TYPE_NOT_MANUAL`), an amount of zero or less, a foreign currency
  without a rate above zero, pounds at a rate other than 1, a day that is not a
  real calendar day or has not arrived in Cairo, and any field a flow sets
  (`relatedType`, `reversalOfId` — refused as unknown fields).
- **Charge to a cycle** is optional; **extra freight requires one** — a late
  freight charge is a cost of that cycle's goods (§2). The cycle must exist (a
  404, never a 500, for an unknown id or a cycle code typed in its place) and
  must not be cancelled or closed (`LEDGER_CYCLE_NOT_OPEN`). A cycle in
  settlement still takes a late cost.
- **Core partners only**, as before; the office reads the ledger and does not
  write it. Reversing stays core partners only.
- **The date** is its own column, `occurred_on`, the Cairo day the money moved;
  today by default. Rows written before this have none and show when they were
  entered, as they always did.
- **A reversal is dated the day it is undone** (Cairo), not the original's day, and carries the original's
  foreign amount and currency so both rows read the same money.
- **Old rows keep working.** A free-text category written before this shows as
  written, still counts as it did, and can still be reversed.

What each counts as — one definition each in `common/ledger-categories.ts`,
read by settlement, the cycle's profit and the dashboard alike (rule 11):

- **A manual expense is an operating expense** — the dashboard's Expenses —
  because `NOT_OPERATING_EXPENSE` does not list it (`operatingExpenseEgp`).
- **Charged to a cycle, it comes off that cycle's profit** on the settlement
  *and* on the cycle's page and Analytics. Found while building this: settlement
  already charged a cycle-linked expense, the cycle profitability did not, so the
  two showed different profits for the same cycle. They now agree; the cycle
  page shows "Expenses charged to it".
- **Other income raises net profit but is not Revenue** — shown on its own, like
  recoveries (`totalOtherIncomeEgp` on the dashboard figures). Credited to a
  cycle, it raises that cycle's profit on the settlement and the cycle page.
- **A reversed entry stops counting.** Found while building this: every reader
  summed only the outflows, so a reversed expense stayed in Expenses for good, and
  undone income (money out under an income category) would have counted as an
  expense. Both now net through the signed readings.
- **Reversing an entry charged to a closed or cancelled cycle is refused** — its
  profit was settled and paid on the figure as it stood.

**FIXED 2026-10-12 — a sale return is not an expense.** A return already comes
off Revenue (the dashboard subtracts its refund from the realised orders), but
its two ledger rows — the sale undone (`revenue` going out) and, for a cash
refund, the cash handed back (`refund` going out) — were also counted in the
dashboard's Expenses, so a 300 cash refund took 900 off net profit. Sales
categories (`SALE_CATEGORIES`) are now outside operating expenses through the
one definition. Settlement and the cycle profitability were not affected: a
return's rows carry no cycle.

**FIXED 2026-10-12 (L7) — cash on hand counts only cash handed back.** The sale undone (`SALE_RETURN`) moves no money, so cash on hand, cash in and cash out leave it out (`NOT_CASH_TYPES`, through `common/cash-position.ts`); the cash refund (`REFUND_PAID`) is still cash out. A 300 cash refund lowers cash by 300, a credit-note return by nothing. By type, not category: `revenue` is also a customer's payment coming in, which is cash.

**FIXED 2026-10-17 — an entry that was undone is not cash, and neither is its undo.** A lender's payment entered at 6,509.86 AED, undone and entered again at 8,302.60 AED put 90,161.56 into both cash in and cash paid out (cash on hand, where the pair cancels, was right). An undone entry and the row that undoes it record a mistake and its correction, not money moving, so cash in and cash out leave both out (`common/cash-position.ts`). Every undo mirrors its entry's full amount, so cash on hand is unchanged. Any later correction is covered by the same rule. Active cycles counts neither closed nor cancelled cycles (`CLOSED_CYCLE_STATUSES`); it read closed alone.

Guesses made while building it (2026-10-11, open until confirmed):

- **Foreign money is stored in pounds.** `amount` is the pounds figure (amount ×
  the rate entered, to the piastre) with currency EGP, because the settlement and
  the dashboard sum `amount` as pounds; what was actually paid is kept beside it
  (`original_amount`, `original_currency`) and shown on the entry. Recording the
  foreign figure as `amount` would have been summed as if it were pounds.
- **Income "Other" has its own key** (`income_other`), distinct from the expense
  "Other" (`other_expense`), so the category alone says which kind a row is.
- **Other income on the dashboard** is added to net profit and returned as its
  own figure; no separate tile was added (recoveries have none either).
- **A cycle in settlement still takes a late cost**, per the rule as given (only
  cancelled and closed are shut). Approving or paying a settlement after such an
  entry uses the figure as it then stands.
- **The ledger's date filter still reads when an entry was entered**, not its
  `occurred_on`.

---

**Money accounts — removed 2026-10-14 (DECIDED by the owner: "we don't need
money accounts").** The ledger records what moved, how much, when and for which
cycle — never which box or bank it moved through. The `money_accounts` and
`reconciliation_entries` tables, and the account link on ledger rows and on a
friend's repayments, were dropped (migration
`20261014120000_drop_money_accounts`). Production's two accounts (Business Bank
Account, Home Storage Room Cash) had already been deleted and nothing pointed at
them; the migration refuses to run, changing nothing, if a ledger row, a
repayment or a reconciliation entry still names one. `GET /ledger/accounts` is
gone (a 404), the ledger shows no Account column or line, and a body that names
an account — a repayment's included — is refused as an unknown field
(`VALIDATION_FAILED`). No seed creates one. Spec 34 TC-INV-38, 99-ledger-entry
TC-L6-08.

## 10. Notifications

**V1 is in-app only**, as the BRD scopes. Email and WhatsApp are deliberately
out. (Superseded in part 2026-10-18: every in-app notification is also pushed to
the partners' phones — below. Email and WhatsApp are still out.)

Raised on: low stock (after a receipt, and since 2026-10-11 after a sale that
takes a product into low stock — §3), a shipment arriving, a cycle created or
changing state, a purchase order created, a partner added to a cycle, an
instalment falling behind (checked daily since 2026-10-11 — §7), and samples
still at a shop 14 days after they were left (daily, once per order, since
2026-10-18 — §4 "Samples at shops").

**What one partner did reaches the others — DECIDED 2026-10-25 (owner), built 2026-10-25.** "a sale and payment
should trigger notifications as well", then "yes i want them add" for returns, reversals and cancellations. Found when
Fares recorded a sale and the owner was not told.

- Raised on: a sale confirmed (one-step, walk-in, a draft confirmed, samples bought), a payment recorded, a return, a
  payment reversed, and a **confirmed** order cancelled. A draft is not news, and neither is cancelling one.
- Read by every active core partner except the one who did it — not an investor, not an inactive login. Each says who
  did it (the partner's name, else the login's email).
- What each says: the sale — shop, order number, total; the payment — amount, shop, method, the orders it went on; the
  return — reference, shop, order, products and units, refund and whether it came off what they owe or was paid in
  cash, the reason; the reversal — amount, shop, reason; the cancel — order number, shop, what it was worth.
- The walk-in's payment is part of its sale, so a walk-in is one notification, not two.
- Raised after the commit through `NotificationsService`, so the push follows (below). A failure is logged and never
  fails the sale, payment or return. One place: `common/partner-news.ts`.
- The assistant and the office chat record through the same services, so they notify the same way.
- GUESS 2026-10-25, not asked: a tap opens the order on Sales for a sale, return or cancel, and Payments for a payment
  or reversal. The payment method is said in the reader's language (bell and push).

**Every office notification is also pushed to the reader's phone** — built
2026-10-18, after the owner's test sale took a product below its minimum, the
bell rang on the desktop and his phone (alerts on, test alert arriving) stayed
silent. Until then only the storefront's requests were ever pushed; every other
notification was only a row.

- DECIDED (as before): the row is the record, the push an attempt. It is
  written first; a push that fails, times out or finds no device loses nothing
  and never fails or rolls back what raised it. It is sent after the commit,
  never inside a transaction.
- The words are the bell's own (`renderNotification` for the stored code), and
  a tap opens the page the bell links to (`/notifications/open`, which asks the
  bell's mapping). A device the push service calls gone (404/410) is forgotten.
- Bounded: every device is tried at once, each gets 2.5 s, the whole delivery
  3 s, so a slow push service cannot hold a sale's response for longer.
- **GUESS 2026-10-18, not asked — the language.** Nothing records which language
  a partner reads (no user, session or device stores one), so a push with no
  stored language goes out in **Arabic**, the business's language — the office's
  included, and the storefront's office alerts too, which were English before.
  The office app itself still opens in English. When a tap opens the app it uses
  the language of a window already open, else the push's. If a partner wants
  English pushes, the fix is to store the language with the device when alerts
  are turned on (the page knows it then).
- GUESSED: a new alert about the same thing replaces the earlier one on the
  phone rather than stacking. The push's tag is the bell's link for it
  (`bellLink` in `common/notification-messages.ts`: the event plus the payload's
  plain string and number values), so "the same thing" is the same event with
  the same values; the storefront's request alerts set their own tags
  (`order-request-<id>` and the like).
- Push needs `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` on the API (set in
  production 2026-10-16); with either missing, push is off with a warning in the
  log and the bell still works. `VAPID_SUBJECT` defaults to a placeholder
  mailto (`push.service.ts`).

---

## 11. Money and rounding

- Monetary values are `NUMERIC(18,2)`, unit costs and FX `NUMERIC(18,4)`,
  quantities `NUMERIC(18,3)`.
- All arithmetic uses decimals, never floating point. A float rounding drift in
  COGS would quietly misstate every settlement.
- Everything reports in EGP. Foreign amounts convert at the rate recorded on the
  document.
- Displayed money always carries thousands separators and two decimals, and
  stays left-to-right in Arabic.

---

## 12. The customer storefront

DECIDED 2026-08-30. A shop owner browses a public catalogue, asks to buy, and
the owner approves. Design in
`docs/superpowers/specs/2026-08-30-customer-storefront-design.md`.

**Who sees what price.** The catalogue is public and quotes retail. A shop that
has been verified sees the price for its own customer type — trade, for a B2B
shop. An unverified account sees retail: nothing has been agreed with them yet,
and showing the wholesale list to whoever fills in a signup form gives it away.

The channel is resolved once, on the server, from the token. Every surface that
shows a price — the card, the product page, the basket, the resulting order —
is handed the price already resolved. No screen chooses.

**Stock is a band, never a count.** In stock, low, or out. A public page saying
"12 left" tells a competitor the exact position, and a shop needs only to know
whether it is worth asking.

**A request holds the stock behind it, for 48 hours.** Submitting sets the units
aside so a second shop cannot be promised the same ones. When the 48 hours pass
the units go back on the shelf and the request stays answerable — expiry is not
a decision, it only stops an unanswered request from costing anything while it
waits. Approving after expiry re-checks what is actually there and refuses if it
has gone.

The deadline is the rule, not the sweeper: a hold past its time is ignored when
availability is calculated, whether or not the job that releases it has run.

**Approving can change what was asked for.** Quantities can be reduced and lines
dropped — ten asked for, six in stock, so six approved and the shop is told why.
What is approved becomes the order. Approving for *more* than was requested is
refused: the shop would be billed for goods it never asked for. Approving
nothing is refused too, because that is a decline wearing a different word, and
a decline must carry a reason.

The price the shop was shown when they asked is recorded on the request. A price
that moves in between does not change what they believed they were asking for;
the approval screen shows both.

**Approving below cost warns (2026-10-11, L4).** The approval screen checks the
lines as they would be approved — the quantities and prices on screen — against
what their goods cost now (§4), per line and in total, and Approve still goes
through. Only the office sees it; the shop is never shown a cost.

**An order request is not a sale order.** Separate records. Outstanding
balances, analytics, payment allocation and settlement projection all read sale
orders, and a request living among them as a status would mean every one of
those has to learn to exclude it.

**A signup becomes an unverified customer.** The owner chose this over a
separate pending queue, knowing it lets a stranger create a row in the table
that orders and balances hang off. Contained rather than argued: unverified
customers are filtered out of the Customers list by default, and an order
request, a payment and a payment plan are all refused against one. A spam row
can exist; it can never touch money.

**An unverified shop may ask for an import, but not for an order.** DECIDED
2026-08-30, by me rather than asked — recorded here so it is not a quiet one.
An order request holds stock, and a hold is a promise; nothing has been agreed
with an account nobody has looked at. An import request holds nothing and
promises nothing, so it is how a shop that signed up an hour ago starts a
conversation instead of sitting in a queue with nothing to do. Reverse it if
that is wrong — the check is one line in `import-requests.service.ts`.

**A photograph belongs to the shop that sent it.** A customer's import-request
photos are served through a portal route that resolves the asset through the
request, so the ownership check is the one that already found the request. The
public catalogue image route refuses anything not attached to a product, and
another shop asking for a photo gets a 404 rather than a 403 — it should not
learn that the request exists.

**Who may be a participant on a cycle.** DECIDED 2026-08-30, after finding a
shop owner sitting on three cycles — one as a CORE_PARTNER with a 5,000
contribution, which is a share of the partners' profit at settlement and every
cycle notification with everyone's figures in it. Nothing had ever checked: the
participant row took any user id the foreign key accepted.

A core partner may also come in as a temporary investor on the same cycle,
because putting extra money in beside your own share is a real thing an owner
does. A shop account can be neither. An office account with no stake can be
neither. `RolesGuard` answers who may *call* the endpoint; this answers who the
call may *name*, and only the first question was being asked.

**Who may read the audit log.** DECIDED 2026-10-10 (U4c). Core partners and
admin support — the roles that already list sales, payments, the ledger and
settlements. Every audit row holds the full before and after of what changed,
so it is those same books in another shape; a temporary investor or a shop is
refused (`ROLE_NOT_ALLOWED`). Before this the endpoint named no roles and any
signed-in account could read it.

**The audit log is readable — built 2026-10-18 (owner).** Each row from `GET /audit-logs` and
`GET /audit-logs/:id` carries `entityLabel` (and `entityLabelAr`, `entityHref`): the record's own number or name —
an order's ORD number, a cycle's code, a product's name and SKU, a lender's name, a payment's reference or shop with
its sum — and the office page that shows it, looked up with one query per record type on the page
(`modules/audit/audit-labels.ts`). A record that no longer exists gets no label and the screen shows the type's
name, never the id. The detail shows **what changed**, one `Field: old → new` line per field that differs, names
translated, money and dates formatted, ids hidden (`components/audit/audit-changes.tsx`); a create lists what was
set, a delete what was removed. A **Who** filter lists the office's people by partner name (email when there is no
partner record), kept in the address as `?actor=`; an action with no actor reads System, an actor nobody has any
more reads Former user. `actorUserId` that is not a uuid is `VALIDATION_FAILED` (400), a uuid that is no user 404.
Search (through the shared list toolbar) matches the record's name and the person's; the record-type filter offers
the types the API writes.

**The menu shows a role what it may open.** DECIDED 2026-10-10 (U4c). An
entry is shown exactly when the endpoint its page lists from lets the role in;
the menu copies the controllers' `@Roles` rather than deciding anything itself.
Since R1 (below) a temporary investor sees the dashboard (their own cycles),
the importing and catalogue pages (scoped to their cycles), settlements (theirs,
with their own line), notifications and settings — and not analytics,
customers, payment plans, order or import requests, sales, payments, the
ledger, partners or the audit log.

2026-10-18 (owner): only the three partners use the office app — no investor has access, though nothing stops an
investor account from signing in (the office login refuses only shop accounts, `USE_PORTAL_LOGIN`). The sidebar
went from 21 entries to 13 by making related pages tabs of one page (`apps/web/src/lib/page-views.ts`); the tabs
carry no role checks, while the sidebar, More and the phone bar still hide the books entries from roles other than
core partner and admin support (`components/layout/nav-model.ts`). The investor rules in this section and R1 below
are built and enforced by the server; they describe nobody who uses the app today.

**DECIDED 2026-10-19 (owner), built 2026-10-20 — an investor cannot sign in to the office.** "No investor account
can sign in to the office app ... only the three partners use it." `POST /auth/login` refuses a temporary investor
with `OFFICE_NOT_FOR_INVESTORS` (401), after the password is checked, so the page cannot be used to learn what kind of
account an email is; `/auth/refresh` ends every sign-in an investor holds (`SESSION_INVALID`), so a partner whose role
is changed to investor is signed out at the next refresh; a password change hands an investor no refresh token. Who may
hold an office sign-in is one function, `mayHoldOfficeSession` (`modules/auth/session-tokens.service.ts`). The
investor stays a participant on the cycles they funded (§8), and every server-side role guard stays as it was (CLAUDE.md
§12). The investor's own dashboard ("your cycles", R1) was removed as unreachable; a role the business figures refuse
now sees only the Dashboard title. Guesses, open until confirmed:
- **Admin support still signs in.** The owner named investors; support is a role the code knows and nobody holds.
- **An inactive investor is told it is the wrong door**, not that the account is inactive (the role is asked first).
- **An investor's access token issued before this change keeps working until its hour ends**; the role guards still
  refuse it everything they refused before. The access token is not checked against the door on every request.
- The assistant's OAuth sign-in already took core partners only (§16); unchanged.

**DECIDED 2026-10-10 by the owner — a temporary investor sees only their own
cycles.** *Built 2026-10-11 (R1, R1b, R1c).* The cycles they put money into, and for each: their
contribution, the cycle's costs, deliveries, losses, profit and settlement, and
their own payout. Nothing else: no customers or balances, no payment plans, no
returns, no business-wide revenue, cash or profit, and no other cycle. This is
enforced by the server on every read — a menu that hides a page is not a guard
(rule 12) — so every list and figure an investor can reach is scoped to the
cycles they participate in, and anything outside them is refused with a code or
simply absent from the list.

*Built 2026-10-10 (R1).* One definition, `common/investor-scope.ts`. Another
cycle's id answers 404 — as if it did not exist — not 403. On a shared cycle an
investor sees the cycle's totals and their own participant row and settlement
line, not another participant's contribution or payout. **Guesses, not yet
agreed** (per-endpoint list in `docs/build-log/waves/arrivals-and-ux/R1.md`):
suppliers and providers are shown only where one of the investor's cycles used
them; the product catalogue, categories and currency rates are shown whole, as
shared reference data, but without each product's supplier links; a customer's
request photo is not served to an investor.

Found while scoping, and fixed: adding or deleting a product photo was open to
any signed-in account and is now core partners only; a cycle's participant list
was sending each person's password hash and no longer does.

**Recent activity on the dashboard** (2026-10-10). The latest real events,
newest first: confirmed sales (dated by their order date — no confirmation time
is stored), payments that were not reversed, and stock received. Drafts never
appear; cancelled and fully returned orders do not either. Core partners and
support see it; an investor's dashboard shows their own cycles instead.
Removed 2026-10-17 (owner: "remove the recent activities table from
dashboard"). The panel and its endpoint (`GET /analytics/recent-activity`) are
gone; the office dashboard is the figure tiles, then To collect beside Top
products. Each kind of event still has its own list: Sales, Payments, Inventory.

**The dashboard, 2026-10-17/18 (owner).** Quick actions: New sale, Record payment, New cycle. **Fuel** left
the dashboard on 2026-10-18 (owner: "remove fuel from dashboard"); it is recorded from the Ledger page's quick
actions only (§9).
On a phone every figure tile keeps its icon (superseded 2026-10-23, below: six showed, then "See more").

**The dashboard in two groups — DECIDED 2026-10-23 (owner, picked from a rendered sample), built 2026-10-23.**
The owner asked "are the data filtered or all time, like net profit?": thirteen equal tiles mixed all-time and
right-now figures with nothing saying which. Now two headed groups:
- **Right now** first — Cash on hand, To collect (what customers owe today, the old Receivables), Owed to lenders
  (with its per-currency line), Stock value (the product page's word since 2026-10-22, the same
  `common/stock-value.ts`), Items in stock, Low stock alerts, Active cycles. Wide: a row of four, then a row of
  three, each filling the width.
- **This month** second — Revenue, Collected, Net profit, Expenses for **this calendar month in Cairo, from its
  1st to today**, with a "Profit and loss →" link to Analytics on This month (`/analytics?period=month`). The
  figures are `GET /analytics/dashboard`'s `month` block, computed by `profitFigures` for exactly the days
  Profit and loss's This month asks for (`thisMonthPeriod`: the 1st to today, which is what the API caps P&L's
  "1st to the month's last day" to) — one definition (rule 11), so the two net profits agree to the piastre.
  The all-time fields stay in the response (the assistant's `get_dashboard` reads them, and now `month` too).
- **Cost of goods sold and Cash paid out left the dashboard** for Analytics' Profit and loss: COGS is the Sales
  tile's second line and a line of "How it adds up", as before; Cash paid out is a new figure under "How it adds
  up", for the selected period, set apart from the arithmetic with a note that it is not a cost
  (`cashOutEgp` from `common/cash-position.ts`, the dashboard's old `totalCashOut` reading, cut to the period's
  ledger days by `ledgerDayWhere`).
- **Phone:** Right now first, then This month. Shown: the first four Right now tiles and the four of This month;
  Items in stock, Low stock alerts and Active cycles wait behind "See more (3)". Seven in two columns leave one
  alone, so Active cycles takes the row. Every tile keeps its icon and links where it did.
- GUESS: **This month's Collected** is payments not undone whose received day (`receivedOn`, a Cairo calendar
  day) falls in the month — the all-time Collected's reading cut to the month. Profit and loss shows no
  Collected, so there is nothing on Analytics to compare it with.
- GUESS: **Cash paid out for a period** is the money-out rows whose ledger day (`occurredOn`, else the Cairo day
  entered) falls in it; an entry undone and its undo are left out together whatever periods they fall in, as
  the all-time figure does. Shown inside "How it adds up" (folded) rather than as a fifth tile.
- GUESS: "a row of four then a row of three" applies once the group is at least 68rem wide (a 1440 screen with
  the sidebar); narrower — a 1280 laptop — four figures do not fit on one line beside their badges, so the
  groups stay two to a row (Active cycles spanning the last). From 68rem to 76rem the figures are a size
  smaller so "669,584.64 EGP" stays on one line. English labels are in sentence case (Cash on hand, Net profit,
  Low stock alerts, Active cycles), as the owner wrote them.
- GUESS: an API without the `month` block makes This month read zeros, never the all-time figures under a This
  month heading. Arabic headings "الآن" and "هذا الشهر"; "النقد المدفوع" for Cash paid out on Analytics — the
  agent's wording, not the owner's.
**Top products** rank by **units sold** (default) or **revenue**, a switch on the dashboard card and on
Analytics' table, remembered on the device; `GET /analytics/top-products?by=units|revenue` (default revenue
for other callers), returns netted out, ties broken by the other measure then the name. The card shows the
ranked figure first with a bar against the top seller ("how is 21 sold on top of 28?" — it was ranked by
revenue while showing units).
**Analytics shows the top five — DECIDED 2026-10-19 (owner: "show only top 5"); the zero-sales rule and the
cycle tie-break GUESSED.** Top products: the five best by the switch that is on, in the API's ranking above
(`?limit=5`); a product that sold nothing net of returns (units sold 0) never takes a place, so fewer than five
sold means fewer rows, and none sold is the empty state. Cycle profitability: the five most profitable cycles,
highest profit first, equal profit by code; the API still sends every cycle in code order (the dashboard and a
cycle's page read that full list), so the ranking and the cut are the web app's (`components/analytics/analytics-top.ts`).
The dashboard's own Top products card is unchanged.

**Summary cards at the top of Cycles, Products and Sales — owner 2026-10-18 ("a few simple summary cards … about that
tab"); built 2026-10-20, the choices below GUESSED.** One shared strip (`components/ui/summary-strip.tsx`, cards in
`components/summary/tab-summaries.tsx`), at most three cards, nothing drawn when there is nothing to show, skeleton
cards while loading. Every figure is an Analytics figure, picked with Analytics' own rules
(`components/analytics/analytics-top.ts`); the browser sums nothing (rule 11).
- **Cycles:** the three most profitable cycles from `GET /analytics/cycle-profitability`, highest profit first, equal
  profit by code. A cycle with a loss or zero profit is not "top-earning" and takes no card (GUESS).
- ~~**Products:** the three best sellers by units.~~ Replaced 2026-10-22 (owner: "remove the cards on top in the
  products tab"), below.
- **Sales:** two cards from `GET /analytics/top-orders` (core partners and support), both **all time** whatever the
  list's date filter (GUESS). *Most revenue:* the realised sale (Confirmed, Partly paid, Paid) whose total less its
  refunds is highest. *Largest order:* the sale with the most units, net of returned units (GUESS: units, not lines),
  how many kinds of product it holds shown (owner 2026-10-22: "products instead" of lines). Ties fall to the other measure, then the order number (GUESS). A sale with nothing left after
  returns is never picked; drafts, cancelled and samples orders never are. One sale may fill both cards (GUESS). A card
  opens its order.

**The tabs' cards, reshaped — owner 2026-10-22, built 2026-10-22, the choices below GUESSED.** Every card wears the
dashboard tiles' icon badge, in the dashboard's colour where it shows the same figure ("all cards need icons like in
dashboard"); on a phone the badge sits above the label, as on the dashboard.
- **Products and Inventory:** the same two cards — *Products*, the active products (the dashboard's Products count,
  GUESS: active only), and *Units in stock*, every batch's remaining quantity summed (the dashboard's Units in stock).
  `GET /analytics/stock-summary`; both read the dashboard's own definitions (`productCount`, `unitsOnShelf` in
  `analytics.service.ts`). A count of 0 is shown, not hidden.
- **Customers:** *Customers*, every customer but the shared walk-in record (the dashboard's count), and *Paid the
  most*, the customer whose payments standing (a reversed one paid nothing) add up highest, all time, opening that
  customer; ties by name (GUESS). Nobody has paid: the count alone. `GET /analytics/customer-summary`.
- **Payments:** *Largest payment*, the single largest payment standing, all time, with who paid it, its day and
  method, opening the customer (a walk-in buyer's says Walk-in and opens nothing); a tie falls to the earlier one
  (GUESS). `GET /analytics/payment-summary`.
- All three endpoints: core partners and support, as the rest of Analytics.
- **The ledger's By column:** who recorded each row — the partner's name, else the login's email; "—" for a row from
  before anyone was recorded. In the CSV export too.

**Profit and loss on Analytics — DECIDED 2026-10-18 (owner, mockup approved), dates GUESSED from how the
dashboard already counts.** "A proper place to see total net profit, with time, and with expenses and sales as
summary, not details." At the top of Analytics: a period (This month — the default since 2026-10-20, owner
2026-10-19; All time was the default until then — · Last month · This year · All time, `?period=all` · Custom days,
kept in the address as `?period=` / `?from=&to=`; an address naming a period always wins, an unknown one is This
month), net profit large with its share of
sales, the summary Sales − Cost of goods sold = Gross profit, − Expenses, then Recovered, Other income and
Exchange difference only when not zero, = Net profit; expenses by category (one total each, largest first,
goods lost on the way as its own line); net profit by month (superseded 2026-10-18 by Option A below: one chart in
day, week or month buckets). `GET /analytics/profit-and-loss?from=&to=`
(core partners and support, as the dashboard).
- **One computation** (rule 11): `AnalyticsService.profitFigures(period?)` is the dashboard's revenue, COGS,
  expenses and net profit, query for query; the dashboard calls it with no period, Analytics with one. All
  time is therefore the dashboard's figures exactly. Each month's bar is the same computation for that
  month's days, so the bars add up to the period (v1; superseded 2026-10-18 by Option A — the buckets are
  `profitParts` split per bucket and added up by `figuresOf`, below); the category split reads the same rows as the Expenses line
  (`expenseWhere`) through the same signed reading, so it adds up to it.
- **Which day each figure belongs to** (Cairo days, both ends included):
  - a sale's revenue and the cost of what it sold: the sale's day (`orderedAt`), as Revenue by month and the
    sales list read it;
  - a return's refund and the cost it reversed: the day it came back (`returnedOn`) — as Revenue by month
    already does, so a reported month does not change;
  - a ledger row (expenses, recoveries, other income): the day the money moved (`occurred_on`), else the Cairo
    day it was entered — as running costs read it (§8); an undo is dated the day it is undone, so a September
    expense undone in October lowers October;
  - goods lost on the way: the day they were marked lost (the record's only date);
  - an exchange difference: the day of the repayment (`paidOn`).
- GUESSED: a `to` after today is today; a `from` after today is refused (`PERIOD_NOT_STARTED`) rather than
  answered with zeros; a reversed range `DATE_RANGE_REVERSED`, a malformed day `BAD_DATE`. All time's months
  start at the first day anything that counts was recorded. The share of sales is shown only when sales are
  above zero.
- **Redesign "Option A" — DECIDED 2026-10-18 (owner, mockup approved); bucket sizes and the week GUESSED.**
  Under the period: four tiles (Sales · Gross profit with its share of sales · Expenses · Net profit with its
  share, green from zero up and red below, "—" when nothing was sold), a "How it adds up" disclosure with the
  full Sales − COGS = Gross − Expenses ± Recovered / Other income / Exchange difference = Net list, one chart
  (sales as columns, net profit as a line, a loss point red), and the top four expense categories with the
  rest folded into "N more categories". The separate Revenue by month card is gone (its figures are the
  chart's columns); `GET /analytics/revenue-by-month` stays — no screen reads it now, but the API checks
  (TC-API-24, TC-ANA-01), the role and investor-scope suites and the walk-in suite still do.
  - **Buckets by length of the period:** up to 35 days a day each (this month, last month); 36–124 days a
    week each; longer a calendar month each (all time; this year from early May — This year runs 1 January to today, so it
    is daily through January and weekly from early February to early May). GUESSED, with the
    **week Saturday to Friday** — the week as an Egyptian calendar prints it, Friday its last day. Edge
    weeks and months are cut to the period. Every bucket is present; a quiet one is zero. Days are Cairo's.
  - **On a phone (below 640px) a by-day period is drawn by week** (owner 2026-10-19, mockup "Option 1"):
    the app adds the API's day buckets into the same Saturday–Friday weeks, cut at the period's edges,
    summed in piastres, so the weeks equal their days and the totals. The week still running is labelled
    "today". Tapping a week opens its days (sales and net profit each, losses red, the week's total). The
    desktop keeps the days; by-week and by-month periods are the same on both. No second server path.
  - **The buckets add up to the totals exactly**, because both are the same parts: `profitParts` reads every
    source once for the period (twelve queries however many buckets — asking `profitFigures` per bucket had
    cost twelve per bucket, 26 for a month by month, would have been 372 by day), each row put on its day by
    the rules above, and `figuresOf` adds up a bucket the way it adds up the period. The dashboard reads the
    same filters summed by the database (`itemised` false), so its figures are unchanged, query for query.
  - All time runs from the first day anything that counts in profit was recorded (a purchase alone no
    longer starts it — it counts nowhere in profit). A row dated after today (check-data 25) still counts
    in all time's totals, so the buckets run on to its day rather than drop it.
  - A samples write-off with no recorded moment (none should exist) falls on its order's day.
  - **Cash paid out — added 2026-10-23 (owner), when it left the dashboard.** Under "How it adds up", apart
    from its lines: the money out of the ledger in the period, stock bought included — not a cost and not in
    net profit (`cashOutEgp`, `common/cash-position.ts`). It costs two queries, so a period is fifteen.

**Notifications are recorded first and delivered second.** Every event writes a
notification row, then attempts a push. A push that fails must never mean a lost
notification, and a shop on an iPhone gets no push at all until the app is added
to their home screen.

**Requests in the office: one page, hidden in production for now.** DECIDED
2026-10-17 (owner: "import requests and order requests can be in one tab, and I
want them to be hidden in prod for now"). Order requests and import requests are
two tabs of one office page, Requests (`/requests`, `?view=imports` for the
second), with one menu entry in place of the two. The old addresses
`/order-requests` and `/import-requests` land on their tab.

In a production build the page is switched off: no menu entry, a request's
notification is plain text rather than a link, and `/requests` or either old
address goes to the dashboard. Local dev shows it. **Nothing about requests
themselves changes**: the API and the storefront are untouched, so shops can
still send order and import requests, an order request still holds its stock
for 48 hours (and releases it when unanswered), and the notifications are still
written. They wait, unanswered, and are all there when the page is switched
back on.

One flag, `apps/web/src/lib/features.ts` (`REQUESTS_ENABLED`):
`NEXT_PUBLIC_FEATURE_REQUESTS=on` on the web project in Vercel turns it on in
production (a redeploy applies it), `off` hides it everywhere, and unset means
off when `NEXT_PUBLIC_VERCEL_ENV` is `production` and on otherwise. **GUESSED,
not asked:** the old addresses keep working in dev rather than being removed;
the push alert the API still sends for a new request opens what the bell
would (since 2026-10-18, §10): the tab when the page is on, the notifications
list when it is off.

---

## Still open

These are **not decided**. The code's current behaviour is stated so nobody
mistakes it for an agreement.

| Question | What the code does today |
|---|---|
| How partners split a temporary investor's fee | Recorded against a named recipient participant; the split itself is manual. BRD §19 assumes equal but does not lock it. |
| Whether leftover stock can move from a closed cycle to general inventory | It cannot. Batches stay owned by their source cycle. |
| ~~Payment account and reconciliation workflow~~ | **DECIDED 2026-10-14 by the owner: none** — "we don't need money accounts". The accounts and the unused reconciliation table were removed (§9, "Money accounts — removed"). Kept here so the question is not raised again as open. |
| Late penalties or interest on overdue balances | None. Overdue flags and notifies only. |
| Whether a shop can pay a deposit before an order exists | It cannot — a payment above what is owed is refused. If prepayment is real here, it needs its own concept rather than a loosened rule. |
| A cycle's "investment" on Analytics after running costs | Analytics sums a cycle's money out as its investment, and that has always included the settlement payout rows. Since L7 a payout row is the cash handed over, net of the partners' running costs, so a paid cycle's investment reads lower by their share. Raised 2026-10-12 (L7); whether payouts belong in "investment" at all is the question. |
| Where the cash for lost goods shows in the ledger | Nowhere. Goods are booked into the ledger when they are received, so units lost on the way never appear in it, though they were paid for. Raised 2026-10-10. |
| Whether stock is held for an order request | §3 says reservations are not in use and reserved quantity is zero; §12 says an order request holds its stock for 48 hours. The two predate 2026-10-10 and disagree. Raised by the 2026-10-10 release review. |
| Blocking sales to a shop that is behind | Not blocked. Deliberate — see §7. |
| Whether a shop that is behind on payment may hold stock | It may. A request checks verification and stock, not the balance. Raised 2026-08-30 with the storefront; not decided. |

---

## Not yet safe to run the business on

Recorded here so it is not forgotten. Rewritten 2026-10-08, when the old list
no longer described the system.

- **Partner logins still use the seeded demo password.** Production is live,
  and the partner accounts open with the password from the seed data, which
  sits in the public repository. The assistant (§16) can write to the business
  through those same logins. Each partner changes theirs before relying on it.
  (Until 2026-10-14 Settings → change password failed every time, so this
  could not be done from the app; it can now — §20.)
  Superseded 2026-10-14: the owner emptied production and replaced the partner
  logins (abdallah@ / shady@ / fares@) with passwords he typed, through
  `scripts/prod-reset-partners.sh`. The seeded password remains only in local and
  demo seeds.
- **Backups have never been tested.** The database's host keeps a short window
  for restoring to an earlier moment. Its length depends on the plan and has not
  been checked, no restore has ever been tried, and no copy is kept anywhere
  else.
- **No real cycle has been confirmed through it yet.** Two cycles exist in
  production. Whether they are the business's own or a trial run is not
  recorded, so no figure from them has been checked against reality.
  Superseded 2026-10-17/18: production holds one real cycle, CYC-2026-0001,
  entered mid-cycle after the fact (the test cycle CYC-2026-0002 was deleted);
  its ledger was checked by hand 2026-10-18 and agrees with itself. Some of its
  figures are still stand-ins until the owner sends the data listed in
  `docs/BUILD_LOG.md` "Waiting on the owner".

Fixed since the first version of this list: it runs in production now, not on
one laptop. Production has its own login-signing secret, and the system refuses
to start with a default or placeholder one.

---

## 13. Open questions — the storefront

### Which language a shop owner gets  — DECIDED 2026-08-31

**The store opens in Arabic for everyone. English is a choice the reader
makes, not one their phone makes for them.**

The rule recorded on 2026-08-30 was "Arabic default", and what was built was
next-intl's ordinary behaviour, which is not the same thing: `defaultLocale`
is only the fallback, and `Accept-Language` beats it. Measured before the
change:

| the phone asks for | it landed on |
|---|---|
| Arabic | `/ar` |
| English | `/en` |
| French | `/ar` |
| nothing | `/ar` |

So a shop owner whose phone was set to English — common here, and often set
by whoever sold the phone rather than by its owner — got an English store and
might never have seen the Arabic one.

`localeDetection: false` in `apps/storefront/src/i18n/routing.ts`. Every
browser now lands on `/ar` whatever it asks for, and the language switch is
one tap away.

TC-STORE-18 pins it, using browser contexts that explicitly request `en-US`,
`en-GB` and `fr-FR`. TC-STORE-15 could not have caught this: it uses the
default context, which never asks for English, so it passed throughout.

### Where a shop sends its basket from  — OPEN, raised 2026-08-31

`<BasketLauncher />` is rendered only by the "My orders" page. A shop that adds
parts while browsing the catalogue sees "Added to your request" and then has no
visible way to review or send it without finding that tab.

`basket-sheet.tsx`'s own comment says the sheet exists "so a shop adding a fifth
part does not lose its place in the catalogue", which reads as the intent being a
launcher visible while browsing. **Not changed** — where a persistent basket
button belongs is a design decision, not a defect to fix quietly.

---

## 14. What "when stock arrived" means  — DECIDED 2026-09-09

**Two dates, shown separately on inventory and on the product page.**

| shown as | is | source |
|---|---|---|
| **Arrived** | when the delivery that brought this batch landed in Egypt | the batch's own delivery date (until 2026-10-10: the cycle's last dated leg) |
| **Received** | when it was verified into stock and became sellable | the batch's own creation |

They are routinely days apart — the reference seed has them five days apart —
and the gap is the useful part: a wide one is stock that sat somewhere before
anybody booked it in. Collapsing them into a single "arrived" would hide
exactly that, so both are shown.

**Arrived is the last leg, not the first.** A CHINA cycle runs
China → UAE → Egypt, and leg 1 arriving is a box in a Dubai warehouse, not
stock a shop can buy. Reading `shippingLegs[0]` would look correct against
every UAE_DIRECT cycle and be wrong for every China one — which is most of the
business. TC-ARR-02 pins this with a two-leg cycle whose legs are dated three
weeks apart.

**Arrived is reliable, not hopeful.** The API already refuses to advance a
cycle whose leg carries no arrival date (`LEG_NOT_ARRIVED`), so stock cannot be
received from an undated leg at all. The screens still handle a null — a cycle
with no legs, or data predating that guard, reaches the same place — and say
"Not dated" rather than showing a dash, because a dash reads as "no data" when
it means "nobody entered it yet". TC-ARR-03 pins the refusal.

Both screens read the same `/inventory` endpoint, so there is one definition of
arrival rather than two (rule 11). TC-ARR-05 asserts they agree.

**DECIDED 2026-10-10 — each batch has its own arrival.** *Built 2026-10-11 (B3).* With
deliveries (§1), Arrived is the date of the delivery that brought the batch into
Egypt, not the cycle's last leg date. Two batches of one product from one cycle
can show two dates. Still the last leg, never the first.

---

## 15. When a purchase order stops being a draft  — DECIDED 2026-09-09

**A purchase order is confirmed when its cycle leaves PURCHASING.**

`PURCHASING -> IN_TRANSIT` and `PURCHASING -> ARRIVED_UAE` both mean the goods
are moving, so the order was placed in the world and can no longer gain lines.
`PURCHASING -> CANCELLED` confirms nothing: a cycle that was abandoned never
ordered anything.

**Why this needed deciding.** Orders were created `DRAFT` and *nothing* moved
them out of it — no endpoint, no transition. Only the demo seeder ever wrote
`CONFIRMED`, which is why a seeded database looked correct and every real one
was wrong. Found by the production audit (TC-AUD-06), not by any feature test.

The label was never the point. `addItem` refuses on a non-DRAFT order — "can
only add items to a DRAFT purchase order" — and with nothing leaving DRAFT that
guard had never once fired. Lines could be added to an order **after its stock
was received and its landed cost computed**, which is the shape of the money
bugs the working rules were written after.

Historical cycles that passed PURCHASING before this rule existed are holding
drafts the transition will never revisit. `scripts/confirm-stranded-orders.sh`
reports them and confirms them with `--fix`. Only the status changes; no line is
touched, because the cycle's own history already implies the order was placed.

### `CANCELLED` was not a real status  — FIXED 2026-09-09

Cancelling any cycle returned "An unexpected error occurred". `CANCELLED` was in
the transition machine, in the office app's copy of it, in the badge colours and
in both locale files — and missing from the `CycleStatus` enum, so the write
failed at the database. Added, with a migration. TC-PO-04 covers it.

### A supplier's invoice is recorded once  — DECIDED 2026-09-19, built 2026-09-25

**The same supplier invoice cannot become two purchase orders.** A purchase order
may carry the supplier's own invoice number; when it does, that number is unique
for that supplier. Numbers are compared trimmed and case-insensitively, since
`inv-001` and ` INV-001` are the same piece of paper. A receipt with no number
is allowed and is not checked. Two suppliers may use the same number. An invoice
number is at most 64 characters.

Why now: receipts are about to arrive by photograph, and the same photo sent twice
— by two partners, or by one partner who was not sure it went through — would
otherwise double the stock and the landed cost of a cycle.

### Rules the office app now enforces too  — DECIDED 2026-09-19, guesses marked

The assistant writes through the same services as the office app, so a check
added for it holds in both places. These were not written down before:

- **A purchase order's FX rate is above zero, and a line discount is between 0
  and 100 percent.** Line totals are exact decimals, never floats.
- **Lines can be added to a draft only while its cycle is open for purchasing**
  (PLANNING, FUNDING, PURCHASING). Adding a receipt to an existing draft needs the
  same supplier, currency and rate; a draft with no invoice number takes the
  receipt's, and one with a different number refuses — record it as its own order.
- **A shipping leg cannot be dated in the future**, and cannot be added to a
  CLOSED or CANCELLED cycle. A new cycle cannot start in the future.
- **Receiving stock is a positive quantity, no more than was ordered, each line
  once.** A line with nothing received is not booked as an empty batch: it stays
  unreceived and can be received when it turns up. *(Guess: the BRD does not say
  what a zero line means; this keeps the record honest and loses nothing.)*
  *Changed 2026-10-10 (§3): "each line once" and "no more than was ordered" are
  now "a delivery line, in as many goes as it takes, never past what it brought
  or what of the line is still waiting". A receipt whose every quantity is zero
  is refused as receiving nothing (B3 guess).*
- **Suppliers and SKUs, when the assistant creates them.** *(Guess.)* A supplier
  whose name matches an existing one — ignoring case, spacing, punctuation and
  "Co., Ltd." — is refused, naming the existing one. A code printed on the receipt
  becomes the new product's SKU, and one already used is refused. The office app's
  own forms are unchanged. Open: a printed code in the house format
  (`PRD-000050`) could later collide with a generated one.

---

## 16. The assistant  — DECIDED 2026-09-19, built 2026-09-25

Partners can talk to the system through Claude (claude.ai, the phone app, Claude
Desktop), connected to it as an MCP server. Spec:
`docs/specs/2026-09-19-mcp-assistant.md`.

**DECIDED 2026-10-13 (owner) — ChatGPT may connect too.** Sign-in returns a code only to Claude's own sites
(claude.ai, claude.com), to apps on the partner's own machine (localhost), and to ChatGPT's two connector callbacks
on chatgpt.com — `/connector_platform_oauth_redirect` and `/connector/oauth/<id>` — never anywhere else on that
site. Every other web service is refused: registration is open, so this list is what keeps a partner's sign-in from
being sent to someone else's site. Adding another AI means adding its exact callback here, not opening a domain.

**Who.** Core partners only. A temporary investor or a shop owner is refused when
signing in. Signing in uses the partner's own login. Each Claude app a partner
connects — the phone, a laptop — signs in once, is remembered, and appears in
Settings as its own connection.

**What it may read.** Everything a core partner can see: cycles, purchase orders,
stock with arrival and receipt dates, sales, payments, customer balances, the
dashboard, FX rates.

*Added 2026-10-11 (I1, autonomous run): who owes what* (`list_receivables`). Every
customer with an unpaid balance, largest first, with how many orders are open,
the day the oldest unpaid one was placed (in Cairo), and how much is overdue on
their payment plan; optionally only those with something overdue. The balance is
the customer's balance as everywhere else (confirmed and partly paid orders).
Decided while building it: **overdue comes only from payment plans** (§7) — a
shop with no plan has nothing overdue, because no date was ever promised — and is
**never shown above what the customer owes now** (a plan can promise more than is
still owed after a return). Reading it notifies nobody.

**What it may change.** Only the intake path, from receipt to sellable stock:
suppliers, products, purchase orders and their lines, cycles, shipping legs (and,
since 2026-10-17, correcting a leg's cost — below), cycle status, and verifying stock in — and, since 2026-10-11, recording a sale, recording a payment a shop
made, and recording what a friend paid a supplier for us and our repayments to him (below) — and, since
2026-10-15, creating a product category (below). It cannot change,
reverse or re-allocate sales or payments, nor touch instalments, settlements, returns or the ledger — those stay
in the office app.
This is enforced by the system, not by the assistant's good behaviour: its access
is valid nowhere except the assistant's own tools.

**Nothing is written without a confirmed preview.** Every change is first shown
to the partner as a preview. It is made only when the partner confirms, within
15 minutes, and what is made is exactly what was previewed — a changed quantity,
a different cycle, or a confirmation used twice is refused.

What was shown binds too, where the same request can do more by the time it is
confirmed: moving a cycle out of PURCHASING is refused if a draft order or a line
appeared since the preview (it would be locked unseen), and verifying stock is
refused if a landed cost moved since (it would be booked at a figure nobody saw).
The partner is shown the new preview instead. The assistant can move a cycle as
far as SELLING; settling and closing stay in the office app.

**Attribution.** Every change is recorded under the partner who signed in, as if
they had made it in the office app.

**Revocable.** A partner can disconnect Claude from Settings at any time — one
device or all — without changing their password. Access also lapses after 30 days
without use, and a partner who stops being a core partner loses it at once.

**The receipt flow.** A partner sends a supplier's receipt or invoice. Claude
reads it; the system matches it against suppliers, products, open cycles and
invoices already recorded, and names what could not be settled. Claude asks
exactly those questions — an unknown supplier, an unmatched line, lines that do
not add up to the stated total, a currency with no known rate, which cycle, a
receipt already recorded — and, when the reading itself failed, a receipt with
no lines, a date that cannot be read, or a currency that cannot be read. It then
previews the purchase order and creates it on the partner's word.

A name on the receipt that is close to a known supplier or product — at most
about one slip in five characters — is offered as a likely match and the partner
confirms it; a close name is never taken as the same thing without that.

Shipping, fees and tax printed on a receipt are not purchase order lines; the partner decides whether they belong on a shipping leg.

**DECIDED 2026-10-11 by the owner — the assistant can record a sale.**
*Built 2026-10-11 (W3).* "I sold 25 of X at Y to Z" is a sale the assistant records, the
same two-call way as every write: it matches the product and the customer
(close names are asked, never assumed), shows the preview — lines, total,
whether the stock is there — and saves only on a clear yes. "To anyone" or a
walk-in buyer is a walk-in sale (§4), paid on the spot. Without a stated price
it offers the list price for that kind of buyer and asks. It creates and
confirms in one step; it records no other payments, returns or settlements.

*Built 2026-10-11 (W3), the `record_sale` tool.* One matcher now serves
receipts and sales: a name is the same thing only when it is the same once
case, spacing and punctuation are ignored (or the SKU or id is), and anything
close — a plural, another word order, extra words like "matt black, size L" —
is offered as a candidate and asked. This replaces the "about one slip in five
characters" wording above for what is *offered*; what is *taken* only got
stricter. Guesses made while building it, open until confirmed:
- A receipt line that contains a product's whole name plus more words used to
  be taken as that product; it is now asked, like any other close name.
- A plural alone ("Spark plugs" against "Spark plug") is asked, not taken.
- A sale with an unsettled name or no price returns its questions and no
  confirmation token at all, rather than a refusal; an unknown customer is
  offered "a walk-in sale" as one answer.
- The assistant's sales are in EGP; the list price offered is the open price
  on the buyer's channel (the customer's type, B2C for a walk-in) — or, with
  none set, the default landed + 20%, said so (§3, 2026-10-18).
- The stock shown in the preview binds: if any of that product is sold
  elsewhere before the partner confirms, even leaving enough, the partner is
  shown a fresh preview (`PREVIEW_CHANGED`).
- A payment method on a named customer's sale is refused, not ignored.

**DECIDED 2026-10-11 by the owner — the assistant can record a payment.**
*Built 2026-10-11 (I2, `record_payment`).* "El-Sayed paid 5,000 cash" is a payment the assistant records,
the same two-call way: it finds the shop with the one matcher (a close or unknown name is asked, never
assumed, and never becomes a new customer), and previews the amount, the method (cash when unsaid), the day
received (today in Cairo when unsaid, never a future day), which orders the money lands on and the shop's
balance before and after. It saves only on a clear yes. It goes through the same payment service the office
app's Record payment uses, so every guard there applies unchanged — not more than the shop owes (§7a), not
more than a named order owes, only the shop's own confirmed orders, not an unverified shop. Without a named
order the money goes on the oldest unpaid orders first (§7); with one, on that order alone. The roles allowed
are the office endpoint's (`PAYMENT_ROLES`: core partners and admin support — the assistant itself only
admits core partners). The preview binds: a sale or another payment for the same shop between the preview
and the yes is `PREVIEW_CHANGED`, and the partner is shown the new preview. It records no reversal,
re-allocation, refund or instalment plan. Guesses, open until confirmed (2026-10-11):
- The assistant's payments are in EGP, as its sales are.
- An order is named by its number (or id); one that is not this shop's is "not found", as on the office form,
  rather than saying whose it is.
- A reference (receipt, transfer or cheque number) is recorded only when the partner gives one.

**Friends who paid a supplier (lenders, §18) — built 2026-10-11 (L2), autonomous run.**
The assistant reads and records a friend's loan the same two-call way, through the methods
the office app's "Paid by a friend" and "Record repayment" call (`LendersService.finance`,
`.repay`, `.quote`, `.list`, `.findOne`), so every guard there applies unchanged — not more
than is left on the order, not more than is owed, not dated forward or before he paid, and no
friend's payment on a cycle being settled, closed or cancelled. A repayment has no status check
of its own and needs none: a cycle reaches settlement only once its friends are repaid, and is
cancelled only once his payment was removed, so a repayment there is refused as nothing owed
(`LENDER_NOT_OWED`, or `LENDER_REPAYMENT_EXCEEDS_OWED` with the order named). Roles are the office endpoints' (`lender-roles.ts`:
reading for core partners and admin support, writing for core partners; the assistant itself
admits only core partners). Four tools:
- `list_lenders` — every friend still owed: per currency, and in pounds at today's rate on the
  exchange-rate page (the dashboard's "owed to lenders" definition, one function), with any
  overdue plan instalment. A friend owed nothing is not listed.
- `get_lender` — one friend by name or id (a close name returns the candidates, as
  `get_customer` does): each order he paid for and its cycle, every repayment with its rate,
  what it cleared, the exchange difference (and the account, on repayments recorded before
  2026-10-11 that named one), his plan, and what is still owed.
- `record_lender_financing` — "Mahmoud paid 30,000 AED for PO-2026-0004". The friend is
  found with the one matcher; an unknown or close name is a question with nothing to confirm,
  and a new friend is added only when the partner agrees (`newLender`). The order is named by
  its reference. The preview shows what the partners fund before and after (the costing's
  "to fund", §18).
- `record_lender_repayment` — "paid Mahmoud 50,000 pounds today", or "pay him off" (the
  service's own settling figure at the rate used). The preview shows the rate and where it
  came from, what it clears in his currency, what is still owed before and after, and the
  exchange difference. It asks no money account (§18, DECIDED 2026-10-11; accounts removed altogether 2026-10-14, §9).
What the preview showed binds (`PREVIEW_CHANGED`): another friend's payment on the order, or
another repayment to him, between the preview and the yes. It does not remove a friend's
payment, reverse a repayment, or agree or cancel a plan — those stay in the office app.
Guesses made while building it, open until confirmed (2026-10-11):
- The rate left unsaid is today's on the exchange-rate page — the one the office form
  prefills — and the preview says so; a currency with no rate there is asked, never guessed.
- ~~The money account: the one the partner names; with several and none named, the assistant
  asks~~ — superseded 2026-10-11: no account is asked (§18, DECIDED by the owner). The tool
  has no account parameter, and the confirmation binds no account. Since 2026-10-14 there are no
  money accounts at all (§9), and `get_lender` shows none on a repayment.
- A friend owed on more than one order is asked which order the repayment is for; it is never
  split across orders.
- A currency the partner states must be the order's; another is refused
  (`LENDER_CURRENCY_MISMATCH`), never converted.
- A friend named who already exists by exact name is that friend even if `newLender` is sent;
  two lenders of one name would make every later lookup a question.
- A new friend is created just before his payment is recorded, as two steps; if recording the
  payment were then refused (only possible if something changed after the bound preview was
  re-checked), the friend stays on file with nothing owed.
- The amount must be more than zero now in `LendersService.finance` itself, not only in the
  office form's DTO, because the assistant calls the method directly.

**Selling below cost (2026-10-11, L4).** `record_sale`'s preview carries a `belowCost`
block on every line sold below what its goods cost — `unitCostEgp`, `unitPriceEgp` (after
the line discount) and `lossEgp`, or null — and `belowCostLossEgp`, the lines' losses
added. It is the sales service's own price check (§4), so the assistant and the office
form cannot disagree. The summary says it in words, and the tool description and the
server instructions tell Claude to tell the partner the loss before the partner
confirms. It is still the partner's call: a below-cost sale confirms like any other,
and the assistant never changes the price itself.

**Deliveries (2026-10-10, built 2026-10-11, B4).** The assistant can record a delivery on a
leg and receive a delivery into stock. Marking goods lost is office-app only: it
books a loss, and a partner should decide that on a screen.

**Departures in parts (2026-10-12, L8, §1).** `add_shipping_leg` with `departedOn` records the
leg's first departure: everything waiting, or only `departureLines` when part left. A later part
is `record_departure` — the leg, the day, per product how many left (none named: everything
waiting) — previewed by the write rolled back: what leaves, what will still wait, what will be on
the way, the leg's status after, and whether the cycle moves (only a leg's first departure moves
it). The confirmation binds the lines, what still waits after them, and the status move: another
departure or a delivery into the origin in between is `PREVIEW_CHANGED`. `get_cycle` shows, per
leg and product, what waits at the origin and each departure. Undoing a departure stays in the
office app.

**Samples at shops (2026-10-20; §4).** Leave samples with a shop, list what is out, record the shop buying (the sale
completed in place), everything returned, or a write-off — `leave_samples`, `list_samples`, `complete_samples_sale`,
`return_samples`, `write_off_samples`. The same service calls and roles as the office; every write is a preview then a
confirmed commit. `return_samples` is not a return of a sale (that stays office-only), and `write_off_samples` is not
goods lost on the way (that stays office-only). Details and guesses in §4.

**Correcting a leg's cost (2026-10-17, owner: "did we add it to the assistant as well?"; §2).**
`update_leg_cost` changes only a leg's cost — basis, amount or rate, pieces or weight, currency, rate
to EGP, the same fields `add_shipping_leg` takes (one definition) — on a leg named by its id or by
its cycle (code or id) and sequence. It calls `ShippingService.updateLeg`, the office's
`PUT /shipping/legs/:id`, so every guard and the re-cost of the whole cycle are the office's; roles
are that endpoint's (`shipping/leg-roles.ts`: core partners). The preview is that write rolled back:
the leg's route, its cost before → after (in its currency and in EGP), whether goods were already
received so the whole cycle is re-costed (and how many delivered units wait to be received at the
new cost), and per product the landed cost per unit before → after with how many units were
received and how many of them already sold. A locked cost comes back as its refusal
(`LEG_COST_LOCKED_*`) with no confirmation; the cost the leg already has is `LEG_COST_UNCHANGED`.
The confirmation binds the cost before and after and every product's figures and sold units, so a
correction, receipt or sale in between is `PREVIEW_CHANGED`. The re-cost rewrites the receipts'
purchase entries exactly as the office's edit does; the assistant still adds or reverses no ledger
entry of its own, and a late charge on a locked cycle is still a cycle expense entered in the
office app. *Guess:* the assistant refuses a
correction that changes nothing rather than offering an empty confirmation.
**Planned — moving leftovers between cycles (§8, L5).** Out of scope for the first build
(2026-10-11): the office app only. When it comes, the tool calls `StockTransfersService.create`
and `undo` with the same roles (`stock-transfers/stock-transfer-roles.ts`), previews the cost and
the target's new cost to fund before the partner's yes, and is refused exactly as the office is.

**The status a record moves the cycle to (2026-10-11, L3, §1).** `record_delivery`
and `add_shipping_leg` with a departure or an arrival move the cycle on by
themselves, as the office app's do. Each preview says where the cycle will land
("This moves CYC-… from PURCHASING to IN_TRANSIT_TO_EGYPT") and which draft
orders leaving Purchasing will confirm, read from the same write rolled back;
both are part of what the confirmation binds. The commit says where it actually
landed, and the step that refused if the walk stopped short.

**Not kept.** The receipt image itself is not stored — the purchase order records
the supplier's invoice number, and the photograph stays in the conversation.

**Arabic names (DECIDED 2026-10-14, owner; §3).** `find_products` searches the
English name, the Arabic name and the SKU, and returns `nameAr` and `categoryAr`
beside `name` and `category` (null when none was entered). Receipt matching
(`match_receipt`) and `record_sale` match a product by either name through the
one matcher — an exact Arabic name is a match, a partial one only a candidate —
and their candidates and lines carry both names. **The assistant never invents a
translation:** `create_product` and a new product in `create_purchase_order` take
`nameAr`/`descriptionAr` only when the partner wrote or said them, and leave them
empty otherwise; the tool descriptions and the server instructions say so. ~~There
is no tool to create a category; an Arabic name for one is added in the office.~~ —
superseded 2026-10-15, below.

**Categories (DECIDED 2026-10-15, owner: "give the assistant create category").**
Two tools:
- `list_categories` (read) — every category: id, name, `nameAr` (null when none
  was entered), the parent it sits under (`parentId`, `parent`, `parentAr`) and how
  many products it holds, from the office's own category list. It is how the
  assistant finds the `categoryId` `create_product` takes, and a parent.
- `create_category` (write, the same two calls as every write) — `name`, `nameAr`
  only when the partner gave it (never a translation), and an optional `parent` by
  id or by English or Arabic name. It goes through `ProductsService.createCategory`,
  the method the office's New Category form calls, so the rules are one definition:
  a name already used (`CATEGORY_NAME_TAKEN`), an Arabic name already used ignoring
  case (`CATEGORY_NAME_AR_TAKEN`), an Arabic name too long or not text, and the
  audit row under the partner who signed in. Roles are the office endpoint's
  (`products/category-roles.ts`: core partners). The parent is settled only by its
  id or one category whose English or Arabic name is the same once case, spacing,
  punctuation and Arabic spelling (§3: ة/ه, أ/ا, the vowel marks) are set aside.
  Nothing matching is `CATEGORY_PARENT_NOT_FOUND` (naming the closest, if one is
  close); two or more is `CATEGORY_PARENT_AMBIGUOUS`, listing them — never a guess.
  The parent a name resolved to binds: if it means another category by the yes,
  `PREVIEW_CHANGED`. Editing, moving or deleting a category stays in the office.

Fixed in the shared method while building it (2026-10-15), so the office form gets
them too: a blank name is refused (`VALIDATION_FAILED`) instead of stored as a
category called nothing; the name is trimmed before the uniqueness check, so
"Brakes " is "Brakes"; a parent id that is no category is `NOT_FOUND`, not a 500
from the foreign key.

Decided (2026-10-15, **GUESS**, recommended option taken under the owner's standing
"decide yourself"): a category's English name is unique **ignoring case**, like a
supplier's name and a category's Arabic name, so "brakes" beside "Brakes" is refused
as `CATEGORY_NAME_TAKEN`, by the office and the assistant alike. Renaming a category
to its own name in other case is allowed. The database index stays exact-case; the
service asks first.


---

### The office chat — DECIDED 2026-10-20 / 2026-10-25 (owner), built 2026-10-25, details GUESSED

A chat inside the office app, on every page (a round button at the bottom corner), on **the assistant's own tools**:
the same services, the same roles, the same preview before every change. `apps/api/src/modules/assistant/chat/`
runs the tool server in process (the MCP client over an in-memory transport), so no tool is copied;
`components/assistant/assistant-chat.tsx` is the panel.

- **The model is the owner's choice, from the API's environment, no code change** (owner: Gemini to start, "maybe
  later Groq or any free one"): `AI_PROVIDER` (gemini, groq, openai, openrouter — any OpenAI-compatible one with
  `AI_BASE_URL`), `AI_API_KEY`, `AI_MODEL`. No key: the chat says it is not set up.
- **The model can only preview.** A change comes back as a card with **Confirm** and **Cancel**; only Confirm saves it,
  with the token that preview issued to that partner for those exact arguments (§16's rules: once, 15 minutes). A
  token the model sends is dropped, and it is never shown one. A refusal on Confirm (expired, already used, the
  facts changed) is said on the card, nothing saved.
- **100 questions a day, shared by the three partners** (owner 2026-10-25; `AI_DAILY_LIMIT`), counted in Cairo days
  from the audit log; then the chat says so until tomorrow. Confirm does not count (no model is called).
- **Only core partners** (owner 2026-10-21: nobody else signs in).
- **Nothing of the conversation is stored**: the browser holds it while the app is open; each question sends its
  newest part (12 turns, 16,000 characters). The audit log records each question's provider, model and tools
  (`ASSISTANT_CHAT`), and every change is audited by the service that made it, as always.
- **Budget per question** (GUESS): a question of at most 2,000 characters, at most six model turns, each tool's answer
  cut to 6,000 characters, tool descriptions to their first sentences — every question carries every tool.
- **Found 2026-10-25: Groq's free tier is too small** — 8,000 tokens a minute, and one question with the tools is
  ~8,300 before its second turn; the chat then says so (`AI_PROVIDER_TOO_SMALL`). Gemini's free tier fits.
- GUESS: the previews are the tools' own English summaries (as for Claude); the chat's answers follow the partner's
  language. Previews read left to right on an Arabic screen.

## 17. Selling on Amazon  — PLANNED, raised 2026-10-08

The owner wants to sell on Amazon as well, at some point. **Nothing is built and
nothing is decided.** This section exists so the idea is not lost, and so the
questions that shape it are asked before any of it reaches code.

What already holds and would not change: marketplace sales are already a kind
of sale (§3). Stock is allocated FIFO from cycle batches when a sale is
confirmed, and that cost is never re-priced. So an Amazon sale would count
toward the profit of the cycle its stock came from, like any other sale, unless
decided otherwise.

Open — each changes the design, so each needs an answer first:

| Question | Why it matters |
|---|---|
| **Which Amazon** — **DECIDED 2026-10-08: both Egypt and the UAE** | Two currencies, Egyptian pounds and dirhams, each with its own payouts. |
| **Where UAE stock comes from** — OPEN | Goods already pass through the UAE on their way to Egypt. Today stock can only be sold once it has been received and checked in Egypt. Selling on Amazon UAE means either selling some goods before they reach Egypt, or sending stock back out of Egypt. |
| **Who ships** — Amazon holds our stock (FBA), or we ship each order — OPEN | With FBA, stock sits in Amazon's warehouse but is still ours until sold. The system has one place stock can be today; this would make it two. |
| **How orders arrive** — recorded by hand, or pulled from Amazon automatically — OPEN | By hand works with today's sales screens. Automatic needs an Amazon seller account connected, and decides when a sale counts as confirmed. |
| **Amazon's fees and payouts** — OPEN | Amazon pays out later and net of its fees. The fee is a selling expense, not part of the goods' cost. Until the payout arrives, the money is owed by Amazon, which is not a shop. |
| **Price per channel** — OPEN | Whether a product can have a different price on Amazon than at the counter. |
| **Returns through Amazon** — OPEN | Whether §5 applies unchanged when the buyer returns to Amazon rather than to us. |
| **What a listing needs** — OPEN | Amazon asks for barcodes, images and weights that most products do not have yet. |

---

## 18. A purchase paid by a friend, repaid in pounds  — DECIDED 2026-10-11 (owner), details OPEN

**What happens in the business (owner, 2026-10-11).** Sometimes a friend pays a
supplier for us — the whole order, say 30,000 AED. We then pay him back in
Egyptian pounds over a few months (three, for example). Each repayment is worth
whatever the dirhams are worth **on the day we pay him**: what we owe him is
30,000 AED, not a fixed number of pounds.

**The guesses below are the code's current answer. Each is OPEN until the owner
confirms it.**

| Rule | Guess | Why |
|---|---|---|
| Who the friend is | A **lender**: a new kind of contact — not a partner, not a customer, not a supplier. He shares in no profit. | He is owed money; he does not own any of the cycle. |
| What he can pay for | All or part of one purchase order, in that order's currency. Never more than the order's total. **Replaced 2026-10-16: the cap is the cycle's cost still unpaid by friends — see the end of this section.** | The example is a supplier order in dirhams. Shipping legs paid by a friend can be added later. |
| What we owe | The amount he paid, **in his currency** (e.g. 30,000 AED), until it reaches zero. | The owner's rule: each payment is worth the rate on that day. |
| A repayment | We pay pounds on a date, at that day's rate (prefilled from the current rate, editable). It clears pounds ÷ rate of the debt. | — |
| Paying too much | Refused: a repayment cannot clear more than is still owed. The last one shows exactly how many pounds settle it at the rate entered. | Rule 1 of the working rules: too much is refused. |
| A plan | Optional: a number of instalments and their due dates (e.g. 10,000 AED a month for three months). An instalment past its due date alerts the partners once, like a customer's (§7). | Same habit as customer plans. |
| What the goods cost | **Unchanged**: the order's lines cost what they cost at the order's own rate, and the batches are costed from that as always (§2). Nothing is re-priced when a repayment happens. | A sale's cost is never changed after the fact (§3). |
| The rate moving | The pounds actually paid minus the debt valued at the order's rate is an **exchange difference**: a cost to the cycle when the dirham rose, a gain when it fell. It counts in that cycle's profit and in the dashboard's. It is not an operating expense and does not re-price stock. | It is a real cost of that cycle's purchase. |
| Cash | No cash leaves when the friend pays the supplier. Cash leaves on each repayment, for the pounds actually paid. | Cash flow follows the money (§9). |
| Settling the cycle | **A cycle cannot be settled while it still owes a lender.** The settlement screen says how much is left and to whom. | Profit is not known until the exchange difference is. Partners would otherwise split money that still has to go to the friend. |
| Partners' capital | ~~The amount the friend paid (at the order's rate) counts toward funding the cycle, so "Split equally" asks the partners for the rest only.~~ **Superseded 2026-10-19 (owner):** his payment is a loan to the partners; they fund the whole cycle, directly or by repaying him, and each partner's contribution is their share of it ("The partners repay the friend", end of this section). | The owner: "we split money among us to repay the lender". |
| Who can do it | Core partners. Others see it, read-only, where they can already see the cycle. | Money-moving rule (working rules §12). |
| A mistake | A repayment is reversed, never deleted or edited — with a reason, once only. The friend's payment can be removed only while nothing has been repaid. | Financial history is never rewritten (§9). |

**Where it shows**
- The purchase order and the cycle page: "Paid by <friend> — 30,000 AED; 18,000 AED still owed".
- A lender's own page: everything he paid for, every repayment with its rate, and what is still owed.
- The dashboard: what we owe lenders, in their currency and in pounds at today's rate.

**Settled while building it (L1, 2026-10-11) — guesses, each OPEN until the owner confirms.**

| Question §18 left open | Guess built | Why |
|---|---|---|
| How much debt a part repayment clears | Pounds ÷ that day's rate, **rounded down** to the piastre of his currency. | Never clear more than the pounds actually bought. |
| Rounding left on the debt | At most 0.01 (of his currency) per part repayment. The repayment that pays it off is the exact "pays it off" figure shown — what is owed × the rate, to the piastre — and it clears all that is left, so the debt ends at exactly zero. | The last one settles exactly (rule 1: no hidden residue). |
| Paying a few piastres more than the "pays it off" figure | Refused, naming the figure. | Too much is refused. |
| A repayment so small it clears 0.00 | Refused. | A payment that changes nothing is a slip. |
| The exchange difference, exactly | Each repayment's pounds − what it cleared at the order's rate (to the piastre); the last one takes whatever keeps the total at the order's rate equal to what he paid at that rate. Over a repaid debt: pounds paid − his amount at the order's rate. | §2's residual habit. |
| Where it is kept | On each repayment, not as a ledger row — the ledger shows the pounds leaving; settlement, cycle profit and the dashboard read the difference from the repayments through one function. | A loss is handled the same way (§9). |
| Ledger | When he pays: money *in* (`lender_financing`) at the order's rate — the goods are booked out at receipt as always, and this says whose money paid. Each repayment: money *out* (`lender_repayment`) for the pounds ("Which account" below). Both are financing: not income, not an expense. | Keeps cash on hand true: we did not pay the supplier. |
| Which account | **DECIDED 2026-10-11 by the owner: none is asked; 2026-10-14: money accounts removed altogether.** On 2026-10-11 he said the step does not matter — customer payments, purchases and the other money flows never recorded an account, so a repayment was the only flow that asked. On 2026-10-14: "we don't need money accounts". There is no account to name: the office's Record repayment has no "From account" field, the lender page no account column, the assistant's `record_lender_repayment` no account parameter and `get_lender` no account on a repayment. A repayment body that names one is refused as an unknown field (`VALIDATION_FAILED`; the old `ACCOUNT_NOT_USABLE` refusal is gone with it). The stored links were dropped with the accounts (§9, "Money accounts — removed"). | The owner's rule; one flow behaving like the others. |
| One friend, one order | A friend's payment for an order is recorded once; to change it, remove it (only while nothing is repaid) and record it again. Two friends may share one order, never above its total. | Doubles are the second-time bug. |
| Which cycles | Not on a cycle in settlement, closed or cancelled. Cancelling a cycle whose order a friend paid for is refused until his payment is removed. An order with no lines (a draft from before PO_NEEDS_ITEM) takes no friend's payment. No guard stops a purchase line being cut below what friends paid — none is needed today, because a line cannot be edited once added; check-data 19.1 watches for it. | A cancelled cycle "never ordered anything" (§15). |
| Dates | His payment and each repayment cannot be in the future; a repayment cannot be dated before he paid. A date left out is today in Cairo, as a payment's is (§7a). | Records of things that happened. |
| Reversing a repayment on a settled or closed cycle | Refused — reverse the settlement first. | It would reopen a debt on a cycle already split. |
| Removing his payment once repayments were reversed | Allowed: only standing (not reversed) repayments block it. Removing it, with a reason, cancels his active plan on it and writes a balancing ledger outflow pointing at the original inflow; the row stays, marked removed. | Nothing has been repaid. |
| A plan | Per order he paid for; instalments in his currency, totalling no more than is owed. One active plan at a time; cancel and agree again. Progress counts repayments dated on or after the plan's day, cumulatively, earliest instalment first — the same function as a customer's plan (§7). | Same habit as customer plans. |
| Who is told when one is late | Every active core partner, once per instalment, by the existing morning job. | §7. |
| "Owed to lenders" on the dashboard | Each currency, and in pounds at the current rate on the exchange-rate page; a currency with no rate is shown without pounds and says so. | §18: "in pounds at today's rate". |
| "Split equally" | **Since 2026-10-19:** splits the cycle's whole cost (goods, legs, expenses charged to it, leftovers moved in) less investors' money — what friends paid is **not** taken off; on a cycle a friend paid for it is each partner's equal share of repaying him. Until then it took off what friends paid. | Owner 2026-10-19 ("The partners repay the friend"). |
| A cycle a friend paid for entirely | **SUPERSEDED 2026-10-19 by the owner.** ~~DECIDED 2026-10-11, built in L2: its profit is split equally among the cycle's core partners; a temporary investor on it gets nothing; a custom split still overrides. "Entirely" means every contribution is zero and the friends' payments leave nothing to fund (`toFundEgp` zero).~~ Now: the partners enter their shares of repaying him (any split — "it does not have to be equally maybe 30,30,40") and profit follows them; with nothing entered it refuses `CYCLE_NOT_FUNDED` like any other cycle, wholly or partly paid by a friend. A custom split still overrides. | The owner, 2026-10-19: "no but I need to show that we split money among us to repay the lender which means that we pay, it looks vague as if we payed nothing". |
| Through the assistant | **Built 2026-10-11 (L2).** `list_lenders`, `get_lender`, `record_lender_financing` and `record_lender_repayment` (§16), through the same `LendersService` methods and the same roles as the office. The rate left unsaid is today's on the exchange-rate page and the preview says so; no money account is asked (DECIDED 2026-10-11; accounts removed 2026-10-14, "Which account" above); a new friend is added only on the partner's yes. Guesses listed in §16. | One set of rules for both doors (working rules §3, §11). |
| Who sees the lenders list and a lender's page | Core partners and admin support, who can also ask what pays a debt off at a rate (the quote behind the repayment form). A temporary investor sees "Paid by" only on his own cycles' orders and cycle page. Every write is a core partner's. | §18: read-only where they already see the cycle. |

**DECIDED 2026-10-16 (owner asked for the capability; details a GUESS, the
recommended option) — he pays in his own currency, at that day's rate.** The
owner's case: a friend paid the supplier in AED while the order is priced in
CNY or USD, and is repaid monthly in pounds at each month's AED rate. This
replaces "in that order's currency" above.

| Rule | Now | Status |
|---|---|---|
| The currency he paid in | EGP, the order's currency, or any currency with a rate on the exchange-rate page (§22); anything else `NO_RATE_RECORDED`, a code that is not three letters `CURRENCY_CODE_INVALID`. Left out: the order's currency. | GUESS |
| The rate | The rate on the day he paid, as typed: above zero (`RATE_NOT_POSITIVE`), at most four decimals (`RATE_TOO_PRECISE`). EGP is 1 (`BASE_CURRENCY_RATE_FIXED`). Left out: the order's rate for the order's currency; for another currency it is required (`FINANCING_RATE_REQUIRED`) — a rate on the page is today's, not his day's, so it only prefills. | GUESS |
| His pounds | `amountEgp` = amount × his rate, half up to the piastre. The ledger inflow is those pounds, at his rate, with his amount and currency kept as the original. | DECIDED |
| The cap | Compared in pounds, and exactly: friends' amount × rate together never above the order's lines × the order's rate (`FINANCING_EXCEEDS_ORDER`, figures in EGP). Exactly, before rounding, so two friends paying exactly what is left in the order's currency are never refused by a piastre of rounding. **Superseded the same day: the cap is the cycle's cost (below); still exact, still in pounds.** | GUESS |
| What we owe him | His amount, in his currency. Repayments clear pounds ÷ the rate typed on the repayment. | DECIDED |
| The exchange difference | Pounds paid − what was cleared valued at **his** rate (the financing's own), not the order's. Over a repaid debt: pounds paid − his `amountEgp`. One definition, `common/lender-math.ts`. | GUESS |
| Partners' capital | ~~"Split equally" and the funding subtract his `amountEgp` (his pounds at his rate).~~ Superseded 2026-10-19: nothing is subtracted; his `amountEgp` is shown beside the cost to fund (`lenderFinancedEgp`) as what the partners repay. | DECIDED (2026-10-19) |
| The office form | Currency (EGP, the order's first, every currency with a rate) and "Rate to EGP on that day": the order's own rate for the order's currency, today's page rate for another, 1 for EGP; what it is worth in pounds shown as he types. | GUESS (the order's rate, not today's, prefills the order's currency, so an untouched form records what it always did) |
| The assistant | `record_lender_financing` takes currency and rate; unsaid, the order's rate for the order's currency, otherwise today's page rate, and the preview says which; the rate is bound to the confirmation. | GUESS |

No migration: a friend's payment already stored its own currency and rate (they
were copies of the order's). Production had no friend's payments.
`check-data` 19.1 now compares in pounds; 19.6 checks `amountEgp` is amount ×
rate.

**DECIDED 2026-10-16 (owner asked: "make the friend payment cover shipping and
fees too"; details a GUESS, the recommended option) — his payment may cover the
cycle's whole cost, not only the order's goods.** The real case: Mohammed paid an
Alibaba order by card, AED 8,302.60 in all — goods 6,509.80, China→UAE shipping
1,551.74 and the card processing fee 241.07. Until now only the goods could be
recorded as owed to him. This replaces "Never more than the order's total"
above and the 2026-10-16 "The cap" row.

| Rule | Now | Status |
|---|---|---|
| What it is linked to | Still the purchase order he paid (no schema change); one friend once per order, as before. | GUESS |
| The cycle's cost | Every purchase order's goods (lines × the order's rate) + every shipping leg's cost (its basis × its rate) + every ledger expense charged to the cycle, net of reversals (`operatingExpenseEgp`, the settlement's own reading), all in EGP. One definition: `CostingService.cycleCost`. | GUESS |
| The cap | All friends' payments on the cycle (amount × his rate, exactly, before rounding) never above the cycle's cost — so a friend may pay what is left of it, whichever order he is recorded against. Refused with `FINANCING_EXCEEDS_CYCLE_COST` (params in EGP: `amount`, `cycle`, `cost`, `financed`, `available`). `FINANCING_EXCEEDS_ORDER` is gone. Checked under the cycle's lock. | GUESS |
| A card or bank fee | Recorded as a manual ledger EXPENSE (`bank_fees`, or any other expense category) with the cycle picked: the ledger already accepted a cycle on every expense category; it counts in the cycle's cost from then on. Record it **before** the friend's payment, or his payment is refused as too much. An expense with no cycle (a running cost) or on another cycle does not raise the cap. | GUESS |
| Cost to fund | **Changed 2026-10-19 (owner):** what the partners fund (`fundingFor` → `toFundEgp`, the cycle page's Split equally and Enter amounts, the assistant previews' `partnersFundBefore/After`) = the cycle's cost (goods + legs + expenses charged to it) + leftovers moved in, floored at 0 — friends' payments are **no longer subtracted**; they are reported beside it (`fundingFor().financed`, the costing's `lenderFinancedEgp`). Split equally then takes investors' money off (`lib/funding-split`, one split). Until 2026-10-19: "… − friends' payments". | DECIDED (the rule), GUESS (the details) |
| Settlement | Unchanged arithmetic: a friend's payment is not income, the expenses still reduce profit, his exchange difference still applies. ~~"A friend paid for it entirely" (§8, `CYCLE_NOT_FUNDED` otherwise) now means his payments cover the cycle's cost **including its expenses**.~~ (That basis is gone, 2026-10-19: the partners' contributions are the basis.) | GUESS |
| A cost that moves after he paid | A leg or an expense added later: the partners fund the new part, and another friend may pay it. A leg corrected down or an expense reversed: cost to fund and what is available stop at zero, never negative; `check-data` 19.1 (now per cycle) will name that cycle for a look. | GUESS |
| Where it shows | `GET /purchases/:id/financings` and `GET /cycles/:id/financing` return `cycleGoodsEgp`, `cycleShippingEgp`, `cycleExpensesEgp`, `cycleCostEgp`, `cycleFinancedEgp` and `availableEgp` — now the cycle-wide room (the order's `orderTotalEgp` and `financedEgp` are kept). The landed-cost endpoint adds `expensesEgp` and `cycleCostEgp`. The office form says what is left of the cycle's cost and that his payment may cover shipping and fees; the wizard's "Cycle cost" is the cycle's cost. The assistant's `record_lender_financing` says the same and its preview shows the cycle's cost, what friends paid of it and what was available. | GUESS |
| The owner's existing 6,509.86 AED | Remove it (with a reason — allowed while nothing is repaid) and record it again at 8,302.60 once the fee is on the cycle. | DECIDED (owner's plan) |

(2026-10-18: the wizard's Funding step is gone — §8 "The wizard ends at the shipping". Where the "Cost to fund"
row above names the wizard's Split equally and funded-versus-cost line, read the cycle page's funding note and
Participants card.)

**Editing and deleting a lender — built 2026-10-18 (owner asked).** `PUT /lenders/:id` corrects his name, phone
and notes — the whole record is replaced, so a phone or note left out is cleared; a blank name is
`LENDER_NAME_REQUIRED`; no money changes; an UPDATE audit row keeps before and after. `DELETE /lenders/:id` is for
a lender added by mistake: refused with `LENDER_HAS_FINANCINGS` (`count`, `name`) while any payment of his still
stands — remove each first, with its reason. Deleting **hides** him (`deleted_at`, migration
`20261018100000_lender_deleted_at`), never erases him, so a removed payment's history still names him; he leaves
the lenders list, his page, the pickers, the assistant's matching and new payments; a DELETE audit row is written.
An unknown or deleted lender is `notFound('lender')`. Both: core partners only (`LENDER_WRITE_ROLES`); reading
lenders stays core partners and admin support. Edit and Delete sit beside his name on his page.

**DECIDED 2026-10-19 (owner) — the partners repay the friend; his payment is a loan to them.**
After a friend (Ahmad Eraiby, 172,155.50 EGP) paid for a whole cycle, pressing Split equally set every
partner to 0 EGP. The owner: "no but I need to show that we split money among us to repay the lender
which means that we pay, it looks vague as if we payed nothing, and it does not have to be equally maybe
30,30,40". So the partners fund the whole cycle, directly or by repaying him; a friend's payment does not
replace their funding. This replaces the 2026-10-11 equal split, the "Partners' capital" rows and the
2026-10-16 "Cost to fund" row above.

| Rule | Now | Status |
|---|---|---|
| What the partners fund | The cycle's cost (goods + legs + expenses charged to it) + leftovers moved in, floored at 0 — **not** less friends' payments. One definition, `CostingService.fundingFor` (→ `toFundEgp` in `common/stock-transfers.ts`); the friends' figure stays beside it (`financed`, the costing's `lenderFinancedEgp`). The landed-cost totals no longer carry `fundedByLenders`. | DECIDED |
| Split equally | Divides that whole figure among the core partners, investors' money off first (`lib/funding-split.ts`, unchanged code; the server figure changed). | DECIDED |
| Profit | Follows the contributions (`CONTRIBUTIONS`, settlement-math.ts). The `LENDERS` basis is removed, in the API and the web types: a cycle with no contributions refuses `CYCLE_NOT_FUNDED` whether or not a friend paid, wholly or in part. A custom split still overrides. | DECIDED |
| Capital at settlement | Each partner's contribution comes back as capital, as on every cycle. Settlement still refuses while a friend is owed (`assertLendersRepaid`, unchanged). | DECIDED |
| Cash and the ledger | Unchanged arithmetic. A contribution posts a `CAPITAL_CONTRIBUTION` INFLOW when entered (the delta, on every edit — 30/30/40 changed to 50/25/25 posts only the three differences); each repayment posts a `lender_repayment` OUTFLOW. Over the cycle's life: lender in (`lender_financing`, +X) + contributions in (+X) − purchase out (−X) − repayments out (−X) = 0 — the same timing every partner-funded cycle already has (the money comes in when it is entered, leaves when it is spent). Contributions entered before the repayments are made show cash on hand above what is in the bank until he is repaid; that is the same as a partner-funded cycle whose contributions are entered before the supplier is paid. | DECIDED (owner's rule); the timing reasoning is a GUESS |
| A cap on contributions | None existed and none is added: a contribution may exceed the cost to fund; the cycle page says so (below). | GUESS |
| The funding note | Shows while `profitBasis` is `NONE` — which now includes a friend-paid cycle with zero contributions. Fully paid by friends: "**Ahmad Eraiby paid 172,155.50 EGP for this cycle. Split who repays him between the partners.**" (AR: "دفع Ahmad Eraiby 172,155.50 جنيه لهذه الدورة. قسّم بين الشركاء من يسدّد له."), "them"/"لهم" for several friends, names joined in the reader's language. Partly paid: "X paid A of this cycle's B. Split the whole cost between the partners — they repay him and fund the rest." A hint under both: his payment is a loan, each amount is that partner's share of repaying it, and profit follows it. Before the names load, "A lender". Buttons unchanged: Split equally, Enter amounts, Paid by a lender. The names come from `GET /cycles/:id/financing` (the "Paid by a friend" section's own query). | GUESS (wording) |
| Enter amounts — any split | Each core partner's row has an amount **and a %**, kept in step: typing 30 in % fills 30% of what the partners fund; typing an amount fills its %. The partners' 100% is the cost to fund less investors' money as entered on the form (investors get an amount only), the same base Split equally uses. Amounts to the piastre. When the %s come to exactly 100 and the last partner's amount came from his %, he absorbs the rounding so the amounts sum exactly (30/30/40 of 172,155.50 = 51,646.65 + 51,646.65 + 68,862.20); an amount someone typed is never changed. A line under the rows: "Entered X of Y to fund." plus "Matches the cost to fund." / "Z still to enter." / "Z more than the cost to fund.", and "The percentages add up to N%, not 100%." when they do not. None of these block Save. Typed values are the form's own state, so a refetch underneath never overwrites them. Save still writes each changed contribution through `PUT /cycles/participants/:id`. Shared `MoneyInput` for both fields; no native controls. | GUESS (the % entry and its base) |
| The participants card | On a cycle a friend paid for, once contributions are entered, a short line under the participants: "Each partner's share of repaying Ahmad Eraiby:" (partly paid: "Each partner's share of the cycle, repaying X included:") with each core partner's amount and % of the partners' total. | GUESS (wording) |
| The assistant | `record_lender_financing`'s preview keeps `partnersFundBeforeEgp`/`partnersFundAfterEgp` (now equal) and says: "The partners still fund all X EGP of the cycle: what he paid is a loan to them, which they repay, each partner's contribution being their share of it." The confirmation still binds `partnersFundAfterEgp`, so a cost that moves in between still changes what was agreed. | GUESS (wording) |
| Adding a friend once friends paid it all | **DECIDED 2026-10-19 (owner: "if fully paid by a lender why give me the option to add another lender ?").** When friends' payments cover the cycle's whole cost, the funding note shows no "Paid by a lender" and the "Paid by a friend" card no "A friend paid for this"; the server already refused one (`FINANCING_EXCEEDS_CYCLE_COST`). Paid only in part, both stay so another friend can pay the rest. | DECIDED |
| CYC-2026-0001 (production) | Its partners' contributions are each partner's share of repaying both friends; the owner gives the split. Nothing is changed in production by this change. | OPEN (owner) |

## 19. Signing out of the office  — built 2026-10-14 (owner asked for a way out), details GUESSED

The owner, 2026-10-14: there was no way to log out. The header's avatar and name now open an account menu
(name, email, role, **Log out**); on a phone, Log out sits at the foot of "More".

| Question | What the code does | Why |
|---|---|---|
| Does signing out end the session on the server? | **Yes, since 2026-10-17 (§23):** `POST /auth/logout` revokes the sign-in's refresh token and every token refreshed from it. The access token is a signed JWT that cannot be taken back; it lapses within the hour. (Until 2026-10-17: no — tokens were stateless and nothing was revoked.) | §23. |
| What the browser forgets | The token and user, every cached query (`queryClient.clear()`), and the unsaved cycle-wizard draft — **GUESS:** the draft is the person's who typed it, and the next partner on the browser should not be offered it as theirs. A partner who signs out mid-wizard loses that draft. | Rule from the owner: logout clears cached data (LEARNINGS). |
| Alerts on this browser | **GUESS:** the browser's push subscription is removed (API row deleted, then the browser unsubscribes) while the token is still there to authorise it. Best effort, given two seconds; it never keeps anyone signed in. The partner turns alerts on again from Settings after the next sign-in. | Subscriptions are stored per user, so without this the next person on the browser would keep receiving the last one's notifications. |
| Where it lands | The login page of the language being read (`/{locale}/login`), replacing the history entry. Back shows nothing of the office: a signed-out shell draws nothing while it redirects, and a page restored from the back/forward cache re-reads storage. | It used to be hard-coded to `/en/login`. |
| Another tab of the same browser | Signs out with it (the `storage` event): its cache is cleared and it goes to the login page. | One browser, one person. |

## 20. Passwords  — DECIDED 2026-10-14 (owner hit "change my password" failing), details GUESSED

The owner, 2026-10-14: changing the password in Settings never worked. The form sent `currentPassword` and the API
read `oldPassword`, so every change failed with a server error, shown as a generic "error"; the form had already
emptied itself before the answer came; a confirmation that did not match did nothing, silently; and nothing stopped
a one-character password.

| Question | Rule | Status |
|---|---|---|
| What a password must be | At least **8 characters, with at least one letter and one digit**. Letters and digits of any script count (Arabic included); spaces count as characters. No symbol or capital required. Refused as `PASSWORD_TOO_WEAK`. | **GUESS** (recommended option, taken without asking): long enough to stop the trivial, short enough that partners do not write it down. The demo seed's `password123` passes. |
| Where it applies | Every place a password is **set**: change password, a partner creating a user (`/auth/register`, `/users`), a shop signing up on the storefront, and `scripts/prod-reset-partners.sh`. One definition, `apps/api/src/common/password-rule.ts`; the office form and storefront carry copies that say so, the office copy pinned by a unit test. | DECIDED |
| Signing in with an older, weaker password | Still works. The rule applies the next time the password is set, not at the door. | **GUESS** — refusing would lock out anyone set up before the rule. |
| New password equal to the current one | Refused, `PASSWORD_SAME_AS_CURRENT`. Only this one is compared; there is no history of older passwords. | DECIDED (owner's brief) |
| Wrong current password | Refused, `WRONG_CURRENT_PASSWORD`, shown in the reader's language through `useApiError()` — checked in Arabic by 99-change-password TC-PW-03. Nothing is changed. | DECIDED |
| Order of checks | The rule first (it needs nothing stored), then the current password, then "not the same". | DECIDED |
| Does changing it sign you out? | **This device stays signed in; every other device is signed out** (since 2026-10-17, §23). All of the person's refresh tokens are revoked and this device is handed a new one. Another device's access token still works until it lapses, within the hour. | **GUESS** (recommended), replacing the 2026-10-14 guess "the session is kept everywhere", which left a lost phone signed in. |
| The form | Fields are kept after any refusal and cleared only on success. A confirmation that differs says *"The two new passwords don't match"* under it and sends nothing. The rule is shown as a hint under the new password; placeholders are valid examples (`YourCurrentPassword1`, `StrongPassword@123`). | DECIDED |
| Unknown or missing fields | `VALIDATION_FAILED` (400), never a 500 — including the old `oldPassword` name, and any field naming a user: whose password it is comes from the token only. | DECIDED |

Open: bcrypt reads only the first 72 bytes of a password, so two passwords that share those are the same password.
The field allows 200 characters. Harmless at the lengths people type; recorded rather than enforced.

## 21. A supplier's country  — raised 2026-10-16 (owner), details GUESSED

The owner, 2026-10-16: the New Supplier popup took the country as free text — "that's not good". One supplier
said "China", the next "CN", a third "الصين", and nothing could tell they were the same place.

| Question | Rule | Status |
|---|---|---|
| What is stored | The **ISO 3166-1 alpha-2 code** (`CN`, `AE`, `EG`), never the words typed. The column stays text; no schema change. | **GUESS** (recommended option, taken without asking) |
| Which countries | All 249 ISO codes. One list, `apps/api/src/common/countries.ts`; the office keeps a copy of the codes in `apps/web/src/lib/countries.ts`, pinned to the API's by `countries.test.ts`. | **GUESS** |
| What a reader sees | The country's name in the language being read — Arabic on /ar, English on /en — from the browser's own `Intl.DisplayNames`, so no names are stored or translated by hand. Never the raw code. The Suppliers list and the supplier card show it; no other screen shows a supplier's country today. | **GUESS** |
| The form | A searchable picker, on the Suppliers page and the `+` beside a supplier picker alike (one form, `entity-forms.tsx`). Found by its name in either language or by its code. **China, the Emirates, Egypt, Turkey and India first**, then the rest A–Z in the reader's language. Required. | **GUESS** — the first five are where the goods come from, home, and the next most likely; change the list in `PREFERRED_COUNTRIES`. |
| What the API accepts | A code from the list, any case (`cn` is saved as `CN`). Anything else is refused, `COUNTRY_UNKNOWN`; empty is refused, `COUNTRY_REQUIRED` — on create, and on edit when a country is sent. A name sent straight to the API is refused: the form sends codes, and a second, looser way in would let free text back. | **GUESS** |
| The assistant | Takes a country however the partner says it — "China", "الصين", "cn", "U.A.E.", "Dubai" — and saves the code. Exact match only, never a guess from a fragment: "Chin" is refused, naming China (CN) as the likely one, so the assistant asks. It reports both the code and the English name (`find_suppliers`, `create_supplier`, a new supplier on `create_purchase_order`). | **GUESS** |
| Suppliers already on file | Migration `20261016100000_supplier_country_codes` converts each country that spells one — any code, any English name, and the aliases in `countries.ts` (UAE, Dubai, Türkiye, the Arabic names of the countries the business deals with…), compared ignoring case, punctuation, spacing and Arabic spelling. Anything else is **left as it was**, shown as typed, and counted by `scripts/check-data.sh` (check 24) to be put right by hand: open the supplier and choose its country — the picker will not save until one is chosen. | **GUESS** |
| Searching suppliers by country | The Suppliers list box and `GET /suppliers?search=` find a supplier by its country's name in either language or by its code. | **GUESS** |

Not changed: a shipping leg's origin and destination are fixed places, not countries; shipping providers and
customers have no country.

## 22. Exchange rates  — DECIDED 2026-10-16 (owner asked for the page), details GUESSED

The owner, entering a past cycle with AED, CNY and USD, needs to see and set
the rates the forms start from. An office page, **Exchange rates** (`/fx-rates`),
at the foot of the menu beside Audit Logs and Settings.

| Question | Rule | Status |
|---|---|---|
| What it shows | Every currency, its rate to EGP (to four decimals) and when it last changed; "no rate yet" for a currency without one. One line: these rates only prefill forms — every order, payment and receipt keeps the rate it was recorded at, so a change here restates nothing. | DECIDED |
| Who | Every office role reads it (`GET /currency-rates` names no roles; the forms of every role prefill from it). Only a core partner changes a rate or adds a currency (`PUT`/`POST`, `@Roles('CORE_PARTNER')`). | GUESS |
| Changing a rate | `PUT /currency-rates/:code`, only for a currency already on the page (404 otherwise, so a typo in a URL makes no currency). Above zero, at most four decimals; EGP is fixed at 1. `null` still means "no rate known". | DECIDED |
| Adding a currency | `POST /currency-rates` with a three-letter code (upper-cased) and a rate, the same rules. A code already there is `CURRENCY_EXISTS`, also when two adds race. | GUESS (no removing a currency: one may be named by old records) |
| One definition | `common/fx-rate.ts` — the code and rate checks, shared with a friend's payment in his own currency (§18). | DECIDED |

## 23. Staying signed in to the office  — DECIDED 2026-10-17 (owner asked), details GUESSED

The owner, 2026-10-17, using the office as an app on his iPhone home screen: why does he have to log in every time
he opens it? The office's only token lasted 24 hours (`JWT_EXPIRATION`) and nothing renewed it, so opening the app a
day later signed him out.

| Question | Rule | Status |
|---|---|---|
| How long a sign-in lasts | **Until 30 days pass without opening the office.** Every time the app talks to the API after its access token has lapsed, it renews the sign-in, and the 30 days start again. Someone who opens it at least once a month never sees the login page. There is **no absolute limit** — a sign-in renewed every month lasts indefinitely. | DECIDED (owner's ask); 30 days and no absolute cap are **GUESS** (recommended) |
| How it works | Signing in gives two tokens. The **access token** (signed JWT, audience `internal`) lasts **1 hour** and goes with every request. The **refresh token** (256 random bits) is exchanged at `POST /auth/refresh` for a new pair. Only its SHA-256 hash is stored (`session_refresh_tokens`). | **GUESS** — 1 hour keeps a stolen access token short-lived; the refresh token is what lasts |
| Each refresh token works once | It is spent on use and replaced. A spent token presented again **more than 30 seconds** after it was spent means two holders (the app and whoever copied it), so **that whole sign-in ends on every device holding it** and both must sign in again. The same partner's other sign-ins (another device) are untouched. | DECIDED (security brief) |
| Reuse within 30 seconds | Treated as the same app racing itself (the page's requests, two tabs, the installed app and a tab): it gets its own new pair in the same sign-in, and nothing is ended — unless that sign-in was signed out meanwhile, which refuses it. | DECIDED — the owner's frontend rule (abdallah-skills building-frontends, "concurrent refreshes are normal", ≈30 s) |
| Several requests at once | Opening the app fires many requests; they share **one** refresh, within a tab and across tabs (a Web Lock). A tab that loses a race to another tab uses the winner's tokens. The 30-second window above covers whatever still gets through (a browser without Web Locks). | DECIDED |
| No signal | If the refresh cannot reach the API, the app **stays signed in** and the request fails as any offline request does; the next request tries again. Only the API refusing the refresh signs out. | **GUESS** |
| Signing out | `POST /auth/logout` revokes that sign-in (§19); the browser then forgets both tokens. Best effort, bounded at two seconds like the push release. | DECIDED |
| Changing your password | Ends every other sign-in; this device is given a new refresh token and stays signed in (§20). | **GUESS** (recommended) |
| Deactivating a user | Setting a user to INACTIVE or SUSPENDED revokes every sign-in they hold. Their access token is refused on the next request anyway (`JwtStrategy` re-reads the status). A refresh by someone no longer ACTIVE, or whose account became a shop's, is refused and ends all their sign-ins. | DECIDED (security brief) |
| A role changed after sign-in | The next refresh re-reads the user, so the new access token carries the current role and name; the office redraws with them. | DECIDED |
| Who it applies to | **The office only.** The assistant has its own OAuth refresh tokens (§16, `oauth_refresh_tokens`), which `/auth/refresh` does not accept; an assistant (MCP) access token is not a refresh token either. The storefront keeps its single `JWT_EXPIRATION` token (24h) and no refresh. | DECIDED for the office; storefront **OPEN** — the same could be done for shops if the owner wants it |
| Refusals | Every refused refresh is `SESSION_EXPIRED` (unknown, spent, revoked or expired token — a client only needs "sign in again"); a user no longer allowed in is `SESSION_INVALID`. | DECIDED |
| On release | Sessions signed in before the release have no refresh token: they end once more, when their current 24-hour token lapses, and last from the next sign-in on. Spent and expired rows stay in the table; nothing clears them yet. | **GUESS** — a periodic cleanup is cheap to add if the table grows |
