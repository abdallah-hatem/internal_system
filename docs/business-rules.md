# Business rules

What the system actually does, and why. This is the agreed record — if a rule
here is wrong, the code is wrong and should change to match.

The BRD describes what the business wants. This describes what was decided when
the BRD left a choice open, and every such decision is marked **DECIDED** with
the date. Anything still open is marked **OPEN** and the code's current guess is
stated plainly, so nobody mistakes a guess for a decision.

Last updated 2026-08-21.

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

Selling more than is available is refused, and the whole confirmation rolls
back: no partial allocation is ever left behind.

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

## 8. Cycle profit and settlement

**Profit is revenue less the cost of what actually sold**, plus anything a
supplier gave back. Revenue and cost are attributed through batch allocations,
not through the cycle's own transactions — a FIFO sale can span batches from
several cycles, so a sale's revenue is deliberately recorded without a cycle.

**Unsold stock keeps its cost with the cycle.** Profit therefore covers sold
units only, and the settlement screen says so.

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

## Still open

These are **not decided**. The code's current behaviour is stated so nobody
mistakes it for an agreement.

| Question | What the code does today |
|---|---|
| How partners split a temporary investor's fee | Recorded against a named recipient participant; the split itself is manual. BRD §19 assumes equal but does not lock it. |
| Whether leftover stock can move from a closed cycle to general inventory | It cannot. Batches stay owned by their source cycle. |
| Payment account and reconciliation workflow | One cash account, no reconciliation. `MoneyAccount` exists for more later. |
| Late penalties or interest on overdue balances | None. Overdue flags and notifies only. |
| Blocking sales to a shop that is behind | Not blocked. Deliberate — see §7. |

---

## Not yet safe to run the business on

Recorded here so it is not forgotten:

- **No production deployment.** Runs on one laptop via `npm run dev`.
- **The JWT secret is the development default.** Anyone reading the public
  repository can forge a login.
- **No backups.** Losing the database volume loses every financial record.
- **No real cycle has been through it.** Every figure verified so far comes from
  invented data.
