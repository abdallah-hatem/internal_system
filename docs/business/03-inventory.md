> Part of the [business rules](../BUSINESS_LOGIC.md) — the index there lists every section. Moved here verbatim 2026-11-01.

## 3. Inventory

**Stock is tracked in batches, and this is the one rule the BRD marks CRITICAL.**
The same product bought in three cycles at three costs stays three batches. A
batch keeps its own landed cost forever.

**FIFO.** A sale draws from the oldest verified batch first. A sale spanning two
batches records a separate allocation per batch, each with the cost that batch
was bought at. That allocation is the COGS for that sale and is never
re-priced — not by a later purchase, not by a supplier refund, not by anything —
except by correcting the cycle's own leg cost before it is settled (§2,
2026-10-17), which re-costs the batch and every sale drawn from it together.

**DECIDED 2026-08-21 — confirming a sale is when the goods leave.** These are
counter sales to shops and marketplace sales; there is no separate dispatch
step in the business, so there is none in the system. Confirming reduces the
stock physically held. Cancelling or returning restores it.

**Reservations are not in use.** `InventoryReservation` exists in the schema for
holding stock against a quote, which is a real future feature, but nothing
drives it today and reserved quantity is honestly zero.

**DECIDED 2026-10-18 (owner), built 2026-10-20 — the product page has no Suppliers or Compatibility card.** Both
cards are gone from a product's page; the data stays where it is (a product's suppliers and motorcycle models are still
stored and still read by the API) — only the cards were removed. TC-PROD-CARDS-01.

**DECIDED 2026-10-19 (owner) — no "Reserved" on screen; a product shows its stock value instead.**
The product page's Reserved tile and the Inventory table's Reserved column read the batch field
above, which nothing writes, so they always said 0; both are removed. Storefront order-request holds
are a separate table (`available-stock.ts`) and were never shown there. In the tile's place:
**Stock value** = each batch's remaining units × its landed unit cost, summed and rounded once, half
up, to the piastre — one definition (`common/stock-value.ts`) shared with the dashboard's Inventory
Value, so the products' values add up to it.

**DECIDED 2026-10-10 — stock is received one delivery at a time.** *Built 2026-10-11 (B3, F1a).*
Each delivery that reaches Egypt is counted and checked into stock as its own
batch, with its own arrival date, and can be sold the moment it is checked in —
while the rest of the shipment is still on the way. A count lower than the
delivery said leaves the difference **waiting to be received** against that
delivery: it is checked in when it is found, or marked lost. Receiving more than
a delivery brought is refused, and the units ever received or lost on an order
line can never total more than were ordered.

Stock can only be received once the cycle has reached Arrived Egypt. The first
receipt moves the cycle on to Selling, through each step's own checks, as the
wizard used to. Since L3 (§1, 2026-10-11) the delivery that reaches Egypt
has already moved the cycle to Arrived Egypt by itself, so a cycle in transit
holding a last-leg delivery exists only in data from before that rule; the
refusal (`CYCLE_NOT_ARRIVED`) stays for it. Selling then continues while later deliveries come in.

FIFO still means the oldest **received** batch first: the day it was checked
in, not the day it landed.

**DECIDED 2026-10-16 (owner asked for the capability; details a GUESS, the
recommended option) — received stock carries the day it was received.** The
owner is entering a cycle that already happened: goods received in Cairo weeks
ago. Receiving takes a **Received on** day (`receivedOn` on
`POST /receipts/verify`), optional, today when left out.
- Never in the future (`DATE_IN_FUTURE`), never a non-date (`BAD_DATE`), and
  never before the delivery that brought the goods reached Egypt
  (`RECEIVED_BEFORE_ARRIVAL`, naming both days).
- That day is the batch's received instant (`createdAt`), which FIFO orders by
  and a back-dated sale is cut off at (§4): today is now, to the second, as
  before; an earlier day is stored at midday Cairo time, so the stored instant
  is that day in Cairo and in UTC alike, on either side of a clock change.
- The office dialog prefills it with the delivery's arrival day (today if it
  arrived today), greys out days before arrival and after today, and keeps the
  counts prefilled with what was delivered (owner: they will not count per
  model).
- GUESS: the arrival day, not today, is the prefill — opening the dialog late
  is the usual reason the day matters. A part of a delivery received on another
  day is its own batch on its own day.
- `check-data` 25.3 and 25.4 watch for a batch received before its delivery
  arrived, or on a day that has not come.

**DECIDED 2026-10-10 — one meaning of "low stock".** A product is low when it is
active, has a minimum set, and the stock on hand is below that minimum. A product
with no minimum is never low. The dashboard count, the inventory filter and the
inventory highlight all use this one rule; the inventory page used to colour any
batch under 10 instead, so the two screens could disagree. *Stock on hand* is
what is on the shelf — every batch's remaining quantity summed — not what is left
after holds: a held unit is still on the shelf, and a minimum is a reorder point
(L2, 2026-10-10). The alert raised on receiving uses the same rule. Defined once
in `apps/api/src/common/low-stock.ts`, with one pinned web copy.

**DECIDED 2026-10-11 (I1, autonomous run) — a sale that takes a product into low
stock raises the alert too.** *Built 2026-10-11.* The low-stock alert used to be
raised only on receiving, so the sale that actually emptied the shelf said
nothing. Now every confirmed sale — a shop's order (in one step or confirmed
from a draft), a walk-in sale, a sale the assistant records, an approved
storefront request — raises the same alert to every active core partner when
it takes a product from not low to low, by the one rule above (below the
minimum; left exactly at the minimum is not low). **No repeat while it stays
low:** a sale of a product that was already low raises nothing. It can alert
again only once stock has been back at or above its minimum — a receipt, a
cancelled sale, a return — and a sale takes it under once more. Sent after the
sale is saved; a refused sale, a draft, or an assistant preview raises nothing.
The brief for this asked for "to or below the minimum"; the decided rule of
2026-10-10 (at the minimum is not low) was kept, so the alert, the dashboard
and the inventory page cannot disagree. Guess, open until confirmed: receiving
stock still alerts whenever the product is low after the receipt, even if it
was already low before (unchanged from 2026-10-10).

**DECIDED 2026-10-14 by the owner — a product is switched off, never deleted.**
*Built 2026-10-14 (`feature/product-deactivate`).* Its orders, batches, receipts,
returns and settlements all point at it, so it is never removed. A core partner
**deactivates** it and can **reactivate** it — from the product page and from the
row's actions on the products list, each after a short confirm that says what it
does. `PUT /products/:id/status` with `{ status }`, core partners only; the status
is ACTIVE or INACTIVE and nothing else, checked on the server on every way in
(that endpoint, `PUT /products/:id`, `POST /products`) — `PRODUCT_STATUS_INVALID`.
Defined once in `apps/api/src/common/product-status.ts` (web reading:
`apps/web/src/lib/product-status.ts`). Any stored value other than ACTIVE reads
as off. Switching to the status it already has changes nothing and logs nothing.
The audit log records DEACTIVATE / REACTIVATE.

**DECIDED 2026-10-14 by the owner — switched off means no more is BOUGHT; what is
on the shelf is still SOLD.**
- *Blocked:* a new purchase-order line, on a new order or added to a draft — from
  the Purchases form, the wizard, or the assistant (`create_purchase_order`) —
  refused as `PRODUCT_INACTIVE`, naming the product (en + ar). The Purchases
  form, the wizard and the assistant's receipt matching (`match_receipt`) stop
  offering it. A product created through quick-create is always active.
- *Allowed while there is stock:* the sale form (shop and walk-in) and the
  assistant's `record_sale`. The sale picker tags it "Inactive" and lists it only
  while some is available; once its stock reaches zero it drops out of every sale
  picker and the assistant no longer matches it. A sale beyond what is on the
  shelf is refused as for any product (`NOT_ENOUGH_STOCK`).
- *Never touched:* orders already made, drafts holding it (confirming one still
  works), a shop's pending request for it (approving still works), stock on the
  shelf, receipts, returns, settlements, history, its prices, and the product
  page, which keeps showing its stock and batches with a note that it is off.
- The low-stock rule above already skips it. The products list filters
  Active / Inactive / All, opening on Active.

Guesses made while building it, open until confirmed (2026-10-14):
- **The storefront keeps showing it while stock remains, and hides it at zero**
  (the owner's recommendation, taken). A shop can still ask for it while there is
  some; asking for more than is left is refused as for any product. "Stock" for
  the catalogue is verified units on the shelf, held ones included, so a product
  whose every unit is held by another shop's request still shows, as "out of
  stock", until the hold ends or the sale empties the shelf. An *active* product
  with nothing on the shelf stays listed as before — it will be bought again.
- **An import request cannot be answered with a switched-off product**
  (`PRODUCT_INACTIVE`): answering one says "we stock this now", and no more of it
  will be bought. The office's answer picker does not offer it.
- "The price list" in the brief was read as the storefront catalogue, which is
  the shops' price list; the office has no separate one. Setting a price on an
  inactive product is still allowed — it is still sold from the shelf.
- On a receipt, a switched-off product's printed SKU is not matched; creating a
  new product under the same SKU is then refused as `PRODUCT_SKU_TAKEN`, naming
  the product — the cue to reactivate it rather than duplicate it.

### Arabic names for categories and products  — DECIDED 2026-10-14 (owner), details GUESSED

The owner, 2026-10-14: categories and products get an Arabic name, products an Arabic description too, and
a reader on Arabic sees them. Migration `20261014150000_arabic_names` (additive, nullable).

**DECIDED (owner's brief):**
- A category has an optional Arabic name; a product an optional Arabic name and Arabic description.
- **Fallback:** wherever the reader's language is Arabic, the Arabic value is shown when there is one, the English
  one otherwise — never a blank. The office follows its URL locale (`/ar`, `/en`); the storefront opens in Arabic
  for everyone (§13), so a shop sees the Arabic unless it switches to English.
- **Search in both languages:** a search matches the English name, the Arabic name and the SKU — the office's
  product and category lists and every product or category picker, the storefront catalogue (plus the barcode, as
  before), and the assistant (`find_products`, receipt matching, `record_sale`).
- **The assistant never invents a translation.** `create_product`, and a new product inside
  `create_purchase_order`, take `nameAr`/`descriptionAr` only when the partner gave them, and leave them empty
  otherwise (§16).

| Question | What the code does | Status |
|---|---|---|
| Is a category's Arabic name unique? | **Yes, when present** — compared ignoring case and surrounding space, the same question the English name answers. Refused as `CATEGORY_NAME_AR_TAKEN`, naming the category that has it. Any number of categories may have none. Enforced twice: the service asks first (so the refusal names itself), and a partial unique index on `lower(name_ar)` stops two at once. | **GUESS** (recommended option, taken) |
| Is a product's Arabic name unique? | **No** — English product names are not unique either (the SKU is what identifies a product). | **GUESS** |
| What is stored | Trimmed. An empty or blank value is stored as **null**, so "no Arabic" has one spelling. Not sent on an edit leaves what is stored; sent empty clears it. A number or object is `VALIDATION_FAILED`. | **GUESS** |
| How long | Arabic name ≤ **200** characters (`NAME_AR_TOO_LONG`), Arabic description ≤ **1000** (`DESCRIPTION_AR_TOO_LONG`) — the limits the assistant's tools already set for the English fields. The office's own English fields still have none; not changed here. | **GUESS** |
| Which name the API sends | **Both.** Responses carry `name` and `nameAr` (and `description`/`descriptionAr`; an invoice line `product`/`productAr`; shipment and stock lines `productName`/`productNameAr`) and the client picks, because only the client knows which language the reader chose (CLAUDE.md §9). One helper per app picks: `apps/api/src/common/arabic-names.ts`, `apps/web/src/lib/localized-name.ts`, `apps/storefront/src/lib/localized-name.ts`; the office's unit test runs its copy against the API's. | DECIDED |
| What a list shows on the other language | The office's category list and product page also show the name in the *other* language (the Arabic under the English on `/en`, and the reverse), so a partner can see whether one was entered. | **GUESS** |
| How the assistant matches an Arabic name | The same matcher, against both names: an exact Arabic name (case, spacing, punctuation, short vowels and the tatweel ignored; أ إ آ read as ا, ة as ه, ى as ي) is a match; anything weaker is offered as a candidate, never taken. Its outputs carry both names (`nameAr`, `categoryAr`, `productAr`; null when none — never a guess). | **GUESS** (the folding) |
| Screens that still show only the English | Stock transfers between cycles, the leftovers dialog, the import-request queue's own text, and the products named inside refusal messages (those are English params the client interpolates). | Recorded, not built — not in the brief's list of screens. |

**Arabic search forgives spelling — DECIDED 2026-10-15 (owner), one detail GUESSED.** Every search over product
and category names, in the office and the storefront, compares Arabic as people type it:

- **ة counts as ه** (خوذه finds خوذة), **ى counts as ي** (هوندي finds هوندى), and **أ إ آ count as ا** (اطار finds
  إطار).
- **Vowel marks and the tatweel are ignored:** fatha, damma, kasra and their tanween, shadda, sukun (U+064B–U+0652),
  the madda and hamza marks above and below (U+0653–U+065F), the superscript alef (U+0670) and the tatweel ـ
  (U+0640). تَيْل فـرامل is found by تيل فرامل.
- **Case is ignored, as before. Nothing else:** no synonyms, no typo forgiveness, no search by meaning. A different
  letter is a different word — ه is not ح, ة is not ت, ء is not ا. English search is unchanged: case only, accents
  and punctuation still count.
- **Where:** the office's Products list and every picker (sale lines, purchase lines, categories, the `+` forms'
  pickers, and every other searchable list built on the shared select), the Categories list, the Inventory list,
  `GET /products?search=` (and so the assistant's `find_products`), the storefront catalogue search and its category
  filter. The assistant's receipt and sale matching already folded the same way and now uses the same definition.
- **How:** one definition, `arabicSearchKey` in `apps/api/src/common/arabic-names.ts`; the office and storefront
  carry copies pinned to it by unit tests over `arabic-search-cases.json`. Prisma's `contains` cannot fold, so each
  product stores the key of its Arabic name in `products.name_ar_search` (migration
  `20261015100000_arabic_search_key`, additive; existing rows backfilled). It is written with every write of the
  Arabic name, never shown, and left out of every API response. Postgres has the same rule as
  `arabic_search_key()`; `scripts/check-data.sh` (check 23) counts any product whose stored key disagrees with it.

| Question | What the code does | Status |
|---|---|---|
| أ / إ / آ as ا | **Folded.** The owner's list of 2026-10-15 named ة, ى and the marks; the alef line was very likely lost in copying — the assistant has folded the alef forms since 2026-10-14, and a search that found إطار in the assistant but not in the office would be the drift §11 warns about. | **GUESS** (kept; owner to confirm) |
| ؤ and ئ | **Read as و and ي.** Unicode writes them as و and ي with a hamza *mark*, and the assistant's matcher has always folded them so (it decomposes text first); search follows it rather than the two disagreeing. So رييس finds رئيس. A standalone ء is a letter and is not folded. | **GUESS** (consistency with the assistant) |
| Customer, supplier and other names | ~~Not folded in their own lists or the API.~~ **Folded since 2026-10-25**, when every list's search moved to the server (below). | Built 2026-10-25 |

**Every office list searches, filters, sorts and pages on the server — 2026-10-25 (owner: "this is the purpose of
pagination, how can you do it client from the first place"), details GUESSED; live 2026-10-26 (`d3955e9`), the Sales
branch filter live 2026-10-27 (`d87b68b`).** The fourteen lists that loaded every
row and worked in the browser — Sales, Payments, Customers, Ledger, Inventory, Notifications, Suppliers, Providers,
Cycles, Purchases, Shipments, Categories, Products, Audit log — now send what their URL says (`page`, `pageSize`,
`q` as `search`, `sort`, and their filters) to their endpoint, which filters, counts and pages in the query. One
definition, `apps/api/src/common/list-query.ts`.

- **The search is this section's, on every list.** Each list's search goes through `arabic_search_key()` in SQL
  (the same rule as `arabicSearchKey`), so the folding above now reaches customer, supplier, provider and buyer
  names, references and order numbers too. What each list searches: Sales — order number, buyer; Payments — shop,
  reference, amount; Customers — name, phone, email; Suppliers — name, phone, email, and the country by part of its
  name in either language or its code; Providers — name, contact, phone, email; Ledger — type, category, reason,
  amount; Purchases — reference, supplier, cycle code; Shipments — cycle code, provider, tracking, either place;
  Cycles — code; Products, Inventory, Categories — the product rule above; Notifications — the text; Audit log — who
  (name or email), the record as written before and after, and the action and record-type codes, plus the codes
  whose names in the reader's language contain the search (the office sends those, as only it knows the words).
- **What a search no longer finds (GUESS):** words only the browser knew — the Ledger's category *in words* (its
  category filter remains), the walk-in buyer by its Arabic name "زبون عابر" (English "Walk-in" still finds it; the
  customer filter's Walk-in choice is the way), and an audit row by a record name its own before/after does not
  carry.
- **Refused, with a code (validate on the server):** a page that is not a whole number from 1 to 1,000,000
  (`LIST_PAGE_INVALID`; the upper bound added 2026-10-26 — a page of 10^20 reached Postgres as an OFFSET it cannot
  hold and answered a 500), a page size outside 1–200 (`LIST_PAGE_SIZE_INVALID`), an order the list does not offer
  (`LIST_SORT_UNKNOWN`), a filter value the list does not offer — an order status, a ledger direction, a type that
  is not a code (`LIST_FILTER_INVALID`), a search over 100 characters (`LIST_SEARCH_TOO_LONG`). A page past the
  end is not refused: it is empty, with the total, and the office moves to the last page.
- **Customers by what they owe** (`?sort=balance`, the dashboard tile): worked out over every match on the server,
  then paged — the whole list in that order, not each page sorted on its own.
- **Notifications:** the page lists every notification, a page at a time; it used to page the bell's 50 newest.
- **The Sales list filters by customer** (owner 2026-10-25): a searchable picker beside status and dates, every shop
  and **Walk-in** as its own choice; `?customer=<id>` (`walk-in` for the walk-in buyer) in the URL, sent as
  `customerId`. A `customerId` that cannot be an id is a 400 and one that is nobody a 404 — never an empty list
  that reads as "no orders". A shop's **New Order** button now opens `/sales?new=1&customer=<id>` (`?customer=`
  alone used to mean "open the form"): the form opens on that shop, and the list underneath shows that shop's
  orders (GUESS).
- **…and, for a customer with branches, by branch** (2026-10-26, §7): once such a customer is picked, a second
  picker lists its branches (an archived one marked, its orders still its) and **On the owner** for its orders on no
  branch; `?branch=<id>` (`none` for the owner) in the URL, sent as `branchId`. Picking another customer, or
  clearing it, drops the branch in the same change. The API takes `branchId` only beside a shop's `customerId`
  (`LIST_FILTER_INVALID` alone or with Walk-in), refuses another customer's branch (`BRANCH_NOT_THIS_CUSTOMER`, as
  the sale does) and one that does not exist (404). GUESS: "On the owner" is always offered, even when the owner has
  no such orders (it then lists none).
- **A list is read again on every visit** (2026-10-26): the page last seen shows at once and is replaced by the
  server's answer, rather than trusted for the office's usual minute — a change made on another screen (a payment
  reversed moves a sale's status) or by another partner shows on the second visit.
- **Still loaded whole, on purpose:** pickers (they list every choice), the CSV exports (every match of the filters
  showing, walked a page at a time), and screens that sum or rank everything they show (a shop's own orders and
  payments, Contracts, Settlements) — not lists that search or page.

### A default price: landed cost + 20%  — DECIDED 2026-10-18 (owner), details GUESSED

The owner: "The default of any product price — B2B and B2C — is landed cost + 20% of its landed cost. Landed 100 →
default price 120 EGP. So I don't have to enter the price manually on the product details page."

| Rule | What the code does | Status |
|---|---|---|
| The default | **landed cost × 1.20**, for B2B and for B2C, in EGP. The 20 is `DEFAULT_MARKUP_PCT`, once, in `apps/api/src/common/default-price.ts`. | **DECIDED** (owner) |
| A set price wins | A price the owner set on a channel is that channel's price; the default applies only to a channel with no open price row. Each channel on its own: B2B set and B2C default is normal. | **DECIDED** (owner) |
| Which landed cost | The **weighted average landed unit cost of the units on the shelf now** — `remainingQty` × `landedUnitCostEgp` over every batch with some left, divided by the units left (verified or not, as "stock on hand" counts them, §3). Nothing on the shelf → the landed cost of the **most recently received batch** (newest `createdAt`). Never received → **no default** (null, shown "—", as an unpriced product was before). | **GUESS** (owner was told and did not object) |
| Rounding | To the **nearest whole pound, half up**, on the price, not on the cost: worked as Σ(qty × cost) × 120 / (Σqty × 100), so an exact .5 is seen as .5 (11 at 50 and 1 at 55 → 60.5 → 61). | **GUESS** |
| Landed at nothing | A cost of 0 is a batch not yet costed, not free goods: when the cost the default would use is 0, there is **no default** rather than a price of 0 (CLAUDE.md §10). A zero-cost batch beside costed ones is averaged in like any other. | **GUESS** |
| It moves | A default is worked out whenever it is read, so it follows the shelf: sell the cheap batch and the default rises. Nothing is stored, and the price history shows only prices the owner set. | **GUESS** (follows from "default") |
| Switched-off products | Unchanged: an inactive product still on the shelf is priced as any other (set, else default). | Follows §3 2026-10-14 |

**Who reads it — one function.** `listPricesFor` / `listPriceOn` in `common/default-price.ts` answer every reader:
`GET /products` and `GET /products/:id` (as `listPrices: { B2B, B2C }`, each `{ amount, currency, source: 'SET' |
'DEFAULT', markupPct? }` or null; the raw `prices` rows stay for the history), the New Order popup and the samples
"They're buying" dialog (both prefill from the products list), the assistant's `find_products` (the same objects) and
`record_sale` (a line without a stated price takes it, marked `priceSource: 'default'` and "default price (landed cost
+ 20%) … confirm or give the price" in the preview), and the storefront's catalogue, product page and request.

**A default is never saved as typed.** A sale line starts from it, and what is saved is the line's price, as for any
list price; a typed price is never overwritten. **2026-10-21 (owner):** in the Products list a default price carries a small
"Default" tag on its own line, the full "Default (landed + 20%)" on hover, so every row is one line. The product page shows the default under whichever of the B2B and B2C fields
is empty (as its placeholder, with "Default (landed + 20%)"; the B2C field was missed until 2026-10-19) and Save stays
off until a price is typed — the default never becomes a set
price by itself. The products list shows the default with the same muted hint.

**The storefront.** It already listed products with no price, as unpriced, and refused a request for one
(`PRODUCT_NOT_PRICED`). It now follows the office: a product with a default shows that figure on its card, its page and
the request, and only a product with neither a set price nor a default is unpriced. A shop is shown **the figure only,
never that it is a default** — "landed + 20%" beside a price would hand any shop the landed cost. **GUESS**, the same
rule as the office.

Open: whether the markup should differ by channel (retail above trade) — the owner said one figure for both.

### Units sold on a product page  — DECIDED 2026-10-26 (owner), details GUESSED, live 2026-10-26 (`d63070d`)

The owner: "in product page we need a card to display how many units were sold".

| Rule | What the code does | Status |
|---|---|---|
| The figure | **Units on realised sales — CONFIRMED, PARTIALLY_PAID, PAID — less units returned**, on a credit note or for cash. The same count as the Analytics top products' units: one definition, `netUnitsSold` / `SOLD_LINE_WHERE` / `REALISED_SALE_STATUSES` in `apps/api/src/common/units-sold.ts`, imported by both (CLAUDE.md §11). | **DECIDED** (owner, 2026-10-26) |
| Not sold | Drafts, cancelled orders, and samples still at a shop (status SAMPLES). Samples count once "They're buying" turns the order into a sale, and only the units the shop kept. A fully returned order (RETURNED) nets to nothing. | **DECIDED** (follows "what counts as sold everywhere else") |
| Price cuts | A price lowered after the sale changes what the units brought in, never how many there were. | **DECIDED** |
| Second line | "across N orders" — the realised orders that still hold at least one unit of the product; an order handed back in full drops out. Hidden at zero. | **GUESS** |
| Arabic label | "الوحدات المباعة", "في N طلب" with Arabic plural forms. | **GUESS** (wording) |
| Who sees it | Sent on `GET /products/:id` as `unitsSold` / `unitsSoldOrders` to the office only, as the stock is; an investor's read of the catalogue does not carry it. | **GUESS** |

The tile is the fifth beside Total Stock, Available, Stock value and Samples: two across on a phone with Units sold
taking the whole row, three then two from 768px, one row of five from 1280px.

---


### A movement's customer and price  — 2026-11-06 (owner), details GUESSED, on `feature/movement-customer-price`, not merged

Owner: "in a product details page, in movement I want to see the customer name and the price". Opening a batch on the
product page (and on Inventory) lists its movements; each row now says who it went to or came back from, and the price
per unit. `GET /inventory/batches/:id/movements` resolves both (`customerName`, `walkIn`, `branchName`, `unitPrice`,
`priceKind` `'sale' | 'refund' | 'cost' | null`, `currency`) in the same three batched reads it already made for the
record numbers — one per kind of record, never one per row; the screen looks nothing up.

| Rule | What the code does | Status |
|---|---|---|
| Customer | SALE and a cancel's RELEASE: the order's customer. RETURN (and a damaged return's WRITE_OFF): the customer of the order it was made on. SAMPLE_OUT / SAMPLE_BACK: the shop holding the samples. The branch, if the order has one, small under the name. The shared walk-in record says "Walk-in", never its stored name. Receipts, transfers, adjustments: "—". | **DECIDED** (owner asked); RELEASE and WRITE_OFF carrying the customer is a **GUESS** |
| Sale price | The line's total ÷ its quantity — after a line discount, the same per-unit rule a return refunds at (`heldUnitPrice`, `common/held-price.ts`) — in the order's currency. As sold: a price lowered later is its own dated record and does not rewrite the sale row. The order-level discount is not spread over the lines. | **GUESS** (as sold, not as later adjusted; order discount left out) |
| Two lines, two prices | Two lines of the same product on one order at different prices: no price ("—"), never an average nobody charged. Only the lines that drew from this batch count, and only this batch's product — another product on the same order never lends its price. | **GUESS** |
| Refund price | `sale_return_items.unit_price` of the return's lines that went back to this batch, in the order's currency. | **DECIDED** |
| Receipt | The batch's landed unit cost in EGP, with a muted "cost" after it, so it is never read as a selling price. Today's landed cost: a leg recosted later shows the new figure. | **DECIDED** (owner's brief) |
| Samples, others | No charge, so "—". Never an invented price. | **DECIDED** |
| A record that is gone | A movement whose order or return no longer exists, or whose reference type names another kind of record, shows nothing — never a 500, never another record's customer. | **DECIDED** |
| Who sees it | Customers and selling/refund prices only for CORE_PARTNER and ADMIN_SUPPORT, who read Sales. A temporary investor's read of their cycle's batch keeps the record numbers and the landed cost (already on the batch), with customer and price null. | **GUESS** |

Desktop: the movements are the shared table (Movement, Customer, Price, Record, Date); a phone: a card per movement,
the customer and price on its second line.
