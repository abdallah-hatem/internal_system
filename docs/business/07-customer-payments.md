> Part of the [business rules](../BUSINESS_LOGIC.md) — the index there lists every section. Moved here verbatim 2026-11-01.

## 7. Customer payments and instalments

**DECIDED 2026-08-21.**

**A plan is agreed per shop, against their running balance** — not per sale. A
shop thinks in terms of what it owes you in total and pays against that.

**Instalment amounts are whatever was agreed.** They need not be equal and there
is no fixed weekly figure. A 20,000 balance might be settled as 10,000 up front
then 1,000, 5,000 and 4,000 on the next three Sundays. An upfront payment is
simply the first instalment, dated the day the plan was agreed.

**Progress is cumulative, not instalment-by-instalment.** What matters on any
date is whether the shop has paid at least what it had promised by then. A shop
that pays 1,000 late but 5,000 early is square. Money is applied to the earliest
instalments first, and a surplus flows forward.

**Overdue means a genuine shortfall** — the cumulative amount promised by today,
less what has actually come in. Due today is not overdue until tomorrow.

**DECIDED 2026-10-10 — a payment can be put on a chosen order.** *Built 2026-10-11 (U2).*
Recorded from an order, the money goes on that order: it must be the same shop's,
confirmed, with something still owed, and the payment cannot be more than that
order owes. Recorded from the shop or the payments list, it goes on the oldest
unpaid orders first, as before.

*2026-10-11 (I2):* "oldest first" now happens on the server, in the same
transaction that records the payment (`applyOldestFirst`), for the office form and
the assistant alike. It was a loop in the browser after the payment was saved, so a
dropped connection could leave money recorded but applied to nothing; now it is all
of it or none of it. Oldest means the order created first — since 2026-10-16, the order sold first (its sale day), then created first (§7a).

A payment is in the order's currency or in Egyptian pounds; no other currency is
offered.

**DECIDED 2026-08-21 — overdue flags and notifies, nothing more.** It appears in
the overdue summary and raises a notification. It
does **not** block new sales, warn on the sale screen, or charge a penalty. This
matches the BRD's V1 scope, and each of those is a deliberate future choice
rather than an oversight.

**DECIDED 2026-10-11 (I1, autonomous run) — overdue is checked every morning and
every partner is told, once per instalment.** *Built 2026-10-11.* Until now overdue
was worked out only when someone opened the overdue summary, only that person was
notified, and nothing in the office app opens it — so in practice nobody was told.
A daily job (05:00 UTC, 07:00–08:00 in Cairo) now finds every instalment that has
fallen behind on an active plan and notifies **every active core partner** —
not investors, not admin support, not shops. Each partner hears about each
instalment **once, ever**: the job runs every day and an instalment stays overdue
until paid, and a daily repeat of the same figure teaches people to ignore the
bell. A later instalment of the same plan falling behind is new and is told. A
partner added after an instalment fell behind is told on the next run. The
notification names the shop, the plan, the instalment's due day and what is
still owed on it (money covers the earliest instalment first, as above). Reading
the overdue summary no longer notifies anyone. This replaces "at most one per
plan per day". **Confirmed by the owner 2026-10-11:** an alert fires once when an
instalment first goes overdue, and again only when a further instalment is
missed — no repeating daily reminder. Guesses, open until confirmed:
- An instalment that is paid and then falls behind again (a payment reversed)
  is not told a second time.
- Admin support can read plans but is not notified; the notification is for the
  partners whose money it is.

One active plan per customer. Agreeing a second while one is live is refused,
because two schedules would claim the same payments. Cancel and re-agree
instead.

A plan cannot promise more than the shop actually owes.

### A sale's instalment contract — DECIDED 2026-10-16 (owner), details GUESSED

The owner: *"On the sale order popup add a button Contract, it shows another
popup to create the plan, then it creates the contract — it should be that
simple."* A bigger first version (a settings page, stored contracts, new
customer fields, a button on the shop page) was rejected as too much and removed.

- **The button.** The sale order popup (Sales) has **Contract** for a sale that is
  confirmed or partly paid, in EGP, with something outstanding, not a walk-in, and
  with no plan yet — offered to core partners, who are the ones who may agree a
  plan. A sale that already has its plan shows Contract to the sales roles (core
  partner, admin support) and it opens the contract directly.
- **The plan popup.** Sale total, paid so far, remaining (= outstanding). Number of
  instalments (default 3, 1–36) and the first due date (default a month from
  today); rows a calendar month apart from the first date (the 31st falls back to
  a short month's last day, then returns), equal amounts with the last absorbing
  the rounding. Every row's date and amount can be changed. **Create contract**
  stays disabled until the rows add up to the remaining amount exactly; the
  difference shows as it is typed. Moving the first date re-dates only rows
  nobody touched; changing the count re-splits the amounts and keeps hand-typed
  dates *(guess)*.
- **A plan for each contract — owner, 2026-10-17.** *"In the installment plan popup
  I want to customize for each contract not a fixed 3 month plan."* Approved from a
  mock: beside the count and the first date, **Every** — week, 2 weeks, month,
  2 months, 3 months. Weeks are 7 days each; months are calendar months
  counted from the first date, clamped as above. Each row can be removed (the count
  drops to match) and **Add instalment** appends one dated one interval after the
  last row, amount 0 (a row after a hand-dated last row is dated from that date and
  keeps it). **Split remaining equally** re-splits the remaining amount over the rows
  there are, the last absorbing the rounding; adding or removing a row never
  re-splits on its own. Changing the interval, like the first date, re-dates only
  rows nobody re-dated. Create stays disabled until every row has a date, an amount
  above 0 and the rows add up exactly; a past date shows the server's own
  `INSTALMENT_DUE_IN_PAST` wording. *Decided (2026-10-17):* the server already
  sorts instalments by date and numbers them in that order, and does not mind two
  on the same day, so no rule was added there — the popup sends the rows sorted by
  date (same-day rows in the order on screen) and allows same-day rows, as the
  server does. Nothing on the server changed: 1–36 rows, each above 0, today or
  later, adding up to what is outstanding, all as before.
- **What has been paid toward a contract — 2026-10-17.** A contract covers exactly what its sale still owed
  when it was signed, so what has been paid toward it is its total less what the sale owes now — the same
  figure everywhere a plan is read (the Contracts list, a shop's page, overdue alerts, the assistant).
  It read the shop's payments since the agreed day before: a down payment made the same day, before the
  contract, was counted as paying it, and each of a shop's contracts was given all the shop's payments. A
  plan with no sale (made before contracts) keeps that older reading.
- **The popup's default — owner, 2026-10-17.** *"Make the default 2 installments on
  the next 2 saturdays."* The popup opens on two weekly instalments, the first on
  the first Saturday after today (Cairo) — never today itself, so a sale made on a
  Saturday is first due the Saturday after — the remaining split between them.
  Every field stays editable.
- **The plan.** An ordinary plan (`PaymentPlansService`, the same rules above —
  verified shop, one active plan per shop, never more than the shop owes, the
  cumulative reading of who is behind) that names the sale (`saleOrderId`, one
  plan per sale). `POST /sales/orders/:id/contract-plan`, core partners only, as
  `POST /payment-plans`. Refused with a code: not confirmed or partly paid
  (`SALE_CONTRACT_NOT_OPEN`), not EGP (`SALE_CONTRACT_NOT_EGP`), nothing
  outstanding or a walk-in (`SALE_CONTRACT_NOTHING_OWED`), the sale already has
  its plan (`SALE_HAS_PLAN`), instalments not adding up to the outstanding amount
  (`CONTRACT_SUM_MISMATCH`), an instalment due before today (`INSTALMENT_DUE_IN_PAST`;
  today is allowed — a payment taken at signing), and the existing
  `CUSTOMER_HAS_ACTIVE_PLAN`. `GET /sales/orders/:id` says whether the sale has
  its plan (`contractPlan`). *Guess:* a cancelled plan lets go of its sale, so the
  sale can be given a new one; the cancelled plan keeps no link.
- **The contract** is a print page (`/sales/[id]/contract`), built live from the
  sale and its plan — nothing about it is stored. Number `CT-` + the order number;
  dated the day the plan was agreed; Cairo. Seller S&F with blank lines for the
  representative and phone; buyer the shop's name and phone, blank lines for the
  address and ID / commercial registration; the sale's lines; three totals —
  total price, **paid at signing = total − the plan's total**, **remaining in
  instalments = the plan's total** (both fixed at signing, so a reprint says what
  was signed, not today's balance); the schedule with a receipt-signature column;
  the terms; two signature lines; "made in two copies". Arabic by default, whatever
  language the office is in, with a switch to English. One A4 sheet for a typical
  sale.
- **The terms are fixed text in code** (suggested wording, approved in the mock;
  the owner may change it later): the buyer received the goods sound and as
  specified; pays the instalments on their dates, cash or bank transfer;
  ownership stays with the seller until paid in full; two consecutive missed
  instalments make the rest due at once; the courts of Cairo decide any dispute.
- **Instalment plans moved into Payments** (owner, same day): a second tab,
  "Instalment plans" (`/payments?view=plans`), for following up — every shop's
  plan, behind, paid so far, remaining, next due, cancel. It has **no create
  button any more**: in the office a plan is agreed only from a sale's Contract
  button. A plan linked to a sale shows its order number and **Open contract**;
  an older plan shows neither. The old `/payment-plans` address redirects to the
  tab, the menu entry is gone, and an overdue-instalment notification opens the
  tab. `POST /payment-plans` stays in the API (the assistant and older callers).
- **Contracts replace payment plans — owner, 2026-10-17.** *"Remove payment plans
  and replace it with contracts, where I can see the contract for this shop."*
  Approved recommendation:
  - The Payments tab is now **Contracts** (`/payments?view=contracts`). The old
    `?view=plans` opens it and swaps the address for the new one; `/payment-plans`
    and the overdue notification land on it too. One row per contract: the shop,
    the order number, the contract total (the plan's total), paid so far against
    it, and the next due date and amount — or **Overdue** with the amount behind,
    or **All paid** when nothing remains. Whoever is behind comes first. The row
    opens that contract's page (`/sales/[id]/contract`, where it is printed,
    downloaded and shared). Cancelling the plan stays on the row.
  - Each shop's page has a **Contracts** section: the same list, that shop's only,
    each row opening its contract; "No contracts for this shop" when there are none.
    It replaces the old payment-plan section there.
  - **Plans with no sale.** Since 2026-10-16 nothing in the office or the
    assistant creates a plan without a sale; `POST /payment-plans` is still in the
    API, so one can be made by calling it directly, and plans agreed before
    contracts existed have no sale. *Decided (2026-10-17):* such a plan is **still
    listed** — it is money owed, and hiding it would hide a debt — labelled **"No
    contract (older plan)"**, with its figures, and its row opens nothing because
    there is no contract page to open. Production had no plans of any kind on that
    day, so today this case is empty.
  - Nothing on the server changed: `GET /payment-plans` (with `customerId` for a
    shop) already returned each plan's sale, totals and standing.
- *OPEN:* a plan reads every payment the shop makes from the agreed day on
  (cumulative, above) — so money paid on the day of signing, or on another of the
  shop's sales, counts toward the instalments. With one active plan per shop that
  is the rule as it stands; whether a sale contract should count only money on
  its own sale is the owner's to say.

---

### Dashboard: To collect — owner, 2026-10-15

The dashboard shows the five customers to chase first, beside Top products, for the roles that see
customer balances (core partner, admin support). **Order: anyone with something overdue on a payment
plan first, then the larger balance; ties by name.** Each row: the customer, their number of unpaid
orders, what they owe, the overdue part (only when there is one), and how long ago their oldest unpaid
order was placed. The headline totals everyone owing and the overdue part across all of them, so it
agrees with the Receivables tile. The figures are the same receivables (§7, `common/receivables.ts`)
and the same overdue rule (plans only, never above what is owed) the assistant's `list_receivables`
reads — `GET /customers/to-collect?limit=` (1–20, default 5). A row opens the customer; View all opens
Customers sorted by balance. Nobody owing shows "Nobody owes you anything right now". Owner chose the
card from a mock; "upcoming" by due date was not used because only plan shops have due dates.

