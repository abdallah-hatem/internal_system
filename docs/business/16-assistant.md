> Part of the [business rules](../BUSINESS_LOGIC.md) — the index there lists every section. Moved here verbatim 2026-11-01.

## 16. The assistant  — DECIDED 2026-09-19, built 2026-09-25

Partners can talk to the system through Claude (claude.ai, the phone app, Claude
Desktop), connected to it as an MCP server. Spec:
`docs/specs/2026-09-19-mcp-assistant.md`.

**DECIDED 2026-10-13 (owner) — ChatGPT may connect too.** Sign-in returns a code only to Claude's own sites
(claude.ai, claude.com), to apps on the partner's own machine (localhost), and to ChatGPT's two connector callbacks
on chatgpt.com — `/connector_platform_oauth_redirect` and `/connector/oauth/<id>` — never anywhere else on that
site. Every other web service is refused: registration is open, so this list is what keeps a partner's sign-in from
being sent to someone else's site. Adding another AI means adding its exact callback here, not opening a domain.

**Who.** Core partners only. A temporary investor or a shop owner is refused when
signing in. Signing in uses the partner's own login. Each Claude app a partner
connects — the phone, a laptop — signs in once, is remembered, and appears in
Settings as its own connection.

**What it may read.** Everything a core partner can see: cycles, purchase orders,
stock with arrival and receipt dates, sales, payments, customer balances, the
dashboard, FX rates.

*Added 2026-10-11 (I1, autonomous run): who owes what* (`list_receivables`). Every
customer with an unpaid balance, largest first, with how many orders are open,
the day the oldest unpaid one was placed (in Cairo), and how much is overdue on
their payment plan; optionally only those with something overdue. The balance is
the customer's balance as everywhere else (confirmed and partly paid orders).
Decided while building it: **overdue comes only from payment plans** (§7) — a
shop with no plan has nothing overdue, because no date was ever promised — and is
**never shown above what the customer owes now** (a plan can promise more than is
still owed after a return). Reading it notifies nobody.

**What it may change.** Only the intake path, from receipt to sellable stock:
suppliers, products, purchase orders and their lines, cycles, shipping legs (and,
since 2026-10-17, correcting a leg's cost — below), cycle status, and verifying stock in — and, since 2026-10-11, recording a sale, recording a payment a shop
made, and recording what a friend paid a supplier for us and our repayments to him (below) — and, since
2026-10-15, creating a product category (below). It cannot change,
reverse or re-allocate sales or payments, nor touch instalments, settlements, returns or the ledger — those stay
in the office app.
This is enforced by the system, not by the assistant's good behaviour: its access
is valid nowhere except the assistant's own tools.

**Nothing is written without a confirmed preview.** Every change is first shown
to the partner as a preview. It is made only when the partner confirms, within
15 minutes, and what is made is exactly what was previewed — a changed quantity,
a different cycle, or a confirmation used twice is refused.

What was shown binds too, where the same request can do more by the time it is
confirmed: moving a cycle out of PURCHASING is refused if a draft order or a line
appeared since the preview (it would be locked unseen), and verifying stock is
refused if a landed cost moved since (it would be booked at a figure nobody saw).
The partner is shown the new preview instead. The assistant can move a cycle as
far as SELLING; settling and closing stay in the office app.

**Attribution.** Every change is recorded under the partner who signed in, as if
they had made it in the office app.

**Revocable.** A partner can disconnect Claude from Settings at any time — one
device or all — without changing their password. Access also lapses after 30 days
without use, and a partner who stops being a core partner loses it at once.

**The receipt flow.** A partner sends a supplier's receipt or invoice. Claude
reads it; the system matches it against suppliers, products, open cycles and
invoices already recorded, and names what could not be settled. Claude asks
exactly those questions — an unknown supplier, an unmatched line, lines that do
not add up to the stated total, a currency with no known rate, which cycle, a
receipt already recorded — and, when the reading itself failed, a receipt with
no lines, a date that cannot be read, or a currency that cannot be read. It then
previews the purchase order and creates it on the partner's word.

A name on the receipt that is close to a known supplier or product — at most
about one slip in five characters — is offered as a likely match and the partner
confirms it; a close name is never taken as the same thing without that.

Shipping, fees and tax printed on a receipt are not purchase order lines; the partner decides whether they belong on a shipping leg.

**DECIDED 2026-10-11 by the owner — the assistant can record a sale.**
*Built 2026-10-11 (W3).* "I sold 25 of X at Y to Z" is a sale the assistant records, the
same two-call way as every write: it matches the product and the customer
(close names are asked, never assumed), shows the preview — lines, total,
whether the stock is there — and saves only on a clear yes. "To anyone" or a
walk-in buyer is a walk-in sale (§4), paid on the spot. Without a stated price
it offers the list price for that kind of buyer and asks. It creates and
confirms in one step; it records no other payments, returns or settlements.

*Built 2026-10-11 (W3), the `record_sale` tool.* One matcher now serves
receipts and sales: a name is the same thing only when it is the same once
case, spacing and punctuation are ignored (or the SKU or id is), and anything
close — a plural, another word order, extra words like "matt black, size L" —
is offered as a candidate and asked. This replaces the "about one slip in five
characters" wording above for what is *offered*; what is *taken* only got
stricter. Guesses made while building it, open until confirmed:
- A receipt line that contains a product's whole name plus more words used to
  be taken as that product; it is now asked, like any other close name.
- A plural alone ("Spark plugs" against "Spark plug") is asked, not taken.
- A sale with an unsettled name or no price returns its questions and no
  confirmation token at all, rather than a refusal; an unknown customer is
  offered "a walk-in sale" as one answer.
- The assistant's sales are in EGP; the list price offered is the open price
  on the buyer's channel (the customer's type, B2C for a walk-in) — or, with
  none set, the default landed + 20%, said so (§3, 2026-10-18).
- The stock shown in the preview binds: if any of that product is sold
  elsewhere before the partner confirms, even leaving enough, the partner is
  shown a fresh preview (`PREVIEW_CHANGED`).
- A payment method on a named customer's sale is refused, not ignored.

**DECIDED 2026-10-11 by the owner — the assistant can record a payment.**
*Built 2026-10-11 (I2, `record_payment`).* "El-Sayed paid 5,000 cash" is a payment the assistant records,
the same two-call way: it finds the shop with the one matcher (a close or unknown name is asked, never
assumed, and never becomes a new customer), and previews the amount, the method (cash when unsaid), the day
received (today in Cairo when unsaid, never a future day), which orders the money lands on and the shop's
balance before and after. It saves only on a clear yes. It goes through the same payment service the office
app's Record payment uses, so every guard there applies unchanged — not more than the shop owes (§7a), not
more than a named order owes, only the shop's own confirmed orders, not an unverified shop. Without a named
order the money goes on the oldest unpaid orders first (§7); with one, on that order alone. The roles allowed
are the office endpoint's (`PAYMENT_ROLES`: core partners and admin support — the assistant itself only
admits core partners). The preview binds: a sale or another payment for the same shop between the preview
and the yes is `PREVIEW_CHANGED`, and the partner is shown the new preview. It records no reversal,
re-allocation, refund or instalment plan. Guesses, open until confirmed (2026-10-11):
- The assistant's payments are in EGP, as its sales are.
- An order is named by its number (or id); one that is not this shop's is "not found", as on the office form,
  rather than saying whose it is.
- A reference (receipt, transfer or cheque number) is recorded only when the partner gives one.

**Friends who paid a supplier (lenders, §18) — built 2026-10-11 (L2), autonomous run.**
The assistant reads and records a friend's loan the same two-call way, through the methods
the office app's "Paid by a friend" and "Record repayment" call (`LendersService.finance`,
`.repay`, `.quote`, `.list`, `.findOne`), so every guard there applies unchanged — not more
than is left on the order, not more than is owed, not dated forward or before he paid, and no
friend's payment on a cycle being settled, closed or cancelled. A repayment has no status check
of its own and needs none: a cycle reaches settlement only once its friends are repaid, and is
cancelled only once his payment was removed, so a repayment there is refused as nothing owed
(`LENDER_NOT_OWED`, or `LENDER_REPAYMENT_EXCEEDS_OWED` with the order named). Roles are the office endpoints' (`lender-roles.ts`:
reading for core partners and admin support, writing for core partners; the assistant itself
admits only core partners). Four tools:
- `list_lenders` — every friend still owed: per currency, and in pounds at today's rate on the
  exchange-rate page (the dashboard's "owed to lenders" definition, one function), with any
  overdue plan instalment. A friend owed nothing is not listed.
- `get_lender` — one friend by name or id (a close name returns the candidates, as
  `get_customer` does): each order he paid for and its cycle, every repayment with its rate,
  what it cleared, the exchange difference (and the account, on repayments recorded before
  2026-10-11 that named one), his plan, and what is still owed.
- `record_lender_financing` — "Mahmoud paid 30,000 AED for PO-2026-0004". The friend is
  found with the one matcher; an unknown or close name is a question with nothing to confirm,
  and a new friend is added only when the partner agrees (`newLender`). The order is named by
  its reference. The preview shows what the partners fund before and after (the costing's
  "to fund", §18).
- `record_lender_repayment` — "paid Mahmoud 50,000 pounds today", or "pay him off" (the
  service's own settling figure at the rate used). The preview shows the rate and where it
  came from, what it clears in his currency, what is still owed before and after, and the
  exchange difference. It asks no money account (§18, DECIDED 2026-10-11; accounts removed altogether 2026-10-14, §9).
What the preview showed binds (`PREVIEW_CHANGED`): another friend's payment on the order, or
another repayment to him, between the preview and the yes. It does not remove a friend's
payment, reverse a repayment, or agree or cancel a plan — those stay in the office app.
Guesses made while building it, open until confirmed (2026-10-11):
- The rate left unsaid is today's on the exchange-rate page — the one the office form
  prefills — and the preview says so; a currency with no rate there is asked, never guessed.
- ~~The money account: the one the partner names; with several and none named, the assistant
  asks~~ — superseded 2026-10-11: no account is asked (§18, DECIDED by the owner). The tool
  has no account parameter, and the confirmation binds no account. Since 2026-10-14 there are no
  money accounts at all (§9), and `get_lender` shows none on a repayment.
- A friend owed on more than one order is asked which order the repayment is for; it is never
  split across orders.
- A currency the partner states must be the order's; another is refused
  (`LENDER_CURRENCY_MISMATCH`), never converted.
- A friend named who already exists by exact name is that friend even if `newLender` is sent;
  two lenders of one name would make every later lookup a question.
- A new friend is created just before his payment is recorded, as two steps; if recording the
  payment were then refused (only possible if something changed after the bound preview was
  re-checked), the friend stays on file with nothing owed.
- The amount must be more than zero now in `LendersService.finance` itself, not only in the
  office form's DTO, because the assistant calls the method directly.

**Selling below cost (2026-10-11, L4).** `record_sale`'s preview carries a `belowCost`
block on every line sold below what its goods cost — `unitCostEgp`, `unitPriceEgp` (after
the line discount) and `lossEgp`, or null — and `belowCostLossEgp`, the lines' losses
added. It is the sales service's own price check (§4), so the assistant and the office
form cannot disagree. The summary says it in words, and the tool description and the
server instructions tell Claude to tell the partner the loss before the partner
confirms. It is still the partner's call: a below-cost sale confirms like any other,
and the assistant never changes the price itself.

**Deliveries (2026-10-10, built 2026-10-11, B4).** The assistant can record a delivery on a
leg and receive a delivery into stock. Marking goods lost is office-app only: it
books a loss, and a partner should decide that on a screen.

**Departures in parts (2026-10-12, L8, §1).** `add_shipping_leg` with `departedOn` records the
leg's first departure: everything waiting, or only `departureLines` when part left. A later part
is `record_departure` — the leg, the day, per product how many left (none named: everything
waiting) — previewed by the write rolled back: what leaves, what will still wait, what will be on
the way, the leg's status after, and whether the cycle moves (only a leg's first departure moves
it). The confirmation binds the lines, what still waits after them, and the status move: another
departure or a delivery into the origin in between is `PREVIEW_CHANGED`. `get_cycle` shows, per
leg and product, what waits at the origin and each departure. Undoing a departure stays in the
office app.

**Samples at shops (2026-10-20; §4).** Leave samples with a shop, list what is out, record the shop buying (the sale
completed in place), everything returned, or a write-off — `leave_samples`, `list_samples`, `complete_samples_sale`,
`return_samples`, `write_off_samples`. The same service calls and roles as the office; every write is a preview then a
confirmed commit. `return_samples` is not a return of a sale (that stays office-only), and `write_off_samples` is not
goods lost on the way (that stays office-only). Details and guesses in §4.

**Correcting a leg's cost (2026-10-17, owner: "did we add it to the assistant as well?"; §2).**
`update_leg_cost` changes only a leg's cost — basis, amount or rate, pieces or weight, currency, rate
to EGP, the same fields `add_shipping_leg` takes (one definition) — on a leg named by its id or by
its cycle (code or id) and sequence. It calls `ShippingService.updateLeg`, the office's
`PUT /shipping/legs/:id`, so every guard and the re-cost of the whole cycle are the office's; roles
are that endpoint's (`shipping/leg-roles.ts`: core partners). The preview is that write rolled back:
the leg's route, its cost before → after (in its currency and in EGP), whether goods were already
received so the whole cycle is re-costed (and how many delivered units wait to be received at the
new cost), and per product the landed cost per unit before → after with how many units were
received and how many of them already sold. A locked cost comes back as its refusal
(`LEG_COST_LOCKED_*`) with no confirmation; the cost the leg already has is `LEG_COST_UNCHANGED`.
The confirmation binds the cost before and after and every product's figures and sold units, so a
correction, receipt or sale in between is `PREVIEW_CHANGED`. The re-cost rewrites the receipts'
purchase entries exactly as the office's edit does; the assistant still adds or reverses no ledger
entry of its own, and a late charge on a locked cycle is still a cycle expense entered in the
office app. *Guess:* the assistant refuses a
correction that changes nothing rather than offering an empty confirmation.
**Planned — moving leftovers between cycles (§8, L5).** Out of scope for the first build
(2026-10-11): the office app only. When it comes, the tool calls `StockTransfersService.create`
and `undo` with the same roles (`stock-transfers/stock-transfer-roles.ts`), previews the cost and
the target's new cost to fund before the partner's yes, and is refused exactly as the office is.

**The status a record moves the cycle to (2026-10-11, L3, §1).** `record_delivery`
and `add_shipping_leg` with a departure or an arrival move the cycle on by
themselves, as the office app's do. Each preview says where the cycle will land
("This moves CYC-… from PURCHASING to IN_TRANSIT_TO_EGYPT") and which draft
orders leaving Purchasing will confirm, read from the same write rolled back;
both are part of what the confirmation binds. The commit says where it actually
landed, and the step that refused if the walk stopped short.

**Not kept.** The receipt image itself is not stored — the purchase order records
the supplier's invoice number, and the photograph stays in the conversation.

**Arabic names (DECIDED 2026-10-14, owner; §3).** `find_products` searches the
English name, the Arabic name and the SKU, and returns `nameAr` and `categoryAr`
beside `name` and `category` (null when none was entered). Receipt matching
(`match_receipt`) and `record_sale` match a product by either name through the
one matcher — an exact Arabic name is a match, a partial one only a candidate —
and their candidates and lines carry both names. **The assistant never invents a
translation:** `create_product` and a new product in `create_purchase_order` take
`nameAr`/`descriptionAr` only when the partner wrote or said them, and leave them
empty otherwise; the tool descriptions and the server instructions say so. ~~There
is no tool to create a category; an Arabic name for one is added in the office.~~ —
superseded 2026-10-15, below.

**Categories (DECIDED 2026-10-15, owner: "give the assistant create category").**
Two tools:
- `list_categories` (read) — every category: id, name, `nameAr` (null when none
  was entered), the parent it sits under (`parentId`, `parent`, `parentAr`) and how
  many products it holds, from the office's own category list. It is how the
  assistant finds the `categoryId` `create_product` takes, and a parent.
- `create_category` (write, the same two calls as every write) — `name`, `nameAr`
  only when the partner gave it (never a translation), and an optional `parent` by
  id or by English or Arabic name. It goes through `ProductsService.createCategory`,
  the method the office's New Category form calls, so the rules are one definition:
  a name already used (`CATEGORY_NAME_TAKEN`), an Arabic name already used ignoring
  case (`CATEGORY_NAME_AR_TAKEN`), an Arabic name too long or not text, and the
  audit row under the partner who signed in. Roles are the office endpoint's
  (`products/category-roles.ts`: core partners). The parent is settled only by its
  id or one category whose English or Arabic name is the same once case, spacing,
  punctuation and Arabic spelling (§3: ة/ه, أ/ا, the vowel marks) are set aside.
  Nothing matching is `CATEGORY_PARENT_NOT_FOUND` (naming the closest, if one is
  close); two or more is `CATEGORY_PARENT_AMBIGUOUS`, listing them — never a guess.
  The parent a name resolved to binds: if it means another category by the yes,
  `PREVIEW_CHANGED`. Editing, moving or deleting a category stays in the office.

Fixed in the shared method while building it (2026-10-15), so the office form gets
them too: a blank name is refused (`VALIDATION_FAILED`) instead of stored as a
category called nothing; the name is trimmed before the uniqueness check, so
"Brakes " is "Brakes"; a parent id that is no category is `NOT_FOUND`, not a 500
from the foreign key.

Decided (2026-10-15, **GUESS**, recommended option taken under the owner's standing
"decide yourself"): a category's English name is unique **ignoring case**, like a
supplier's name and a category's Arabic name, so "brakes" beside "Brakes" is refused
as `CATEGORY_NAME_TAKEN`, by the office and the assistant alike. Renaming a category
to its own name in other case is allowed. The database index stays exact-case; the
service asks first.


---

### The office chat — DECIDED 2026-10-20 / 2026-10-25 (owner), built 2026-10-25, live 2026-10-26 (Groq set on Vercel by the owner), details GUESSED

A chat inside the office app, on every page (a round button at the bottom corner), on **the assistant's own tools**:
the same services, the same roles, the same preview before every change. `apps/api/src/modules/assistant/chat/`
runs the tool server in process (the MCP client over an in-memory transport), so no tool is copied;
`components/assistant/assistant-chat.tsx` is the panel.

- **The model is the owner's choice, from the API's environment, no code change** (owner: Gemini to start, "maybe
  later Groq or any free one"): `AI_PROVIDER` (gemini, groq, openai, openrouter — any OpenAI-compatible one with
  `AI_BASE_URL`), `AI_API_KEY`, `AI_MODEL`. No key: the chat says it is not set up.
- **The model can only preview.** A change comes back as a card with **Confirm** and **Cancel**; only Confirm saves it,
  with the token that preview issued to that partner for those exact arguments (§16's rules: once, 15 minutes). A
  token the model sends is dropped, and it is never shown one. A refusal on Confirm (expired, already used, the
  facts changed) is said on the card, nothing saved.
- **100 questions a day, shared by the three partners** (owner 2026-10-25; `AI_DAILY_LIMIT`), counted in Cairo days
  from the audit log; then the chat says so until tomorrow. Confirm does not count (no model is called).
- **Only core partners** (owner 2026-10-21: nobody else signs in).
- **Nothing of the conversation is stored**: the browser holds it while the app is open; each question sends its
  newest part (12 turns, 16,000 characters). The audit log records each question's provider, model and tools
  (`ASSISTANT_CHAT`), and every change is audited by the service that made it, as always.
- **Budget per question** (GUESS): a question of at most 2,000 characters, at most six model turns, each tool's answer
  cut to 6,000 characters, tool descriptions to their first sentences — every question carries every tool.
- **Found 2026-10-25: Groq's free tier is too small** — 8,000 tokens a minute, and one question with the tools is
  ~8,300 before its second turn; the chat then says so (`AI_PROVIDER_TOO_SMALL`). Gemini's free tier fits.
- **2026-11-08: production moved to Gemini.** Groq's free tier refused every question (413: 8,000 tokens a minute against
  ~9,900 for one question; every model on the key is capped at 8,000 or less). `AI_PROVIDER=gemini` with the owner's
  key; `gemini-2.5-flash` is closed to new keys (404 "no longer available to new users"), and `gemini-3.8-flash`
  on the free tier answered 503 "high demand" or ran past the timeout with every tool. **The model is
  `gemini-flash-lite-latest`** (default in code and `AI_MODEL` on Vercel), with `reasoning_effort: low` for Gemini and a
  50 s call limit — answered "how much do customers owe" correctly in ~15 s (checked in production 2026-11-08).
- GUESS: the previews are the tools' own English summaries (as for Claude); the chat's answers follow the partner's
  language. Previews read left to right on an Arabic screen.

