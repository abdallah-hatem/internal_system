> Part of the [business rules](../BUSINESS_LOGIC.md) — the index there lists every section. Moved here verbatim 2026-11-01.

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
landed cost, so only other outflows count as period expenses — and goods lost
on the way (§2), which are not a ledger entry at all.

**DECIDED 2026-10-10 — a loss is not money moving.** *Built 2026-10-11 (B2, B3).* The cash for
the goods left when they were bought, so marking them lost moves no money and
writes no ledger entry. The loss is its own record, and profit — on the
settlement and on the dashboard, read through one shared definition — subtracts
it.

**Cash flow is reported separately from profit** (BRD §11).

**Guess 2026-10-11 (L5, open until confirmed) — a transfer of leftovers between
cycles is a ledger pair, not money.** Moving leftover stock to another cycle at
its cost (§8) writes a `cycle_transfer` INFLOW on the giving cycle and the same
OUTFLOW on the taking one. They net to zero across the
business and are left out of cash in, cash out and cash on hand
(`NOT_CASH_CATEGORIES`, `common/cash-position.ts`), and out of every expense and
profit figure (`CAPITALISED_CATEGORIES`). Undoing the move writes the mirror pair.

**DECIDED 2026-08-22 — the ledger records money as it is received, not as it
is earned.** Confirming a sale raises no ledger entry; a payment does. Revenue
was previously booked at both points, so 31,200 of orders produced 72,710 of
ledger revenue.

The sale is not lost by this — the order records it — and the difference
between the two is money still to come. The dashboard shows all three side by
side, because a strong month of selling and an empty till look identical if
only one figure is given:

| Figure | Means |
|---|---|
| Revenue | what has been sold |
| Collected | what has actually arrived |
| Receivables | the gap: sold, not yet paid for |

Note the two are separated by a step: a payment adds to Collected when it is
recorded, and reduces Receivables when it is **allocated** to an order. Both
the customer's page and a payment recorded against a chosen order (§7) do both
in one action.

**DECIDED 2026-10-11 (owner, mockup accepted) — a manual entry can't lie.**
*Built 2026-10-12 (L6): API, form, unit tests and the browser e2e (spec 99-ledger-entry, 34 TC-INV-54..58).*
The ledger's "New Entry" form offered system types like Purchase, a free-text
category, an Inflow/Outflow radio, a free-text cycle id and no date, and
`POST /ledger` saved whatever it was sent — a partner could write `purchase`,
`contribution` or `settlement` in either direction and silently move cash,
profit or a settlement. Now "Record money in or out":

- **Two kinds, and the kind sets the direction.** *An expense* (money we spent:
  out) or *other income* (money in that isn't a sale, a customer payment, a
  contribution or a refund: in). There is no direction to choose.
- **Categories come from one fixed list**, `common/manual-ledger-categories.ts`,
  which the API validates against and the web form and the ledger's category
  filter offer (the web holds a copy only because Next cannot import across apps;
  a test fails if they differ).
  - Expense: rent, salaries, utilities, transport and delivery, fuel, packaging,
    marketing, bank fees, customs and clearance, extra freight (for a cycle), other.
  - **Fuel** (added 2026-10-17, owner: fuelling the delivery car is a regular expense). A **Fuel** quick-action
    button (core partners, who alone may write the ledger) opens this same form in place already on Expense → Fuel,
    dated today, no cycle; only the amount (and a note, if wanted) is typed. No cycle means it is a running cost,
    shared to the cycles running like rent (§8, 2026-11-08); charge it to a cycle by picking one. Not automatic:
    fuel is a different amount each time, so a schedule would record figures nobody paid.
    **It lives on the Ledger page only** (owner 2026-10-18: "remove fuel from dashboard"): a labelled "Quick
    actions" strip under the page title — set apart from Add entry and Export, which stay the page's toolbar —
    shown to core partners only, same form, same refresh. History: it began on the dashboard (2026-10-17), was
    added to the ledger page on 2026-10-18, and left the dashboard the same day.
  - Other income: other income, interest, other.
- **Refused by the server**, each with a code in both languages: any other
  category (`LEDGER_CATEGORY_NOT_MANUAL` — every system category, free text,
  wrong case), a category of the other kind (`LEDGER_CATEGORY_WRONG_KIND`), a
  direction or type that disagrees with the kind (`LEDGER_DIRECTION_MISMATCH`,
  `LEDGER_TYPE_NOT_MANUAL`), an amount of zero or less, a foreign currency
  without a rate above zero, pounds at a rate other than 1, a day that is not a
  real calendar day or has not arrived in Cairo, and any field a flow sets
  (`relatedType`, `reversalOfId` — refused as unknown fields).
- **Charge to a cycle** is optional; **extra freight requires one** — a late
  freight charge is a cost of that cycle's goods (§2). The cycle must exist (a
  404, never a 500, for an unknown id or a cycle code typed in its place) and
  must not be cancelled or closed (`LEDGER_CYCLE_NOT_OPEN`). A cycle in
  settlement still takes a late cost.
- **Core partners only**, as before; the office reads the ledger and does not
  write it. Reversing stays core partners only.
- **The date** is its own column, `occurred_on`, the Cairo day the money moved;
  today by default. Rows written before this have none and show when they were
  entered, as they always did.
- **A reversal is dated the day it is undone** (Cairo), not the original's day, and carries the original's
  foreign amount and currency so both rows read the same money.
- **Old rows keep working.** A free-text category written before this shows as
  written, still counts as it did, and can still be reversed.

What each counts as — one definition each in `common/ledger-categories.ts`,
read by settlement, the cycle's profit and the dashboard alike (rule 11):

- **A manual expense is an operating expense** — the dashboard's Expenses —
  because `NOT_OPERATING_EXPENSE` does not list it (`operatingExpenseEgp`).
- **Charged to a cycle, it comes off that cycle's profit** on the settlement
  *and* on the cycle's page and Analytics. Found while building this: settlement
  already charged a cycle-linked expense, the cycle profitability did not, so the
  two showed different profits for the same cycle. They now agree; the cycle
  page shows "Expenses charged to it".
- **Other income raises net profit but is not Revenue** — shown on its own, like
  recoveries (`totalOtherIncomeEgp` on the dashboard figures). Credited to a
  cycle, it raises that cycle's profit on the settlement and the cycle page.
- **A reversed entry stops counting.** Found while building this: every reader
  summed only the outflows, so a reversed expense stayed in Expenses for good, and
  undone income (money out under an income category) would have counted as an
  expense. Both now net through the signed readings.
- **Reversing an entry charged to a closed or cancelled cycle is refused** — its
  profit was settled and paid on the figure as it stood.

**FIXED 2026-10-12 — a sale return is not an expense.** A return already comes
off Revenue (the dashboard subtracts its refund from the realised orders), but
its two ledger rows — the sale undone (`revenue` going out) and, for a cash
refund, the cash handed back (`refund` going out) — were also counted in the
dashboard's Expenses, so a 300 cash refund took 900 off net profit. Sales
categories (`SALE_CATEGORIES`) are now outside operating expenses through the
one definition. Settlement and the cycle profitability were not affected: a
return's rows carry no cycle.

**FIXED 2026-10-12 (L7) — cash on hand counts only cash handed back.** The sale undone (`SALE_RETURN`) moves no money, so cash on hand, cash in and cash out leave it out (`NOT_CASH_TYPES`, through `common/cash-position.ts`); the cash refund (`REFUND_PAID`) is still cash out. A 300 cash refund lowers cash by 300, a credit-note return by nothing. By type, not category: `revenue` is also a customer's payment coming in, which is cash.

**DECIDED 2026-10-26 (owner) — an entry undone and its undo leave every period's figures, not only cash.** Found in
production: a 3,338.82 bank fee on CYC-2026-0001 dated 15 July, undone on 26 October, put **−3,338.82** into the
dashboard's This month Expenses (the month held only the undo) while July kept the fee. Now Expenses, Other income
and Recovered — the dashboard's all-time and This month figures and every Profit and loss period and bucket — leave
out an entry that was undone **and** its undo, whichever periods they fall in: July 0, October 0, all time 0. One rule
for cash and profit alike, `apps/api/src/common/undone-entries.ts` (`undoneEntryIds`, `standingEntriesWhere`), read by
`cashPosition` and `AnalyticsService.profitParts` (rule 11). All-time figures are unchanged (the pair always netted to
zero). A settlement's expenses, the cycle page's "expenses charged to it" and the cycle's cost still read the cycle's
rows net of reversals (`operatingExpenseEgp`): over a cycle's whole life the pair nets to zero, so both read 0 for a
reversed pair and count an unreversed one once (tested); neither counts one half. *Supersedes, for profit figures, the
2026-10-18 line below that "a September expense undone in October lowers October".*

**FIXED 2026-10-17 — an entry that was undone is not cash, and neither is its undo.** A lender's payment entered at 6,509.86 AED, undone and entered again at 8,302.60 AED put 90,161.56 into both cash in and cash paid out (cash on hand, where the pair cancels, was right). An undone entry and the row that undoes it record a mistake and its correction, not money moving, so cash in and cash out leave both out (`common/cash-position.ts`). Every undo mirrors its entry's full amount, so cash on hand is unchanged. Any later correction is covered by the same rule. Active cycles counts neither closed nor cancelled cycles (`CLOSED_CYCLE_STATUSES`); it read closed alone.

Guesses made while building it (2026-10-11, open until confirmed):

- **Foreign money is stored in pounds.** `amount` is the pounds figure (amount ×
  the rate entered, to the piastre) with currency EGP, because the settlement and
  the dashboard sum `amount` as pounds; what was actually paid is kept beside it
  (`original_amount`, `original_currency`) and shown on the entry. Recording the
  foreign figure as `amount` would have been summed as if it were pounds.
- **Income "Other" has its own key** (`income_other`), distinct from the expense
  "Other" (`other_expense`), so the category alone says which kind a row is.
- **Other income on the dashboard** is added to net profit and returned as its
  own figure; no separate tile was added (recoveries have none either).
- **A cycle in settlement still takes a late cost**, per the rule as given (only
  cancelled and closed are shut). Approving or paying a settlement after such an
  entry uses the figure as it then stands.
- **The ledger's date filter still reads when an entry was entered**, not its
  `occurred_on`.

---

**Money accounts — removed 2026-10-14 (DECIDED by the owner: "we don't need
money accounts").** The ledger records what moved, how much, when and for which
cycle — never which box or bank it moved through. The `money_accounts` and
`reconciliation_entries` tables, and the account link on ledger rows and on a
friend's repayments, were dropped (migration
`20261014120000_drop_money_accounts`). Production's two accounts (Business Bank
Account, Home Storage Room Cash) had already been deleted and nothing pointed at
them; the migration refuses to run, changing nothing, if a ledger row, a
repayment or a reconciliation entry still names one. `GET /ledger/accounts` is
gone (a 404), the ledger shows no Account column or line, and a body that names
an account — a repayment's included — is refused as an unknown field
(`VALIDATION_FAILED`). No seed creates one. Spec 34 TC-INV-38, 99-ledger-entry
TC-L6-08.

### "Paid by" on an expense — DECIDED 2026-10-26 (owner), built 2026-10-27 on `feature/expense-paid-by` (migration `20261027180000_expense_paid_by`), NOT shipped, details GUESSED
The owner (2026-10-26, "build it" 2026-10-27): an expense can be paid by the business or by one of the partners — fuel
for a delivery paid from a partner's own pocket. It is still booked as the same expense (charged to a cycle, or a
running cost shared from payouts, as today), but no business cash leaves and the partner's running account (§8) is
credited with it: the business owes it back; he withdraws it or leaves it in for a contribution. The Ledger form and
the Fuel quick action get a **Paid by** picker, defaulting to the business. Reversing the expense reverses the credit;
the account may not go negative.

Built (API, office screens, Postgres and unit tests; e2e written, not run — owner: not for now):

- **The expense is the same row.** `POST /ledger` takes an optional `paidByUserId`. The ledger row is written exactly
  as any manual expense — category, cycle, day, pounds — and names the payer in a new column, `paid_by_user_id`. Every
  profit reader (operating expenses, the P&L, the dashboard's Expenses and net profit, a cycle's profit and settlement,
  running-cost shares and their charge from payouts) reads it as before, because none of them asks who paid (tested
  against a business-paid twin: every figure but cash moves identically).
- **Not cash.** Which ledger rows are cash has one definition, `CASH_ROWS_WHERE` in `common/cash-position.ts` (CLAUDE.md
  §11): it now leaves out a row a partner paid, alongside `NOT_CASH_CATEGORIES` and `NOT_CASH_TYPES`. So cash in, cash
  out, cash on hand and the P&L's Cash paid out do not move (tested).
- **The credit.** A new account movement kind, `EXPENSE_PAID` (+ his balance), one per ledger row
  (`partner_account_movements.expense_entry_id`, unique), written in the same transaction as the row. The balance and
  its pots stay one definition (`common/partner-account.ts`: `MOVEMENT_SIGN`, `potsOf`); the Partners page shows it as
  "Expense he paid" and a total "Expenses he paid".
- **Reversing** the expense (`POST /ledger/:id/reverse`) marks the credit reversed in the same transaction, under his
  account's lock; the undo row names the same payer, so it is not cash either. The credit cannot be reversed from his
  account on its own (`ACCOUNT_EXPENSE_REVERSE_ON_LEDGER`): the ledger would keep an expense nobody owes him for.
- **Refusals** (coded, en + ar): `LEDGER_PAYER_NOT_PARTNER` (an investor, the office's ADMIN_SUPPORT login, an id that
  is nobody, not an id), `LEDGER_PAYER_INACTIVE` (`partner`: a partner who has left), `LEDGER_PAID_BY_ONLY_EXPENSE`
  (income with a payer), `EXPENSE_CREDIT_ALREADY_TAKEN` (`partner`, `amount`, `available`) and every refusal a manual
  entry already had (zero or negative, a future day, a closed or cancelled cycle). Nothing is written on a refusal.
- **Who records it**: core partners, as for every manual entry (`POST /ledger` is `CORE_PARTNER` only, CLAUDE.md §12).
- **The screens**: the entry form (Add entry and the Fuel quick action are the same form) shows Paid by for an expense
  only, opening on "The business"; choosing a partner says "No business cash leaves: {partner}'s account is credited
  with it…". The form is mounted fresh on every open, so a partner chosen and cancelled is never the next entry's payer
  (tested). The ledger row says "Paid by {partner}", and its detail too.
- **Data check** (`scripts/check-data.sh`): 28 and 28.6 count `EXPENSE_PAID` as money in / untied money; new 28.3 (an
  `EXPENSE_PAID` credit no standing expense matches — missing row, an undo, not money out, another payer, other pounds,
  or standing while its expense is undone / undone while its expense stands), 28.4 (an expense paid by a partner with no
  credit), 28.5 (an undo naming another payer than its expense).

| Question | Guess built | Why |
|---|---|---|
| What the credit is | A new movement kind `EXPENSE_PAID` linked to its ledger row (`expense_entry_id`), not a ledger category and not an advance. The ledger row stays the expense; the movement is only "the business owes him this". | CLAUDE.md §11: what it is NOT — not cash, not a contribution, not income. An advance paid a supplier for a cycle's goods; this is a cost the business had. |
| Which pot it is in | **Untied money**, whatever the expense was charged to: he may take it out or leave it in to fund any cycle. Written with no cycle. | "He withdraws it or leaves it in for a contribution." |
| How a reversal shows | The movement stays, marked reversed with the expense's reversal reason (as every account reversal), and the ledger keeps the expense and its undo, both naming him. | §9: history is never rewritten. |
| Reversing after he took the money out (or drew it into a contribution) | **Refused**, `EXPENSE_CREDIT_ALREADY_TAKEN`, naming what was credited and what his account still holds untied. Undo the withdrawal or the contribution first, then the expense. Nothing is written. | An account never goes negative (owner 2026-10-25). |
| Who can be the payer | **Active core partners only.** An investor never: he is not one of "the partners", and his money is his investment in one cycle, not a running account (§8: "who an account is"). A partner who has left: refused (GUESS). | Owner: "one of the partners". |
| Recording for another partner | Any core partner may record an expense paid by any other; the named partner is credited, never the one typing it. | As for advances (§8: one person keeps the books). |
| A cycle in Settlement, or Closed | As for any manual expense: a cycle in **Settlement** still takes the late cost, and his credit is written (it is untied, so the funding lock does not apply); **Closed or Cancelled** refuses it (`LEDGER_CYCLE_NOT_OPEN`), and reversing an expense on a cycle that has since closed is refused — his credit then stands. | §9 L6: only cancelled and closed are shut. |
| A running cost paid by him | **Since 2026-11-08 (§8):** shared to the running cycles like any running cost, off their profit; he is credited the whole amount. (Was: shares fixed over the partners of its day and taken from payouts.) | "A running cost shared from payouts, as today" — superseded by "investors pay for every cost too". |
| Doing it twice | Two expenses are two credits. Reversing twice, or twice at once, undoes the credit once: the second is `ENTRY_ALREADY_REVERSED` (re-read under the account lock). | The second-time bug. |
| The currency | The credit is the expense's pounds (`amount_egp`); what he paid, if not pounds, is kept beside it as on the ledger row. | One figure for the balance. |
| Arabic | The new strings ("دفعه", "النشاط", the hint and the refusals) are the agent's wording, for the owner to correct. | — |
| OPEN | `AnalyticsService.getCycleProfitability`'s `investment` (what a cycle "consumed in cash") sums a cycle's money-out rows without netting an undone pair — for a business-paid expense too (found while testing this; not changed here). | Out of this feature's scope. |

