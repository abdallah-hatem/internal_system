# Customers with branches — sample notes (2026-10-25)

**Update, 2026-10-25:** the owner first chose a lighter "Deliver to" instead, then said "make full branches again".
Full branches are now built from this design (branch `agent-branches-sample`; the rules are in BUSINESS_LOGIC §7
"A customer with branches"). Differences from this sample: there is no credit limit (the app has none), the payments
table has no "Went to" column, and a sale order's branch cannot be cleared — with none sent, it goes on the default.

This was a sample only when written. The pages next to this file show how it could look:

- `customer-page.html`: Ahmad Zogmar as the owner, with Mokattam, Master and LS2.
- `new-order.html`: New Order for him, picking a branch.
- `new-order-ar.html`: the same New Order in Arabic.

The figures on the pages are made up so there is something to add up. Ahmad Zogmar owes 0 today and has no open
orders. A dashed amber outline marks what is new; the checkbox at the top turns the marks off so the page reads as
it would in the app.

Already decided (BUILD_LOG "Next up", BUSINESS_LOGIC §7, owner 2026-10-25): one customer with branches under it,
never a separate customer per branch. Each branch has its own orders, balance and statement. The customer shows the
combined total. One payment can go to one branch or across several. Credit and contract limits, the storefront login
and the invoice header belong to the owner.

The owner's review of this sample (2026-10-25): "I like the design, I guess the branch shouldnt be required, in a
sale order, it should auto select the default branch". The samples now show this: each owner has a default branch,
and on a sale order the branch is optional and filled in from that default.

## 1. Where the data lives

### Recommended: a small branch table under the customer

```
CustomerBranch
  id, customerId (the owner), name, phone?, address?, isActive, createdAt
Customer
  + defaultBranchId?   (one of his own branches; null = no default)
SaleOrder
  + branchId?   (optional; null = the owner himself, as every order is today)
```

- **The default branch** (owner, 2026-10-25: "it should auto select the default branch"). It is kept on the
  customer as `defaultBranchId`, not as an `isDefault` flag on each branch. A flag would allow two defaults, or none
  after a branch is closed, unless extra checks prevent it. One column on the owner can only ever name one branch.
  The server checks that it names one of his own active branches. Closing the default branch clears it.

- The owner stays one `Customer` row. His payments, login (`shopOwnerUserId`), contracts and credit stay where they
  are now.
- A branch holds only what makes it a branch: a name, where to deliver and who to call.
- An order names its branch. A branch's balance is what its orders still owe. It is worked out the same way as the
  customer's balance today, using only that branch's orders.
- Payments do not need a branch. A payment already belongs to the owner and is put on orders, and each order says
  which branch it is for. "Paid to LS2" just means "the money went on LS2's orders".
- A customer with no branches has no branch rows, so nothing changes for him. This matches "no data change for
  them".

Good: it matches what was decided (a branch is never a customer). There is only one place for the credit, the login,
the invoice header and the payments, so they cannot differ between branches. The change is small: one table and one
optional column.

Cost: lists and reports that group by customer keep working. Anything that should name the branch has to read
`branchId` and show it: statement rows, the sales list, the invoice's delivery line and the order popup.

### Considered, not recommended: `Customer.parentId` (each branch is a customer with a parent)

Good: orders, payments and statements would work per branch with little new code, because they already hang off a
customer.

Bad: it goes against the decision that a branch is never a separate customer record. Every place that adds up money
by customer would have to learn to add a parent and its children together: the balance, the "cannot pay more than
owed" check, contracts, overdue, the storefront login, analytics and the customers list. Any one it misses shows a
wrong figure. An owner's payment would belong to one customer row but pay another row's orders. Today's rule "a
payment can only pay the customer who made it" (§7a) forbids that. Branches would also show up in every customer
picker unless they were hidden everywhere. Too many places to get wrong.

## 2. How the money adds up

- **A branch's balance** = what its confirmed orders still owe (today's rule, using only its orders).
- **The owner's balance ("Owes us")** = all his orders: every branch, plus any order with no branch. It is always
  the branch figures added together plus "no branch". It is never stored on its own, so it cannot disagree with them.
- **Paid** on the customer page = all the owner's payments (payments belong to the owner).
- **A payment** is recorded once, for the owner:
  - "One branch": oldest first across that branch's orders only.
  - "All branches": oldest first across all his orders, whatever the branch. Picking orders by hand still works.
  - It can never be more than what is owed on what was chosen (that branch's balance, or the combined balance).
- **Statement**: one statement for the owner, with the branch named on every row, closing at the combined balance.
  Filtered to one branch, it shows only that branch's rows and closes at that branch's balance. A payment split over
  two branches shows on each branch's statement as the part that went there.
- **Profit column**: each row as today. A branch's statement adds up only its own rows.
- **Contracts, samples, returns and price cuts** stay on the order, so they land on that order's branch.
- **Credit and contract limits**: checked against the owner's combined balance, whichever branch is ordering.

Important: **the app has no credit limit today**, and there is no field for one on the customer. §7 also says
overdue "does not block new sales, warn on the sale screen". The New Order sample shows the owner's position against
a 50,000 limit as information only. Whether there is a limit, and what happens when an order goes over it, is open
question 1.

## 3. What the samples show

Customer page (owner):
- The usual header with an "Owner · 3 branches" tag under the name.
- The same three tiles. "Owes us" is the total across branches and says so.
- A new **Credit and Contract** card with the owner's figures.
- A new **Branches** card: one row per branch with address and phone, orders, sold, paid and owes. A total row adds
  up to the same figure as the tile. The default branch has a **Default** tag (Mokattam in the sample, only as an
  example). Each other branch has **Make default**, which moves the default to it.
- Orders: the same table with a **Branch** column and a branch filter (All, Mokattam, Master, LS2).
- Payments: as today, plus a "Went to" column (for example "Mokattam 3,000.00 · Master 6,000.00").
- Contracts: as today, each naming its order's branch.
- Statement: as today, with a Branch column and a branch filter.

New Order:
- After choosing Ahmad Zogmar, a **Branch** picker appears next to the customer. It only appears for a customer with
  more than one branch. Each option shows what that branch owes.
- **The branch is not required** (owner, 2026-10-25). Choosing the owner's name picks his **default branch** for
  you. The person can change it to another branch. There is no "clear" (owner, 2026-10-25: "not required because
  default to the default"): an order sent without a branch goes on the default branch.
  - A value the person picked is never overwritten. Only choosing the customer (again) fills in his default.
  - The server does the same when no branch is sent: it does not refuse the order. A branch that is sent must be one
    of this customer's own active branches.
- Under it, a box: who pays (the owner), what this branch owes, what the owner owes across all branches, and the
  credit line if a limit is set.
- A line saying how the invoice will read, and a sample invoice header: **Bill to** Ahmad Zogmar, **Deliver to**
  Mokattam branch with the branch phone. With no branch, the invoice has no delivery line.

## 4. Open questions for the owner

1. **Is there a credit limit?** None exists today. If there is one: a single figure for the owner across all
   branches (as decided)? When an order would go over it, should the app warn and let it through, or refuse it?
2. **Contract limit**: today a customer can have one active instalment plan. With branches, is it still one for the
   owner, or one per branch (contracts sit on an order, so on a branch)?
3. **Invoice**: "Bill to" the owner, with "Deliver to: LS2 branch" and the branch phone under it. Is that right? The
   invoice also has an "Account" box (balance before and after). Should it show the owner's combined balance or the
   branch's own?
4. **Prices**: can a branch have its own prices or discount, or does it always buy at the owner's? Today prices are
   set per channel (B2B or B2C), not per customer, so "same as the owner" needs no work.
5. **Contact**: does each branch have its own phone and address? Its own contact person?
6. **Returns**: a return on an LS2 order lowers what LS2 owes. Can a credit from it pay a Mokattam order, or does it
   stay with LS2?
7. **Payments**: when the owner pays without naming a branch, the money goes oldest first across all branches. Is
   that right?
8. **Storefront**: there is one login, the owner's (decided). Does he see each branch's orders and balance as well as
   the total? Will a branch manager ever need a login that sees only his branch?
9. **An existing customer that is really a branch**: if another shop is already its own customer, do we move it
   under an owner (its orders and payments move with it) or keep it separate? Moving money between customers is the
   risky part.
10. **Ahmad Zogmar's old orders**: he has none open today. Any orders he already has stay on "no branch" unless you
    say which branch each one was. Is that right?
11. **Names**: are Mokattam, Master and LS2 spelled exactly as they should print on an invoice? In Arabic: المقطم،
    ماستر، LS2?
12. **Closing a branch**: a closed branch takes no new orders but keeps its history and balance until it is paid.
    Is that right?
13. **A customer with one branch** picks none on New Order (decided). Should his page still show the Branches card?
14. **Ahmad Zogmar's default branch**: which one is it, Mokattam, Master or LS2? The sample shows Mokattam only as an
    example.
15. **An owner with no default set**: does a new order sit on the owner, with no branch, until someone picks one?
    The sample assumes yes.
