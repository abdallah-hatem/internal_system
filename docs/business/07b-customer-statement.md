> Part of the [business rules](../BUSINESS_LOGIC.md) — the index there lists every section. Moved here verbatim 2026-11-01.

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

### The statement's Profit column — DECIDED 2026-10-23 (owner, picked from a rendered sample), built 2026-10-23, live 2026-10-26, details GUESSED

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

