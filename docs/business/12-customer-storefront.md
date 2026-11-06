> Part of the [business rules](../BUSINESS_LOGIC.md) — the index there lists every section. Moved here verbatim 2026-11-01.

## 12. The customer storefront

DECIDED 2026-08-30. A shop owner browses a public catalogue, asks to buy, and
the owner approves. Design in
`docs/superpowers/specs/2026-08-30-customer-storefront-design.md`.

**Who sees what price.** The catalogue is public and quotes retail. A shop that
has been verified sees the price for its own customer type — trade, for a B2B
shop. An unverified account sees retail: nothing has been agreed with them yet,
and showing the wholesale list to whoever fills in a signup form gives it away.

The channel is resolved once, on the server, from the token. Every surface that
shows a price — the card, the product page, the basket, the resulting order —
is handed the price already resolved. No screen chooses.

**Stock is a band, never a count.** In stock, low, or out. A public page saying
"12 left" tells a competitor the exact position, and a shop needs only to know
whether it is worth asking.

**A request holds the stock behind it, for 48 hours.** Submitting sets the units
aside so a second shop cannot be promised the same ones. When the 48 hours pass
the units go back on the shelf and the request stays answerable — expiry is not
a decision, it only stops an unanswered request from costing anything while it
waits. Approving after expiry re-checks what is actually there and refuses if it
has gone.

The deadline is the rule, not the sweeper: a hold past its time is ignored when
availability is calculated, whether or not the job that releases it has run.

**Approving can change what was asked for.** Quantities can be reduced and lines
dropped — ten asked for, six in stock, so six approved and the shop is told why.
What is approved becomes the order. Approving for *more* than was requested is
refused: the shop would be billed for goods it never asked for. Approving
nothing is refused too, because that is a decline wearing a different word, and
a decline must carry a reason.

The price the shop was shown when they asked is recorded on the request. A price
that moves in between does not change what they believed they were asking for;
the approval screen shows both.

**Approving below cost warns (2026-10-11, L4).** The approval screen checks the
lines as they would be approved — the quantities and prices on screen — against
what their goods cost now (§4), per line and in total, and Approve still goes
through. Only the office sees it; the shop is never shown a cost.

**An order request is not a sale order.** Separate records. Outstanding
balances, analytics, payment allocation and settlement projection all read sale
orders, and a request living among them as a status would mean every one of
those has to learn to exclude it.

**A signup becomes an unverified customer.** The owner chose this over a
separate pending queue, knowing it lets a stranger create a row in the table
that orders and balances hang off. Contained rather than argued: unverified
customers are filtered out of the Customers list by default, and an order
request, a payment and a payment plan are all refused against one. A spam row
can exist; it can never touch money.

**An unverified shop may ask for an import, but not for an order.** DECIDED
2026-08-30, by me rather than asked — recorded here so it is not a quiet one.
An order request holds stock, and a hold is a promise; nothing has been agreed
with an account nobody has looked at. An import request holds nothing and
promises nothing, so it is how a shop that signed up an hour ago starts a
conversation instead of sitting in a queue with nothing to do. Reverse it if
that is wrong — the check is one line in `import-requests.service.ts`.

**A photograph belongs to the shop that sent it.** A customer's import-request
photos are served through a portal route that resolves the asset through the
request, so the ownership check is the one that already found the request. The
public catalogue image route refuses anything not attached to a product, and
another shop asking for a photo gets a 404 rather than a 403 — it should not
learn that the request exists.

**Who may be a participant on a cycle.** DECIDED 2026-08-30, after finding a
shop owner sitting on three cycles — one as a CORE_PARTNER with a 5,000
contribution, which is a share of the partners' profit at settlement and every
cycle notification with everyone's figures in it. Nothing had ever checked: the
participant row took any user id the foreign key accepted.

A core partner may also come in as a temporary investor on the same cycle,
because putting extra money in beside your own share is a real thing an owner
does. A shop account can be neither. An office account with no stake can be
neither. `RolesGuard` answers who may *call* the endpoint; this answers who the
call may *name*, and only the first question was being asked.

**Who may read the audit log.** DECIDED 2026-10-10 (U4c). Core partners and
admin support — the roles that already list sales, payments, the ledger and
settlements. Every audit row holds the full before and after of what changed,
so it is those same books in another shape; a temporary investor or a shop is
refused (`ROLE_NOT_ALLOWED`). Before this the endpoint named no roles and any
signed-in account could read it.

**The audit log is readable — built 2026-10-18 (owner).** Each row from `GET /audit-logs` and
`GET /audit-logs/:id` carries `entityLabel` (and `entityLabelAr`, `entityHref`): the record's own number or name —
an order's ORD number, a cycle's code, a product's name and SKU, a lender's name, a payment's reference or shop with
its sum — and the office page that shows it, looked up with one query per record type on the page
(`modules/audit/audit-labels.ts`). A record that no longer exists gets no label and the screen shows the type's
name, never the id. The detail shows **what changed**, one `Field: old → new` line per field that differs, names
translated, money and dates formatted, ids hidden (`components/audit/audit-changes.tsx`); a create lists what was
set, a delete what was removed. A **Who** filter lists the office's people by partner name (email when there is no
partner record), kept in the address as `?actor=`; an action with no actor reads System, an actor nobody has any
more reads Former user. `actorUserId` that is not a uuid is `VALIDATION_FAILED` (400), a uuid that is no user 404.
Search (through the shared list toolbar) matches the record's name and the person's; the record-type filter offers
the types the API writes.

**The menu shows a role what it may open.** DECIDED 2026-10-10 (U4c). An
entry is shown exactly when the endpoint its page lists from lets the role in;
the menu copies the controllers' `@Roles` rather than deciding anything itself.
Since R1 (below) a temporary investor sees the dashboard (their own cycles),
the importing and catalogue pages (scoped to their cycles), settlements (theirs,
with their own line), notifications and settings — and not analytics,
customers, payment plans, order or import requests, sales, payments, the
ledger, partners or the audit log.

2026-10-18 (owner): only the three partners use the office app — no investor has access, though nothing stops an
investor account from signing in (the office login refuses only shop accounts, `USE_PORTAL_LOGIN`). The sidebar
went from 21 entries to 13 by making related pages tabs of one page (`apps/web/src/lib/page-views.ts`); the tabs
carry no role checks, while the sidebar, More and the phone bar still hide the books entries from roles other than
core partner and admin support (`components/layout/nav-model.ts`). The investor rules in this section and R1 below
are built and enforced by the server; they describe nobody who uses the app today.

**DECIDED 2026-10-19 (owner), built 2026-10-20 — an investor cannot sign in to the office.** "No investor account
can sign in to the office app ... only the three partners use it." `POST /auth/login` refuses a temporary investor
with `OFFICE_NOT_FOR_INVESTORS` (401), after the password is checked, so the page cannot be used to learn what kind of
account an email is; `/auth/refresh` ends every sign-in an investor holds (`SESSION_INVALID`), so a partner whose role
is changed to investor is signed out at the next refresh; a password change hands an investor no refresh token. Who may
hold an office sign-in is one function, `mayHoldOfficeSession` (`modules/auth/session-tokens.service.ts`). The
investor stays a participant on the cycles they funded (§8), and every server-side role guard stays as it was (CLAUDE.md
§12). The investor's own dashboard ("your cycles", R1) was removed as unreachable; a role the business figures refuse
now sees only the Dashboard title. Guesses, open until confirmed:
- **Admin support still signs in.** The owner named investors; support is a role the code knows and nobody holds.
- **An inactive investor is told it is the wrong door**, not that the account is inactive (the role is asked first).
- **An investor's access token issued before this change keeps working until its hour ends**; the role guards still
  refuse it everything they refused before. The access token is not checked against the door on every request.
- The assistant's OAuth sign-in already took core partners only (§16); unchanged.

**DECIDED 2026-10-10 by the owner — a temporary investor sees only their own
cycles.** *Built 2026-10-11 (R1, R1b, R1c).* The cycles they put money into, and for each: their
contribution, the cycle's costs, deliveries, losses, profit and settlement, and
their own payout. Nothing else: no customers or balances, no payment plans, no
returns, no business-wide revenue, cash or profit, and no other cycle. This is
enforced by the server on every read — a menu that hides a page is not a guard
(rule 12) — so every list and figure an investor can reach is scoped to the
cycles they participate in, and anything outside them is refused with a code or
simply absent from the list.

*Built 2026-10-10 (R1).* One definition, `common/investor-scope.ts`. Another
cycle's id answers 404 — as if it did not exist — not 403. On a shared cycle an
investor sees the cycle's totals and their own participant row and settlement
line, not another participant's contribution or payout. **Guesses, not yet
agreed** (per-endpoint list in `docs/build-log/waves/arrivals-and-ux/R1.md`):
suppliers and providers are shown only where one of the investor's cycles used
them; the product catalogue, categories and currency rates are shown whole, as
shared reference data, but without each product's supplier links; a customer's
request photo is not served to an investor.

Found while scoping, and fixed: adding or deleting a product photo was open to
any signed-in account and is now core partners only; a cycle's participant list
was sending each person's password hash and no longer does.

**Recent activity on the dashboard** (2026-10-10). The latest real events,
newest first: confirmed sales (dated by their order date — no confirmation time
is stored), payments that were not reversed, and stock received. Drafts never
appear; cancelled and fully returned orders do not either. Core partners and
support see it; an investor's dashboard shows their own cycles instead.
Removed 2026-10-17 (owner: "remove the recent activities table from
dashboard"). The panel and its endpoint (`GET /analytics/recent-activity`) are
gone; the office dashboard is the figure tiles, then To collect beside Top
products. Each kind of event still has its own list: Sales, Payments, Inventory.

**The dashboard, 2026-10-17/18 (owner).** Quick actions: New sale, Record payment, New cycle. **Fuel** left
the dashboard on 2026-10-18 (owner: "remove fuel from dashboard"); it is recorded from the Ledger page's quick
actions only (§9).
On a phone every figure tile keeps its icon (superseded 2026-10-23, below: six showed, then "See more").

**Right now simplified: Cash from sales, one Stock tile — DECIDED 2026-11-06 (owner), on
`feature/dashboard-cash-from-sales`, not merged.** The owner: "simplify the dashboard cards, we don't need cash
on hand, make it available cash from sales". Cash on hand mixed the partners' funding, lender money, supplier
payments and sales into one figure he found meaningless. Right now is six tiles, in this order: **Cash from
sales, To collect, Owed to lenders, Stock, Low stock alerts, Active cycles** (supersedes the 2026-10-23 list
below).
- **Cash from sales** = the payments customers made that are not reversed (`payments.status = 'RECORDED'`, the
  all-time Collected's reading) **minus the cash refunded to them for returns** (`REFUND_PAID` ledger rows),
  all time, leaving out an entry undone together with its undo (`common/undone-entries.ts`, as cash on hand).
  A credit-note return takes nothing off (the money stays collected; only the shop's debt went down). Read from
  the payments, not their `PAYMENT_RECEIVED` ledger rows, because reversing a payment writes no undo row. More
  refunded than paid reads below zero, never 0. One definition, `apps/api/src/common/cash-from-sales.ts`, sent
  as `cashFromSalesEgp` by `GET /analytics/dashboard`; the tile's second line: "Paid in, less refunds" ("ما دفعه
  العملاء ناقص المسترد"), one line, cut at the edge. It links to Payments. Arabic label "النقد من المبيعات".
  GUESS (agent's wording): the second line and both Arabic strings.
- **Cash on hand left the dashboard.** `cashOnHand` (and cash in / cash out) stay in the API response: the
  assistant's `get_dashboard` and the invariant tests read them, and Analytics' Cash paid out is the same reading.
- **Stock** — owner 2026-11-06: the stock value at landed cost (`common/stock-value.ts`) as the figure, and the
  number of units in stock as a small muted pill beside the title ("Stock 897"; a screen reader hears "897 units
  in stock"). The Units in stock tile is gone; the pill is the only place the count shows on the dashboard.
- **Layout:** wide (the group ≥ 68rem), two rows of three; narrower, three rows of two, no tile spanning. Phone:
  Cash from sales, To collect, Owed to lenders and Stock show; Low stock alerts and Active cycles wait behind
  "See more (2)". The skeleton traces the same six, the second lines and Stock's pill.

**The dashboard in two groups — DECIDED 2026-10-23 (owner, picked from a rendered sample), built 2026-10-23.**
The owner asked "are the data filtered or all time, like net profit?": thirteen equal tiles mixed all-time and
right-now figures with nothing saying which. Now two headed groups:
- **Right now** first (superseded 2026-11-06, above) — Cash on hand, To collect (what customers owe today, the old Receivables), Owed to lenders
  (with its per-currency line), Stock value (the product page's word since 2026-10-22, the same
  `common/stock-value.ts`), Items in stock, Low stock alerts, Active cycles. Wide: a row of four, then a row of
  three, each filling the width.
- **This month** second — Revenue, Collected, Net profit, Expenses for **this calendar month in Cairo, from its
  1st to today**, with a "Profit and loss →" link to Analytics on This month (`/analytics?period=month`). The
  figures are `GET /analytics/dashboard`'s `month` block, computed by `profitFigures` for exactly the days
  Profit and loss's This month asks for (`thisMonthPeriod`: the 1st to today, which is what the API caps P&L's
  "1st to the month's last day" to) — one definition (rule 11), so the two net profits agree to the piastre.
  The all-time fields stay in the response (the assistant's `get_dashboard` reads them, and now `month` too).
- **Cost of goods sold and Cash paid out left the dashboard** for Analytics' Profit and loss: COGS is the Sales
  tile's second line and a line of "How it adds up", as before; Cash paid out is a new figure under "How it adds
  up", for the selected period, set apart from the arithmetic with a note that it is not a cost
  (`cashOutEgp` from `common/cash-position.ts`, the dashboard's old `totalCashOut` reading, cut to the period's
  ledger days by `ledgerDayWhere`).
- **Phone:** Right now first, then This month. Shown: the first four Right now tiles and the four of This month;
  Items in stock, Low stock alerts and Active cycles wait behind "See more (3)". Seven in two columns leave one
  alone, so Active cycles takes the row. Every tile keeps its icon and links where it did.
- GUESS: **This month's Collected** is payments not undone whose received day (`receivedOn`, a Cairo calendar
  day) falls in the month — the all-time Collected's reading cut to the month. Profit and loss shows no
  Collected, so there is nothing on Analytics to compare it with.
- GUESS: **Cash paid out for a period** is the money-out rows whose ledger day (`occurredOn`, else the Cairo day
  entered) falls in it; an entry undone and its undo are left out together whatever periods they fall in, as
  the all-time figure does. Shown inside "How it adds up" rather than as a fifth tile.
- DECIDED 2026-10-26 (owner): **This month's Expenses** (and net profit) leave out an entry undone and its undo
  whatever months they fall in — a July fee undone in October is in neither — the same rule as cash
  (`common/undone-entries.ts`, §9), so the block still equals Profit and loss's This month to the piastre.
- GUESS: "a row of four then a row of three" applies once the group is at least 68rem wide (a 1440 screen with
  the sidebar); narrower — a 1280 laptop — four figures do not fit on one line beside their badges, so the
  groups stay two to a row (Active cycles spanning the last). From 68rem to 76rem the figures are a size
  smaller so "669,584.64 EGP" stays on one line. English labels are in sentence case (Cash on hand, Net profit,
  Low stock alerts, Active cycles), as the owner wrote them.
- GUESS: an API without the `month` block makes This month read zeros, never the all-time figures under a This
  month heading. Arabic headings "الآن" and "هذا الشهر"; "النقد المدفوع" for Cash paid out on Analytics — the
  agent's wording, not the owner's.
**Top products** rank by **units sold** (default) or **revenue**, a switch on the dashboard card and on
Analytics' table, remembered on the device; `GET /analytics/top-products?by=units|revenue` (default revenue
for other callers), returns netted out, ties broken by the other measure then the name. The card shows the
ranked figure first with a bar against the top seller ("how is 21 sold on top of 28?" — it was ranked by
revenue while showing units).
**Analytics shows the top five — DECIDED 2026-10-19 (owner: "show only top 5"); the zero-sales rule and the
cycle tie-break GUESSED.** Top products: the five best by the switch that is on, in the API's ranking above
(`?limit=5`); a product that sold nothing net of returns (units sold 0) never takes a place, so fewer than five
sold means fewer rows, and none sold is the empty state. Cycle profitability: the five most profitable cycles,
highest profit first, equal profit by code; the API still sends every cycle in code order (the dashboard and a
cycle's page read that full list), so the ranking and the cut are the web app's (`components/analytics/analytics-top.ts`).
The dashboard's own Top products card is unchanged.

**Summary cards at the top of Cycles, Products and Sales — owner 2026-10-18 ("a few simple summary cards … about that
tab"); built 2026-10-20, the choices below GUESSED.** One shared strip (`components/ui/summary-strip.tsx`, cards in
`components/summary/tab-summaries.tsx`), at most three cards, nothing drawn when there is nothing to show, skeleton
cards while loading. Every figure is an Analytics figure, picked with Analytics' own rules
(`components/analytics/analytics-top.ts`); the browser sums nothing (rule 11).
- **Cycles:** the three most profitable cycles from `GET /analytics/cycle-profitability`, highest profit first, equal
  profit by code. A cycle with a loss or zero profit is not "top-earning" and takes no card (GUESS).
- ~~**Products:** the three best sellers by units.~~ Replaced 2026-10-22 (owner: "remove the cards on top in the
  products tab"), below.
- **Sales:** two cards from `GET /analytics/top-orders` (core partners and support), both **all time** whatever the
  list's date filter (GUESS). *Most revenue:* the realised sale (Confirmed, Partly paid, Paid) whose total less its
  refunds is highest. *Largest order:* the sale with the most units, net of returned units (GUESS: units, not lines),
  how many kinds of product it holds shown (owner 2026-10-22: "products instead" of lines). Ties fall to the other measure, then the order number (GUESS). A sale with nothing left after
  returns is never picked; drafts, cancelled and samples orders never are. One sale may fill both cards (GUESS). A card
  opens its order.

**The tabs' cards, reshaped — owner 2026-10-22, built 2026-10-22, the choices below GUESSED.** Every card wears the
dashboard tiles' icon badge, in the dashboard's colour where it shows the same figure ("all cards need icons like in
dashboard"); on a phone the badge sits above the label, as on the dashboard.
- **Products and Inventory:** the same two cards — *Products*, the active products (the dashboard's Products count,
  GUESS: active only), and *Units in stock*, every batch's remaining quantity summed (the dashboard's Units in stock).
  `GET /analytics/stock-summary`; both read the dashboard's own definitions (`productCount` in `analytics.service.ts`,
  `unitsOnShelf` in `common/repositories/units-on-shelf.ts` since 2026-10-28). A count of 0 is shown, not hidden.
  **Products: superseded 2026-10-28** — its cards follow its filters (below); Inventory keeps these.
- **Customers:** *Customers*, every customer but the shared walk-in record (the dashboard's count), and *Paid the
  most*, the customer whose payments standing (a reversed one paid nothing) add up highest, all time, opening that
  customer; ties by name (GUESS). Nobody has paid: the count alone. `GET /analytics/customer-summary`.
- **Payments:** *Largest payment*, the single largest payment standing, all time, with who paid it, its day and
  method, opening the customer (a walk-in buyer's says Walk-in and opens nothing); a tie falls to the earlier one
  (GUESS). `GET /analytics/payment-summary`.
- All three endpoints: core partners and support, as the rest of Analytics.
- **The ledger's By column:** who recorded each row — the partner's name, else the login's email; "—" for a row from
  before anyone was recorded. In the CSV export too.

**The Products tab's cards follow its filters — owner 2026-10-28 ("in products tab above the table we need cards
that responds to filter, so when filter by category, it shows number of products in that category, and total number of
units as well"); built 2026-10-28 on `feature/product-cards-filters`, merged into `dev` (not yet in production); the choices below GUESSED.**
- **What they count:** *Products*, how many products the table's search, category and status match — the table's own
  total; *Units in stock*, the units those products hold on the shelf. Worked out by the server for the whole filtered
  set, never added up from the page on screen (LEARNINGS). Changing page changes neither figure.
- **One filter, one definition** (rule 11): `GET /products/summary?search=&categoryId=&status=` reads the same `where` as
  `GET /products` (`productListWhere`, `apps/api/src/modules/products/product-list-where.ts`), so the cards and the
  table cannot count different products; a value the table refuses, the cards refuse with the same code
  (`LIST_FILTER_INVALID`, `VALIDATION_FAILED`, `LIST_SEARCH_TOO_LONG`). The web app sends the table's own parameters,
  less its page and order.
- **Units in stock** is the one definition the dashboard and the Inventory card read (`unitsOnShelf`,
  `apps/api/src/common/repositories/units-on-shelf.ts`): each batch's remaining quantity, summed, across every cycle the product
  arrived in. **GUESS (as the existing card and Inventory's on-shelf figure):** a sample out at a shop has left the
  shelf and is **not** counted; a unit held for a customer is still on the shelf and **is** counted (nothing holds
  stock today, §3).
- **Category** is that category alone; its subcategories' products are not included — as the table has filtered since
  it moved to the server (2026-10-25). **GUESS:** kept as the table does; if a parent category should take in its
  children, both change together through `productListWhere`.
- **Status:** the cards follow the table's status filter, which opens on Active — so on first open *Products* is the
  dashboard's active count, as before. With *Inactive* or *All*, an inactive product and its units on the shelf are
  counted (**GUESS:** the table lists them, so the cards count what it lists).
- **Nothing matches:** both cards say 0 (shown, not hidden).
- **Loading and the second visit:** skeleton cards while the figures load. The cards are keyed by the filters alone:
  another filter shows skeletons until its own figures arrive — never the last filter's under the new one; coming back
  to a filter shows its figures and reads them again; a change to any product refreshes them with the table.
- **Wording (GUESS, the agent's):** "match the search and filters" / «تطابق البحث والتصفية» under Products, "held by
  these on the shelf" / «لدى هذه المنتجات على الرف» under Units in stock.
- **Who:** core partners and support, as the Inventory card (`ROLE_NOT_ALLOWED` otherwise) — stock is the office's.

**Profit and loss on Analytics — DECIDED 2026-10-18 (owner, mockup approved), dates GUESSED from how the
dashboard already counts.** "A proper place to see total net profit, with time, and with expenses and sales as
summary, not details." At the top of Analytics: a period (This month — the default since 2026-10-20, owner
2026-10-19; All time was the default until then — · Last month · This year · All time, `?period=all` · Custom days,
kept in the address as `?period=` / `?from=&to=`; an address naming a period always wins, an unknown one is This
month), net profit large with its share of
sales, the summary Sales − Cost of goods sold = Gross profit, − Expenses, then Recovered, Other income and
Exchange difference only when not zero, = Net profit; expenses by category (one total each, largest first,
goods lost on the way as its own line); net profit by month (superseded 2026-10-18 by Option A below: one chart in
day, week or month buckets). `GET /analytics/profit-and-loss?from=&to=`
(core partners and support, as the dashboard).
- **One computation** (rule 11): `AnalyticsService.profitFigures(period?)` is the dashboard's revenue, COGS,
  expenses and net profit, query for query; the dashboard calls it with no period, Analytics with one. All
  time is therefore the dashboard's figures exactly. Each month's bar is the same computation for that
  month's days, so the bars add up to the period (v1; superseded 2026-10-18 by Option A — the buckets are
  `profitParts` split per bucket and added up by `figuresOf`, below); the category split reads the same rows as the Expenses line
  (`expenseWhere`) through the same signed reading, so it adds up to it.
- **Which day each figure belongs to** (Cairo days, both ends included):
  - a sale's revenue and the cost of what it sold: the sale's day (`orderedAt`), as Revenue by month and the
    sales list read it;
  - a return's refund and the cost it reversed: the day it came back (`returnedOn`) — as Revenue by month
    already does, so a reported month does not change;
  - a ledger row (expenses, recoveries, other income): the day the money moved (`occurred_on`), else the Cairo
    day it was entered — as running costs read it (§8); ~~an undo is dated the day it is undone, so a September
    expense undone in October lowers October~~ **superseded 2026-10-26 (owner):** an entry undone and its undo are
    left out of every period, both halves (§9, `common/undone-entries.ts`) — September and October both read 0;
  - goods lost on the way: the day they were marked lost (the record's only date);
  - an exchange difference: the day of the repayment (`paidOn`).
- GUESSED: a `to` after today is today; a `from` after today is refused (`PERIOD_NOT_STARTED`) rather than
  answered with zeros; a reversed range `DATE_RANGE_REVERSED`, a malformed day `BAD_DATE`. All time's months
  start at the first day anything that counts was recorded. The share of sales is shown only when sales are
  above zero.
- **Redesign "Option A" — DECIDED 2026-10-18 (owner, mockup approved); bucket sizes and the week GUESSED.**
  Under the period: four tiles (Sales · Gross profit with its share of sales · Expenses · Net profit with its
  share, green from zero up and red below, "—" when nothing was sold), a "How it adds up" disclosure (open by
  default — owner 2026-10-31; its header still folds it) with the full Sales − COGS = Gross − Expenses ± Recovered / Other income / Exchange difference = Net list, one chart
  (sales as columns, net profit as a line, a loss point red), and the top four expense categories with the
  rest folded into "N more categories". The separate Revenue by month card is gone (its figures are the
  chart's columns); `GET /analytics/revenue-by-month` stays — no screen reads it now, but the API checks
  (TC-API-24, TC-ANA-01), the role and investor-scope suites and the walk-in suite still do.
  - **Buckets by length of the period:** up to 35 days a day each (this month, last month); 36–124 days a
    week each; longer a calendar month each (all time; this year from early May — This year runs 1 January to today, so it
    is daily through January and weekly from early February to early May). GUESSED, with the
    **week Saturday to Friday** — the week as an Egyptian calendar prints it, Friday its last day. Edge
    weeks and months are cut to the period. Every bucket is present; a quiet one is zero. Days are Cairo's.
  - **On a phone (below 640px) a by-day period is drawn by week** (owner 2026-10-19, mockup "Option 1"):
    the app adds the API's day buckets into the same Saturday–Friday weeks, cut at the period's edges,
    summed in piastres, so the weeks equal their days and the totals. The week still running is labelled
    "today". Tapping a week opens its days (sales and net profit each, losses red, the week's total). The
    desktop keeps the days; by-week and by-month periods are the same on both. No second server path.
  - **The buckets add up to the totals exactly**, because both are the same parts: `profitParts` reads every
    source once for the period (twelve queries however many buckets — asking `profitFigures` per bucket had
    cost twelve per bucket, 26 for a month by month, would have been 372 by day), each row put on its day by
    the rules above, and `figuresOf` adds up a bucket the way it adds up the period. The dashboard reads the
    same filters summed by the database (`itemised` false), so its figures are unchanged, query for query.
  - All time runs from the first day anything that counts in profit was recorded (a purchase alone no
    longer starts it — it counts nowhere in profit). A row dated after today (check-data 25) still counts
    in all time's totals, so the buckets run on to its day rather than drop it.
  - A samples write-off with no recorded moment (none should exist) falls on its order's day.
  - **Cash paid out — added 2026-10-23 (owner), when it left the dashboard.** Under "How it adds up", apart
    from its lines: the money out of the ledger in the period, stock bought included — not a cost and not in
    net profit (`cashOutEgp`, `common/cash-position.ts`). It costs two queries, so a period is fifteen.
- **What made a bar — DECIDED 2026-10-28 (owner: "in the Profit and loss analytics chart, maybe clicking on a day
  or a month should open a popup or show me the details of loss"), built 2026-10-28 on `feature/pnl-drilldown`,
  merged into `dev` (not yet in production), details GUESSED.** Clicking a bar of the chart — a day, a week or a month — opens a popup of that
  bar's figures broken down, so a loss can be traced to the lines that made it. On a phone, an opened week's days
  are each a button to their own breakdown, and "What made this week" opens the week's.
  - **One definition** (rule 11): `GET /analytics/profit-and-loss/breakdown?from=&to=` reads the bar's days with
    `profitParts` — the very parts the chart's buckets add up — and groups them by the record each came from
    (`profit-breakdown.ts`). Its totals are `figuresOf` those parts, the bar's own arithmetic, so Sales, Gross
    profit, Expenses and Net profit equal the bar's to the piastre, and each list's total equals its line.
    `profitParts` now carries, on each itemised part, the record it was read from; the dashboard's summed reading
    is unchanged. A part the grouping does not recognise throws rather than drop out of the popup.
  - **The lists:** revenue and cost of goods **by order** (sold in the period, returns and price cuts in the
    period as their own figures with their days, cost of goods less the cost a return put back, gross profit);
    **every expense** (a ledger row with its category, note, Paid by — a partner, or "the business" — and its
    cycle; goods lost on the way with the product, quantity, leg and cycle; samples written off, one row per
    samples order); **the exchange difference by repayment** (the friend, the pounds paid, the rate, the cycle and
    the purchase order); **refunds recovered and other income** by ledger row. A list with nothing in the period is
    not shown. Each row links: an order to `/sales?order=`, an expense or other line to `/ledger?entry=` (new: the
    ledger opens the entry a link names, fetched on its own, and forgets the link when closed), a cycle to its page.
  - **Which day:** the rules above, unchanged — so a return or a price cut on a later day than its sale counts
    on its own day, under its order, with no sale figure that day; the sale's day keeps the whole sale.
  - **Asked by period** (validated on the server): both days required (`PNL_BREAKDOWN_NEEDS_PERIOD`), real days
    (`BAD_DATE`), in order (`DATE_RANGE_REVERSED`), not starting after today (`PERIOD_NOT_STARTED`), at most 31
    days — a month, the widest bar (`PNL_BREAKDOWN_TOO_LONG`, GUESS). A `to` after today is **not** cut to today
    (unlike the chart's period): all time's last bar may run on to a row dated forward, and the popup must equal it.
    Core partners and support only, as the rest of Analytics (`ROLE_NOT_ALLOWED` otherwise).
  - **Paged by the server**, each list on its own (`section`, `page`, `pageSize`, the same refusals as every office
    list: `LIST_PAGE_INVALID`, `LIST_PAGE_SIZE_INVALID`, `LIST_FILTER_INVALID`); 25 rows a page (GUESS); "Show more"
    asks for the next page of that list. A list's total is of all its rows, never the rows on screen added up.
  - GUESSED: orders are listed **worst gross profit first** (the popup is for finding a loss), expenses, exchange
    and other lines largest first; ties by day then id. An order's day in the list is the first day it touched the
    period. Empty period: "Nothing was recorded in this period." A skeleton while it loads.

**Notifications are recorded first and delivered second.** Every event writes a
notification row, then attempts a push. A push that fails must never mean a lost
notification, and a shop on an iPhone gets no push at all until the app is added
to their home screen.

**Requests in the office: one page, hidden in production for now.** DECIDED
2026-10-17 (owner: "import requests and order requests can be in one tab, and I
want them to be hidden in prod for now"). Order requests and import requests are
two tabs of one office page, Requests (`/requests`, `?view=imports` for the
second), with one menu entry in place of the two. The old addresses
`/order-requests` and `/import-requests` land on their tab.

In a production build the page is switched off: no menu entry, a request's
notification is plain text rather than a link, and `/requests` or either old
address goes to the dashboard. Local dev shows it. **Nothing about requests
themselves changes**: the API and the storefront are untouched, so shops can
still send order and import requests, an order request still holds its stock
for 48 hours (and releases it when unanswered), and the notifications are still
written. They wait, unanswered, and are all there when the page is switched
back on.

One flag, `apps/web/src/lib/features.ts` (`REQUESTS_ENABLED`):
`NEXT_PUBLIC_FEATURE_REQUESTS=on` on the web project in Vercel turns it on in
production (a redeploy applies it), `off` hides it everywhere, and unset means
off when `NEXT_PUBLIC_VERCEL_ENV` is `production` and on otherwise. **GUESSED,
not asked:** the old addresses keep working in dev rather than being removed;
the push alert the API still sends for a new request opens what the bell
would (since 2026-10-18, §10): the tab when the page is on, the notifications
list when it is off.

---

