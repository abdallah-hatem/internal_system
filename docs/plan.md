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

### 1b. Move the document shell into the locale segment  ← small, known bug

`<html>` and `NextIntlClientProvider` live in `app/layout.tsx`, outside the
`[locale]` segment, so they never see the route's locale: `useLocale()` returns
the default on an `/ar/` route and every locale-aware redirect sends a
signed-out Arabic user to the English login page. Covered by TC-AUTH-08, marked
fixme rather than deleted.

### 2. Returns, refunds and adjustments

BRD 9 requires them and requires history to survive. There is no path at all
today. For a parts business this is a weekly event, not an edge case.

- Customer return: reverse the sale line, decide restock per policy, write a
  reversing COGS entry so cycle profit corrects itself.
- Supplier refund against a purchase: the `SupplierRefund` table exists and is
  unused. A refund reduces the cycle's landed cost, so batches already costed
  need an adjustment entry rather than a silent re-price.

### 3. Ledger reversals

The BRD forbids hard deletion of financial records and asks for
reversal/cancellation. The ledger can create entries but not reverse them, so
the only way to fix a mistake today is to edit history.

### 4. Stock reservation

`InventoryReservation` exists in the schema and nothing drives it. Confirming a
sale moves quantity to reserved, but nothing releases it, expires it, or shows
it. Until then "available" is only accidentally correct.

### 5. Notifications that reach someone

Notifications are written to the table on low stock and arrival, but the centre
is not somewhere anyone looks. Either surface them where the work happens or
accept they are an audit trail, not an alert.

### 6. Phase 2 customer portal — not before the above

A portal that shows a shop owner a balance derived from settlement logic that
cannot settle, or stock counts that ignore reservations, is worse than no
portal. Hold it.

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
