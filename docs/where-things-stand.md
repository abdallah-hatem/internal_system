# Where things stand — 27 October 2026

A snapshot for someone picking this up, or for you in three months. What the
business does, what is built, what is live, and what is knowingly unfinished.

`docs/BUSINESS_LOGIC.md` is the authority on *rules*; this file is the authority
on *state*. Where they disagree, the rules file wins and this one is stale.
`docs/BUILD_LOG.md` carries the day-to-day: current stage, what waits on the
owner, what is queued next. (Earlier snapshots — 9 September, 21 October — are
in the file's history.)

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

Who pays for a cycle: the partners, and sometimes temporary investors. A partner
pays suppliers from his own pocket as an **advance** on his running account; an
advance funds only the cycle it was paid for (2026-10-26). The cycle's
contributions default to equal thirds, drawn from those accounts, which never go
negative. **A friend (lender)** may pay the supplier — goods, shipping and fees —
and the partners repay him later in pounds at the day's rate: his payment is a
loan to them, not funding in their place. Part of such a loan may stay in the
cycle as the friend's own investment (CYC-2026-0001, 2026-10-27). Profit is split
by contribution, investors included, so funding decides who gets paid; a cycle
with nothing entered cannot be settled. Running costs with no cycle (rent,
fuel…) come out of the partners' payouts.

Stock is costed **FIFO** in batches at landed cost (purchase + that batch's share
of freight and fees). Shops buy at trade (B2B) prices, walk-ins at retail (B2C)
and pay on the spot. Shops can owe, pay in parts, or sign an instalment contract;
a shop may have **branches** under one owner who pays for all (2026-10-27). Where
no price is set, a product's price defaults to landed cost + 20%. Samples can be
left at a shop free until it decides to buy, return or keep them.

### Who uses it

| | |
|---|---|
| **Core partners** | the office app — only the three partners use it (owner, 2026-10-18) |
| **Admin support** | a role the code knows (sells, records payments, reads the books); the production logins are the three partners |
| **Temporary investors** | participants on cycles they fund (Ahmad Eraiby and Mohammed Setta on CYC-2026-0001); they cannot sign in to the office (`OFFICE_NOT_FOR_INVESTORS`); the server's role guards stay |
| **Shop owners** | the storefront — browse, ask to buy, ask us to import |
| **The assistant** | in the office (the chat button on every page) or Claude/ChatGPT over MCP, signed in as a partner: reads the books, records sales, payments, receipts, legs and lenders with a preview and a Confirm before every write |

---

## What is built

Three apps in one repository. The two frontends never talk to each other and
never share a token.

```
apps/api          NestJS 11 · Prisma 6 · PostgreSQL     the only thing with the database
apps/web          Next.js 16 · English default, Arabic   the office app, "S&F System" (installable)
apps/storefront   Next.js 16 · Arabic default, RTL       the shop-facing store
```

910 commits · 37 migrations · 131 Playwright spec files plus API jest and web
unit suites.

The office, by menu entry (13; related pages are tabs of one page):

- **Dashboard** — two groups of tiles: Right now (cash on hand, to collect, owed to lenders, stock value, items in
  stock, low stock, active cycles) and This month (revenue, collected, net profit, expenses — the Profit and loss
  computation); on a phone four + four, then See more. Top products by units or revenue; quick actions New sale,
  Record payment, New cycle.
- **Cycles | Purchases | Shipments** — a three-step wizard (origin and currency picked from cards, purchase order,
  shipping leg), then everything on the cycle page: departures and deliveries in parts, receiving with a date, losses
  and refunds, leg cost corrected after arrival with re-costing, where-the-goods-are cards, and below the Shipment
  card **one Funding card**: target and put in so far (advances, contributions, a repaid friend, investors), each
  partner's contribution covered or short, shares as agreed, the exchange difference on repaying a friend as its own
  line, the profit split by largest-remainder percentages with Change split and Add investor. A friend's payment,
  leftovers moved to another cycle.
- **Sales** — New Order popup (draft, confirm, walk-in paid on the spot, samples; a hint when the shop already holds
  samples; a Branch picker for a shop with two or more branches, starting on its default), back-dated sales, invoice
  and delivery note as PDF (deliver-to branch), instalment contract as PDF, Adjust price and History on a confirmed
  order, returns, cancel.
- **Customers** (branches card, statement with a Branch and a screen-only Profit column), **Payments (with
  Contracts**; pay to all branches or one), **Lenders, Ledger, Inventory, Products | Categories** (a Units sold tile
  on the product page), **Suppliers | Providers, Partners | Settlements** (each partner's running account: advances,
  contributions, withdrawals, payouts left in), **Analytics** (Profit and loss, top products, cycle comparison),
  **Settings | Exchange rates | Audit log**. Every office list searches, filters, sorts and pages on the server;
  the Sales list also filters by customer and branch. Notifications open from the bell — a sale, payment, return,
  reversal or cancel by one partner reaches the others — and every one is pushed to the partners' phones in Arabic.
  Requests (order/import requests from shops) exists but is hidden in production.

The parts worth knowing about:

- **Coded refusals.** A service never writes user-facing English; a refusal names
  itself (`NOT_ENOUGH_STOCK`) and the client translates it (CLAUDE.md §9).
- **One definition per rule.** Ledger categories, available stock, low stock,
  write-offs, default price, funding lock, profit figures, undone entries, units
  sold, a sale's branch — each lives once, after copies drifted (CLAUDE.md §11).
- **Server-side guards and roles** on every money endpoint (CLAUDE.md §3, §12),
  with `scripts/check-data.sh` for records the business could not have produced.
- **Serverless-shaped.** Files in Vercel Blob, daily cron jobs (hold sweep 03:00,
  overdue instalments and samples reminder 05:00 UTC), one Prisma connection per
  instance, the API in `iad1` beside the database. The office chat's model comes
  from the API's environment (`AI_PROVIDER`, `AI_API_KEY`; the owner set Groq).

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

Production runs `origin/master` at `d87b68b` (2026-10-27): customer branches and the Sales branch filter, migration
`20261025120000_customer_branches` applied first; a walk-in looks up no branch. Earlier the same day the Funding card
learnt to count investors, read shares as agreed and show true percentages (`962ab07`), and CYC-2026-0001's funding
was corrected by a one-off script. On 2026-10-26: the office chat, partner notifications, the New Order samples
hint, partner running accounts (migration `20261025100000_partner_running_accounts`), the wizard's choice cards, the
statement's Profit column, a picker's search box that does not raise a phone's keyboard, units sold on the product
page, each cycle's funding its own, undone entries leaving every period, the Funding card (`105bd6b`, `42d2272`),
and server-side lists with the Sales customer filter (`d3955e9`). Earlier releases: BUILD_LOG "Live in production".
Nothing is merged and waiting.

**Not shipped:** Edit order on a confirmed order is saved on `feature/edit-order` (`4bdbf1e`, with its migration
`20261026100000_sale_order_edits`) for possible later use; that migration must not reach production until the branch
ships. How to ship: `docs/deployment.md` "Shipping a release".

### The data in production (2026-10-27)

Real, small, and entered partly after the fact. Production was emptied by the
owner on 2026-10-14 (`scripts/prod-reset-partners.sh`; logins abdallah@, shady@,
fares@ with his own passwords); the old test cycle and, on 2026-10-18, the
owner's test sales were deleted.

- **CYC-2026-0001** — the first real cycle, entered mid-cycle (an Alibaba order,
  PO-2026-0001). Received in Egypt 9 Sep (the owner's date; China/UAE dates
  estimated 20 Jul / 10 Aug / 28 Aug). **SELLING**, five participants. Corrected
  2026-10-23: 18 forgotten pieces added (9 products, 3 categories); leg 2 Dubai →
  Cairo 5,250 AED flat at 14 = 73,500 EGP for all 248 pieces. 2026-10-26: the
  Alibaba card fee (241.07 AED) moved from an expense into leg 1, every unit
  +13.46 EGP, total cost unchanged at 193,382.28; Abdallah's double-counted
  65,000 EGP advance reversed. 2026-10-27, funding as it really was
  (`prisma/one-off/2026-10-27-cyc-0001-funding.ts`): Ahmad Eraiby's loan is
  9,878.84 AED (60,000 EGP of it stayed in as his investment), repaid on 15 Aug /
  15 Sep / 15 Oct and owing nothing; contributions Abdallah 55,000, Shady
  33,084.50, Fares 33,084.49, temporary investors Ahmad Eraiby 60,000 and
  Mohammed Setta 20,000. Exchange difference on repaying him 3,787.84 EGP (was
  7,788.12). Profit split Eraiby 29.82 / Abdallah 27.34 / Shady 16.45 / Fares
  16.45 / Setta 9.94 %.
- **CYC-2026-0002** — started 2026-10-26, China route in AED, **PLANNING**: three
  participants, no purchase order or leg yet; advances recorded on it (Abdallah
  50,775, Shady 10,000 EGP, as read 2026-10-26).
- **Sales** ORD-2026-00001..00005, dated 12–16 Oct: Sameh (paid cash), Koshary,
  Flesteeny (5,000 paid), Ahmad Emad, Hussien El Sayed. Koshary's 100 off every
  unit was applied by the owner through Adjust price on 2026-10-23.
- **Branches**: none entered yet. Ahmad Zogmar's three (Mokattam, Master, LS2) wait
  for the owner to pick a default; the local script refuses production, the
  customer page's Branches card does it by hand.

Waiting on the owner (also in BUILD_LOG): the small UAE costs beyond leg 2's
5,250 AED; Ahmad Zogmar's default branch.

---

## Knowingly unfinished

Ordered by what would hurt first.

- **Guesses waiting for the owner.** Every rule built on a guess is marked GUESS in BUSINESS_LOGIC, the open
  questions are on the Rules Review page (BUILD_LOG "Waiting on the owner"). New this week: the branches guesses
  (§7 — a customer with branches and no default stays on the owner), the Funding card's guesses (§8), the rate at
  which a friend's loan becomes his investment (§18), and **an advance left undrawn on a settled, closed or cancelled
  cycle** (§8, OPEN — stranded today). The biggest older ones for money: running-cost shares (§8), samples kept free
  and write-offs (§4), the default price's basis and rounding (§3), the P&L's dates and buckets.
- **Known bugs** (BUILD_LOG Next up): the order popup's Allocations show raw batch codes; the CI e2e step fails on
  the container name; `POST /ledger/<not-a-uuid>/reverse` answers 500 instead of a coded refusal; return numbers
  (`RET-…`) are given without a lock, so two returns at once can collide; `apps/web/package-lock.json` is out of
  sync, so `npm ci` refuses there.
- **Change split** writes each participant's share separately and only the dialog checks they add to 100 (the
  server checks at settlement); one server-side save is queued.
- **No screen creates a temporary investor** — Add investor picks only existing ones; queued.
- **E2e not run since 2026-10-21.** The owner's rule since 2026-10-25 is unit and database tests only; the e2e
  specs written for branches, server-side lists and partner accounts have not run. The full suite takes 4 h on the
  Windows laptop; run it in parts.
- **No rate limiting anywhere.** `POST /auth/portal/signup` is public; ten requests
  in a second all succeed. `@nestjs/throttler` is the fix; the limits are a
  judgement call nobody has made.
- **Backups have never been tested.** Neon's restore window has not been checked
  and no restore has been tried. Production is backed up only when the owner asks.
  The plan is in BUILD_LOG "Queued, not started" (needs the owner's Neon access).
- **Queued features**: samples into the current order, Confirm & paid in one step, Paid by on an expense, Edit order
  (saved), selling on Amazon (§17, six questions open).
- **Smaller**: `/inventory` returns every batch with no paging; system-written
  ledger reasons are stored in English; no dark theme; the push language is always Arabic (nothing records a
  partner's language); the daily cron makes the "six hours before a hold lapses"
  warning unreliable (Hobby plan); the storefront's basket only shows on "My orders"
  (§13, open); the storefront shows nothing of branches yet.

---

## How to work on it

```bash
cd /Users/abdallahhatem/Desktop/Projects/Personal/internal_system
npm run dev                         # three titled windows: api :3001, web :3000, store :3002
npm run db:reset                    # rebuild the local database; restart the API afterwards (CLAUDE.md §8)
(cd apps/api && npm run db:seed:history)   # optional: May–October 2026 of trading for Analytics
scripts/check-data.sh               # records the business could not have produced; every count should be zero
```

Branches: `master` is production. `dev` still points at `4bdbf1e`, the same commit as `feature/edit-order` (master's
work plus Edit order, without the 2026-10-27 release merge); bring it level with master before building on it.

Agents get their own database and ports: `scripts/agent-env.sh <name>` and
`scripts/agent-servers.sh <name> start` (BUILD_LOG "How to run things here").

Read `CLAUDE.md` first — rules written after specific bugs, each naming the bug.
`.claude/LEARNINGS.md` carries the corrections that would otherwise be repeated,
including: docs move with the code in the same change (2026-10-19), keep flows
small, no e2e unless the owner asks, and never chain a production migration to
the push.
