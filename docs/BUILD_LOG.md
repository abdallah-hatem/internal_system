# Build log

Run mode: fully autonomous — chosen by the user on 2026-10-10 (this run). The MCP run before it was
fully autonomous too, chosen 2026-09-19.
Goal (current, 2026-10-19): the owner tests today's batch locally (samples, default price, wizard + funding lock,
P&L Option A), the full e2e suite runs, then it ships. The goal before it — walk-in sales + the assistant records
sales (plan `docs/superpowers/plans/2026-10-11-walk-in-and-assistant-sales.md`) — shipped 2026-10-11.

## Current stage
2026-10-19 — production runs `origin/master` (`f231309`, the 2026-10-18 batch). Today's batch is merged into local
`master` (`299fba9`) and **waits for the owner's local test**, then the full e2e run, then a ship with one migration.
Standing: no e2e unless the owner asks (the full run before the next big ship is his ask); keep flows small.
State of the product and of production's data: `docs/where-things-stand.md`.

## Merged locally — awaiting the owner's test (not in production)
Ship order when he says go (`docs/deployment.md` "Shipping a release"): `scripts/ship-prod.sh migrate` **on its own**
for `20261018200000_samples_at_shops` (additive: order statuses `SAMPLES`, `SAMPLES_RETURNED`, `SAMPLES_WRITTEN_OFF`;
movement types `SAMPLE_OUT`, `SAMPLE_BACK`; three nullable `sale_orders` dates), then `ship-prod.sh status` must print
"Database schema is up to date!", then push `master`. The code reads the new enum values, so it must not go first.
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
- A product's default price is landed cost + 20% where no price is set (`22c0856`; §3; `common/default-price.ts`).
  2026-10-19: the product page's B2C field shows it too (it only did for B2B).

## Live in production (newest first, last two weeks)
Older history: "History" at the foot of this file, and `git log`.
- 2026-10-18 — the audit log names the record and lists what changed; a Who filter (by partner name) and a
  record-type filter that offers what the API writes (`3e9b748`, `07cb929`, `f231309`).
- 2026-10-18 — every office notification is pushed to the reader's phone, in Arabic (`18d52be`; §10).
- 2026-10-18 — Profit and loss v1 on Analytics, from the dashboard's own computation (`225be8f`; redesigned locally,
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
Targeted pass 2026-10-19 (owner chose the cheaper run): invariants TC-INV-72..83 added and passing (spec 34 87/87);
the specs stale from the menu tabs, folded legs, 3-step wizard and funding note fixed and passing (27, 17, 40, 47,
50, 51, 64, 72, 78, 80, 85, 86, 87, 89, 90, 91, 98, 99-*); investor-UI tests deleted (only the partners use the app),
their API refusal tests kept. Still failing or unrun:
- Full suite (466 tests) not run since the 2026-10-18 batches; it runs before the next big production ship (Next up).
- 99-skeletons: Dashboard, Products, Sales, a customer and a cycle — skeleton rows no longer match the real rows' count
  or height (Products: the default-price hint makes rows taller). Product issue, not a stale test.
- 99-table-columns TC-COL-04.03 (statement) and 04.10 (contracts): the screen-reader-only "Actions" header is wider
  than its cell; TC-COL-05: invoice and statement wider than A4. Pre-existing, not from 2026-10-18/19.
- API real-database suites: 64/66 pass; walk-in.db "Payment dated now, in Cairo" and references.db "22:30 UTC on the
  10th" fail because their fixtures pin the clock before the back-dated-sales rule (2026-10-16). Fixtures to update.
- 61-production-browser edited, not run (production only). TC-NOT-05 / TC-UI-02 as before.
- Partners view draws its running-costs section twice on a fresh load (closes an open period picker); tests wait.

## Waiting on the owner
Data the owner will send when he has it (asked 2026-10-17/18; ask again at the start of the next session):
- Leg 2 (Dubai → Cairo) of CYC-2026-0001: is 20 AED per piece right, and is 14 EGP/AED the rate? (Saved that way; edit the leg when confirmed.)
- UAE costs for this shipment (wrapping paper, fuel in the UAE…): each amount, currency, what it was — goods-related ones go into leg 2's cost, others as cycle expenses.
- Mohamed Abu Setta, the second lender: what he paid in total, currency, date, what it covered. Then: record his financing on PO-2026-0001 and set the three partners' contributions (64,400.97, a stand-in) back to 0 — the partners paid nothing.
- Repayments already made to Ahmad Eraiby or Mohamed Abu Setta: amount, date, method each.
- Koshary (ORD-2026-00002): the new lower price per product. Then cancel the order, re-enter it dated 13 Oct at those prices (prices for Koshary only, not the catalogue), and record his first payment, 5,000 EGP cash, dated the day he paid (he said "today", 2026-10-17).

## Blocked
_(none)_

## Next up
- Later (owner, 2026-10-19): no investor account can sign in to the office app — refuse TEMP_INVESTOR at the office
  login (and on refresh), like shop accounts (`auth.service.ts`); only the three partners use it. Tidy the
  investor-only UI and specs that would then be unreachable.
- Before the next big production ship (owner, 2026-10-19): run the FULL e2e suite (466 tests, in ~3-minute groups on
  an agent database). A targeted pass (invariants for today's rules + the known-stale specs + the real-database API
  suites) was run first, at the owner's choice, to save tokens.
- Later (owner, 2026-10-18): remove the Suppliers and Compatibility cards from the product details page.
- After the owner approves samples + default price locally (2026-10-18): give the assistant the samples flow — leave
  samples, list what is out, "they're buying" (complete the sale), returned, write off — through the same service
  methods and roles as the office, with the usual preview/confirm; find_products already returns the default price.
- Future (owner, 2026-10-18): a few simple summary cards or small charts at the top of each tab, about that tab —
  e.g. top-earning cycles on Cycles, top-selling products on Products, the order with the most revenue and the
  largest order on Sales. Build it once there is enough data for a "top" to mean something (today: one cycle, five
  orders, five products); one shared summary-strip component, figures from the existing analytics definitions.
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
- Seen, not fixed (L1, 2026-10-11): approving a settlement while a recalculation replaces its draft answers 500
  (P2025) instead of NOT_FOUND — a race between Calculate and Approve.
- Observation: the dashboard's cash on hand counts a friend's payment as money in at once while the purchase is only
  booked out at receipt — the same timing every partner-funded cycle already has (contribution in, purchase out at
  receipt). Not a new bug; consider booking purchases out when the order is confirmed.
- Live assistant: delivery-note test once a real cycle is in transit (see notes/assistant-live-test-2026-10-11.md).
- Rotate the seeded `password123` on partner accounts — production no longer has them (the owner replaced the logins
  with his own passwords via `scripts/prod-reset-partners.sh`, 2026-10-14); local and demo seeds still do.
- Queued from the 2026-10-10/11 run: system-written ledger reasons are stored in English (needs a code/params
  migration); the app has no dark theme; audit nits #39–#46; §3 vs §12 reservations contradiction (Still open);
  R1's reference-data guesses for investors (moot while no investor uses the office app, owner 2026-10-18).

## Queued, not started
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
