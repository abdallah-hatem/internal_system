> Part of the [business rules](../BUSINESS_LOGIC.md) — the index there lists every section. Moved here verbatim 2026-11-01.

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
  leg has left (the L3 rule deleting a delivery follows). Undoing never moves the cycle back
  — *except, since 2026-10-27, the shipment's last departure, which returns the cycle to
  Preparing (below, "a Preparing status")*. Deleting a leg-1
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
  recorded is walked through Funding and Purchasing too (and, since 2026-10-27,
  Preparing, where its orders are confirmed), each through its own
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

**DECIDED 2026-10-27 (owner) — a Preparing status between Purchasing and In
transit.** *Built 2026-10-27 on `feature/preparing-status` (migration
`20261028100000_cycle_status_preparing`), not yet on `dev`.* The owner: "it now
should be in preparation (a new status its where the website or factory
prepares your order, then next its in transit to uae)". The statuses run
Planning → Funding → Purchasing → **Preparing** → In transit (China) or Arrived
UAE (UAE direct) → … The statuses before shipping are written down once,
`BEFORE_SHIPPING` in `apps/api/src/common/cycle-statuses.ts` (Planning, Funding,
Purchasing, Preparing), with the full ordered list beside it; the office app's
copy and the stranded-drafts scripts are pinned to it by tests.
- **Purchasing → Preparing is the only way on from Purchasing** (besides
  Cancel). It is the move that confirms the cycle's draft orders (§15) — the
  order is placed, so it gains no more lines. Change status on the cycle page
  offers it; the assistant's `transition_cycle` makes it.
- **Set by itself.** A departure recorded on a cycle still in Purchasing (or
  earlier) walks it through Preparing on its way (L3): Purchasing → Preparing →
  In transit, or → Preparing → Arrived UAE → In transit to Egypt on a UAE-direct
  cycle, each step through its own checks; the orders are confirmed at the
  Preparing step, once. **The first departure moves the cycle on to In transit,
  as before**; later departures (L8) move nothing.
- Guesses, open until confirmed (2026-10-27):
  - **DECIDED 2026-10-27 (owner: "keep it as is, set by hand or on departure") — "the cycle's order is
    confirmed" means the cycle has left Purchasing (§15).** There is no other moment in this code at which a
    purchase order stops being a draft, and no confirm button on an order: the
    cycle's orders are confirmed together when it leaves Purchasing, and that
    move now always lands in Preparing. So Preparing is set by itself only
    when a departure walks the cycle through it or a departure is undone (below);
    otherwise a partner moves Purchasing → Preparing by hand when the supplier
    has the order. Finishing the wizard with no departure still leaves the
    cycle in Purchasing with its order a draft — finishing is not placing the
    order — and the wizard is not reopened on a Preparing cycle (its order can
    gain no lines).
  - **GUESS — a cycle with no purchase order cannot be Preparing**
    (`CYCLE_HAS_NO_ORDER`): at least one order line on the cycle. An order with
    no lines still refuses as before (`PO_HAS_NO_ITEMS`). Two orders, one
    already confirmed and one a draft (a cycle sent back to Purchasing and given
    a forgotten order): Preparing confirms the draft and names only it.
  - **GUESS — back from Preparing to Purchasing is allowed while nothing has
    departed** (`CYCLE_HAS_DEPARTED` once any departure is recorded on any of
    its legs), for a status set by mistake or an order forgotten. The orders
    already confirmed stay confirmed — an order is never a draft again — and
    leaving Purchasing again confirms only the drafts added since. Continue
    setup returns, as for any cycle in Purchasing.
  - **GUESS — undoing the shipment's last departure returns the cycle to
    Preparing**, never to Purchasing: nothing has left any more and the order
    is still confirmed. This applies only when it is the only departure the
    whole shipment has, nothing it carried was delivered or marked lost, and
    the cycle stands where only a departure could have put it (In transit; In
    transit to Egypt on a UAE-direct cycle). It replaces, for that one case, the
    L8 refusal "Move the cycle back first" — a move Change status could never
    make. Every other undo keeps the L8 rules: a later part of a leg that left in
    parts is undone without moving the cycle, and a second leg's only departure
    on a cycle in transit to Egypt is still refused (`DEPARTURE_IN_USE`, status).
    The cycle page says it before the click ("the cycle goes back to
    Preparing") and the toast after; the server's `undoReturnsTo` on each
    departure decides both.
  - **GUESS — a Preparing cycle can be cancelled**, under the same checks as
    cancelling from Purchasing (nothing moved in from another cycle, no friend's
    payment standing): the factory or website can fail to deliver before
    anything ships. Its orders stay confirmed on the cancelled cycle. Nothing
    moves a cancelled cycle and nothing is recorded on its shipment.
  - A Preparing cycle is not open for new purchase orders (as Purchasing is) —
    the stranded-drafts check (`scripts/confirm-stranded-orders.sh`,
    `ship-prod.sh stranded`) counts a draft on a Preparing cycle as stranded.
  - Badge violet; "Preparing" / «قيد التجهيز».

---

