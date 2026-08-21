# Implementation plan

Status as of 2026-08-20. Written after working through the running system, so
the ordering reflects what is actually broken rather than what the BRD lists.

## Where the build stands

Phase 1 is roughly 70% complete by surface area — 18 API modules, 22 screens,
38 tables, bilingual — but the remaining work is concentrated in the money
path, which is the part the business runs on.

Working and verified end to end:

- Import cycles with both route shapes, and per-leg shipment cost charged by
  piece, by weight, or as a flat combined payment.
- Landed cost: shipping is spread across the goods it moved and lands on the
  batch, so cost of sale includes freight.
- Batch inventory with FIFO allocation. A sale spanning two batches at
  different costs takes the older first and keeps each batch's own cost
  forever, which is the BRD's one CRITICAL requirement.
- Cycle profit: revenue, COGS, gross profit, proportional participant shares,
  and a temporary investor's fee taken from their profit rather than capital.
- Analytics that reconcile with each other.

## The order I would build in

### 1. Make settling a cycle real  ← DONE 2026-08-20

Settlement calculated correctly but could not conclude: `approve`, `markPaid`
and `reverse` were status flips, so paying partners wrote nothing to the ledger,
reversing undid nothing, and no cycle ever reached CLOSED.

Now: paying writes one ledger entry per participant and closes the cycle;
closing while stock remains is refused unless explicitly accepted, because that
stock's cost stays with the cycle; reversing writes balancing entries and
reopens the cycle rather than rewriting history.

Two defects found while building it, both of which would have corrupted every
later cycle:

- The payout counted the investor-fee line, which is a memo of a deduction
  already inside that participant's profit share. Payouts disagreed with the
  settlement screen and did not reconcile to capital plus profit.
- Settlement payouts were being counted as cycle expenses on any later
  recalculation, turning an 11,620 profit into a 100,871 loss. Paying out
  distributes profit already earned; it is not a cost of earning it.

### 1b. The Arabic login redirect  ← DONE 2026-08-21

Two separate causes, and I had only diagnosed one.

The document shell did sit outside the `[locale]` segment, so `useLocale()`
returned the default and `<html lang>`/`dir` were wrong. Moving it into
`app/[locale]/layout.tsx` fixed that — and immediately surfaced three whole
namespaces with no Arabic at all (providers, categories, wizard), which had been
masked while the locale never really resolved. Those are translated now, and
the two files are at full parity.

But the redirect itself had a different cause: the API client's 401 handler
hard-navigated to a hardcoded `/en/login`. A signed-out page fires queries, they
401, and that navigation overrode whatever the route guard had correctly
decided. It now keeps the locale from the current path.

Worth remembering: the structural fix alone would not have fixed the reported
bug, and the one-line fix alone would have left lang, dir and the missing
translations broken.

### 2. Customer returns  ← DONE 2026-08-21

Goods go back to the batch they were sold from, at the cost they left at,
because the same product sits in several batches at different landed costs and
restocking "the product" would quietly re-price inventory.

The original sale is never edited: a return is its own record, and what changes
is derived — the customer owes less, the stock is back, the COGS is reversed.
Damaged goods are refunded but written off rather than restocked. Credit note
by default, cash refund on request.

Returns net off every profit figure: cycle profitability, the dashboard,
revenue by month (in the month they came back, so a reported month does not
move) and top products. Missing any one of those made two pages disagree about
the same sales, which is how the reconciliation tests earn their keep.

### 2b. Supplier refunds  ← DONE 2026-08-21

The endpoint and UI already existed but the refund was inert — a row and an
audit entry, nothing more. It now reaches the ledger as an inflow on the cycle
and nets off cycle investment and settlement expenses.

It deliberately does not re-price batches: units already sold keep the cost they
were sold at, and a settlement may already be agreed on it. Refunding more than
the order was worth is refused.

### 3. Ledger reversals  ← DONE 2026-08-21

My earlier note here was wrong: the reversal endpoint already existed and
already wrote a balancing entry. What was missing were the guards, and without
them the feature was a way to corrupt the ledger rather than correct it.

- Reversing twice is refused; two balancing entries against one original
  double-count the correction.
- A reversal cannot itself be reversed — that chain nets to nothing while
  obscuring what happened.
- An entry raised by a flow (a settlement payout, a sale's revenue, a payment)
  cannot be reversed on its own: the ledger and the record it describes would
  stop agreeing. Those have their own reversal paths, and the error says so.
- A reason is required, and the reversal is audited.

### 4. Stock quantities  ← DONE 2026-08-21

This turned out to be a correctness bug rather than a missing feature.

Confirming a sale moved saleable to reserved and never reduced remainingQty,
and nothing ever released the reservation. remainingQty therefore still counted
goods that had left the building, which inflated inventory value on the
dashboard and the unsold-stock figure a cycle is closed on — the figure that
decides whether closing is even allowed. Returns then added to remainingQty,
so a batch could hold more units than ever arrived; one held 122 of 100.

Confirming a sale is now the point the goods leave, because these are counter
sales to shops and marketplace sales with no separate dispatch step. Remaining
falls on confirm and is restored on cancel or return. A migration rebuilds the
three quantities on existing batches from the movements that actually happened.

`InventoryReservation` is still unused. It is the right home for holding stock
against a quote, which is a genuine feature — but it is not what was breaking
the numbers, and reserved is now honestly zero rather than a growing figure
nobody could clear.

### 5. Notifications  ← DONE 2026-08-21

The events were being raised all along and reached nobody: the header bell
showed a hardcoded 3 and did nothing when clicked.

It now shows the real unread count, opens the recent items with mark-read and
mark-all, and links to the full list. No badge when nothing is unread. The user
chip beside it was hardcoded too — every partner saw "Admin" on a system whose
point is that actions are attributable.

Still in-app only, as the BRD scopes for V1. Email and WhatsApp remain
deliberately out.

### 6. Phase 2 customer portal — not before the above

A portal that shows a shop owner a balance derived from settlement logic that
cannot settle, or stock counts that ignore reservations, is worse than no
portal. Hold it.

## Test isolation  ← DONE 2026-08-21

The suite shares one API and one database, and ten spec files pick "the first
confirmed order" or "a batch with stock", so what they found depended on what
earlier runs had left behind. Three tests in one day passed alone and failed in
a full run, each costing a diagnosis before establishing the code was fine.

globalSetup now snapshots the developer's database, resets to the seeded state,
and restores the snapshot afterwards — the development database is also the
test database, so a run must not cost anyone their data. Two consecutive full
runs now give identical results.

Still to do: per-test fixtures that create their own data, so tests stop
scavenging from each other within a run.

## Two things worth doing early because they get harder later

**Decide the TBDs.** The BRD leaves four open and the code currently guesses at
all of them: the Sunday installment and overdue rules, the return policy,
what happens to unsold stock when a cycle closes, and how the partners split a
temporary investor's fee. Each guess is now embedded in behaviour and tests.

**Prove CI.** The workflow exists but has never run against a real push. It is
worth confirming before it is needed.

## How I would sequence the work itself

Finish the cycle lifecycle end to end for one real import before broadening.
Run an actual cycle through the system — real supplier, real shipping invoice,
real sales, real settlement — and let it expose what is wrong. An hour of
poking at the running app produced six real defects this session; a real cycle
will produce more, and they will be the ones that matter.
