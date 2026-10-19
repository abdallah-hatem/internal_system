# Where things stand — 19 October 2026

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
| **Temporary investors** | built and enforced server-side (own cycles only); no investor uses the app |
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

- **Dashboard** — figure tiles (six then See more on a phone), To collect, Top
  products by units or revenue; quick actions New sale, Record payment, New cycle.
- **Cycles | Purchases | Shipments** — a three-step wizard (info, purchase order,
  shipping leg), then everything on the cycle page: departures and deliveries in
  parts, receiving with a date, losses and refunds, leg cost corrected after
  arrival with re-costing, where-the-goods-are cards, funding note, participants,
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

Production runs `origin/master` at `415ccf9` (shipped 2026-10-19; migration
`20261018200000_samples_at_shops` applied first). That batch added: samples at
shops (rounds 1 and 2); default price = landed cost + 20% (B2B and B2C); the cycle
wizard ending at step 3 with a funding note on the cycle page and funding locked
once the settlement is approved; a cancelled order owes nothing; Profit and loss
redesigned (Option A, weeks on a phone); Analytics' top five; the Partners tab
refreshing after a settlement action; `db:seed:history` (local only). Nothing is
merged locally and waiting. How to ship: `docs/deployment.md` "Shipping a release".

### The data in production (2026-10-18, checked again 2026-10-19)

Real, small, and entered partly after the fact. Production was emptied by the
owner on 2026-10-14 (`scripts/prod-reset-partners.sh`; logins abdallah@, shady@,
fares@ with his own passwords); the test cycle CYC-2026-0002 and, on 2026-10-18,
the owner's test sales were deleted.

- **CYC-2026-0001** — the first real cycle, entered mid-cycle (an Alibaba order,
  PO-2026-0001). Received in Egypt 9 Sep (the owner's date; China/UAE dates
  estimated 20 Jul / 10 Aug / 28 Aug). Now **SELLING**. Leg 2 Dubai → Cairo saved
  as 20 AED × 230 pieces = 4,600 AED at 14 = 64,400 EGP — rate not confirmed.
- **Sales** ORD-2026-00001..00005, dated 12–16 Oct: Sameh (paid cash), Koshary,
  Flesteeny (5,000 paid), Ahmad Emad, Hussien El Sayed.
- **Lenders**: Ahmad Eraiby is recorded (renamed 2026-10-17). Mohamed Abu Setta,
  the second lender, is not recorded yet.
- **Ledger checked 2026-10-18**: receipts = goods + legs to the piastre;
  collected + receivables = revenue; cash on hand 34,800 = collected. On 2026-10-19
  collected read 39,800: a 5,000 payment on Koshary's ORD-2026-00002 was recorded
  on 2026-10-18 (presumably his first cash payment). The
  partners' capital of 64,400.97 (21,466.99 / 21,466.99 / 21,467 by Split equally)
  is a **stand-in** for leg 2's cost until Mohamed Abu Setta's payment is recorded.
  Under the 2026-10-19 rule the partners' contributions on CYC-2026-0001 are each
  partner's share of repaying both friends (the owner gives the split) — not 0, and
  not this stand-in.

Waiting on the owner (also in BUILD_LOG): leg 2's rate and per-piece price, the
UAE costs, Mohamed Abu Setta's payment, repayments already made to either lender,
and Koshary's new prices (then his order is re-entered at them, with his 5,000
cash payment).

---

## Knowingly unfinished

Ordered by what would hurt first.

- **The full e2e suite has not run since the 2026-10-18 batches.** It runs before
  the next big ship. Known stale specs (old menu entries, the old payment-plans
  page, finished legs now folded, the removed Recent Activity panel, two that fail
  on master too) are listed in BUILD_LOG "Known e2e debt".
- **No rate limiting anywhere.** `POST /auth/portal/signup` is public; ten requests
  in a second all succeed. `@nestjs/throttler` is the fix; the limits are a
  judgement call nobody has made.
- **Backups have never been tested.** Neon's restore window has not been checked
  and no restore has been tried. Production is backed up only when the owner asks.
- **Guesses waiting for the owner.** Every rule built on a guess is marked GUESS
  in BUSINESS_LOGIC; the list of open ones is in BUILD_LOG "Next up". The biggest
  for money: running-cost shares (§8), samples kept free and write-offs (§4), the
  default price's basis and rounding (§3), the P&L's dates and buckets.
- **Queued features**: the assistant's samples tools (after the owner approves
  samples), removing the Suppliers and Compatibility cards from a product's page,
  per-tab summary cards once there is data, selling on Amazon (§17, six questions
  open).
- **Smaller**: `/inventory` returns every batch with no paging; system-written
  ledger reasons are stored in English; no dark theme; a Calculate/Approve race on
  a settlement answers 500; the push language is always Arabic (nothing records a
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
