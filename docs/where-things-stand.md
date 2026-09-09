# Where things stand — 9 September 2026

A snapshot for someone picking this up, or for you in three months. What the
business does, what is built, what is live, and what is knowingly unfinished.

`docs/business-rules.md` is the authority on *rules*; this file is the authority
on *state*. Where they disagree, the rules file wins and this one is stale.

---

## The business

Three partners import motorcycle parts into Egypt and sell them to shops.

Money goes out in one currency, comes back in another, and the gap between those
two events is weeks. The whole system exists to answer one question honestly:
**did this import make money, and whose money was it?**

An import runs as a **cycle** — a single batch of buying, shipping, receiving and
selling that is funded, tracked and settled as one unit.

```
PLANNING → FUNDING → PURCHASING → [IN_TRANSIT] → ARRIVED_UAE
        → IN_TRANSIT_TO_EGYPT → ARRIVED_EGYPT → VERIFICATION
        → SELLING → SETTLEMENT → CLOSED
```

Two shapes of import:

| | legs | route |
|---|---|---|
| `CHINA` | 2 | China → UAE → Egypt |
| `UAE_DIRECT` | 1 | UAE → Egypt |

Partners put money in per cycle, in whatever proportion they agree. Profit is
split by those contributions, so **who funded what** is not bookkeeping detail —
it decides who gets paid. A temporary investor can join one cycle for a fee
without becoming a partner.

Stock is costed **FIFO** in batches. Landed cost is the purchase price plus that
batch's share of freight, customs and fees, so the same product bought twice has
two different costs and the older units sell first.

Shops buy at trade (B2B) prices; walk-in customers at retail (B2C). Shops can
pay in instalments, so a customer's balance is a real number the system has to
be right about.

### Who uses it

| | |
|---|---|
| **Core partners** | full access; the only role that can move money or settle |
| **Temporary investors** | see the cycles they funded, nothing else |
| **Shop owners** | the storefront only — browse, ask to buy, ask us to import |

---

## What is built

Three apps in one repository. The two frontends never talk to each other and
never share a token.

```
apps/api          NestJS 11 · Prisma 6 · PostgreSQL 16     the only thing with the database
apps/web          Next.js 16 · English default             the partners' app
apps/storefront   Next.js 16 · Arabic default, RTL         the shop-facing store
```

**143 commits · 12 migrations · 521 tests**

| suite | count | what it covers |
|---|---|---|
| `chromium` | 470 | the office app and the API, against localhost |
| `storefront` | 21 | the store, on a phone viewport |
| `production` | 30 | the deployed system, against real URLs |
| api unit | 9 files | arithmetic, guards and config that need no browser |

Last full local run: **490 passed, 0 failed**, on a database wiped and reseeded
from scratch.

### The parts worth knowing about

**Surface separation.** Tokens carry an audience — `internal` or `portal` — and a
global guard refuses a token presented to the wrong system. A shop owner's token
is not merely unauthorised in the office app; it is not a token there at all.

**Coded refusals.** Nothing user-facing is written in English inside a service. A
refusal names itself (`NOT_ENOUGH_STOCK`) and the client translates it, because
the API cannot know which language the reader chose. A test fails if a thrown
code has no translation in both locales, or if a translation outlives the code
that threw it.

**One definition per rule.** Ledger categories, available stock, and now arrival
dates each live in exactly one place, after each of them existed twice and
drifted — which shows up as a wrong figure on one screen and a right one on
another, and gets looked for in the wrong place.

**Serverless-shaped.** Files go to Vercel Blob rather than disk, the holds sweep
is a platform cron rather than an in-process timer, and Prisma is capped to one
connection per instance. All three were bugs first.

---

## What is live

| | URL | |
|---|---|---|
| API | `internal-system-api.vercel.app` | Neon Postgres, private Blob store |
| Office | `internal-system-web-three.vercel.app` | **not** `-web`, see below |
| Store | `internal-system-store.vercel.app` | |

> **The office app is at `-three`.** `internal-system-web.vercel.app` belongs to
> a different Vercel account — generated `.vercel.app` names are first-come
> across all of Vercel. That URL serves a stranger's app, and it returns 200 on
> `/`, which is exactly why it went unnoticed for two sessions. Test on a route
> only this app has, never `/`.

Production holds real but small data: **4 cycles, 3 products, 2 customers,
3 sale orders**. It is in use, not a demo.

### Not yet in production

Three commits are unpushed, and two production steps are deliberate:

1. **The `CANCELLED` migration.** Until it is applied, clicking Cancel on a cycle
   in the deployed office app answers "An unexpected error occurred".
2. **`scripts/confirm-stranded-orders.sh --fix`** against Neon. Two purchase
   orders on cycles that passed PURCHASING before the confirmation rule existed
   are still drafts, and the transition that would confirm them has already
   happened.

---

## Known gaps

Ordered by what would hurt first.

### No rate limiting, anywhere

`grep` for Throttle/rate-limit across the API returns nothing. That was fine when
every endpoint needed an office login. The storefront changed it: `POST
/auth/portal/signup` is public, and ten requests in a second all returned 201.
Someone could fill the Customers tab with thousands of unverified shops — and
that queue is where real ones get triaged.

`@nestjs/throttler` is the fix; the limits are a judgement call nobody has made.

### Push notifications have never reached a real device

The web-push and PWA work is tested through the API and a browser, but not one
actual phone. On iOS notifications only work once the app is on the home screen,
which is why the store carries an install guide — but the end-to-end path is
unverified.

### Inventory loads everything

`/inventory` returns every batch of every product with no server-side paging, and
both the inventory screen and the product page read it. Fine at 3 products,
visibly slow at a few hundred, and it is already the reason one test could not
find its own row.

### One open business question

**Where a shop sends its basket from** (`business-rules.md` §13). The basket
launcher renders only on the "My orders" tab, so a shop adding parts while
browsing has no visible way to review or send them. Deliberately not decided.

### Smaller, but real

- **JWT secret** is a generated development value. Fine now; rotate before real
  shops depend on it.
- **Cron is daily**, because Hobby rejects anything finer. Hold *expiry* is safe
  either way — `availableQty` ignores a hold past its deadline — but the "six
  hours before this lapses" warning lands inside its window about 12% of the time
  and should not be relied on.
- **`~/.claude` is not a git repository**, so the skills and learnings files
  built alongside this project exist on one machine only.

---

## How to work on it

```bash
cd /Users/abdallahhatem/Desktop/Projects/Personal/internal_system
npm run dev            # three titled windows: api :3001, web :3000, store :3002
npm run db:reset       # rebuild from nothing; restart the API afterwards
scripts/check-data.sh  # records the business could not have produced; every count should be zero
```

Read `CLAUDE.md` first — it is thirteen rules written after specific bugs, and
each one names the bug. `.claude/LEARNINGS.md` loads automatically and carries
the corrections that would otherwise be repeated.

Two habits that matter more than the rest:

- **A test that passes against the broken code is not a test.** Revert the fix,
  watch it fail, restore. This has caught worthless tests repeatedly, including
  three times in the session that produced this document.
- **Never run the suite against data being used.** The harness snapshots and
  restores, and a failed run once left the seeded state behind — the next run
  snapshotted *that* over the only copy, and a morning of data entry was gone.
