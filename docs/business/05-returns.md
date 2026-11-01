> Part of the [business rules](../BUSINESS_LOGIC.md) — the index there lists every section. Moved here verbatim 2026-11-01.

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

**Two returns at once get different numbers** — fixed 2026-10-27. `RET-YYYY-NNNNN` was taken as "the highest so far, plus one" with nothing stopping a second return from reading the same highest, so two returns recorded at the same moment could be handed one number. The series is now locked for the moment the number is chosen, as purchase orders' `PO-` is (`common/references.ts`).

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

