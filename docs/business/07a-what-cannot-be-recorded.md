> Part of the [business rules](../BUSINESS_LOGIC.md) — the index there lists every section. Moved here verbatim 2026-11-01.

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

**Nor can it be negative** (2026-10-10). A negative discount is a hidden price
rise; it is refused on every path that creates an order.

**A payment can only pay the customer who made it.** Allocation checks the
order belongs to the payer. It did not, and the picker offered every order in
the system by number, so one shop's money could clear another's debt.

**A record must point at something that exists.** A payment for an unknown
customer is a clear refusal, not a 500.

**DECIDED 2026-10-16 (with back-dated sales, §4; details a GUESS, the
recommended option) — money cannot pay for a sale that had not happened yet.**
A payment is not applied to an order sold after the day the payment was
received (`PAYMENT_BEFORE_ORDER`, naming the order, the day it was sold and the
day the money came in) — on a chosen order, oldest first and the Allocate
action alike. A payment the same day as the sale is fine. **Oldest first now
means sold first** (the sale's day), then written first: a sale back-dated to
the 1st is paid before one typed in earlier for the 8th; money left over that
could only go on a later sale is refused rather than applied. The payment
dialog's order list sorts the same way. `check-data` 25.2 watches for a payment
allocated to a sale made after it was received.

---


### A customer with branches — DECIDED 2026-10-25 (owner), built 2026-10-25, live 2026-10-27 (`d87b68b`, migration `20261025120000_customer_branches`), details GUESSED
Some shops now have several branches, each buying separately, with **one owner who pays for all**. Decided: one
customer with branches under it (option 2 of two offered; separate customers per branch was the other). Each branch
keeps its own orders, balance and statement; the customer shows the combined total; an owner's payment can go to one
branch or across several. Also decided (owner, 2026-10-25): credit and contract limits, the storefront login and the
invoice header are all the **owner's**, not each branch's. The owner picked the design from a rendered sample
(`docs/samples/branches/`), then (2026-10-25) "the branch shouldnt be required, in a sale order, it should auto
select the default branch" and "not required because default to the default".

- **A branch is not a customer.** It is a row under the customer (`customer_branches`): a name, an address, a phone,
  whether it is the default, whether it is archived. An order names its branch (`sale_orders.branch_id`); an order
  with none is on the owner. Payments, contracts, the storefront login and the invoice header stay on the customer.
- **Names**: once per customer, ignoring case and extra spaces ("LS2" and "ls2" are one branch;
  `BRANCH_NAME_TAKEN`). Required, at most 80 characters. Another customer may use the same name.
- **The default branch**: at most one per customer, held by the server and a unique index. Making one the default
  takes it off the other. An archived branch cannot be the default; archiving the default leaves none.
- **A sale order's branch** (one rule, `resolveSaleBranch`, for the office form, drafts, samples, walk-in, the
  assistant's `record_sale` and the office chat): a branch named must be this customer's (`BRANCH_NOT_THIS_CUSTOMER`)
  and not archived (`BRANCH_ARCHIVED`); none named means the customer's default branch.
  - GUESS (open): a customer with branches but **no default** — the order stays on the owner, with no branch. Ahmad
    Zogmar gets his branches with no default until the owner picks one.
  - GUESS: New Order offers a picker only when the customer has **two or more** open branches ("a customer with one
    branch picks none"); with one, the default rule decides.
  - GUESS: a sale completed from samples keeps the branch the samples were left at.
  - **Samples by branch** (owner 2026-10-27, "build it"; details in §4 "Samples by branch"): New Order lists the
    order's own branch's samples first and the others under "At other branches"; a sample taken from another branch is
    allowed and tagged with its branch. GUESS: Add all takes the order's branch only; no server refusal across
    branches of one customer.
- **Balances**: a branch owes what its confirmed orders still owe (the `owedBy` rule, narrowed). The owner owes all of
  it — every branch plus the orders on no branch; the branch figures always add up to it (they are the same orders
  split one way). Nothing is stored twice.
- **Payments** (recorded once, for the owner): to **all branches**, oldest first across every order, never more than
  the combined owed (`PAYMENT_EXCEEDS_OWED`, as before); to **one branch**, oldest first on that branch's orders only,
  never more than it owes (`PAYMENT_EXCEEDS_BRANCH_OWED`, `BRANCH_OWES_NOTHING`); on a chosen order, as before. A
  branch and an order together are refused (the order already says its branch).
  - GUESS: an **archived** branch can still be paid — it keeps its balance until settled.
- **Statements**: the owner's is every row with its branch named (a payment spread over two branches names both). One
  branch's statement is the same history narrowed to its orders, with each payment shown as the part that went there;
  it closes at that branch's balance, and the branches' closing balances (plus the orders on no branch) add up to the
  owner's. The Profit column works the same way.
- **Contracts, samples, returns and price cuts** stay on their order, so on its branch.
- **The invoice**: billed to the owner; "Deliver to" the branch, with its address and phone. GUESS: the invoice's
  Account box (balance before and after) is the **owner's** combined balance, not the branch's.
- **Who**: core partners add, edit, make default, archive and restore branches (as they edit customers); the office
  roles read them.
- **Not built**: credit and contract **limits** — the app has none today (overdue does not block a sale, above), so
  there is nothing per branch to move. The storefront shows nothing new (the owner's login sees his orders as before).
- Open, for the owner: which of Mokattam, Master and LS2 is Ahmad Zogmar's default, and the names' spelling; an
  owner with no default (above). A return's credit note lowers what its own order owes (§5), so it stays on that
  order's branch.

