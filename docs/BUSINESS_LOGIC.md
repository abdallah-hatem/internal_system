# Business rules

What the system actually does, and why. This is the agreed record — if a rule
here is wrong, the code is wrong and should change to match.

The BRD describes what the business wants. This describes what was decided when
the BRD left a choice open, and every such decision is marked **DECIDED** with
the date. Anything still open is marked **OPEN** and the code's current guess is
stated plainly, so nobody mistakes a guess for a decision.

## How this is laid out (since 2026-11-01)

This file is the index. Each section lives in its own file under
[`docs/business/`](business/), moved there verbatim; read only the sections a
task touches. A reference such as "BUSINESS_LOGIC §8" or "§4 'Samples by
branch'" means the section file the table below names for §8 or §4 — search
that file for the quoted heading.

The markers mean the same in every file: **DECIDED** (date, and who) is agreed;
**OPEN** is not decided, and the code's current behaviour is stated beside it;
**GUESS** / **GUESSED** is what was built where the owner has not yet answered —
it holds until he confirms or changes it; **FIXED** records a bug corrected;
**PLANNED** is agreed in principle and not built; **Superseded** marks a passage
kept for history that a later decision replaced.

**When a rule changes:** edit the section file under `docs/business/` (dated,
marked as above), add a line to the top of
[`00-recent-changes.md`](business/00-recent-changes.md), and change the line
below only if the section's scope changed. A new top-level section gets its own
file and a line here.

## Sections

| § | Title | File | Covers |
|---|---|---|---|
| — | Recent changes | [00-recent-changes.md](business/00-recent-changes.md) | The dated "Last updated" log of every edit to these rules, newest first; and "Sales opens on the orders still being paid for" (the Sales list's default status filter). |
| 1 | Import cycles | [01-import-cycles.md](business/01-import-cycles.md) | Route shapes, legs and their costs, deliveries and leaving in parts, losses and taking them back, the cycle's status following its shipment (incl. Preparing), Continue setup, Edit leg, where a cycle's goods are. |
| 2 | Landed cost | [02-landed-cost.md](business/02-landed-cost.md) | Shipping as part of the goods' cost, computed landed cost, per-piece legs, a leg's cost shared equally per piece, lost goods as a loss. |
| 3 | Inventory | [03-inventory.md](business/03-inventory.md) | Batches and FIFO, when goods leave, no reservations, stock value, receiving per delivery, low stock, switching a product off, Arabic names and search, the default price (landed cost + 20%), units sold, server-side search/filter/sort/paging of office lists. |
| 4 | Sales | [04-sales.md](business/04-sales.md) | Orders and stock limits, the product picker, create-and-confirm, walk-in sales, invoice, below-cost warning, cancelling, samples at shops (by branch, into an order, partial returns), lowering a price, an order's history and value now, Edit order (not shipped), Confirm & paid. |
| 5 | Returns | [05-returns.md](business/05-returns.md) | Returns never edit the sale; goods back to their batch at their cost; damaged goods; credit notes; partial returns; returns net off profit. |
| 6 | Supplier refunds | [06-supplier-refunds.md](business/06-supplier-refunds.md) | Refunds do not re-price batches; refunds for goods lost on the way; undoing a refund. |
| 7 | Customer payments and instalments | [07-customer-payments.md](business/07-customer-payments.md) | Payment plans against a running balance, cumulative progress, overdue, paying a chosen order, a sale's instalment contract, the dashboard's To collect. |
| 7b | A customer's statement | [07b-customer-statement.md](business/07b-customer-statement.md) | The statement closing at the app's balance, a payment reversed once, the statement's Profit column. |
| 7a | What cannot be recorded | [07a-what-cannot-be-recorded.md](business/07a-what-cannot-be-recorded.md) | Refusals: overpaying, unconfirmed orders owing, forward dates, discounts, cross-customer payments, dangling records; a customer with branches. |
| 8 | Cycle profit and settlement | [08-cycle-profit-and-settlement.md](business/08-cycle-profit-and-settlement.md) | Cycle profit, funding and splits, temporary investors and fees, settlement and its reversal, leftover stock moved on, payouts explained, the wizard and funding lock, partner running accounts, each cycle's own funding, the Funding card, Put in so far, Change split, the Partners page's cards, running costs. |
| 9 | The ledger | [09-ledger.md](business/09-ledger.md) | History never rewritten, what is and is not an expense, losses, cash flow vs profit figures, manual entries, cash on hand, undone entries, "Paid by" on an expense. |
| 10 | Notifications | [10-notifications.md](business/10-notifications.md) | In-app notifications, one partner's actions reaching the others, push to phones. |
| 11 | Money and rounding | [11-money-and-rounding.md](business/11-money-and-rounding.md) | Numeric precision, decimals only, EGP reporting, how money is displayed. |
| 12 | The customer storefront | [12-customer-storefront.md](business/12-customer-storefront.md) | Storefront prices and stock bands, order requests and approval, signups and verification, photos; and the office: roles (who may be a participant, read the audit log, sign in — the investor door), the menu, the dashboard, summary cards and the tabs' cards, Analytics and Profit and loss ("What made a bar"), notification delivery, "Requests in the office". |
| — | Still open | [still-open.md](business/still-open.md) | Table of questions not decided and what the code does today. |
| — | Not yet safe to run the business on | [not-yet-safe.md](business/not-yet-safe.md) | Operational risks (logins, backups, unconfirmed real data) and what superseded them. |
| 13 | Open questions — the storefront | [13-storefront-open-questions.md](business/13-storefront-open-questions.md) | Which language a shop owner gets (DECIDED: Arabic); where a shop sends its basket from (OPEN). |
| 14 | What "when stock arrived" means | [14-when-stock-arrived.md](business/14-when-stock-arrived.md) | Arrived vs received dates, arrival as the last leg, each batch's own arrival. |
| 15 | When a purchase order stops being a draft | [15-purchase-order-draft.md](business/15-purchase-order-draft.md) | PO confirmed when its cycle leaves Purchasing, no CANCELLED status, a supplier invoice recorded once, rules the office enforces too. |
| 16 | The assistant | [16-assistant.md](business/16-assistant.md) | The MCP assistant (Claude/ChatGPT): who, what it reads and changes, confirmed previews, attribution, revoking, receipts, sales, payments, lenders, deliveries, samples, categories; the office chat. |
| 17 | Selling on Amazon | [17-amazon.md](business/17-amazon.md) | PLANNED: Egypt + UAE, six OPEN questions (UAE stock, fees, price per channel, returns, listings). |
| 18 | A purchase paid by a friend, repaid in pounds | [18-paid-by-a-friend.md](business/18-paid-by-a-friend.md) | Lenders: what a friend pays, what we owe and repay, plans, the rate moving, editing a lender, the partners repaying him as a loan to them. |
| 19 | Signing out of the office | [19-signing-out.md](business/19-signing-out.md) | What signing out ends and forgets, alerts, where it lands, other tabs. |
| 20 | Passwords | [20-passwords.md](business/20-passwords.md) | Changing a password and its rules. |
| 21 | A supplier's country | [21-supplier-country.md](business/21-supplier-country.md) | ISO country codes chosen from a list, display, API, assistant, existing suppliers, search. |
| 22 | Exchange rates | [22-exchange-rates.md](business/22-exchange-rates.md) | The exchange rates page and its one definition. |
| 23 | Staying signed in to the office | [23-staying-signed-in.md](business/23-staying-signed-in.md) | 30-day sign-in with one-use refresh tokens, reuse, signing out, password change, deactivation, role changes. |

Sections appear above in the order they had in the single file (7b before 7a,
"Still open" and "Not yet safe" between §12 and §13).
