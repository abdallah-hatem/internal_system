# Business rules

What the system actually does, and why. This is the agreed record — if a rule
here is wrong, the code is wrong and should change to match.

The BRD describes what the business wants. This describes what was decided when
the BRD left a choice open, and every such decision is marked **DECIDED** with
the date. Anything still open is marked **OPEN** and the code's current guess is
stated plainly, so nobody mistakes a guess for a decision.

Last updated 2026-09-19.

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

A leg's status is a reading of its dates, never a field anyone sets:

| Dates recorded | Leg reads |
|---|---|
| none | pending |
| departure | in transit |
| departure and arrival | arrived |

And the cycle cannot pass a point its goods have not reached:

| Cycle step | Requires |
|---|---|
| In transit (China) | leg 1 has departed |
| Arrived UAE (China) | leg 1 has arrived |
| In transit to Egypt | the last leg has departed |
| Arrived Egypt | every leg has arrived |

A UAE-direct cycle's single leg is UAE→Egypt, so arriving in the UAE asks
nothing of it — the goods are sitting at its origin and it has not started.

Arriving without a departure date, arriving before departing, and either date
in the future are all refused.

Rate-based legs derive their total rather than asking for it, so the per-piece
rate itself stays on the record. A leg can be priced in another currency with an
FX rate; everything lands in EGP.

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

---

## 3. Inventory

**Stock is tracked in batches, and this is the one rule the BRD marks CRITICAL.**
The same product bought in three cycles at three costs stays three batches. A
batch keeps its own landed cost forever.

**FIFO.** A sale draws from the oldest verified batch first. A sale spanning two
batches records a separate allocation per batch, each with the cost that batch
was bought at. That allocation is the COGS for that sale and is never
re-priced — not by a later purchase, not by a supplier refund, not by anything.

**DECIDED 2026-08-21 — confirming a sale is when the goods leave.** These are
counter sales to shops and marketplace sales; there is no separate dispatch
step in the business, so there is none in the system. Confirming reduces the
stock physically held. Cancelling or returning restores it.

**Reservations are not in use.** `InventoryReservation` exists in the schema for
holding stock against a quote, which is a real future feature, but nothing
drives it today and reserved quantity is honestly zero.

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

---

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

**DECIDED 2026-08-21 — overdue flags and notifies, nothing more.** It appears in
the overdue summary and raises a notification, at most one per plan per day. It
does **not** block new sales, warn on the sale screen, or charge a penalty. This
matches the BRD's V1 scope, and each of those is a deliberate future choice
rather than an oversight.

One active plan per customer. Agreeing a second while one is live is refused,
because two schedules would claim the same payments. Cancel and re-agree
instead.

A plan cannot promise more than the shop actually owes.

---

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

**A payment can only pay the customer who made it.** Allocation checks the
order belongs to the payer. It did not, and the picker offered every order in
the system by number, so one shop's money could clear another's debt.

**A record must point at something that exists.** A payment for an unknown
customer is a clear refusal, not a 500.

---

## 8. Cycle profit and settlement

**Profit is revenue less the cost of what actually sold**, plus anything a
supplier gave back. Revenue and cost are attributed through batch allocations,
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

**Reversing a settlement writes balancing entries and reopens the cycle.** It
never rewrites history. A reason is required.

**Paying out is not a cycle expense.** It distributes profit already earned;
counting it as a cost re-charges the cycle for its own success.

---

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
landed cost, so only other outflows count as period expenses.

**Cash flow is reported separately from profit** (BRD §11).

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
recorded, and reduces Receivables when it is **allocated** to an order. The
customer's page does both in one action; the API does not.

---

## 10. Notifications

**V1 is in-app only**, as the BRD scopes. Email and WhatsApp are deliberately
out.

Raised on: low stock, a shipment arriving, a cycle created or changing state, a
purchase order created, a partner added to a cycle, and a payment plan falling
behind.

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

**Notifications are recorded first and delivered second.** Every event writes a
notification row, then attempts a push. A push that fails must never mean a lost
notification, and a shop on an iPhone gets no push at all until the app is added
to their home screen.

---

## Still open

These are **not decided**. The code's current behaviour is stated so nobody
mistakes it for an agreement.

| Question | What the code does today |
|---|---|
| How partners split a temporary investor's fee | Recorded against a named recipient participant; the split itself is manual. BRD §19 assumes equal but does not lock it. |
| Whether leftover stock can move from a closed cycle to general inventory | It cannot. Batches stay owned by their source cycle. |
| Payment account and reconciliation workflow | One cash account, no reconciliation. `MoneyAccount` exists for more later. |
| Late penalties or interest on overdue balances | None. Overdue flags and notifies only. |
| Whether a shop can pay a deposit before an order exists | It cannot — a payment above what is owed is refused. If prepayment is real here, it needs its own concept rather than a loosened rule. |
| Blocking sales to a shop that is behind | Not blocked. Deliberate — see §7. |
| Whether a shop that is behind on payment may hold stock | It may. A request checks verification and stock, not the balance. Raised 2026-08-30 with the storefront; not decided. |

---

## Not yet safe to run the business on

Recorded here so it is not forgotten:

- **No production deployment.** Runs on one laptop via `npm run dev`.
- **The JWT secret is the development default.** Anyone reading the public
  repository can forge a login.
- **No backups.** Losing the database volume loses every financial record.
- **No real cycle has been through it.** Every figure verified so far comes from
  invented data.

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
| **Arrived** | when the shipment physically landed in Egypt | the cycle's **last dated** shipping leg's `arrivedOn` |
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

### A supplier's invoice is recorded once  — PLANNED 2026-09-19

**The same supplier invoice cannot become two purchase orders.** A purchase order
may carry the supplier's own invoice number; when it does, that number is unique
for that supplier. Numbers are compared trimmed and case-insensitively, since
`inv-001` and ` INV-001` are the same piece of paper. A receipt with no number
is allowed and is not checked. Two suppliers may use the same number. An invoice
number is at most 64 characters.

Why now: receipts are about to arrive by photograph, and the same photo sent twice
— by two partners, or by one partner who was not sure it went through — would
otherwise double the stock and the landed cost of a cycle.

---

## 16. The assistant  — PLANNED 2026-09-19

Partners can talk to the system through Claude (claude.ai, the phone app, Claude
Desktop), connected to it as an MCP server. Spec:
`docs/specs/2026-09-19-mcp-assistant.md`.

**Who.** Core partners only. A temporary investor or a shop owner is refused when
signing in. Signing in uses the partner's own login. Each Claude app a partner
connects — the phone, a laptop — signs in once, is remembered, and appears in
Settings as its own connection.

**What it may read.** Everything a core partner can see: cycles, purchase orders,
stock with arrival and receipt dates, sales, payments, customer balances, the
dashboard, FX rates.

**What it may change.** Only the intake path, from receipt to sellable stock:
suppliers, products, purchase orders and their lines, cycles, shipping legs,
cycle status, and verifying stock in. It cannot record or change sales, payments,
instalments, settlements, returns or the ledger — those stay in the office app.
This is enforced by the system, not by the assistant's good behaviour: its access
is valid nowhere except the assistant's own tools.

**Nothing is written without a confirmed preview.** Every change is first shown
to the partner as a preview. It is made only when the partner confirms, within
15 minutes, and what is made is exactly what was previewed — a changed quantity,
a different cycle, or a confirmation used twice is refused.

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
receipt already recorded — then previews the purchase order and creates it on
the partner's word. Shipping, fees and tax printed on a receipt are not purchase
order lines; the partner decides whether they belong on a shipping leg.

**Not kept.** The receipt image itself is not stored — the purchase order records
the supplier's invoice number, and the photograph stays in the conversation.

