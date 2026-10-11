# L5 — leftover stock moves to another cycle at its cost (spec)

Owner decision 2026-10-11, BUSINESS_LOGIC §8 "leftover stock can move to another cycle at its cost".
Everything not stated there was settled in this run and is written into §8 as a dated guess (2026-10-11).

## What it is

Cycle **A** has finished selling but still holds units on the shelf. Instead of closing A and writing them off,
a core partner moves some or all of them to cycle **B**, which is still open. The units leave A at exactly their
landed cost and join B at exactly that cost. A makes no profit and no loss on them; B's partners fund them.

## Data

- `StockTransfer` — from-cycle, to-cycle, `movedOn` (Cairo day), `reason`, `createdBy`, `createdAt`,
  `status` (`ACTIVE` / `REVERSED`), and when undone: `reversedAt`, `reversedBy`, `reversalReason`.
- `StockTransferLine` — product, source batch (A), destination batch (B, null once undone), qty, unit landed cost
  (the source batch's, 4 dp), cost (qty × unit, 2 dp).
- `InventoryBatch.transferredFromBatchId` — B's new batch points back at A's batch.
- Two new movement types: `TRANSFER_OUT` (on A's batch, negative) and `TRANSFER_IN` (on B's batch, positive;
  on A's batch, positive, when undone). `referenceType` `STOCK_TRANSFER`, `referenceId` the transfer.
- B's new batch: same product, same `landedUnitCostEgp`, same `arrivedOn`, same `createdAt` as the source
  (FIFO reads `createdAt`, §3 — the moved units still sell first), `VERIFIED`, no order line, no delivery line.

## Money

- Ledger, category `cycle_transfer`, no account, `relatedType` `STOCK_TRANSFER`:
  - on A: `INFLOW` of the total cost — A recovers it;
  - on B: `OUTFLOW` of the same — B pays for it.
- `cycle_transfer` is in `CAPITALISED_CATEGORIES` (not an expense, not income) and in a new
  `NOT_CASH_CATEGORIES` (no money moved), both in `common/ledger-categories.ts`. The dashboard's cash in, cash
  out and cash on hand read `NOT_CASH_CATEGORIES` through `common/cash-position.ts`.
- A's profit: unchanged — the units were never sold, so they were never in A's COGS. A's unsold value drops
  by the cost; its settlement can close without a write-off.
- B's cost to fund: `CostingService.fundingFor` → `toFund = landed + transferredIn − financed` (floor 0).
  `transferredIn` is `common/stock-transfers.ts#cycleTransfersInEgp` (active transfers into the cycle).
- B's settlement: its `project()` reads every batch on the cycle, so the moved batch is its own stock: revenue
  and COGS when sold, unsold value while not.
- Analytics' cycle profitability `investment` nets transfers, signed (out lowers A's, in raises B's).

## Rules (server, `StockTransfersService`)

| # | Rule | Refusal |
|---|---|---|
| 1 | Source is SELLING or SETTLEMENT | `TRANSFER_SOURCE_NOT_SELLING` {cycle, status} |
| 2 | Source has no PAID settlement | `TRANSFER_SOURCE_PAID` {cycle} |
| 3 | Source has every unit accounted for | `TRANSFER_SOURCE_NOT_ACCOUNTED` {cycle, onTheWay, waiting} |
| 4 | Target is not SETTLEMENT / CLOSED / CANCELLED | `TRANSFER_TARGET_CLOSED` {cycle, status} |
| 5 | Target is not the source | `TRANSFER_SAME_CYCLE` |
| 6 | Each line > 0 | `TRANSFER_QTY_NOT_POSITIVE` {product} |
| 7 | Never more than on the shelf (verified, sellable, less live holds) | `TRANSFER_MORE_THAN_ON_SHELF` {product, available, requested} |
| 8 | A product listed twice | `TRANSFER_DUPLICATE_PRODUCT` {product} |
| 9 | At least one line | `TRANSFER_NO_LINES` |
| 10 | A reason | `TRANSFER_REASON_REQUIRED` |
| 11 | Not in the future | `DATE_IN_FUTURE` (label `STOCK_MOVED`) |
| 12 | Unknown cycle / product / transfer | `NOT_FOUND` |
| 13 | Core partners only | `ROLE_NOT_ALLOWED` |

Undo (`POST /stock-transfers/:id/undo`, reason required):

| # | Rule | Refusal |
|---|---|---|
| U1 | Still active | `TRANSFER_ALREADY_UNDONE` |
| U2 | A not paid out (SELLING/SETTLEMENT, no PAID settlement) | `TRANSFER_SOURCE_PAID` |
| U3 | B not settling, closed or cancelled | `TRANSFER_TARGET_CLOSED` |
| U4 | None of the moved units touched in B: no sale allocation (any status), no hold, no return, nothing moved on, remaining = sellable = moved | `TRANSFER_UNITS_SOLD` {product, cycle} |

Undo puts the units back on A's batches (`TRANSFER_IN` movement), deletes B's batches and their movements (nothing
depends on them — U4), writes two balancing `cycle_transfer` rows (`reversalOfId` → originals), and marks the
transfer `REVERSED`. Nothing is edited in the ledger.

Also:
- B cannot be cancelled while it holds stock moved in (`CYCLE_HAS_TRANSFERS_IN`) — undo first.
- `markPaid` reads the cycle's live unsold stock, not the snapshot from calculate, so moving leftovers after
  approval lets the payout close without the write-off prompt. A transfer and its undo refresh the unsold figures
  on an open (DRAFT/APPROVED) settlement of either cycle — profit and payouts do not change.
- Both cycles are locked (`lockCycle`, id order) for the transfer and its undo.
- No service is called inside the transaction; the audit row is written after the commit.

## Edge cases (each a test)

Partial move · moving everything · more than the shelf · a product A never had · zero / negative · to itself ·
to a settling / closed / cancelled target · from a cycle still on the way / not yet selling / paid out ·
units held for a shop's request · a product listed twice · undo after a sale in B (refused) · undo after a sale in
B that was cancelled (still refused) · undo after A paid (refused) · undo twice · A's profit unchanged ·
B's cost to fund up by exactly the cost · B's settlement counts the moved units as its own · moved units sell
before B's own (FIFO by check-in) · goods-location buckets on A sum to ordered with "Moved to another cycle" ·
B shows "From CYC-A" outside its own ordered · cash on hand, cash in, cash out unchanged · dashboard profit
unchanged · B cannot be cancelled while it holds moved stock · the ledger rows cannot be reversed on their own
(they carry a `relatedType`).

## UI

- Cycle A's page: **Move leftovers** (core partner, A in SELLING/SETTLEMENT and not paid out). Dialog: target cycle
  (shared `Select`; open cycles other than A, plus "Start a new cycle for them" → the wizard, which links back with
  the new cycle chosen), the date (shared `DatePicker`), a reason, then per product on the shelf how many (all by
  default), with the cost moving.
- Settlements' `CYCLE_HAS_UNSOLD_STOCK` prompt offers **Move leftovers** for that cycle, in place, like I3's
  status-refusal fix; after a save it comes back and the payout can be tried again.
- A **Transfers** section on both cycles' pages: date, other cycle, products and units, cost, who, status, and
  **Undo** where allowed.
- Goods-location cards: A gains **Moved to another cycle**; B shows **From CYC-A** under the cards, outside its
  ordered total.
- Both locales, logical properties.

## Out of scope

The assistant (planned, §16). Moving a damaged unit (it is written off, never on the shelf).
