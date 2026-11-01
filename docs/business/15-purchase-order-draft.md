> Part of the [business rules](../BUSINESS_LOGIC.md) — the index there lists every section. Moved here verbatim 2026-11-01.

## 15. When a purchase order stops being a draft  — DECIDED 2026-09-09

**A purchase order is confirmed when its cycle leaves PURCHASING.**

`PURCHASING -> IN_TRANSIT` and `PURCHASING -> ARRIVED_UAE` both mean the goods
are moving, so the order was placed in the world and can no longer gain lines.
*Since 2026-10-27 (§1, Preparing) the way on from PURCHASING is `PURCHASING ->
PREPARING`: the order is placed and being prepared. A cycle sent back from
PREPARING keeps its orders confirmed; leaving again confirms only drafts added
since.*
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

