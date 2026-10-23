# Build log

Run mode: fully autonomous — chosen by the user on 2026-10-10 (this run). The MCP run before it was
fully autonomous too, chosen 2026-09-19.
Goal (current, 2026-10-22): the 2026-10-20 and 2026-10-22 "Next up" items — shipped at the owner's word ("finish
whats running then update docs, then push dont start anything else", 2026-10-22), the price adjustment and order
history as their API only. The goal before it — the 2026-10-19 batch — is live.

## Current stage
2026-10-23 — production runs `origin/master`; CYC-2026-0001's data was corrected in production at the owner's word
("re-cost sold, keep it and set prices, names ok, go"), after a rehearsal on a copy (`.backups/prod-20261023-050844.sql`,
taken before any change, is the way back): the 18 forgotten pieces, leg 2 at 5,250 AED, Ahmad Eraiby's 13,905.69 AED
and his three repayments, contributions 67,056.33 each. Nothing is merged locally and waiting.
The 9 new products stay on their default prices; the price is set on each sale as needed (owner, 2026-10-23). Next: the Rules Review answers
(`https://claude.ai/artifact/Dcr2nHwoT8gygvVhu3bBrG`); the backup test (Queued); CI's e2e step fails on GitHub before any
test runs (`motorcycle_parts_db` container name), unfixed; the sale order popup's Allocations still shows raw batch codes.
State of the product and of production's data: `docs/where-things-stand.md`.

## Live in production (newest first, last two weeks)
Older history: "History" at the foot of this file, and `git log`.
- 2026-10-23 — shipped, no migration: the dashboard in two groups (`2248549`; BUSINESS_LOGIC "The dashboard in two
  groups"): Right now (cash on hand, to collect, owed to lenders, stock value, items in stock, low stock alerts, active
  cycles) and This month (revenue, collected, net profit, expenses — `profitFigures`, the same computation as P&L's This
  month, Cairo month; `GET /analytics/dashboard` adds `month`); a phone shows four + four, See more (3). Cost of goods
  sold stays in P&L; Cash paid out joins P&L's "How it adds up" for the period (`cashPosition(db, within)`). Picked by
  the owner from a rendered sample; looked at from the agent's screenshots.
- 2026-10-23 — production data corrected (no deploy needed for it): CYC-2026-0001 gets the 18 pieces forgotten when it
  was entered — 3 new categories (Bags, Screws, Phone holders; Arabic حقائب / مسامير / حوامل هواتف, Claude's wording,
  owner OK) and 9 products (PRD-000006…014) on PO-2026-0001 at 13.85, through both legs (10 Aug, 9 Sep) and received
  9 Sep; leg 2 FLAT 5,250 AED at 14 (73,500 EGP, was 20 × 230 = 4,600 AED) — the cycle re-costed, sold units' COGS
  +767.15 EGP across 7 orders (owner: "re-cost sold"); Ahmad Eraiby's financing re-recorded as 13,905.69 AED at the
  blended 13.9066 (193,380.87 EGP) on 15 Jul, repaid in thirds 15 Aug / 15 Sep / 15 Oct at 14 / 14.50 / 14.90
  (201,168.99 EGP), owes 0; exchange difference 7,788.12 EGP; contributions 67,056.33 × 3 (equal, owner). Cycle profit
  20,459.34 → 11,904.07 EGP. Script `apps/api/prisma/one-off/2026-10-23-cyc-0001-extras.ts` (`00c90c4`; refuses a second
  run); rehearsed on a production copy first, where check-data's 66 checks were all 0. `scripts/check-data.sh` fixed to
  run under macOS bash 3.2 (an apostrophe in a SQL comment).
- 2026-10-23 — shipped: on a phone "Where the goods are" lists the first three products, then See more (`72a3b41`).
- 2026-10-22 (evening) — shipped, no migration:
  - Product page audit (`326b567`): batches are a DataTable on desktop and a card per batch on a phone, full width under
    the two columns (two columns from 1280px); movements only under an opened batch, each by its record number
    (ORD-/RET-/PO-) as a link — the batch movements endpoint sends `reference`; "Received" is the quantity, "Checked in"
    the date; prices first on a phone; the price field's placeholder is empty, the default on the line beneath; Save
    44px on a phone; the SKU under the name. The Inventory page's movements use the same component.
  - Icons drawn at lucide's weight (`16d8ca7`): Hugeicons' default stroke 1.5 carried ~74% of lucide's ink, so every
    icon read smaller; both icon modules pass stroke 2 by default (box unchanged, nothing clipped; unit tests pin it).
  - Hugeicons everywhere (`fc4221d`, the other machine, earlier the same day): one icon module per app, lucide-react
    uninstalled and refused by lint.
- 2026-10-22 — shipped (`a5bae77`, no migration): the tabs' cards reshaped (§12) — Products and Inventory: products and units in stock (the
  dashboard's figures, `GET /analytics/stock-summary`); Customers: how many, and who paid the most
  (`…/customer-summary`); Payments: the largest payment and who paid it (`…/payment-summary`); Sales' largest order
  counts products, not lines; every card has the dashboard's icon badge; the ledger has a By column. Tests:
  `summary-strip.test.tsx`, `tab-summaries.db.spec.ts` (reversed payments never count), spec 102 (TC-TABSUM-02..08),
  each break-checked.
- 2026-10-22 (afternoon) — shipped, no migration:
  - "Adjust price" on a confirmed order and its "History" tab (`e286f9c`; §4 "Office screen" guesses).
  - An order's Total is what it is worth now, "sold at …" beneath; Items show price now / "was", worth now and
    "returned · held" (`50454df`; §4 "What the order is worth now", `common/order-value-now.ts`). The shared DataTable
    sizes for a phone's columns only; the Contract popup's "Paid so far" reads the value now.
- 2026-10-22 (morning) — shipped (PR #1, migration `20261022100000_sale_price_adjustments` applied first): a leg starts
  from where it leaves; Delete delivery only where it works; goods-card icons on a phone; the price-adjustment and
  order-history API.
- 2026-10-22 — shipped (migration `20261022100000_sale_price_adjustments` first — two new tables, no data rewritten):
  - A new shipping leg starts from where it leaves: out of China USD at a flat amount, out of the UAE AED per piece,
    the rate filled in (`legCostStart` in `cycles/leg-plan.ts`, for the wizard and the cycle page's Add leg; §2).
    GUESS: the Shipments page's own New leg form still starts on EGP.
  - Delete delivery is offered only where it would work: the shipment marks each delivery `deletable` from
    `deliveryDeleteBlock` (the check `deleteDelivery` refuses with); the button is off with the reason (§1).
  - The place cards of "Where the goods are" show their icons on a phone too, rows level in en and ar, skeleton
    included (TC-I3-12, spec 99-skeletons).
  - API only: lowering a confirmed sale's price (`POST /sales/orders/:id/price-adjustments`, `…/preview`) and an
    order's full history (`GET /sales/orders/:id/history`) — §4, with the guesses marked; every revenue reader,
    the statement, the invoice and check-data take the cut on its own day; returns refund at the held price
    (`common/held-price.ts`). Tests: `price-adjustment.db.spec.ts` (11, each break-checked; five at once lower once).
  - Tests brought up to date: the unit fakes that had no price-adjustment table; `running-costs.flow.spec` had no
    `$queryRaw` for the cycle lock since `b19b06f`; the Arabic delivery-wording test reads grouped strings.
- 2026-10-21 — shipped (follow-up, no migration):
  - The Partners page projects only the open cycles where something can have moved the profit
    (`SettlementsService.cyclesWithProfitActivity`, beside `project`), four at a time: 6 s → 0.2 s with 200 open cycles,
    the same figures (profit-activity.db.spec, specs 42, 46, 99-running-costs).
  - Products list: a default price is a "Default" tag on the price's line (owner's choice), price columns 10.5rem.
  - Sales list: Status 10.5rem, so shop names stop wrapping; customer phone cards and the cycle's place cards load
    as skeletons of their real height; contracts' actions column 4rem; the invoice and statement fit A4 on paper.
  - The e2e specs that also failed on `master` brought up to date (Known e2e debt).
- 2026-10-21 — shipped (`b19b06f`, no migration), the 2026-10-19 "Next up" batch:
- The Settlement button on a cycle's page opens Partners → Settlements with that cycle chosen (`?cycle=<id>`; §8).
- Profit and loss opens on This month; All time is `?period=all` (§12).
- No investor signs in to the office: login `OFFICE_NOT_FOR_INVESTORS`, refresh ends their sign-in, the investor
  dashboard ("your cycles") removed (§12; `mayHoldOfficeSession`). Specs that refused an investor at the API now use a
  hand-signed investor token (`investorSession` in tests/support/fixtures.ts); investor UI specs removed.
- The product page lost its Suppliers and Compatibility cards (§3).
- The assistant's samples tools: `leave_samples`, `list_samples`, `complete_samples_sale`, `return_samples`,
  `write_off_samples` (§4, §16; roles in `modules/sales/sales-roles.ts`).
- Summary cards at the top of Cycles, Products and Sales (`components/ui/summary-strip.tsx`, `GET /analytics/top-orders`; §12).
- Fixed: Calculate and Approve racing on a settlement answered 500 — both take the cycle's lock now (§8, TC-SET-17);
  the Partners tab mounted its running-costs section twice on a fresh load; the office login lost what was typed before
  the page hydrated and sent the form blank (uncontrolled fields, Login disabled until hydrated).
- Tests brought up to date: the two API real-database suites that pinned the clock; the assistant's read-tools fixture
  (a batch with no landed cost); ~40 stale e2e specs (Categories as a tab, purchases at `/cycles?view=purchases`, the
  wizard's Finish, the shared dialog's footer, Arabic-first invoices, default prices, renamed seed logins, phone cards,
  ledger reads capped at 200 rows a page — `allLedgerRows`, the users list newest-first — partners by role).
- 2026-10-21 (owner, testing locally): the tab bar on tabbed pages (Partners | Settlements, Cycles | Purchases |
  Shipments, …) showed a vertical scrollbar — the tabs' underline overflowed it by 1px; it scrolls sideways only now
  (`components/ui/tab-bar.tsx`).
- 2026-10-21 (owner, testing locally): the invoice has no signature lines, and wears the contract's header (logo,
  title, tagline, number and date over a heavy rule) — one `DocumentHeader` for both (§4).
- Windows: the e2e seed step runs `npx` through a shell on win32; `apps/api/.env.example` documents the VAPID keys.
- 2026-10-19 (evening) — shipped (`73e8c29`, no migration):
  - The partners repay a friend who paid for a cycle, in any split (`072d645`; §18 "The partners repay the friend"):
    his payment is a loan, Split equally divides the whole cost, Enter amounts takes amounts or %, profit follows the
    contributions; the equal split for a cycle a friend paid entirely is gone. No way to add a friend once friends
    paid it all (`c70ed1f`); an empty share box shows the equal share (`f1ad47a`).
  - Where-the-goods-are cards: the icon above the label, six in one row from 1024px, "To UAE" / "To Egypt" (`815107a`).
  - The always-zero Reserved tile and column removed; a product's Stock value in its place, one definition with the
    dashboard's Inventory Value (`324edab`, `5852479`; §3, `common/stock-value.ts`).
  - The P&L tooltip stays inside the chart with one bucket (`6620d00`).
  - Local seed logins are Abdallah, Shady and Fares @motoparts.com (`518931a`; CLAUDE.md §8); production's are unchanged.
- 2026-10-19 — shipped (`415ccf9`; migration `20261018200000_samples_at_shops` first):
  - Profit and loss redesigned as Option A (`7834f4e`): four tiles, "How it adds up", one sales/net chart in day, week
    (Saturday–Friday) or month buckets by the period's length, top four expense categories; the Revenue by month card
    is gone (§12 "Profit and loss on Analytics"; `common/period-buckets.ts`).
  - Cycle wizard ends at step 3, Shipping leg; a funding note on the cycle page (Split equally / Enter amounts / Paid by
    a lender); funding locks once the settlement is approved, `FUNDING_LOCKED_AFTER_SETTLEMENT`; a stale draft is
    refused at approval, `SETTLEMENT_STALE_FUNDING` (`1dfb963`; §8; `common/funding-lock.ts`).
  - Six months of trading history for Analytics, `cd apps/api && npm run db:seed:history` (`caf2e1f`; local only,
    refuses a non-local database; CLAUDE.md §8).
  - A cancelled order owes nothing — outstanding goes to 0, the total stays (`2a45571`; §4). Production's own
    cancelled orders, if any, are what check-data 12.2 finds; run it after the ship.
  - Samples at shops, rounds 1 and 2 (`1062e28`, `c59486d`; §4 "Samples at shops"): the New Order popup's samples
    switch, "They're buying" opens the New Order popup pre-filled, Returned, Write off, the 14-day reminder, the
    Samples column on Inventory and the Samples card on a product's page, settlement refused while samples are out.
  - 2026-10-19: Analytics' Top products and Cycle profitability show the top five; products that sold nothing are
    dropped, cycles ranked by profit (§12 "Analytics shows the top five").
  - A product's default price is landed cost + 20% where no price is set (`22c0856`; §3; `common/default-price.ts`).
    2026-10-19: the product page's B2C field shows it too (it only did for B2B).
  - On a phone, a period drawn by day shows Saturday–Friday weeks; tapping a week lists its days (`e4e6435`; §9).
  - Fixes from the targeted test pass: the Partners tab refreshes after a settlement is approved, paid or reversed
    (`24c7442`); the default-price hint wraps inside its column (`97f1fc7`); invariants TC-INV-72..83 (`3e3cc91`).
- 2026-10-18 — the audit log names the record and lists what changed; a Who filter (by partner name) and a
  record-type filter that offers what the API writes (`3e9b748`, `07cb929`, `f231309`).
- 2026-10-18 — every office notification is pushed to the reader's phone, in Arabic (`18d52be`; §10).
- 2026-10-18 — Profit and loss v1 on Analytics, from the dashboard's own computation (`225be8f`; redesigned 2026-10-19,
  above).
- 2026-10-18 — one search-and-filters toolbar (`ListToolbar`) on every office list (`51b4cf9`).
- 2026-10-18 — Fuel quick action on the Ledger page only, gone from the dashboard (`22c1de6`, `54791b9`; §9).
- 2026-10-18 — a lender can be edited and deleted (hidden, `deleted_at`; refused while a payment of his stands,
  `LENDER_HAS_FINANCINGS`; migration `20261018100000_lender_deleted_at`); one edit icon everywhere (`17eb2e6`; §18).
- 2026-10-18 — the sidebar went from 21 entries to 13 by merging pages into tabs (`b431efb`; `lib/page-views.ts`,
  `components/ui/page-views.tsx`): Cycles | Purchases | Shipments, Suppliers | Providers, Products | Categories,
  Partners | Settlements, Settings | Exchange rates | Audit log; Notifications left the sidebar (the bell opens it).
  Old addresses redirect to their tab with parameters kept. No role checks on the tabs — owner 2026-10-18: only the
  three partners use the office app, no investor has access.
- 2026-10-18 — top products by units or revenue with bars; dashboard tiles keep their icons on a phone, six then See
  more; the ledger is سِجِلّ الحسابات in Arabic.
- 2026-10-18 — the owner's test sales deleted from production (see where-things-stand for the data left).
- 2026-10-17/18 — a leg's cost can be corrected after arrival and the cycle re-costs (+ assistant `update_leg_cost`);
  a per-piece leg is charged for the pieces that travelled on it; compact Shipment card with status dots; Recent
  Activity removed from the dashboard; phone fixes (logo in the top bar, dialogs without the bottom strip, slimmer
  bottom bar, customer orders/payments as cards, New Order buttons in two rows).
- 2026-10-17 — the sale contract (`feature/sale-contract`, migration `20261016110000_sale_contract_plan`): Contract
  button on the sale popup → plan popup → printed contract `/sales/[id]/contract` with Download PDF / Share PDF
  (`lib/document-pdf.ts`) and a clean Print; Contracts are a tab of Payments; the invoice gets the same PDF buttons.
- 2026-10-17 — 30-day office sign-in (1h access + rolling refresh token, migration
  `20261017100000_session_refresh_tokens`; §23); the window no longer scrolls past the app frame; one Requests page
  (Order | Import), hidden in production; the products table shows stock in place of Min stock.
- 2026-10-16 — sale and receipt dates (back-dated sales draw that day's stock); a friend's payment in his own
  currency covering the cycle's goods, shipping and fees; Exchange rates page; supplier country picker; Send a test
  alert (VAPID keys set in production, the owner's test alert arrived).
- 2026-10-15 — skeletons replace "Loading…"; one DataTable and one Dialog; Arabic search forgives spelling; the
  assistant lists and creates categories; the dashboard's To collect card; the office app is S&F System.
- 2026-10-14 — Arabic names for categories and products; product deactivate/reactivate; log out; money accounts
  removed (migration `20261014120000_drop_money_accounts`); password change fixed; every field shows an example;
  production reset by the owner with `scripts/prod-reset-partners.sh` (logins abdallah@ / shady@ / fares@).
- 2026-10-13 — ChatGPT may connect to the assistant (its two callbacks only).
- 2026-10-12 — L5–L8 (leftover transfer, ledger entry, running costs out of payouts, departures in parts) and
  isolated e2e per agent.

## Known e2e debt
Full run 2026-10-20 (Windows laptop, agent database, 1,219 tests incl. storefront, 4.1 h): 1,006 passed, 135 failed,
59 did not run. Every failure was then re-run, and the ones still failing were run against an untouched `master`
worktree to tell old breakage from new. 2026-10-21 (owner: "do 5 and 6") the old breakage was fixed too:
- 99-skeletons: the Dashboard and customer row counts were stale (13 tiles since 2026-10-18, contracts since
  2026-10-17); the place cards' skeleton traced the old side-by-side layout; the customer page's phone card skeleton
  was 12px short; Sales rows wrapped the shop name (Status 12.5rem → 10.5rem); Products rows with a default price
  were two lines (now a "Default" tag on the price's line, owner's choice); the spec's cycle is funded (an unfunded
  one shows the funding note above the cards, which no skeleton can predict).
- 99-table-columns: Inventory has 7 columns; screen-reader-only titles are not measured; cells are measured once no
  transition runs; the contracts' actions column fits its button (3rem → 4rem); the invoice and statement drop their
  screen minimum width on paper (`PAPER_FIT`), so they fit A4; Products fits its card (price columns 10.5rem, name
  min 13rem).
- 54-storefront TC-STORE-07/16: the test tapped Requests and clicked "طلبك" before the page changed, hitting the
  product page's "أُضيف إلى طلبك" button; it waits for the address now. The store was fine.
- 07 TC-SALE-04 and 95 TC-DR-07 were upset by the summary cards ("all" matched "Most revenue, all time"; a count
  read before the search applied).
- `GET /users/participation` (the Partners page) projected every open cycle one after another: 6 s with 200 open
  cycles, 0.2 s now — only cycles with something that can move profit are projected (`cyclesWithProfitActivity`,
  beside `project`; profit-activity.db.spec), four at a time.
Windows notes: `npm run` scripts that are shell scripts need Git Bash (`bash scripts/reset-db.sh`); `db:seed:history`'s
quoting fails in cmd — run its `ts-node` line from Git Bash; `nest start --watch` can stop the API after a spurious
file event — run `node dist/src/main` for long e2e runs.

## Waiting on the owner
- Every guess the system is built on and every open question (88 items) is on the Rules Review page,
  `https://claude.ai/artifact/Dcr2nHwoT8gygvVhu3bBrG`; his answers are saved in its database (`answers`, one document per
  item) for Claude to read and apply, with BUSINESS_LOGIC updated from them.
Data the owner will send when he has it (asked 2026-10-17/18; ask again at the start of the next session):
- UAE costs for this shipment (wrapping paper, fuel in the UAE…) beyond leg 2's 5,250 AED — the owner expects some, small (2026-10-23): each amount, currency, what it was — goods-related ones go into leg 2's cost, others as cycle expenses.
- (Answered 2026-10-23, applied in production: leg 2 is 5,250 AED flat at 14; Ahmad Eraiby paid everything and was
  repaid in three thirds; contributions 67,056.33 each. Mohamed Abu Setta is not a lender on CYC-2026-0001.)
- (Done 2026-10-23 by the owner himself through Adjust price: Koshary's 100 off every unit he holds.)

## Blocked
_(none)_

## Next up
Shipped 2026-10-21: everything the 2026-10-19 list asked for (Live in production). Left below, each with why:
- Future (owner, 2026-10-20): a small AI chat inside the office app on the assistant's own tools
  (`apps/api/src/modules/assistant/tools`) — same services, same roles, the same preview/confirm before every write
  (the confirm is a button in the chat), signed in as the partner chatting. Model and key from the API project's
  Vercel environment, so the owner swaps them with no code change: `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`
  (provider-agnostic adapter; Claude API recommended for tool use — free tiers are too small for the tool list,
  Gemini Flash ~20 requests/day, Groq ~8k tokens/min). No key set: the chat says it is not set up, never errors.
  Needs a monthly spending cap or a per-day request limit, an input-token budget per call with one realistic-size
  test (LEARNINGS), and no conversation kept beyond what the audit log already records.
- Owner to confirm the guesses still open from the 2026-10-11/12 batches (details in the History entries below):
  §18 lender guesses (rounding down, ledger rows, one friend per order, plans); §16 lender-tool guesses (today's rate
  when unsaid, ask which order, currency checked not converted) and the §8 residual guess (residual to the last
  participant with a share); §1 L3 guesses (only a changed departure is news; the status dialog closes when its fix
  moved the cycle; receiving says "cycle is now Selling"); §9 L6 guesses (foreign amounts stored in pounds +
  original_*, income "Other" as its own key, other income into net profit without a tile, a cycle in SETTLEMENT
  still takes a late cost, the date filter still reads entry time); §8 L7 guesses (who shares, capital counts toward
  the cap, the partner who leaves); §1 L8 guesses; §3 product-deactivate guesses (storefront visibility,
  import-request answer refused); §4, §7b, §16 I2 guesses. Today's batch adds the guesses marked in §3 (default
  price), §4 (samples), §8 (wizard/funding lock) and the P&L passage (buckets, the Saturday–Friday week).
  2026-10-20 adds: §12 the investor door (admin support still signs in; an issued access token lives out its hour),
  §4/§16 the samples tools' guesses, §12 the summary cards' guesses.
- Not done 2026-10-20 — a business rule (CLAUDE.md §5), for the owner to decide. Observation: the dashboard's cash on hand counts a friend's payment as money in at once while the purchase is only
  booked out at receipt — the same timing every partner-funded cycle already has (contribution in, purchase out at
  receipt). Not a new bug; consider booking purchases out when the order is confirmed.
- Not done 2026-10-20 — needs a real cycle in transit in production. Live assistant: delivery-note test once a real cycle is in transit (see notes/assistant-live-test-2026-10-11.md).
- Not done 2026-10-20 — the owner set the local logins to `password123` on 2026-10-19 (CLAUDE.md §8), so rotating
  them is his call. Rotate the seeded `password123` on partner accounts — production no longer has them (the owner replaced the logins
  with his own passwords via `scripts/prod-reset-partners.sh`, 2026-10-14); local and demo seeds still do.
- Not done 2026-10-20 — each is its own piece of work (a migration; a theme); asked to be scheduled. Queued from the 2026-10-10/11 run: system-written ledger reasons are stored in English (needs a code/params
  migration); the app has no dark theme; audit nits #39–#46; §3 vs §12 reservations contradiction (Still open);
  R1's reference-data guesses for investors (moot while no investor uses the office app, owner 2026-10-18).

## Queued, not started
- Test the backups (owner 2026-10-21: "we need to test backups of course"; for later). Nothing has ever been
  restored. Plan: (1) read Neon's point-in-time restore window for the plan production is on; (2) restore without
  touching production — a Neon branch from production at a past moment, `scripts/check-data.sh` against it, record
  counts compared with production, then delete the branch; (3) a backup that does not depend on Neon alone — a
  scheduled `pg_dump` of production to storage the owner controls, and one dump restored into a scratch database to
  prove it. Needs the owner's Neon access (console, or the Neon CLI with a key) — steps 1–2 with him.
- Selling on Amazon (Egypt + UAE) — BUSINESS_LOGIC §17, PLANNED, six questions still OPEN.

## Phases
- Walk-in + assistant sales — shipped 2026-10-11 · [decisions](build-log/decisions/walk-in-and-assistant-sales.md)
- MCP assistant — shipped 2026-09-25 · [log](build-log/decisions/mcp-assistant.md)
- Partial arrivals + UX batch — shipped 2026-10-11 · [decisions](build-log/decisions/arrivals-and-ux.md) · [waves](build-log/waves/arrivals-and-ux/)

## Notes
- [Live assistant test](build-log/notes/assistant-live-test-2026-10-11.md) — invoice image, walk-in and shop sales: pass; deliveries need a cycle in transit.
- [Backfill rehearsal](build-log/notes/backfill-rehearsal.md) — old-shape data → migrate → backfill twice → check-data zero.

## How to run things here
- Postgres runs in Docker: `open -a Docker`, then `docker compose up -d postgres`. Quit both afterwards.
- Port 3000 may belong to another project. Start directly: API `cd apps/api && WEB_ORIGIN=http://localhost:3003
  CRON_SECRET=local-cron-secret npm run start:dev` (specs 27/34 call the daily overdue job with that secret); web `cd apps/web && npm run dev -- -p 3003`; storefront `PORT=3002` (specs 54/59).
- **Parallel agents get their own environment (2026-10-12)** — no queueing for one database or fixed ports. Each
  agent works in its own worktree (`.next` and `dist` are per checkout; one stack per checkout) and:
  ```
  (cd apps/api && npm ci) && (cd apps/web && npm ci) && (cd apps/storefront && npm ci)   # fresh worktree only
  eval "$(scripts/agent-env.sh <name>)"        # database motorcycle_parts_<name> + slot N; exports below
  scripts/agent-servers.sh <name> start         # API 31N1, storefront 31N2, office 31N3; PIDs in .agent-servers/<name>/
  cd apps/web && npx playwright test '<pattern>' --project=chromium
  scripts/agent-servers.sh <name> stop && scripts/agent-env.sh <name> --drop    # when finished
  ```
  `agent-env.sh` exports `DATABASE_URL`, `API_BASE`, `WEB_URL`, `STORE_URL`, `PORT`/`API_PORT`/`WEB_PORT`/`STORE_PORT`,
  `WEB_ORIGIN`, `STORE_ORIGIN`, `NEXT_PUBLIC_API_URL`, `CRON_SECRET`. The database is copied from
  `motorcycle_parts_template` (migrated, reference seed; rebuilt automatically when migrations/schema/seed change),
  about a second. globalSetup snapshots, reseeds and restores only that database. Each shell call starts fresh, so
  prefix every command that needs the env with the `eval` line. `scripts/agent-env.sh --list` shows who holds which
  slot. Stop only your own servers (`agent-servers.sh <name> stop`), never `pkill -f next-server`.
  Lines for a subagent's brief:
  > Give yourself an isolated e2e environment: pick a short name (e.g. your task id, `[a-z0-9_]`). In your worktree run
  > `npm ci` in apps/api, apps/web, apps/storefront; then `eval "$(scripts/agent-env.sh <name>)"` before every command
  > that runs servers or specs, `scripts/agent-servers.sh <name> start`, and run specs from apps/web as usual. Never
  > use ports 3000–3003 or the `motorcycle_parts` database. When done: `scripts/agent-servers.sh <name> stop` and
  > `scripts/agent-env.sh <name> --drop`.
- With nothing set, the suite is as before: API 3001, office 3000, storefront 3002, database `motorcycle_parts`
  (`apps/web/tests/support/env.ts` is the only file in the tests that names an address).
- Specs: `WEB_URL=http://localhost:3003 npx playwright test '<pattern>' --project=chromium`, in 4 groups:
  `tests/(0[0-9]|1[0-9])-`, `tests/(2[0-9]|3[0-4])-`, `tests/(3[5-9]|4[0-9]|5[0-4])-`, `tests/(5[5-9]|6[0-9]|7[0-9])-`, `tests/(8[0-9]|9[0-9])-` (the fifth group: 80–94 were missing from "full" runs until 2026-10-11).
- Production: `scripts/ship-prod.sh status|migrate|env|stranded|smoke`. Pushing `master` deploys all three
  apps. Vercel builds production only (`ignoreCommand`). Check each deploy reaches READY on the new commit.
- Auto mode blocks production steps: switch this session to manual (set_session_permission_mode), let the owner
  approve each step, switch back to auto.

## History
The "Current stage" line as it stood on 2026-10-18, before this file's top was split into sections (2026-10-19).
Kept verbatim; everything in it is also in the sections above.

Stage on 2026-10-18: shipped 2026-10-17 — the sale contract is live (`feature/sale-contract` merged to master; migration `20261016110000_sale_contract_plan` applied first): Contract button on the sale popup → plan popup → printed contract `/sales/[id]/contract` with Download PDF / Share PDF (lib/document-pdf.ts; browser-drawn sheets, numbered only when several, table headers repeat) and Print that prints the PDF on desktop Chromium/Firefox (page print with @page margin 0 elsewhere); Payment Plans is a tab of Payments. Also live: 30-day office sign-in (refresh tokens, migration `20261017100000_session_refresh_tokens`); the window no longer scrolls past the app frame. Known e2e debt (not run, owner said no e2e): 27-payment-plans, 50-date-formatting, 61-production-browser still use the old /payment-plans page; TC-NOT-05, TC-UI-02 fail on master too. Production data (2026-10-17): test cycle CYC-2026-0002 and its records deleted; CYC-2026-0001 received in Egypt 9 Sep (owner's date; China/UAE dates estimated 20 Jul / 10 Aug / 28 Aug; leg 2 Dubai→Cairo corrected 2026-10-17 to 20 AED × 230 pieces = 4,600 AED at 14 = 64,400 EGP, re-costing the cycle — rate not yet confirmed by the owner), in SELLING; sales ORD-2026-00001..00005 (Sameh paid cash, Koshary, Flesteeny 5,000 paid, Ahmad Emad, Hussien El Sayed) dated 12–16 Oct; lender renamed Ahmad Eraiby. Ledger checked 2026-10-18: arithmetic agrees (receipts = goods + legs to the piastre; collected + receivables = revenue); capital 64,400.97 (21,466.99 / 21,466.99 / 21,467 by Split equally) stands in for leg 2's cost until Mohamed Abu Setta's payment is recorded; cash on hand 34,800 = collected. Also live 2026-10-17/18: leg cost correctable after arrival with re-costing (+ assistant update_leg_cost), per-piece count forced to the units on the leg, compact Shipment card with status dots, Fuel quick action on the Ledger page only (removed from the dashboard, owner 2026-10-18), Recent Activity removed, phone fixes (logo in the top bar, dialogs without the bottom strip, slimmer bottom bar, customer orders/payments as cards, New Order buttons in two rows), dashboard tiles with icons and See more on a phone, top products by units or revenue with bars, the ledger named سِجِلّ الحسابات in Arabic. Known e2e debt from these (not run): 85-shipment-panel, 17-shipping-costing, 89-investor-readonly and 99-departures-in-parts open finished legs, which now start folded; 75-recent-activity removed. Also 2026-10-18: the sidebar went from 21 entries to 13 by merging pages into tabs (lib/page-views.ts, components/ui/page-views.tsx): Cycles | Purchases | Shipments, Suppliers | Providers, Products | Categories, Partners | Settlements, Settings | Exchange rates | Audit log; Notifications left the sidebar (the bell opens it). Old addresses redirect to their tab with parameters kept. The tabs carry no role checks — owner 2026-10-18: only the three partners use the office app, no investor has access. Known e2e debt (not run): 78-menu-by-role, 87-investor-scope, 90-catalogue-readonly, 91-lists-show-everything, 64/72-assistant specs click or count the old menu entries. Standing: no e2e unless the owner asks; keep flows small.

### Done, moved out of "Next up" on 2026-10-19
These entries sat under Next up after they had shipped (money accounts, deactivate, L1–L8, I1–I3, isolated e2e,
the partial-arrivals plan: all live by 2026-10-14). Kept verbatim; the still-open questions in them are gathered in
Next up above.

- Money accounts removed 2026-10-14 on `chore/remove-money-accounts` (owner: "we don't need money accounts"; not
  merged, not pushed). Migration `20261014120000_drop_money_accounts` (sorts after everything in production) drops
  `money_accounts`, `reconciliation_entries` and the `account_id` columns on `financial_transactions` and
  `lender_repayments`; it raises and changes nothing if any row still names an account (rehearsed: one ledger row
  pointing at an account → P0001, tables intact). Run `scripts/ship-prod.sh migrate` before the deploy. Gone:
  `GET /ledger/accounts` (now 404), the repayment DTO's account (an unknown field → `VALIDATION_FAILED`),
  `ACCOUNT_NOT_USABLE` (en/ar), the ledger's Account column/line, the assistant's account on `get_lender`, the seeds'
  two accounts, `money_accounts` in prod-reset-partners' KEEP list. `GET /ledger/:id` with a non-uuid is a 404, not
  a 500. Tests: 34 TC-INV-38 rewritten, 99-ledger-entry TC-L6-08 new, assistant `tools/lenders.spec.ts` — each
  failed against the old code first. Docs: BUSINESS_LOGIC §9 ("Money accounts — removed"), §16, §18, Still open;
  CLAUDE.md §8. Green: api lint + typecheck + jest 1446; web lint + typecheck + unit 578 + 101; e2e (own env
  `noacct`) group 20–34 + 10, 16, 41, 49, 64, 67, 72, 77–79, 95, 96, 98-lender, 99-assistant-lenders,
  99-ledger-entry, 99-running-costs: 300 passed, 7 skipped, 2 failed only in the combined run (TC-CASH-01 sums
  `/ledger?limit=500` against the dashboard; TC-L6-03 finds no core partner in the users list) — neither reads an
  account, both pass alone (19/19 for their two specs); check-data zero; minimal/reference/demo seeds run.
- Infra (owner 2026-10-12, after L7 lands): isolated e2e per agent — DONE on `chore/isolated-e2e`: every spec and
  the Playwright config read addresses from `tests/support/env.ts`; `scripts/agent-env.sh <name>` (the planned
  `agent-db.sh`) makes the database from a migrated template and prints the env + port block;
  `scripts/agent-servers.sh` starts/stops that agent's stack; globalSetup snapshots/restores that database only. See
  "How to run things here". Proven 2026-10-12: agents a and b in two worktrees ran group `(2[0-9]|3[0-4])-` at the
  same time, 163 passed / 2 skipped each, 178 s each; a plain run of 01-auth with nothing set: 14 passed, default DB
  snapshot/restored, check-data zero. Per task from now on: touched specs + affected groups in the agent's own environment; the
  full suite once before each deploy. (Skill updated: abdallah-skills 1.46.0.)
- Done 2026-10-12: L6, L8, L7 shipped unattended; dev stopped, Docker quit, Amphetamine ended.
- Deactivate a product built 2026-10-14 on `feature/product-deactivate` (from af653cc; not merged, not pushed; no
  migration): `PUT /products/:id/status` (core partners), Deactivate/Reactivate with a confirm on the product page
  and each list row, list filter Active/Inactive/All. Owner decided mid-build: off = no more is BOUGHT (new PO
  lines refused `PRODUCT_INACTIVE`, buying pickers and receipt matching drop it); the shelf is still SOLD (sale
  form tags it Inactive, record_sale and the storefront keep it) until stock is zero. §3; guesses there (storefront
  visibility, import-request answer refused). New specs 99-product-deactivate(+storefront), assistant unit tests.
  Seen, not fixed: TC-PORTAL-03 fails when run after 34 — TC-INV-48's product is named "Cost Check", which lands on
  the catalogue's first page and trips the "no `cost` in the payload" word check.
- L8 built 2026-10-12 on `feature/l8-departures-in-parts` (master 431c4d2 merged in; not merged back, not pushed):
  goods leave in parts (§1) — a departure per day with per-product lines, Undo where nothing depends on it, only
  what left can arrive or be lost, PARTLY_DEPARTED, goods cards split waiting-at-origin from on-the-way, the
  assistant's `record_departure`; the wizard stops at Purchasing; Add next leg / Edit leg (cost while unlocked) on
  the cycle page through the Shipments page's own forms. Migration `20261012140000_shipment_departures` (sorts after
  20261012130000) carries the SQL backfill — run `scripts/ship-prod.sh migrate` before the deploy; rehearsed by
  `scripts/rehearse-departures-backfill.sh` (demo seed → departures removed → backfill twice → identical rows,
  check-data zero). E2E fixtures now order before they ship and send leg 2 only after a leg-1 delivery. Full e2e
  green (5 groups: 199, 152, 144, 230, 266 passed), api jest 1362, web unit 552+101, lint, typecheck, check-data
  zero (new checks 12.91–12.93). Screens in `.ui-audit/l8/`. Owner to confirm the L8 guesses in §1.
- L6 built 2026-10-12 on `feature/l6-ledger-entry` (master 6d03bc5 merged in; not merged back, not pushed): a manual
  ledger entry can't lie (§9) — "Record money in or out" with kind cards, the one category list, cycle picker, date;
  every refusal server-side with a code. Migration renamed `20261012130000_ledger_entry_date` so it applies after
  20261011230000 and 20261012100000 — run `scripts/ship-prod.sh migrate` before the deploy. Fixed on the way:
  cycle profitability ignored cycle-charged expenses while settlement subtracted them; reversed expenses stayed in
  Expenses; **a sale return was counted as an expense on the dashboard** (a 300 cash refund took 900 off net profit;
  own commit, `SALE_CATEGORIES`); Escape in a picker closed the whole form. Full e2e green (5 groups: 199, 147, 144,
  230, 253 passed), api jest 1322, web unit 510+99, lint, typecheck, check-data zero (new check 21). Screens in
  `.ui-audit/l6/`. Owner to confirm the §9 guesses (foreign amounts stored in pounds + original_*, income "Other"
  as its own key, other income into net profit without a tile, a cycle in SETTLEMENT still takes a late cost, the
  date filter still reads entry time). Open (§Still open): cash on hand counts a return's two rows as cash out.
- L7 built 2026-10-12 on `feature/l7-running-costs-payouts` (master d02d301 merged in; not merged back, not pushed):
  running costs come out of the core partners' payouts and a payout explains itself line by line (§8). A cost with
  no cycle is split equally among the active core partners (rounded down, the odd piastre to the partner who joined
  last, named on the Partners page); Mark paid takes each partner's waiting share, oldest first, up to his payout,
  the rest carries; `running_cost_charges` records it, reversing the settlement releases it, a charged cost cannot be
  reversed (`RUNNING_COST_CHARGED`). The payout row is the cash handed over; a `running_cost_share` row (not cash, not
  an expense) records the deduction. Settlements keep their costs line by line (`cost_breakdown`); the card drops the
  lump "Expenses"; the Partners page gains Running costs (period picker) and each payout's breakdown. Cash on hand no
  longer counts a return's sale undone. One Escape helper for every dialog with pickers (RecordPaymentDialog lost its
  form). Migration `20261012150000_running_cost_charges` (additive; sorts after 20261012140000) — run
  `scripts/ship-prod.sh migrate` before the deploy. New: e2e 99-running-costs (TC-RC-01..03), 34 TC-INV-59..64,
  79 TC-RP-10, all failing against master's code and passing after; check-data 22–22.3. Screens in `.ui-audit/l7/`.
  Owner to confirm the L7 guesses in §8 (who shares, capital counts toward the cap, the partner who leaves). Open
  (§Still open): Analytics' cycle "investment" counts settlement payouts.
- L3 building: status follows departures/deliveries (owner 2026-10-11); no money account on a friend's repayment
  (owner); amount inputs start-aligned app-wide (owner screenshot).
- L4 phase 1 building (no DB, beside L3): below-cost warning wherever a selling price is set — sale form, walk-in,
  confirm, order-request approval, price list, assistant record_sale preview. Warns, never refuses (owner 2026-10-11).
- L3 built 2026-10-11 on `feature/l3-status-follows-shipping` (not merged, not pushed), three commits:
  (1) owner decision — recording a departure or a delivery moves the cycle on by itself through each step's own
  checks (§1; `CyclesService.followShipment`; every entry point incl. the assistant's previews; office toast
  "… — cycle is now X"); (2) owner decision — a friend's repayment asks no money account (§18; migration
  `20261011230000_lender_repayment_account_optional` — run `scripts/ship-prod.sh migrate` before the deploy;
  stored accounts, the production test data's Business Bank Account included, are kept); (3) typed amounts and
  quantities start-aligned in every input (one unlayered rule in globals.css; screens in `.ui-audit/l3/`).
  Full e2e green (5 groups; TC-LIST-07 failed once in group 5 and passed alone 3/3 and in a full group-5 rerun),
  api jest, web unit, lint, typecheck, check-data zero. Owner to confirm the §1 L3 guesses (only a changed
  departure is news; the status dialog closes when its fix moved the cycle; receiving says "cycle is now Selling").
  Existing cycles behind their shipment are not moved until their next departure or delivery.
- TEST DATA IN PRODUCTION (owner asked 2026-10-11, remove when he says): CYC-2026-0001 (UAE direct, In transit to Egypt),
  PO-2026-0001 (TEST Al Noor Trading; TEST Full face helmet ×100 @200 AED, TEST Brake pad set ×200 @50 AED; rate 13),
  lender TEST Mahmoud paid 30,000 AED; repayments 100,000 EGP @13.3 (20 Sep) and 150,000 EGP @13.85 (5 Oct), both from
  Business Bank Account; leg Dubai→Cairo TEST Gulf Freight 5,000 EGP departed 5 Sep. Still owed 11,650.89 AED;
  exchange difference 11,461.57 EGP. All entered through the assistant (live test of the L2 tools: pass).
- Observation: the dashboard's cash on hand counts a friend's payment as money in at once (390,000) while the purchase
  is only booked out at receipt — the same timing every partner-funded cycle already has (contribution in, purchase
  out at receipt). Not a new bug; consider booking purchases out when the order is confirmed.
- L2 built 2026-10-11 on `feature/l2-lenders-assistant` (not merged, not pushed): (1) owner decision — a cycle a
  friend paid for entirely splits its profit equally among its core partners (§8, §18; spec 34 TC-INV-45..47);
  (2) assistant tools `list_lenders`, `get_lender`, `record_lender_financing`, `record_lender_repayment` (§16, §18;
  unit `tools/lenders.spec.ts`, e2e spec 99); (3) the I3 "Not departed" twice nit. No migration. Full e2e green
  (5 groups), api jest, web unit, lint, typecheck, check-data zero. Owner to confirm the §16 lender-tool guesses
  (today's rate when unsaid, ask which order, currency checked not converted; the account question was dropped by the owner in L3)
  and the §8 residual guess (residual to the last participant with a share). After merging, toggle the assistant
  connector off/on to see the new tools.
- L1 merged into master 2026-10-11 (alignment review: money rules ALIGNED; 8 missing edge-case tests + 4 doc gaps fixed in a04608e) — from `feature/l1-lender-financing` (§18, spec/plan `docs/superpowers/{specs,plans}/2026-10-11-lender-financing.md`):
  lenders, "Paid by a friend" on the order and cycle page, repayments in pounds at the day's rate, plans, the settlement
  gate, the dashboard's owed-to-lenders figure. Migration `20261011200000_lender_financing` — run `scripts/ship-prod.sh
  migrate` before the deploy. Full e2e green (5 groups), check-data zero (new checks 19–19.5). Ship after the owner's go.
  Owner to confirm the §18 guesses (rounding down, ledger rows, one friend per order, plans). The OPEN one — a cycle a
  friend paid for entirely — was decided by the owner 2026-10-11 and built in L2.
  Seen while testing, not fixed: approving a settlement while a recalculation replaces its draft answers 500 (P2025)
  instead of NOT_FOUND — a race between Calculate and Approve.
- I1 shipped 2026-10-11. Owner: toggle the assistant connector off/on to see `list_receivables`.
- I2 shipped 2026-10-11: assistant `record_payment` (owner-approved, §16) with "oldest first" moved to
  the server; printable sale invoice / delivery note (§4); customer statement with print + CSV (§7b); recent activity
  links the shop; Sales/Payments keep their rows while a new range loads; AppModule compiles in jest; FIFO across two
  selling cycles pinned (34 TC-INV-30). **Found and fixed: a partial return marked the whole order RETURNED and its
  remaining debt vanished from the shop's balance** (§5). Before shipping, run `scripts/check-data.sh` against
  production: check 18 lists orders already caught. Guesses to confirm: §4, §7b, §16.
- `PaymentsService.reverse` reversing twice added the money back twice — fixed in I3 phase 1
  (`PAYMENT_ALREADY_REVERSED`; unit spec + 34 TC-INV-31, the latter to run in phase 2).
- I3 (owner 2026-10-11): record a leg's departure and its deliveries from the cycle details page (reuse RecordDeliveryDialog / the shipments page's departure form, no second definition); a LEG_NOT_DEPARTED / LEG_NOT_ARRIVED refusal in Change status offers that action in place. After this the wizard is only for setting a cycle up.
  Also (owner 2026-10-11): location cards at the top of cycle details — per cycle and per product, how many are in China (not shipped), on the way to UAE, in UAE, on the way to Egypt, in Egypt (received + not checked in), sold; Lost only when > 0. Built from the shipment model's per-leg entered/delivered/onTheWay/received/waiting/lost. Layout: option A (cards + product table; cards per product on a phone) — chosen by the owner 2026-10-11.
- Live assistant: delivery-note test once a real cycle is in transit (see notes/assistant-live-test-2026-10-11.md).
- Rotate the seeded `password123` on partner accounts.
- Queued from this run: system-written ledger reasons are stored in English (needs a code/params migration); the app
  has no dark theme; audit nits #39–#46; §3 vs §12 reservations contradiction (Still open); R1's reference-data guesses
  for investors; partner logins still use the seeded password (rotate).
- Plan `docs/superpowers/plans/2026-10-10-partial-arrivals-and-ux.md` — waves 1–5, then verify and ship.
