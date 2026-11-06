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

**A credit note can only lower what the order still owes — DECIDED 2026-11-06
(owner).** Found in production the same day: ORD-2026-00016, a shop order for
2,000, was confirmed, paid in full in cash, then returned whole. The return form
defaulted to a credit note, and a credit note only lowered the order's
outstanding, floored at zero. The order owed nothing, so nothing went down: the
shop's balance stayed 0, no credit was kept anywhere, and no `REFUND_PAID` row was
written — cash on hand stayed 2,000 too high while the partner had handed the
cash back. The 2,000 vanished.

- A return on a credit note whose refund is more than the order's outstanding is
  **refused** (`RETURN_CREDIT_OVER_OWED`, naming the order, the refund and what is
  still owed). The partner then chooses a cash refund. The method is never
  switched quietly.
- Partly paid is the same rule: 500 owed and a return worth 800 on a credit note is
  refused. A credit that equals what is owed is allowed and leaves the order paid.
- **No method named**: a walk-in is cash (as before); a shop is a credit note when
  the refund fits within what is owed, and **cash** when it does not, so the API
  never defaults into the refusal.
- A second return is checked against what the first left: the outstanding is read
  again inside the return's transaction, under the `RET-` lock, so two returns at
  once cannot both fit against the same figure.
- The office's return dialog works out the refund of the lines picked (each unit at
  the price it is held at, as the API does) and, once it is more than is owed,
  picks Cash and disables the credit note with the reason under it.
- `returns.service.spec.ts` (API) and `return-refund-method.test.tsx` (web) hold
  the cases; TC-INV-96 in `34-business-invariants` is the invariant (written, not
  run: no e2e). ORD-2026-00016 itself is not corrected by this change.
- **OPEN (idea, not built):** split such a return — credit up to what is owed, cash
  for the rest — instead of refusing. Refusing was chosen: one return, one method,
  and the partner says which money moved.

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

