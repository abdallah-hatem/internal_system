# Walk-in sales and the assistant recording sales

2026-10-11 · feature mode · autonomous (the owner chose "walk-in, paid now"; no questions on this project)

## Rules
BUSINESS_LOGIC §4 "a walk-in sale is paid on the spot" and §16 "the assistant can record a sale" (both *Building*).

## API
- `POST /sales/orders` accepts `walkIn: true` (instead of `customerId`), plus `payment: { method }` (default CASH).
  It creates, confirms and records a payment of the full total in ONE transaction, reusing `confirmWithin` and the
  payments `allocateWithin` (no second copy of either). Channel is B2C. The shared walk-in customer comes from
  `common/walk-in.ts` `walkInCustomer(tx)`, which finds the one customer with `isWalkIn = true` or creates it under a
  unique partial index, so the race is safe.
- Refusals: `walkIn` together with `customerId` → `VALIDATION_FAILED`; `walkIn` with `confirm: false` (a draft) →
  `WALK_IN_NOT_DRAFT`; editing or deleting the walk-in customer → `WALK_IN_RESERVED`; and every existing sale refusal
  (stock, discount, negative, idempotency).
- A migration adds `Customer.isWalkIn` (boolean, default false, unique where true). The reference and demo seeds keep a
  "Walk-in" record. The customers list and pickers hide it; reports include it.
- Returns on a walk-in order: refund method is forced to money (no credit note).

## Web
- The sale form gets a **Walk-in** switch beside Customer. When on, the customer picker hides, the channel is fixed to
  B2C, retail prices fill in, a payment-method picker shows (cash default), only **Sell & take payment** is offered (no
  draft), and the total is shown as paid.

## Assistant (MCP)
- New tool `record_sale` {customer?: name or id, walkIn?: boolean, lines:[{product: name/SKU/id, qty, unitPrice?,
  discount?}], paymentMethod?}. Preview → confirmation token → commit, exactly like the other writes. The preview
  shows each line's match, the price used and whether it is the list price, the total, the stock available, and for a
  walk-in "paid on the spot by <method>". Close names → candidates; nothing found → a question; no price →
  offers the list price and asks. Binding: the preview's lines, prices and total, so a stock or price change between
  preview and confirm gives `PREVIEW_CHANGED`.
- `instructions.ts`: a short "Recording a sale" paragraph.

## Out of scope
Assistant payments for named customers, returns, settlements. The walk-in's optional name and phone.
