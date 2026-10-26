# Where things stand — 21 October 2026 (evening)

A snapshot for someone picking this up, or for you in three months. What the
business does, what is built, what is live, and what is knowingly unfinished.

`docs/BUSINESS_LOGIC.md` is the authority on *rules*; this file is the authority
on *state*. Where they disagree, the rules file wins and this one is stale.
`docs/BUILD_LOG.md` carries the day-to-day: current stage, what waits on the
owner, what is queued next. (The previous snapshot was dated 9 September and
last touched 19 September; it is in git history.)

---

## The business

Three partners (Abdallah, Shady, Fares — trading as S&F) import motorcycle parts
into Egypt and sell them to shops.

Money goes out in one currency, comes back in another, and the gap between those
two events is weeks. The whole system exists to answer one question honestly:
**did this import make money, and whose money was it?**

An import runs as a **cycle** — a single batch of buying, shipping, receiving and
selling that is funded, tracked and settled as one unit.

```
PLANNING → FUNDING → PURCHASING → [IN_TRANSIT] → ARRIVED_UAE
        → IN_TRANSIT_TO_EGYPT → ARRIVED_EGYPT → VERIFICATION
        → SELLING → SETTLEMENT → CLOSED            (or CANCELLED)
```

Two shapes of import: `CHINA` (China → UAE → Egypt, two legs) and `UAE_DIRECT`
(UAE → Egypt, one leg). Goods may leave and arrive in parts; the cycle's status
follows its departures and deliveries by itself.

Who pays for a cycle: the partners, always. They put money in directly, or **a
friend (lender)** pays the supplier — goods, shipping and fees — and the partners
repay him later in pounds at the day's rate: his payment is a loan to them, not
funding in their place (owner 2026-10-19; on a branch awaiting his test, see
BUILD_LOG). Each partner's contribution is their share — directly or of repaying
him — in any proportion ("Split equally", or e.g. 30/30/40 by amount or %).
Profit is split by contribution, so funding decides who gets paid; a cycle with
nothing entered cannot be settled, friend or not (the 2026-10-11 equal split for
a cycle a friend paid for entirely is gone). Running costs with no cycle (rent,
fuel…) come out of the partners' payouts.

Stock is costed **FIFO** in batches at landed cost (purchase + that batch's share
of freight and fees). Shops buy at trade (B2B) prices, walk-ins at retail (B2C)
and pay on the spot. Shops can owe, pay in parts, or sign an instalment contract.
Where no price is set, a product's price defaults to landed cost + 20%.
Samples can be left at a shop free until it decides to buy, return or keep them.

### Who uses it

| | |
|---|---|
| **Core partners** | the office app — only the three partners use it (owner, 2026-10-18) |
| **Admin support** | a role the code knows (sells, records payments, reads the books); the production logins are the three partners |
| **Temporary investors** | participants on cycles they fund; cannot sign in to the office since 2026-10-20 (`OFFICE_NOT_FOR_INVESTORS`); the server's role guards stay |
| **Shop owners** | the storefront — browse, ask to buy, ask us to import |
| **The assistant** | Claude or ChatGPT over MCP, signed in as a partner: reads the books, records sales, payments, receipts, legs and lenders with a preview before every write |

---

## What is built

Three apps in one repository. The two frontends never talk to each other and
never share a token.

```
apps/api          NestJS 11 · Prisma 6 · PostgreSQL     the only thing with the database
apps/web          Next.js 16 · English default, Arabic   the office app, "S&F System" (installable)
apps/storefront   Next.js 16 · Arabic default, RTL       the shop-facing store
```

775 commits · 34 migrations · 124 Playwright specs (about 466 tests) plus API
jest and web unit suites.

The office, by menu entry (13 since 2026-10-18; related pages are tabs of one page):

- **Dashboard** — two groups of tiles (owner 2026-10-23): Right now (cash on hand, to collect, owed to lenders,
  stock value, items in stock, low stock, active cycles) and This month (revenue, collected, net profit,
  expenses — the Profit and loss computation); on a phone four + four, then See more. To collect, Top
  products by units or revenue; quick actions New sale, Record payment, New cycle.
- **Cycles | Purchases | Shipments** — a three-step wizard (info, purchase order,
  shipping leg), then everything on the cycle page: departures and deliveries in
  parts, receiving with a date, losses and refunds, leg cost corrected after
  arrival with re-costing, where-the-goods-are cards, one Funding card (target, paid so far, contributions, split — 2026-10-26),
  a friend's payment, leftovers moved to another cycle.
- **Sales** — New Order popup (draft, confirm, walk-in paid on the spot, samples),
  back-dated sales, invoice and delivery note as PDF, instalment contract as PDF,
  returns, cancel.
- **Customers, Payments (with Contracts), Lenders, Ledger, Inventory,
  Products | Categories, Suppliers | Providers, Partners | Settlements, Analytics**
  (Profit and loss, top products, cycle comparison), **Settings | Exchange rates |
  Audit log**. Notifications open from the bell; every one is also pushed to the
  partners' phones in Arabic. Requests (order/import requests from shops) exists
  but is hidden in production.

The parts worth knowing about:

- **Coded refusals.** A service never writes user-facing English; a refusal names
  itself (`NOT_ENOUGH_STOCK`) and the client translates it (CLAUDE.md §9).
- **One definition per rule.** Ledger categories, available stock, low stock,
  write-offs, default price, funding lock, profit figures — each lives once,
  after copies drifted (CLAUDE.md §11).
- **Server-side guards and roles** on every money endpoint (CLAUDE.md §3, §12),
  with `scripts/check-data.sh` for records the business could not have produced.
- **Serverless-shaped.** Files in Vercel Blob, daily cron jobs (hold sweep 03:00,
  overdue instalments and samples reminder 05:00 UTC), one Prisma connection per
  instance, the API in `iad1` beside the database.

---

## What is live

| | URL | |
|---|---|---|
| API | `internal-system-api.vercel.app` | Neon Postgres, private Blob store |
| Office | `internal-system-web-three.vercel.app` | **not** `-web`, see below |
| Store | `internal-system-store.vercel.app` | |

> **The office app is at `-three`.** `internal-system-web.vercel.app` belongs to
> a different Vercel account. It returns 200 on `/`, which is why it went
> unnoticed for two sessions. Test on a route only this app has, never `/`.

Production runs `origin/master` with the evening 2026-10-22 release (the product page audit fixes, icons at lucide's
weight — no migration; BUILD_LOG). Before that, the 2026-10-22 release (migration `20261022100000_sale_price_adjustments`): a
new leg starts in USD flat out of China and AED per piece out of the UAE; Delete delivery only where it works; the
place cards' icons on a phone; and the API — not yet the screens — of lowering a confirmed sale's price and of an
order's full history (§4). Before it, the 2026-10-19 "Next up" batch (`b19b06f`, shipped 2026-10-21) and its follow-up
the same day, no migration in either: the Settlement button carries its cycle; Profit and loss opens on This month; no
investor signs in to the office; the product page without Suppliers/Compatibility; the assistant's samples tools;
summary cards on Cycles, Products and Sales; the invoice with the contract's header and no signature lines; the
Calculate/Approve race and the login's lost typing fixed; the Partners page fast with many open cycles; a default price
shown as a "Default" tag in the Products list. Before that `73e8c29` (2026-10-19 evening) and `415ccf9` (2026-10-19,
migration `20261018200000_samples_at_shops`) — BUILD_LOG "Live in production". Nothing is merged locally and waiting. How to ship: `docs/deployment.md` "Shipping a release".

### The data in production (2026-10-18, checked again 2026-10-19)

Real, small, and entered partly after the fact. Production was emptied by the
owner on 2026-10-14 (`scripts/prod-reset-partners.sh`; logins abdallah@, shady@,
fares@ with his own passwords); the test cycle CYC-2026-0002 and, on 2026-10-18,
the owner's test sales were deleted.

- **CYC-2026-0001** — the first real cycle, entered mid-cycle (an Alibaba order,
  PO-2026-0001). Received in Egypt 9 Sep (the owner's date; China/UAE dates
  estimated 20 Jul / 10 Aug / 28 Aug). Now **SELLING**. Corrected 2026-10-23 (BUILD_LOG):
  18 forgotten pieces added (9 new products, 3 new categories); leg 2 Dubai → Cairo is 5,250 AED flat at 14 =
  73,500 EGP for all 248 pieces; profit 11,904.07 EGP after a 7,788.12 EGP exchange difference.
- **Sales** ORD-2026-00001..00005, dated 12–16 Oct: Sameh (paid cash), Koshary,
  Flesteeny (5,000 paid), Ahmad Emad, Hussien El Sayed.
- **Lenders**: Ahmad Eraiby paid the whole cycle, 13,905.69 AED (15 Jul, blended 13.9066), and was repaid in
  three thirds on 15 Aug / 15 Sep / 15 Oct at 14 / 14.50 / 14.90 (201,168.99 EGP); he is owed nothing.
- **Ledger checked 2026-10-18**: receipts = goods + legs to the piastre;
  collected + receivables = revenue; cash on hand 34,800 = collected. On 2026-10-19
  collected read 39,800: a 5,000 payment on Koshary's ORD-2026-00002 was recorded
  on 2026-10-18 (presumably his first cash payment). The
  partners' contributions are each partner's equal third of repaying Ahmad: 67,056.33 EGP each (since 2026-10-23;
  the 64,400.97 stand-in is gone).

Waiting on the owner (also in BUILD_LOG): the small UAE costs he expects beyond leg 2's 5,250 AED. Koshary's 100 off every unit he holds was applied by the owner through Adjust
price on 2026-10-23.

---

## Knowingly unfinished

Ordered by what would hurt first.

- **The full e2e suite ran 2026-10-20** (1,219 tests), and on 2026-10-21 every spec that failed — the stale ones and
  those that also failed on `master` — was brought up to date and passes (BUILD_LOG "Known e2e debt"). The suite takes
  4 h on the Windows laptop; run it in parts.
- **No rate limiting anywhere.** `POST /auth/portal/signup` is public; ten requests
  in a second all succeed. `@nestjs/throttler` is the fix; the limits are a
  judgement call nobody has made.
- **Backups have never been tested.** Neon's restore window has not been checked
  and no restore has been tried. Production is backed up only when the owner asks.
  The plan is in BUILD_LOG "Queued, not started" (needs the owner's Neon access).
- **Guesses waiting for the owner.** Every rule built on a guess is marked GUESS
  in BUSINESS_LOGIC; all 88, with the open questions, are on the Rules Review page for him to answer (BUILD_LOG
  "Waiting on the owner"). The biggest
  for money: running-cost shares (§8), samples kept free and write-offs (§4), the
  default price's basis and rounding (§3), the P&L's dates and buckets.
- **The price adjustment and the order history have no screen yet** (API shipped 2026-10-22; BUILD_LOG Next up).
- **Queued features**: selling on Amazon (§17, six questions open).
- **Smaller**: `/inventory` returns every batch with no paging; system-written
  ledger reasons are stored in English; no dark theme; the push language is always Arabic (nothing records a
  partner's language); the daily cron makes the "six hours before a hold lapses"
  warning unreliable (Hobby plan); the storefront's basket only shows on "My orders"
  (§13, open).

---

## How to work on it

```bash
cd /Users/abdallahhatem/Desktop/Projects/Personal/internal_system
npm run dev                         # three titled windows: api :3001, web :3000, store :3002
npm run db:reset                    # rebuild the local database; restart the API afterwards (CLAUDE.md §8)
(cd apps/api && npm run db:seed:history)   # optional: May–October 2026 of trading for Analytics
scripts/check-data.sh               # records the business could not have produced; every count should be zero
```

Agents get their own database and ports: `scripts/agent-env.sh <name>` and
`scripts/agent-servers.sh <name> start` (BUILD_LOG "How to run things here").

Read `CLAUDE.md` first — rules written after specific bugs, each naming the bug.
`.claude/LEARNINGS.md` carries the corrections that would otherwise be repeated,
including: docs move with the code in the same change (2026-10-19), keep flows
small, no e2e unless the owner asks, and never chain a production migration to
the push.
