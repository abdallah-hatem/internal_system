> Part of the [business rules](../BUSINESS_LOGIC.md) — the index there lists every section. Moved here verbatim 2026-11-01.

## 4. Sales

A sale is drafted, then confirmed. Confirming allocates stock by FIFO and is the
point the goods and the revenue are real. A draft reserves nothing and counts
for nothing — it appears in no revenue, profit or top-product figure.

**DECIDED 2026-08-22 — an order cannot be created for more than is in stock.**
Only confirming used to check, so an order for 600 units against 60 on the
shelf was built, priced at 720,000 and saved, and nothing objected until the
last step. The quantity available is shown in the product picker and the line
turns red as it is exceeded, so the limit is visible before it is reached
rather than explained afterwards.

**The product picker names each product's category beside it** — owner 2026-10-27 ("product names we just want it simple … maybe with category showing beside it in sale order product dropdown"), built the same day. New Order's picker reads "Y20 headset · Intercoms", the category in the reader's language; a product with no category shows its name alone, and the search matches the category in either language (`productPickerOption` in `SaleOrderForm.tsx`). The chosen product keeps the category in the field too (GUESS: it is one label). **Changed 2026-10-29** (owner: "instead of the sku, in the choose product dropdown, show the category, and remove it from beside the name"): the option reads the name alone, and the line under it opens with the category where the SKU was — "Intercoms · 60 in stock" (no category: the stock alone). The SKU is no longer shown in the picker but the search still finds it. The chosen product's field shows the name alone.

Quantities are summed per product across the order: two lines of 40 against 60
in stock is 80, and checking each line alone would let it through. A product
with no stock cannot be put on an order at all.

Selling more than is available is refused, and the whole confirmation rolls
back: no partial allocation is ever left behind.

**DECIDED 2026-08-23 — an order that has been paid against cannot be
cancelled.** Cancelling put the stock back and did nothing about the money: the
payment stayed allocated to the cancelled order, so it cleared nothing, could
not be used anywhere else, and still read as collected — while the order
dropped out of what the shop owed. The screen even offered Cancel specifically
on partially paid orders, the one state where money had certainly arrived.

Cancelling is for an order that never happened. Money coming back is a refund,
and a refund is a return (§5), where the goods, the cost and the cash move
together. Cancelling also asks before acting, since it cannot be undone and the
button sits beside Confirm.

**A cancelled order owes nothing — fixed 2026-10-18.** Cancelling put the stock
back and set the status, but left `outstanding` at the full total, so every
cancel made through the app produced exactly the record check-data 12.2
("cancelled order still showing a balance") exists to find; found when the
history seed cancelled an unpaid order. Now (`POST /sales/orders/:id/cancel`,
core partners only) the stock comes back through a RELEASE movement, the status
becomes CANCELLED and `outstanding` is **0**; `total` stays as the record of what
the order was. Refused: an order already CANCELLED or RETURNED
(`ORDER_ALREADY_CLOSED`), anything paid against it (`ORDER_PAID_CANNOT_CANCEL`,
above). Cancel on samples still at a shop is "Returned" (§4 "Samples at shops").
Checked by `apps/api/src/modules/sales/sales.cancel.db.spec.ts`. Orders cancelled
before the fix keep their old balance until corrected; check-data 12.2 lists them.


**DECIDED 2026-10-10 — an order can be created and confirmed in one step.**
*Built 2026-10-11 (U1).* Both happen together or neither does: if confirming is refused (not
enough stock, say), nothing is saved and the order stays on screen to fix. Saving
a draft first is still possible. A draft shows no amount owed anywhere — it counts
for nothing until it is confirmed.

Saving the same new order twice (a double click, a retry after a dropped
connection) creates it once: the second request is answered with the first
order. This holds per person, across the server's instances.

**DECIDED 2026-10-11 by the owner — a walk-in sale is paid on the spot.**
*Built 2026-10-11 (W1, W2).* A buyer who is not a shop does not need a customer record. A
walk-in sale is created, confirmed and paid in full in one step, at retail
(B2C) prices, by the method chosen (cash by default), dated now. It cannot be a
draft and never leaves anything owed. Behind it is one shared "Walk-in" record
the system keeps: it cannot sign in, cannot be edited or deleted, and never
shows a balance. Stock, discount and price rules are the same as any sale. A
walk-in return is refunded in money, not as credit — there is no account to
hold it.

*Server built 2026-10-11 (W1); the sale form built 2026-10-11 (W2); the assistant (W3) to come.*
On the form, a **Walk-in** switch beside Customer replaces the customer with a
payment method (cash first) and offers one button, *Sell & take payment*. Lists
and the order show such a sale as "Walk-in" with no balance, and its return
offers a money refund only.
Guesses made while building it, open until confirmed:
- A walk-in sale whose lines are all free (total 0) takes no payment — a zero
  payment would say money moved when none did.
- Asking for a credit-note refund on a walk-in return is refused
  (`WALK_IN_REFUND_IN_MONEY`), not quietly turned into cash; leaving the
  method out gives cash.
- The walk-in record cannot be named as the customer of an ordinary sale
  (`WALK_IN_RESERVED`): that sale could be a draft or owe money.
- The dashboard's customer count leaves the walk-in record out; its sales
  count in revenue as any sale does.
- A payment method on a sale that is not a walk-in is refused, not ignored.

**Built 2026-10-11 (I2) — a confirmed sale prints as an invoice / delivery note.**
From the order, *Invoice* opens a page in the reader's language and direction
with a *Print* button (the browser's print onto A4; no menu, buttons or chrome on
the paper). It shows the business name, "Sales invoice / Delivery note", the order
number and date, the shop (name, phone), every line (product and SKU, quantity,
unit price, discount, line total), subtotal, discounts, order total, what has been
paid on this order and what it still owes. **2026-10-21 (owner):** no "Received by /
Delivered by" lines to sign any more, and its header is the contract's — the logo, the
title, "S&F — Motorcycle parts and accessories", the number and date, over a heavy rule
(one `DocumentHeader`, `components/ui/document-header.tsx`; the tagline once in
`document-tagline.ts`). A draft and a cancelled order have no invoice (`INVOICE_DRAFT`,
`INVOICE_CANCELLED`) and offer no button. Guesses, open until confirmed (2026-10-11):
- **The shop's balance on the invoice is its balance at the moment of this sale**:
  "balance before this sale", "this invoice", "balance after this sale" — the
  running balance from the shop's statement (§7b) right after this sale's row, so
  a reprint next month shows the same figures. "Paid" and "still owed" on the order
  are as of printing. The alternative — today's balance — changes every reprint.
- What returns took off the order is shown as "Returns credited", so total − paid −
  returns = still owed on paper; a fully returned order says so and owes nothing.
- The business name printed is "MotoParts"; no address, tax number or logo is
  printed — none is on file. A walk-in sale prints "Walk-in customer", "paid in
  full on the spot", and no account box.
- The invoice number is the order number; there is no separate invoice sequence.

**DECIDED 2026-10-11 by the owner — selling below cost warns, and never refuses.**
*Built 2026-10-11 (L4).* He sold 90 helmets at 1,000 EGP each when each had landed
at 2,616.67, and nothing told him. Now every place a selling price is set says so
before the sale is made — and the sale still goes through if he chooses it: a
clearance or a favour to a shop is his decision, not the system's.

- **What "cost" means.** The landed cost (§2) of the units this sale would actually
  draw under FIFO (§3): the oldest received batch first, each at its own cost.
  A line that spans two batches costs exactly those units, so 3 units drawn as
  2 at 900 and 1 at 1,100 cost 2,900 together (966.67 each) — selling them at
  1,000 is *not* below cost though it is under the newer batch. Two lines of one
  product draw in order, the second after the first, as confirming does.
- **What it is compared with.** The line's total *after its line discount* — the
  figure the order stores — against the cost of its units, each batch's share
  rounded to the cent exactly as confirming records the COGS. It is compared per
  line, in cents, never per unit: a price that is at cost to the cent across the
  line is not flagged because a four-place unit cost rounds differently. Exactly
  at cost is not below it. The warning is that line's cost, the price per unit
  after the discount, and the loss on the line; the order shows the losses added.
- **No stock, no warning.** A line the shelf cannot cover in full is not costed —
  confirming refuses it (`INSUFFICIENT_STOCK` / `NOT_ENOUGH_STOCK`) and that is
  the message. A line still being filled in (no product, no quantity) is not
  costed either.
- **One rule, one definition** (CLAUDE.md §11). `apps/api/src/common/below-cost.ts`
  computes it; `POST /sales/price-check` answers every surface; the batch
  list it reads is the same function confirming allocates from (`fifoBatches`).
  Nothing is written and nothing is refused by it.
- **Where it shows.** The office sale form, shop and walk-in, under each line and
  under the order total, as price, quantity or discount change; a draft's order
  view above Confirm (the cost is read again — stock may have moved since it was
  written); approving a storefront request (§12); setting a product's B2B or B2C
  price; and the assistant's `record_sale` preview (§16).
- **A product's price** is checked against the oldest batch on the shelf — what
  the next unit sold at that price would draw, which is the same check as a sale
  of one unit. No stock, no warning.
- **Who sees it.** The roles that sell — core partners and admin support, who
  already read landed costs on the inventory page and a sale's allocations. A
  temporary investor or a shop never reaches the check (the endpoint carries the
  sales roles and refuses anyone else), and a product's price warning is shown
  only to whoever may set the price (core partners).
- Coded (`BELOW_COST`) and said in the reader's language; the amber warning
  style, not the red of a refusal.

Guesses made while building it, open until confirmed (2026-10-11):
- A sale in a currency other than EGP is not compared: the cost is in pounds and
  the order records no rate to convert at. (The assistant and storefront requests
  are always EGP.)
- A free line (price 0) on stock that cost something is a loss and warns.
- The warning sits beside the buttons rather than asking "are you sure?" first:
  it is on screen before Confirm is pressed, and a second click to get past it
  would make a decided price slower to enter every time.

**DECIDED 2026-10-16 (owner asked for the capability; details a GUESS, the
recommended option) — a sale has a date.** Entering a cycle that already
happened means entering sales made weeks ago (B2B, some paid in instalments).
A sale takes a **Sale date** (`orderedOn`, YYYY-MM-DD, a Cairo day) on
`POST /sales/orders`, the walk-in sale and `POST /sales/price-check`;
optional, today when left out, never in the future (`DATE_IN_FUTURE`), never a
non-date (`BAD_DATE`). It is stored in `orderedAt` so that the sale's Cairo day
is the day chosen (today: now, as before; an earlier day: midday in Cairo).
- **Stock that day.** A sale dated before the day it is entered draws only
  from batches received on or before the end of its day (§3), FIFO among them,
  at creation and at confirm. Short of that: `NOT_ENOUGH_STOCK_ON_DATE`
  (product, day, what there was, what was wanted) — it never draws stock that
  arrived later. A sale entered for its own day draws the whole shelf exactly
  as before.
- GUESS: **a draft keeps its day.** A draft saved on Monday for Monday and
  confirmed on Wednesday was never back-dated, so it draws the whole shelf as
  before (confirming is when the goods leave, §3). A draft saved for an
  earlier day is held to that day's stock when confirmed. There is no endpoint
  that edits a draft, so a draft's day is chosen when it is saved; to change
  it, cancel and enter it again.
- GUESS: **back-dated sales are drawn from what is left in those batches now.**
  Entering history out of order — today's sales first, then last month's — can
  find the early batches already sold and refuse; enter a past cycle's sales in
  date order.
- Everything that reads a sale's date reads `orderedAt`: revenue by month
  (bucketed by the Cairo month, which also fixes a sale at 00:30 on the 1st
  being charted a month early), the dashboard, the customer statement, the
  invoice, To collect's oldest unpaid order, the sales list and the customer's
  pages. Settlement reads allocations, not dates. The below-cost warning of a
  back-dated sale is costed from the stock of its day.
- **The assistant** (`record_sale`) sends `orderedOn` only when the partner
  says the sale was on an earlier day; the preview names the day, shows that
  day's stock and binds the day.
- The office form: "Sale date", the shared date picker, today prefilled,
  future days greyed out; an earlier day says only stock received by then can
  be sold.
- `check-data` 25 and 25.1 watch for a sale dated forward and a back-dated sale
  that drew stock received after its day.

### Samples at shops (owner 2026-10-18)

The owner, 2026-10-18 (mockup approved): "Sometimes we leave samples at shops with no money; when they like it they
say ok let's make a deal, or they send them back." Built the same day as the smallest flow, from the screen he already
uses (LEARNINGS "Keep flows small"). Migration `20261018200000_samples_at_shops` (additive: order statuses
`SAMPLES`, `SAMPLES_RETURNED`, `SAMPLES_WRITTEN_OFF`; movement types `SAMPLE_OUT`, `SAMPLE_BACK`; nullable
`sale_orders.samples_left_at`, `samples_decided_at`, `samples_reminded_at`). The rules are in
`apps/api/src/common/samples.ts` (pure) and `common/samples-out.ts` (what is out, read from the database).

**Round 2 (owner 2026-10-18, after testing it locally).** "At shops" reads **"Samples"** everywhere; "They're buying"
opens the **normal New Order popup pre-filled** instead of its own dialog, so lines can be changed, removed and added;
a product's page shows its **Samples**, and its B2C price stat card is gone. The rules below are updated in place and
marked "round 2".

**Leaving samples.** The New Order popup has one amber switch, **"Samples — no charge yet"** ("Units leave the shelf.
No sale, nothing owed, until the shop decides."). With it on there is no draft, no discount, no total, prices are
optional, and the one button reads **Leave samples** (`POST /sales/orders` with `samples: true`).

- DECIDED (owner): **the price is optional until the shop decides.** A price given is kept on the line as a note
  (the decision starts from it); the line and the order total **0** and owe **0** whatever was noted.
- The units leave the shelf from real batches, **FIFO like a sale** (the same `drawFifo` confirming uses), each draw a
  `SaleItemAllocation` at that batch's landed cost, with a `SAMPLE_OUT` movement. Stock rules are a sale's: more than
  is on the shelf is `NOT_ENOUGH_STOCK` (summed per product), a quantity of 0 or less `QTY_NOT_POSITIVE`, and a
  back-dated leave draws only the stock of its day (`NOT_ENOUGH_STOCK_ON_DATE`).
- Same ORD- numbering, same idempotency key (a double click leaves the samples once).
- **A real customer only:** walk-in, the walk-in record, or `walkIn: true` with `samples: true` → `SAMPLES_NEED_SHOP`;
  no customer → `CUSTOMER_REQUIRED`; an id that is not a customer → 404.
- **It is not a sale.** A samples order (open, returned or written off) counts in no revenue, COGS, receivable,
  customer balance or statement, dashboard, Analytics, P&L, settlement profit, invoice (`INVOICE_SAMPLES`) or
  contract (`SALE_CONTRACT_NOT_OPEN`), and cannot be returned (`ONLY_CONFIRMED_RETURNABLE`). Every reader already
  counts only CONFIRMED / PARTIALLY_PAID / PAID (and RETURNED for a return's netting); the customer statement used to
  read "not DRAFT, not CANCELLED" and now leaves the samples statuses out too.
- **No payment against it:** a payment sent with the samples order itself → `VALIDATION_FAILED`; one recorded or
  allocated against it afterwards → `SAMPLES_NOT_PAYABLE`. A discount sent on a samples line is set to 0, not refused.
- GUESS: leaving samples that take a product below its minimum raises the low-stock alert, as a sale does — the
  shelf is what low stock means (§3).

**On Sales.** The order shows an amber **"Samples · N units"** badge (round 2: the owner asked for "Samples" wherever
the screens said "At shops"; Arabic عينات), and when opened: the shop and the day
left, how many days ago, and the day the reminder is due (or "Reminder sent"). The list's status filter has
**Samples**. Three actions, and nothing else (no invoice, payment, contract, return or cancel):

- **"They're buying"** — DECIDED (owner 2026-10-18, round 2, replacing the first round's per-product
  Buying / Returned dialog): **opens the normal New Order popup, pre-filled**, because the shop may take more, take
  less, or add products. Title "Complete sale from samples ORD-…", and one line above the fields: "N units were out as
  samples; anything you remove goes back to the shelf." Pre-filled: the shop (fixed — the samples were left with it;
  the server refuses another with `SAMPLES_OTHER_SHOP`), today, the order's channel and currency, and every line that
  went out at its quantity and price — the price noted when left (a typed price: it stays when the channel changes),
  else the product's price for the channel, else 0. In the popup everything a sale allows: lower a quantity (the
  rest goes back to the shelf), remove a line (all of it back), raise one, add products, set prices and discounts. A
  product's units out on this order count as available to it in the popup. No draft, no walk-in, no samples switch;
  one button, **Complete sale** (`POST /sales/orders/:id/samples/convert`, the body a new order sends). The
  below-cost warning is not shown there (GUESS: it costs from the shelf's FIFO, which is not what the kept units cost).
- **"Returned"** — everything back on the shelf; the order ends **SAMPLES_RETURNED** (not a cancelled sale, not a
  return of a sale). Since 2026-10-28 it asks which products and how many came back, and the rest stay samples on the
  order ("Return some samples, not all", below). **Cancel on samples is "Returned"** (`POST …/cancel` does the same, for core partners — cancel
  is theirs alone, while `POST …/samples/return` is open to the sales roles; the screen does not offer Cancel at all).
- **"Write off"** (core partners only, like Cancel) — the shop kept them or they were lost. Asks first, showing the
  cost written off; an optional note goes to the audit log.

**DECIDED (built) — the shop buying converts the order in place.** Same order, same ORD number, becomes a
**CONFIRMED sale dated the day chosen** in the popup (`samples_left_at` keeps the day left, and the order says "Began
as samples left on …"), with **exactly the lines the popup was saved with** — revenue, COGS, the receivable and the
shop's debt start that day. Chosen over a linked sale because nothing reads it differently from any other sale: a
payment, a return, a contract and the invoice work on it as they are. Per product (`planSamplesConversion` in
`common/samples.ts`, owner 2026-10-18 round 2):
- **Kept** = the lesser of what went out and what the sale has. Those units **are the units that went out** — same
  batches, same cost — and they do not move again (no second movement; they left with `SAMPLE_OUT`).
- **Back** = what went out and is not kept: back to the batch each unit left (`SAMPLE_BACK`).
- **Extra** = what the sale has beyond what went out — a raised quantity, or a product that never went out — drawn
  FIFO from the shelf exactly as confirming a sale draws (`drawFifo`, movement `SALE`). Checked first, on the shelf of
  the sale's day: for a product that went out the refusal is **`SAMPLES_EXTRA_NOT_IN_STOCK`** ("5 of X went out as
  samples; selling 9 needs 4 more from the shelf, and only 1 is there"), for one that never went out it is the sale's
  own `NOT_ENOUGH_STOCK` / `NOT_ENOUGH_STOCK_ON_DATE`. Nothing moves on a refusal.
- Every line is checked as a new order's are, by the same code (`checkLines`, `saleLines`): a real product,
  quantity above 0, price 0 or more, no negative discount, no discount above its line.
- So a unit is counted once: kept (sold), back (shelf) or drawn (sold) — shelf + samples + sold always equals what
  was received.
- GUESS (kept from round 1): **which units are kept** — the oldest-received of what went out, as FIFO would have drawn
  them (§3); the units put back are the newer ones. When one product has two lines, they take the kept units in the
  order of the lines, the later line taking the shelf for its rest.
- DECIDED by me, round 2 (the owner said "treat as Returned, or refuse with a code — pick one"): **a sale with no
  lines at all is refused, `SAMPLES_NOTHING_KEPT`, pointing at "Returned"** — saving a sale should never quietly
  record a return, and "Returned" is one click beside it. Removing every sample line but adding another product is a
  sale (of the new product) with every sample back on the shelf.
- GUESS, round 2 (replaces "always dated today"): **the sale's day is today unless an earlier day is entered**, as on
  any sale — never in the future (`DATE_IN_FUTURE`) and **never before the samples were left**
  (`SAMPLES_SALE_BEFORE_LEFT`; the picker greys those days out). Extra units come from the stock of that day.
- Converting twice, or after Returned / Write off, is `SAMPLES_ALREADY_DECIDED`; two saves at once make one sale (the
  claim on the order is a conditional update only one wins).

**Returned and written off — how stock and money move.**

| Outcome | Stock | Money |
|---|---|---|
| Left (SAMPLES) | Off the shelf (`remainingQty`/`saleableQty` fall), counted under **Samples** | Nothing: no sale, no ledger row |
| Bought (CONFIRMED) | Kept units stay out (sold, same batches); units not kept back to their own batch (`SAMPLE_BACK`); extra drawn FIFO (`SALE`) | A normal sale on its day, with the popup's lines: revenue, COGS, receivable |
| Returned (SAMPLES_RETURNED) | Every unit back to the batch it left (`SAMPLE_BACK`) | Nothing. Its lines and allocations stay as the record of what went out and count in nothing, as a cancelled sale's do |
| Part returned (stays SAMPLES, 2026-10-28) | The units named back to the batch each left (`SAMPLE_BACK`); the rest stay out on the order | Nothing |
| Written off (SAMPLES_WRITTEN_OFF) | Gone for good: never back on the shelf, not at a shop | Their landed cost is a cost of the cycle each unit came from |
| Bought into other sales (SAMPLES_BOUGHT, 2026-10-27) | Every unit moved, with its allocation, into the sales that bought it — no stock moved | Nothing on the samples order; each sale is a normal sale with those units' cost as its COGS |

**The write-off is costed like goods lost on the way (§2, §9; CLAUDE.md §11).** `samplesWrittenOffEgp` in
`common/cycle-losses.ts` sums the cost on the written-off orders' allocations, per cycle (by batch) or for all
cycles, dated the day it was written off; `cycleWriteOffsEgp` gives goods lost on the way and samples written off
apart and together, and settlement, the dashboard's net profit, Analytics' P&L and the cycle comparison all subtract
the total — one definition. It is **not** a ledger row (no money moved — the cash left when the goods were bought),
**not** a cost of goods sold (nothing was sold, so it is neither in COGS nor in revenue), **not** an operating expense
in the ledger's sense and **not** a cost recovery. It shows as its own line: **"Samples written off"** in the P&L's
expenses by category, and in a payout's cycle costs. A leg re-cost (§2) re-costs those allocations with the rest, so
the write-off follows a corrected cost while the cycle is unsettled.
- GUESS: a write-off is the **whole order** and cannot be undone — there is no mix of returned and written off on
  one order. OPEN for the owner: a shop that sends some back and keeps the rest free can today only be recorded as
  "They're buying" the kept units at a price of 0 (their cost then lands in that sale's COGS rather than on a
  "Samples written off" line — the cycle's profit is the same). Round 2: that is a line at price 0 in the popup.

**Inventory.** A **Samples** column (named "At shops" until the owner's round 2, 2026-10-18; Arabic عينات) (units out on open samples orders, per product and per batch), beside
**On shelf** (was "Total Stock": every batch's remaining units) and **Total** = on shelf + at shops. **Low stock still
means the shelf** (§3, `common/low-stock.ts` reads `remainingQty`): units at shops are not on it and are counted once,
from the open samples orders' allocations (`common/samples-out.ts`) — never twice. Shelf + at shops + sold always adds
up to what was received (net of returns and losses).

**Settlements.** DECIDED (owner): **a cycle cannot be settled while any of its units are out as samples** — calculate,
approve, pay, and the plain move to Settlement all refuse with `CYCLE_HAS_SAMPLES_OUT`, naming how many units at which
shops, sorted by name, and what to do ("3 unit(s) of cycle CYC-… are out as samples at Delta Bikes (1), Nile
Motors (2). Record what the shops decided — bought, returned or written off — before settling."). Unsold-stock figures
(`common/unsold-stock.ts`, the cycle's projection and the cycle comparison) count units at shops as **unsold**, at
the cost they left at — never as sold.

**The reminder.** DECIDED (owner): **14 days after samples were left** and while they are still at the shop, every
active core partner gets "Samples at <shop> for 14 days" (`SAMPLES_AT_SHOP_REMINDER`, en + ar in
`common/notification-messages.ts`, with the units and the order on the push's second line), linking to the order
(`/sales?order=<id>`, which opens it). Once per order, ever: `samples_reminded_at` is claimed by an update only one run
can win. Never before the 14th Cairo day, never for decided samples. It rides the daily job: Vercel's cron
`GET /jobs/overdue-payments` (05:00 UTC) and the `@Cron` in `OverdueScheduler`. Through `NotificationsService`, so it is
pushed to phones too (§10).
- GUESS: a partner who joins after the reminder went out is not told again (once per order, not per partner — unlike
  overdue instalments).

**Editing.** A samples order's lines cannot be edited while open — there is no edit path for any order (§4); to change
what is out, record "Returned" (since 2026-10-28, only the units that came back) and leave more samples if needed. Changing the lines **when the shop buys** is what the
"They're buying" popup is for (round 2).

**On a product's page** (owner 2026-10-18, round 2). A **Samples** card: the units of the product out on open samples
orders in all, and per order the shop, the units, how long ago they were left, linking to the order
(`/sales?order=<id>`); "No samples out" when there are none. The stat card that showed the B2C price is now the
Samples total — the prices card below it still shows and sets both B2B and B2C prices (only the card was removed;
B2C pricing is unchanged everywhere else).

**New Order warns when the shop holds samples** (owner 2026-10-25; built 2026-10-25, live 2026-10-26). Why: a new order for 5 helmets
when 1 is the sample the shop already has draws 5 more from the shelf while the sample still counts as out — stock
reads one low and the cycle cannot settle until the samples order is closed.
- Picking a shop in New Order shows, **above the lines**, an amber hint per open samples order: "This shop holds 1
  Helmet as a sample (ORD-…, left …)" — each product and its units (Arabic: "هذا المحل لديه … كعينة"), and under it
  "If those are what they're buying, complete that samples order instead…". Each order has a link, **"They're buying
  — open ORD-…"**, which closes New Order and opens that samples order's "They're buying" popup (above), read fresh.
- **A hint only — DECIDED (owner): it never blocks the new order**; a separate purchase while a sample is on trial is
  valid. Neither button looks at it, and the API refuses nothing because of it.
- **One definition of "samples out at a shop"** (CLAUDE.md §11): `samplesAtShop` in `common/samples-out.ts` reads the
  same open-samples allocations as Inventory's Samples column, the cycle's unsold stock and the settlement gate, filtered
  to the shop — so returned, written-off and bought samples are not in it (they are no longer `SAMPLES`), nor another
  shop's. `GET /sales/orders/samples-at-shop?customerId=` (sales roles): no shop `CUSTOMER_REQUIRED`, an id that is not
  a customer 404. A samples order is never a draft, so there is no draft state to show.
- Not shown for a walk-in (no shop) nor in "They're buying" itself (it is that order). Switching shop never leaves the
  last shop's hint: it is read per shop and not kept once nothing shows it, so it never shows samples since decided.
- **The assistant:** `record_sale`'s preview to a shop holding samples ends with "Samples at this shop: …", each order
  with its products and units, pointing at `complete_samples_sale`; its data carries `samplesAtShop`. It binds nothing
  — the sale still goes through. **The office chat** shows the same hint, translated, under the preview card, its link
  opening "They're buying" (`/sales?buying=<id>`); the English note is cut from the card so it is not said twice (the
  model still reads it).
**Samples into the current order** (owner 2026-10-27: "need the sample to not be just a hint … a button to click to
add this sample to the current order, and auto handle the rest … a shop can also have 3 samples of 3 different
products, but he decides to make an order that includes buying 2 of them while one still remains as a sample"). Built
2026-10-27 on `feature/samples-into-order`; live 2026-10-27 (evening). Migration `20261027120000_samples_into_order` (additive: order
status `SAMPLES_BOUGHT`; nullable `sale_items.from_samples_order_id`, indexed, a foreign key to the samples order).
- **New Order.** The samples hint is a list per product of each open samples order, with **Add to order** beside each
  and one **Add all** (every product of every order at the shop not yet on the order). The line added is the product
  at the units the shop holds and the channel's price, tagged **"From sample ORD-… · N at the shop"** (Arabic
  "من العينة …"), and edits like any line — quantity, price, discount, remove. A product already added reads
  **Added**. The line's units at the shop count as available to it on the form. The hint's link to "They're buying"
  stays.
- **On confirm, in one transaction** (`confirmWithin`, the one path for create-and-confirm, a draft's confirm and the
  assistant): each samples order a line names is held (a row claim, in id order), checked again as it stands now, and
  per line (`planSampleLines` in `common/samples.ts`, which plans each samples order exactly as "They're buying" plans a
  conversion, `planSamplesConversion`):
  - the sample's units move into the sale line **with their allocations at the batch and cost they left at** — no
    second shelf draw, no stock movement (they left with `SAMPLE_OUT`); the sale's COGS and the statement's Profit are
    at that cost;
  - **more than the sample** holds takes the rest from the shelf, FIFO (`drawFifo`, movement `SALE`); the shelf check
    when saving asks the shelf only for that rest;
  - **fewer leaves the rest as a sample** on the same order: its line is cut to what its draws still hold.
- **Lines not added stay samples on the same order** — the same ORD number, the day left and the reminder unchanged
  (`samples_left_at`, `samples_reminded_at` untouched; `samples_decided_at` stays empty). **A samples order with nothing
  left closes as bought** (`SAMPLES_BOUGHT`, `samples_decided_at` set): no lines, total 0, never a sale itself, counted in
  nothing, no actions on it. Its popup says "Bought on …: every unit went into ORD-…"; an open one partly bought says
  "Part bought in ORD-…" (`samples.soldInto` on the order, the sales whose lines name it, not drafts or cancelled).
- **Validated on the server** (`sampleSources`, asked when a draft or a sale is saved and again at confirm), coded,
  en + ar: another shop's samples, a walk-in → `SAMPLES_OTHER_SHOP`; a returned, written-off or bought-out order →
  `SAMPLES_ALREADY_DECIDED`; an order that never was samples → `NOT_SAMPLES`; a product the order holds none of (or none
  any more) → **`SAMPLES_PRODUCT_NOT_OUT`** (new); dated before they were left → `SAMPLES_SALE_BEFORE_LEFT`; a samples
  line on a samples order, or an id that is not an id → `VALIDATION_FAILED`; an id that is no order → 404.
- **Twice**: the same Idempotency-Key answers with the first sale; another sale of units already moved is refused
  (the order is closed, or the product no longer out); two at once queue on the claim and the second reads what the first
  left, so no unit is ever taken twice. Shelf + samples + sold still equals what was received.
- **The "They're buying" popup**: a product removed, or lowered below what went out, is listed under **"Not on the sale"**
  with **Keep as sample** (chosen) or **Returned**. Returned units go back to the shelf as before. If any units are kept
  the samples order cannot become the sale — it still holds samples — so the sale is a **new order** made exactly as New
  Order makes one from samples (`buyPartOfSamples`: units neither bought nor kept back to the shelf first, then
  `prepareDraft` + `confirmWithin` with every line of a product that went out tagged with this order); the samples order
  stays open with what is kept. The request body is the old one plus `keepAsSample: [productId…]`, and it carries the
  form's Idempotency-Key.
- **History.** A samples order's history shows what was left (read from the leaving's audit row, so it stays right after
  units move) and each move: **"Samples bought in another order"** (`SAMPLES_INTO_SALE`, the sale's number) and **"Some
  samples returned"** (`SAMPLES_PART_RETURNED`). The sale's line shows "From sample ORD-…" in its popup.
- **The assistant** (§16): `record_sale` takes `fromSamples: "ORD-…"` per line — the same `SalesService.create`, so every
  check above is the preview's and the commit's; the preview line says "(from samples ORD-…)", and the samples note
  tells the model to use it. The office chat's hint is unchanged (its link opens "They're buying").
- `scripts/check-data.sh` 26.3–26.5: a samples order closed as bought that still holds lines; a sale line from another
  shop's samples or from an order that never was samples; a confirmed sale line from samples whose allocations do not
  add up to it.
- GUESS: **a samples order emptied by sales gets its own status, `SAMPLES_BOUGHT`**, and loses its lines (its lines are
  what is still at the shop); what was left and where it went are read from the audit log.
- GUESS: **the units a line takes are the sample's oldest-received**, as FIFO would (the round-1 guess, kept).
- GUESS: **the samples order changing between opening New Order and confirm** — fewer units left than the line asks: the
  line takes what is left and the rest from the shelf (not refused); none of that product left: `SAMPLES_PRODUCT_NOT_OUT`;
  the order returned, written off or bought out: `SAMPLES_ALREADY_DECIDED`, and the draft stays a draft.
- GUESS: the added line is priced at the channel's list price — the hint carries no noted price (a noted price is not a
  decision).
- GUESS: choosing another product on a sample line makes it an ordinary line; switching to walk-in or to leaving samples
  takes the sample lines off, like switching shop (a line typed by hand stays; an order left with none gets an empty
  line).
- GUESS: no below-cost warning on a sample line — its units cost what they left at, not the shelf's FIFO cost the check
  reads (as in "They're buying").

**Samples by branch** (owner 2026-10-27: "what happens when having samples for 2 branches, then we start an order on
the third branch, or even one of the 2?" — the proposal below, then "build it"). Built 2026-10-27 on
`feature/samples-by-branch`, no migration; live 2026-10-27 (a short heading per samples order replaced the sentence that repeated its rows).
- **The list says where each sample is.** `samplesAtShop` (`common/samples-out.ts`, the one reading) returns each samples
  order's branch — `{ id, name, archived }`, or null when it is on the owner — and `GET /sales/orders/samples-at-shop`
  passes it on (backwards compatible: a field added). In New Order each sample row reads **"Helmet × 1 · LS2 ·
  ORD-0412"**; a sample on no branch reads **"On the owner"** (the branches wording); an archived branch reads
  "Old Street · Archived".
- **The order's branch first.** The samples of the branch the order is going on (picked, else the default, else the
  owner — exactly what the server will save) are listed first; every other branch's are under a collapsed
  **"At other branches (N samples)"** heading (N = sample rows). An order on a branch holding none says
  **"No samples at Mokattam."** above it. A customer with no branches (and no samples on one) sees the list as before.
- **Taking another branch's sample is allowed** — one owner pays for all — but the line says so: **"From LS2's samples
  ORD-0412 · 1 at the shop"** (the owner's: "From the owner's samples …"); a sample of the order's own branch keeps
  "From sample ORD-…".
- **Changing the order's branch** regroups the list at once; lines already added stay, and their tag follows (own
  branch / another branch).
- The assistant's `record_sale` samples note names the branch: "- ORD-0412 (left 2026-10-20) at the LS2 branch: 1 ×
  Helmet (HLM)" ("(archived)" when it is); the office chat's hint shows the branch above each order.
- GUESS: **"Add all" adds only the order's own branch's samples**; another branch's (or the owner's, on a branch's
  order) are added one by one, so taking them is deliberate.
- GUESS: **no server refusal for a sample from another branch of the same customer** — `SAMPLES_OTHER_SHOP` still
  checks the customer only. The sale line's branch is the order's; the samples order keeps its own.
- GUESS: **samples on the owner (no branch) count as "another branch" for an order that is on a branch**, and as the
  order's own for an order on the owner (a customer with branches but no default).
- GUESS: in "They're buying" the choice is asked for a **lowered** line too, not only a removed one ("fewer leaves the
  rest as a sample", as in New Order). With nothing kept it converts in place as before. Without `keepAsSample` (an older
  client, the assistant's `complete_samples_sale`) nothing is kept — the API's default is the old behaviour; the popup's
  default is Keep.
- GUESS: the new sale made by "They're buying" with units kept goes on the shop's default branch, as a new order does.
- GUESS: cancelling or returning a sale that took units from samples puts them on the shelf, as for any sale — they do not
  become samples again.

- GUESS: the hint lists units out per product on each order (all units of a product summed across the batches they
  left), oldest order first; no price is shown (a noted price is not a decision).

**Return some samples, not all** (owner 2026-10-28: "I should be able to pick which sample a shop returned"; the same
day a one-off returned one of Ahmad Zogmar's two Y30s by hand, `7e33ddb`). Built 2026-10-28 on
`feature/partial-sample-return`, **no migration** (every record it writes already existed: the one-off and "They're
buying" with Keep as sample write the same ones).
- **"Returned" asks what came back.** It opens the products the shop holds on the order, once each (its lines summed),
  with the units at the shop and a quantity that **defaults to all of it**; lower it, or 0 for what stays. Below them:
  "N go back on the shelf; M stay at the shop as samples", or the old sentence when everything comes back. Every unit
  at 0 says "Nothing is coming back" and **Put back on the shelf** cannot be pressed; more than is at the shop, a
  negative or an empty field says "From 0 to N" under it and cannot be sent. The server's refusal shows in the dialog,
  translated, with what was typed kept. **Cancel (or ×, Escape) forgets what was typed**: the next visit opens on all
  again (CLAUDE.md §13).
- **`POST /sales/orders/:id/samples/return`** takes `{ lines: [{ productId, quantity }], customerId?, version? }`
  (sales roles, as before). Without `lines` it is the whole order, exactly as before — Cancel on samples and older
  clients send none.
- **The chosen units go back to the batches they left, at their cost**, in one transaction under the order's claim:
  each comes off the order's draws (`takeFromSamples`), goes back on its batch's shelf with a `SAMPLE_BACK` movement
  (`sampleBack`), and the lines are written as they stand (`settleSamplesLeft`) — the records the 2026-10-28 one-off
  made. Which units: `planSamplesReturn` (`common/samples.ts`), which plans what stays exactly as "They're buying"
  plans what is kept (`planSamplesConversion`).
- **The rest stay samples on the same order**: same ORD number, `samples_left_at` and `samples_reminded_at` untouched,
  `samples_decided_at` empty, still counted under Samples, still holding its cycles' settlement (`CYCLE_HAS_SAMPLES_OUT`
  names the units still out). A cycle none of whose units stay out is free to settle.
- **Nothing left → SAMPLES_RETURNED, as today** (lines kept as the record of what went out; `samples_decided_at` set).
  Returning what is left after an earlier part return, or after part was bought, closes it the same way.
- **History** shows each part return as **"Some samples returned"** (`SAMPLES_PART_RETURNED`, the audit row's
  products and units, the same event "They're buying" with Returned writes), then "Samples returned" if the rest come
  back later.
- **Refused, coded, en + ar** (CLAUDE.md §9): no line at all → `SAMPLES_RETURN_NOTHING` (new); 0 or less →
  `QTY_NOT_POSITIVE`; a product the order holds none of — never left, or already bought out of it →
  `SAMPLES_RETURN_PRODUCT_NOT_OUT` (new); more than is out, two lines of a product counted together →
  `SAMPLES_RETURN_MORE_THAN_OUT` (was the assistant's own, now the service's); a shop named that is not the one they
  were left with → `SAMPLES_OTHER_SHOP`; the order changed since the screen read it → `ORDER_VERSION_CONFLICT`;
  returned, written off, bought (in place or into other sales) → `SAMPLES_ALREADY_DECIDED`; never samples →
  `NOT_SAMPLES`; a quantity that is no number, a line without a product id, lines that are not a list →
  `VALIDATION_FAILED`; an id that is no order → 404. Nothing moves on any refusal. `SAMPLES_RETURN_NOT_ALL` is gone.
- **Twice:** a second return reads what the first left (the claim holds the row), so it can never take a unit back
  twice; the same click twice carries the version the screen showed and the second is `ORDER_VERSION_CONFLICT`.
- **The assistant:** `return_samples` takes `returned` (product and quantity) as the office's lines — names matched to
  the products on the order (a close name is a question; a name matching none is `SAMPLES_RETURN_PRODUCT_NOT_OUT`),
  every amount the service's check. The preview says what comes back and what stays; it binds both, so a return made
  elsewhere in between is `PREVIEW_CHANGED`.
- GUESS: **the units that come back are the newest-received; the oldest stay** — as when the shop buys part (the kept
  units are the oldest, round 1's guess). The 2026-10-28 one-off returned the first draw it found, which on that
  one-batch order is the same unit.
- GUESS: **two lines of one product are added together** and checked as one against what is out (not refused).
- GUESS: **a return is dated when it is recorded** — no day picker; the shelf gets the units back today.
- GUESS: **the dialog sends the order's version** and a changed order is refused with a reload, not applied to what
  is there now; the assistant (whose preview binds instead), Cancel and an older client send none. `customerId` is
  checked only when sent.
- GUESS: **a fraction of a unit can come back** (quantities are decimals everywhere else).

**The assistant** (§16; tools built 2026-10-20, owner's queue of 2026-10-18): `list_sales` labels each order `kind:
"SALE"` or `"SAMPLES"` as before. Five tools carry the flow, each the office endpoint's own `SalesService` call,
previewed by that call rolled back and committed with the confirmation token (`tools/samples.ts`):
- `leave_samples` (= `POST /sales/orders` with `samples: true`): a shop on file only — walk-in `SAMPLES_NEED_SHOP`,
  none `CUSTOMER_REQUIRED`; a price is only noted.
- `list_samples`: open samples orders per order, per shop and per product, as the Sales list and a product's Samples
  card show them.
- `complete_samples_sale` (= `…/samples/convert`): the lines the shop buys, or none for "exactly what was left"; a
  line without a price takes the price noted when left, else the list price, marked for the partner to confirm; a
  `PRICE_NEEDED` question when neither exists.
- `return_samples` (= `…/samples/return`): the whole order, or — since 2026-10-28 — the products and quantities the
  partner names, the rest staying samples ("Return some samples, not all", above). More than went out is
  `SAMPLES_RETURN_MORE_THAN_OUT` (the service's check now); `SAMPLES_RETURN_NOT_ALL` is gone.
- `write_off_samples` (= `…/samples/write-off`): the preview shows the cost written off.
Roles are the office endpoints', defined once in `modules/sales/sales-roles.ts` (`SALES_ROLES`; write-off
`SALES_PARTNER_ROLES`). Guesses, open until confirmed (2026-10-20):
- A noted price of 0 is read as "no price noted" (the service stores 0 when none was given).
- With no noted, list or default price the assistant asks (`PRICE_NEEDED`); the office popup falls back to 0.
- `complete_samples_sale` keeps the samples order's channel and currency; the assistant offers no channel change.
- (Superseded 2026-10-28: the quantity check on `return_samples` is the service's, which takes part returns.)
- `list_samples` reads at most 20 pages of 100 open samples orders.
- `leave_samples` uses the B2B channel for a B2B customer and B2C otherwise, as `record_sale` does.

**Who.** Leaving samples, "They're buying" and "Returned": the sales roles (core partners and admin support), as
selling is. "Write off": core partners only (GUESS — it moves cost onto a cycle, like cancelling a sale).

**Checked by** `apps/api/src/common/samples.spec.ts` (the rules, `planSamplesConversion`, `planSampleLines`),
`apps/api/src/modules/sales/samples-into-order.db.spec.ts` (samples into the current order, on stock received through
cycle, PO, leg, delivery and verified receipt), `apps/web/src/components/sales/samples-into-order.test.tsx`, spec
105-samples-into-order (written, not run),
`apps/api/src/modules/sales/samples.db.spec.ts` (against Postgres: every figure before and after, and each change the
popup can make), `apps/web/src/components/sales/samples-form.test.tsx` and
`samples-pages.test.tsx`, spec 34 TC-INV-72..74, and `scripts/check-data.sh` 26–26.2 (a samples order with a total,
a balance or money on it; an open one whose batches do not hold its lines; one with no day left).

---

### Lowering a price after the order is confirmed  — DECIDED 2026-10-22 (owner), details GUESSED, API live 2026-10-22, office screen live 2026-10-22 (`e286f9c`); the order's total as its value now DECIDED 2026-10-22 (Option A, live 2026-10-22, `50454df`)

**What happens in the business.** A shop's price is lowered after its order was confirmed — Koshary
(ORD-2026-00002) was given 100 EGP off per product on 2026-10-22, after two returns and a 5,000 cash payment.
Until this is built the only way is a hand correction in the database; cancelling and re-entering the order would
break its returns and payments. The owner: "do you think we should add a feature to update price after order
confirm?" — yes.

| Rule | Answer | Status |
|---|---|---|
| When the lower revenue counts | **On the day of the adjustment**, not the order's date — reports already looked at do not change (owner, 2026-10-22: "adjustment date"). | DECIDED |
| What it is | A dated **price adjustment** on a confirmed order line, recorded beside it, never an edit of the line's original price. The order shows "price lowered from 1,250 to 1,150 on 22 Oct by Abdallah"; the audit log keeps it. | GUESS |
| What it covers | Only the units the shop still holds on that line (sold less returned). Returned units keep the price they were refunded at; returns, payments and allocations are never rewritten. | GUESS |
| What moves | The order's total and outstanding drop by (old − new price) × units held; revenue and net profit drop on the adjustment's day; COGS, stock and batch costs do not change. No ledger row: the ledger records money received (§4 "the ledger records money as it is received"). | GUESS |
| Limits (server, coded refusals) | Lower only — never above the price it replaces; never below zero; never more than the order still owes (a lower price on a paid-up order would mean a refund, which is a return or a separate decision); not on a draft, cancelled order, or an order on a cycle whose settlement is approved or paid. | GUESS |
| Who | Core partners (rule 12). | GUESS |
| Where | An "Adjust price" action on the confirmed order's popup: pick a line, type the new price, see what the shop will owe before saving. | GUESS |

**As built (2026-10-22, API; the office screen below).** `POST
/sales/orders/:id/price-adjustments` (and `…/preview`, which writes nothing), core partners only;
`modules/sales/price-adjustments.service.ts`, table `sale_price_adjustments` with its per-batch shares in
`sale_price_adjustment_items` (migration `20261022100000_sale_price_adjustments`). Where it differs from, or adds
to, the table above:

- ~~GUESS (changed from the table): the order's total does not drop~~ — **superseded, DECIDED 2026-10-22 (owner,
  "Option A", from a rendered sample he picked; he found the Total staying at what was first sold "a bit
  misleading"): the office shows what the order is worth now, the sold total beneath it** — see "What the order is
  worth now" below. The stored `total` still stays what was sold (the line is never edited); the invoice and the
  statement are unchanged and still show the cut on its own line, "Price lowered" (total − paid − price lowered −
  returns credited = owes). Every revenue figure takes the cut off on the adjustment's day: dashboard,
  P&L, revenue by month, top products and top orders, each cycle's profit and its settlement, the shop's statement
  (an "ADJUSTMENT" row), `check-data` 13.1 (and 13.2: a cut's batch shares add up to it).
- **Per batch, so each cycle loses its own units' revenue** (§8): the held units are split by the batches they came
  from (each allocation less what came back to it), the last batch taking the rounding residual.
- **A unit handed back after its price was lowered is refunded at the lower price** — one definition,
  `common/held-price.ts`, used by the adjustment and by returns.
- **Refused, each with its code:** not lower than the price the held units are at now, or negative
  (`PRICE_ADJUSTMENT_NOT_LOWER`, `PRICE_ADJUSTMENT_BAD_PRICE`); more off than the order owes
  (`PRICE_ADJUSTMENT_EXCEEDS_OWED`; exactly what it owes is accepted and leaves it paid up); a draft, cancelled,
  paid-up or returned order (`PRICE_ADJUSTMENT_ORDER_NOT_OPEN`); a line with every unit returned
  (`PRICE_ADJUSTMENT_NOTHING_HELD`); a day before the sale or in the future (`PRICE_ADJUSTMENT_BEFORE_SALE`,
  `DATE_IN_FUTURE`); another order's line (`SALE_ITEM_NOT_IN_ORDER`).
- **GUESS: not while the sale is under an instalment contract** (`PRICE_ADJUSTMENT_UNDER_CONTRACT`): the contract
  covers what was owed when it was signed, so a cut under it would read as instalments paid. Cancel the contract,
  lower the price, draw a new one.
- **GUESS: not on units from a cycle being settled, closed or with its settlement approved or paid**
  (`PRICE_ADJUSTMENT_CYCLE_SETTLED`) — its figures are agreed.
- **Two at once lower it once:** the order's row is locked while the cut is checked and written.
- The audit log records `PRICE_ADJUSTED` on the order. No ledger row (no money moved).

**Office screen (built 2026-10-22, on its branch until the owner has tried it locally).** "Adjust price" in the
sale order popup's actions (`components/sales/adjust-price.tsx`): pick the line, type the new unit price, the day
and an optional note; the server's own preview (`…/preview`) shows units covered, what it takes off and what the
shop owes before → after as the person types (350 ms after the typing pauses), and Save sends exactly that. The
screen's own choices, each a GUESS until the owner says otherwise:

- GUESS: the button shows only on a confirmed or partly paid sale, for a core partner — the statuses the server
  takes (a draft, paid, returned, cancelled or samples order never shows it). A sale under an instalment contract
  still shows it, and the popup says why it cannot (`PRICE_ADJUSTMENT_UNDER_CONTRACT`) instead of a form.
- GUESS: the line picker lists only lines the shop still holds units of, each with units held and its price now;
  with one such line it is chosen already.
- GUESS: the price field starts empty and is never filled in for the person — the current price is shown under it.
- GUESS: the day starts on Cairo's today; days before the sale and after today cannot be picked.
- GUESS: the note is capped at 500 characters in the form (the server sets no limit).
- GUESS: Save is enabled only once the preview of exactly what is typed has come back without a refusal; every
  other refusal (cycle settled, more off than owed, not lower) is the server's, said in the reader's language.
- ~~The order's Items table still shows the price each line was sold at; the price now is in its History.~~
  Superseded 2026-10-22 (owner, Option A) — below.

**What the order is worth now — DECIDED 2026-10-22 (owner, Option A); built and live
2026-10-22 (`50454df`).**

- **An order's Total is what it is worth now**: what was sold, less what came back at the price it was refunded at,
  less every price cut. The sold total is under it in small muted text, "sold at 30,300.00 EGP", only when the two
  differ; an order with no returns and no cuts shows one figure, as before. Where: the Sales list (table and phone
  card), the order popup's header, a shop's page (its orders), the Contract popup's "Sale total" (whose "Paid so far"
  is now value now − remaining: a return or a cut is not money paid).
- **In the order's Items**: a line whose price was cut shows the price now with "was 1,250.00" under it, and its line
  total is what it is worth now (units held × price now; nothing for returned units) with "sold at 5,000.00 EGP"
  under it. A line with a return but no cut: its price as sold, line total now with "sold at …". The quantity column
  keeps the sold quantity; under the product's name "1 returned · 3 held" once anything came back. On a phone the
  figures under the name read "4 × 1,250.00 → 1,150.00".
- **One definition, on the server** (CLAUDE.md §11): `apps/api/src/common/order-value-now.ts`, beside and using
  `held-price.ts`. Per order `valueNowEgp` = total − Σ return lines' `refundEgp` − Σ adjustments' `amountEgp`; per
  line `returnedQty`, `heldQty`, `soldUnitPrice` (line total ÷ quantity, as History's "sold at"), `unitPriceNow`
  (`heldUnitPrice`), `priceCut`, `lineValueNow`. Read from the stored figures the outstanding was moved by, so for an
  order still owed: **value now − payments standing + cash refunded = outstanding** (a cash refund hands the money
  back instead of lowering what is owed — §5). Returned by `GET /sales/orders` (each row, in the same queries as the
  page: no query per row), `GET /sales/orders/:id`, `GET /customers/:id` (its orders) and the assistant's sales and
  customer reads (`valueNow` beside `total`). The Sales list has no sort or filter by total.
- GUESS: "was" is the price per unit as sold after the line's discount (what History calls "sold at"), not the
  price before the discount; the Discount column still shows the discount given at the sale.
- GUESS: a credit note larger than what the order still owed is clamped at zero by the return (§5), so on such an
  order the value now can be below what was paid; the identity above then reads as a surplus nobody holds. Not
  changed here.

Koshary's 100 off is not applied yet: once the Adjust price button is in production, or through the API when the owner
says so.

### An order's full history  — DECIDED 2026-10-22 (owner), API live 2026-10-22, office screen live 2026-10-22 (`e286f9c`)

`GET /sales/orders/:id/history` (`modules/sales/order-history.service.ts`): one timeline, oldest first, each event
with its day and who recorded it — created and confirmed with its lines and prices, samples left / bought /
returned / written off, each payment allocated to it and any reversal, each return (reference, lines, refund,
method, reason), each price cut (line, old → new price, units), cancellation — and beside it, per product: started
with, returned, holds now, sold at, price now. Read from the records that already exist and the audit log (who
confirmed or cancelled); no second copy of the figures. What the order owed after each event is replayed in the
order things were recorded, as the statement replays it, and ends on the order's own outstanding (`replayedOwes`
beside `owes`, equal unless stored figures disagree). GUESS: a sale entered later is shown on its own day (its
`orderedAt`), created and confirmed alike.

**Office screen (built 2026-10-22).** A "History" tab beside "Order" in the sale order popup
(`components/sales/order-history.tsx`): the per-product table (started with, returned, holds now, sold at, price
now), then the timeline oldest first — each event's day, who, what (lines and prices, a return's reference, lines,
refund, method and reason, a price cut's old → new and units, a payment's method and reference) and what the order
owed after it — and under it both "history ends at" and "the order owes now", as the API sends them. Nothing is
summed in the browser. GUESS: when the two differ the tab says so in red and points at the data check, rather than
showing one of them. GUESS: on a phone the per-product table is one card per product (five columns do not fit).

### Editing a confirmed order — DECIDED 2026-10-25 (owner), NOT SHIPPED: saved on branch `feature/edit-order`

Built 2026-10-25/26 and held back from the 2026-10-27 release at the owner's word ("I would like to ship customer
branches, but not the edit order, lets just save it in a feature branch"). The code, its migration
`20261026100000_sale_order_edits`, its tests, this section's full rules and its Still-open guesses (the same product
added twice, an edit below what was paid, whether an edit notifies the partners and the assistant may edit) live on
`feature/edit-order` and are not in production. Until it ships there is no edit path for a confirmed order: a price
cut is a price adjustment (above), fewer units a return (§5).

### Confirm & paid in one step — DECIDED 2026-10-27 (owner), live 2026-10-27, details GUESSED

The owner: "in sales order we need a confirm and paid button for easier access", then "start build the confirm and
pay". A shop that pays on the spot took two steps — Confirm, then Record payment — for one event.

- **What it does (DECIDED).** On a draft sale order — the order popup on Sales, and New Order — a **Confirm & paid**
  button confirms the order and records a payment of its full total on it, in ONE server call and one transaction:
  both or neither. `POST /sales/orders/:id/confirm-and-pay` `{ version, payment?: { method } }` for a draft; New
  Order sends its order with `paid: true` to `POST /sales/orders` (create, confirm and pay in one transaction).
- **Refused for everything Confirm refuses** — not enough stock, a stale version, an order that is not a draft
  (confirmed, paid, cancelled: `ONLY_DRAFT_CONFIRMABLE`) — because it runs the same `confirmWithin`; and for samples at
  a shop (`SAMPLES_NOT_PAYABLE`) and an unverified customer (`CUSTOMER_NOT_VERIFIED`, as Record payment refuses).
  The payment goes through the same `recordWithin`/`allocateWithin` as Record payment (ledger INFLOW, allocation,
  every cap). A refusal at any step leaves the draft as it was: no stock drawn, no payment, no ledger row.
- **Twice (DECIDED by the rule above).** The order row is locked first, so a double click or two partners at once
  confirm and pay once; the second is refused `ONLY_DRAFT_CONFIRMABLE`. New Order's send carries its idempotency key,
  so a retry answers with the same order and one payment.
- **Who.** The roles allowed both to sell and to record a payment (core partner, admin support), worked out from the
  two lists so narrowing either narrows this.
- **Notifications.** The sale and the payment are each told to the other partners once, after the commit.
- GUESS: **the method is cash**, Record payment's own default, and the buttons ask nothing — the point is one click.
  The API takes `payment.method` (the four Record payment offers); a payment by another method is Confirm, then
  Record payment. Reference: the order number (as the walk-in sale's payment).
- GUESS: **the payment is dated the order's own day**, not today — a back-dated draft was paid when it was sold, and
  a payment is never before its order nor in the future (§7a). The owner's first words said "today"; for a draft
  made and paid the same day the two are the same. A draft from an earlier day paid today would want Confirm, then
  Record payment dated today.
- GUESS: **walk-in.** A walk-in sale is never a draft and is already paid on confirm (§4), so New Order does not
  offer the button with Walk-in on (nor with Samples on — not charged). `paid: true` on a walk-in body is the
  walk-in sale it already was; the walk-in record is refused on the draft endpoint (`WALK_IN_RESERVED`, unreachable
  from the office).
- GUESS: **an order worth nothing** is confirmed and takes no payment of 0 (as the walk-in sale): it stays CONFIRMED
  owing 0.
- GUESS: in the popup it sits beside Confirm Order (both disabled while either runs); in New Order it is the last
  button, after Create & confirm, so Enter in a field still saves a draft.

