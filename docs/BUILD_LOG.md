# Build log

Run mode: no build-software run is active. The last autonomous run was chosen 2026-10-10; since then work is done
feature by feature at the owner's word, each on its own branch, merged and shipped when he says.
Goal (current, 2026-10-27): the "Next up" list below, top first.

## Current stage
2026-10-27 (evening) — **production runs `origin/master`** with what was on `dev` (owner: "ship current"): a new
temporary investor from the Funding card, Change split saved on the server in one go, samples into the current order
(migration `20261027120000_samples_into_order` applied first) and the known-bugs batch — on top of customer branches
(`d87b68b`) and the other 2026-10-26/27 releases under "Live in production" (build-log/history/2026-10.md). Production's migrations end at
`20261027120000_samples_into_order`; nothing is merged and waiting. **Live too:** Confirm &
paid in one step, and **samples by branch** (BUSINESS_LOGIC §4 "Samples by branch", §7; owner 2026-10-27 "build it",
then "tidy and push dev and merge"): New Order shows the order's branch's samples first, the rest under a collapsed
"At other branches", tags a sample taken from another branch, regroups when the branch changes; Add all = the order's
branch only (GUESS); one short heading per samples order instead of a sentence repeating its rows. No migration.
- **2026-11-06, later — the Sameh sale removed (owner: "that was just a test, remove any sale related thing from
  sameh today"):** `prisma/one-off/2026-11-06-remove-sameh-test-sale.ts` deleted ORD-2026-00016, its line, payment
  and allocation, RET-2026-00007 and its line, their 3 ledger rows, 2 stock movements (net 0, stock unchanged),
  6 notifications and 6 audit rows, with one DELETE audit row recording it (backup `prod-20261106-042010.sql`,
  rehearsed on prodcopy, check-data all zero). Collected 128,400 → 126,400; cash on hand stays 162,803.65; revenue
  220,725 unchanged. The entry below is history.
- **2026-11-06, production data fix:** RET-2026-00007 (Sameh, ORD-2026-00016, one Y30, 2,000 paid in cash) was
  saved as a credit note on a paid order, so the 2,000 vanished and cash on hand stayed 2,000 high; Fares had handed
  the cash back (owner). `prisma/one-off/2026-11-06-ret-00007-cash-refund.ts` made it a cash refund with its
  `REFUND_PAID` row (rehearsed on a fresh prodcopy, then `--production`): cash on hand 164,803.65 → 162,803.65.
  Every other return (6) was checked: none credited more than was owed. `check-data.sh` 12.11 now flags a credit
  note bigger than what the order owed, and 12.1 lets a returned order keep payments refunded in cash. The code fix
  (refuse such a credit note; the form picks Cash on a paid order) is merged into `dev`, not shipped.
- **Edit order** (on a confirmed order) is not shipped: saved on `feature/edit-order` (`4bdbf1e`) with its migration
  `20261026100000_sale_order_edits`, which must not be applied to production until that branch ships. Master's
  history holds no Edit order commit, so the branch can still be merged later.
- **2026-10-29: `master` took all of `dev`** (`6295f5a`) — the picker's category, Preparing, Paid by, Sales'
  default filter, the P&L drilldown, the Products cards, partial sample returns, Put in so far on the Partners cards,
  the category under the name in the picker and the e2e fixes. **`dev` is ahead of `master`** with the phone-width
  fixes and the search-then-click fix (merged 2026-10-29, owner: "merge both to dev and push"; no migration) —
  awaiting the owner's test before they ship. Edit order lives only on `feature/edit-order`.
  Nothing is held on another machine as far as git shows.
- **Full e2e on `dev` (owner 2026-10-28 "full e2e")**, on branch `fix/e2e-dev` (not merged): baseline 1,219 passed,
  60 failed, 22 skipped (data-dependent `test.skip`) of 1,301; after the fixes 1,279 passed, 0 failed, 22 skipped,
  every group re-run green. Most failures were specs behind agreed changes (Sales' default filter, Preparing, tied
  account money, Delete delivery switched off) or racing streamed pages and server-side search. Three page fixes:
  the cycle and customer pages' skeletons trace the page again, and Collapse all sits beside the categories search
  on a phone. Web vitest 1,666, API jest 2,806 (with database specs), tsc, lint and `next build` clean.
- Tests at the release: API, web and unit suites green (counts in build-log/history/2026-10.md, "Stage on 2026-10-26/27"); e2e not run
  (owner, 2026-10-25: unit and database tests only).
- The office chat runs on the API's `AI_PROVIDER`/`AI_API_KEY` (the owner set Groq on Vercel).
- Waiting on the owner: the
  branches GUESSes (BUSINESS_LOGIC §7); the Funding card GUESSes (§8); an advance left undrawn on a settled cycle
  (§8, OPEN); the Rules Review answers; the small UAE costs for CYC-2026-0001.
State of the product and of production's data: `docs/where-things-stand.md`.

## Waiting on the owner
- Every guess the system is built on and every open question (88 items) is on the Rules Review page,
  `https://claude.ai/artifact/Dcr2nHwoT8gygvVhu3bBrG`; his answers are saved in its database (`answers`, one document per
  item) for Claude to read and apply, with BUSINESS_LOGIC updated from them.
- New since 2026-10-25, not yet on that page: the branches GUESSes (BUSINESS_LOGIC §7), the Funding card GUESSes
  (§8 "Investors in the funding" and the sections before it), the rate at which a friend's loan becomes his investment
  (§18), and an advance left undrawn on a settled, closed or cancelled cycle (§8, OPEN — stranded today).
- Ahmad Zogmar's default branch — Mokattam, Master or LS2 — and the names' spelling; then add them through his
  Branches card (the local one-off refuses production).
Data the owner will send when he has it (asked 2026-10-17/18; ask again at the start of the next session):
- UAE costs for this shipment (wrapping paper, fuel in the UAE…) beyond leg 2's 5,250 AED — the owner expects some, small (2026-10-23): each amount, currency, what it was — goods-related ones go into leg 2's cost, others as cycle expenses.
- (Answered 2026-10-23, applied in production: leg 2 is 5,250 AED flat at 14; Ahmad Eraiby paid everything and was
  repaid in three thirds; contributions 67,056.33 each. Mohamed Abu Setta is not a lender on CYC-2026-0001.
  Superseded 2026-10-27 by the owner's fuller facts: his loan was smaller, 60,000 of it his investment; Mohammed
  Setta a temporary investor of 20,000; contributions 55,000 / 33,084.50 / 33,084.49 — "Live in production", build-log/history/2026-10.md.)
- (Done 2026-10-23 by the owner himself through Adjust price: Koshary's 100 off every unit he holds.)

## Blocked
_(none)_

## Next up
In priority order. Everything the earlier lists asked for and the owner shipped is under "Live in production" in build-log/history/2026-10.md.
- **On `feature/dashboard-cash-from-sales`, not merged — Cash from sales, one Stock tile, exchange-rate loss/gain**
  (owner 2026-11-06, §12, §18). Right now: Cash from sales (payments not reversed − `REFUND_PAID`, all time,
  `common/cash-from-sales.ts`) replaces Cash on hand (still in the API); Stock value + Units in stock became one
  Stock tile with the unit count as a pill beside the title; six tiles, two rows of three, phone "See more (2)".
  The exchange difference reads "Exchange-rate loss" (red, −) / "gain" (green, +) with a hint line, through one
  component (`components/lenders/exchange-result.tsx`) on Analytics, settlements, the Funding card and a lender's
  page. Unit + component tests seen to fail first; TC-INV-64b written, not run (no e2e). The dashboard and
  Analytics visual baselines will need retaking when it merges. Screenshots for the owner taken on an agent DB.
- **On `dev` 2026-11-06, not shipped — a credit note cannot credit more than is owed** (owner decision
  2026-11-06, §5). ORD-2026-00016 (2,000, paid in full, returned whole on the default credit note) lost the 2,000:
  nothing owed went down and no `REFUND_PAID` was written. Now refused (`RETURN_CREDIT_OVER_OWED`), the default is
  cash when the credit would not fit, and the return dialog picks Cash and explains why. Unit + component tests;
  TC-INV-96 written, not run (no e2e); TC-INV-64's fixture paid 1,500 instead of 2,000 so its credit step is
  legitimate. ORD-2026-00016 was corrected on production the same day (RET-2026-00007 is now a cash refund; see
  Current stage). Split credit + cash: OPEN idea in §5.
- **On `dev` 2026-11-04, not shipped — table widths** (owner: "Yes, fix them", "Merge into dev"): `feature/table-widths`
  merged (`37f9bda`). Customers' Balance and Cycles' Profit hold the largest amounts, ROI moved under Profit so the
  setup cycle's two actions fit, four date columns hold the widest Arabic month (TC-COL-04.11/06/07). Ledger at 1280
  still scrolls sideways (Known bugs). CI green on `97cf268` (run 41848721219): TC-F1B-08 updated to the one column,
  the 7 Linux baselines reviewed and committed; the storefront build needed one rerun for Google Fonts, and the
  build's retry now waits 60 s. CI lessons: `.claude/LEARNINGS.md` "CI".
- **On `dev` 2026-11-01 — fewer tokens per change** (owner 2026-11-01: "try to do all"): BUSINESS_LOGIC split into an
  index + `docs/business/` sections and BUILD_LOG trimmed (history in `build-log/history/`); `npm run test:affected`
  prints the Jest / web-unit / e2e / visual tests a change touches; visual regression specs (`npm run test:visual`,
  10 office screens EN+AR, 4 storefront); CI fixed (lockfiles had stopped `npm ci` since ≥ 2026-10-28) and now runs
  on `dev` too. PR #2 merged into `dev` 2026-11-03 (`823018b`, CI fully green): CI starts the storefront, runs the
  visual specs against reviewed darwin + linux baselines, retries a build once on a Google Fonts download failure;
  the full e2e suite passes on any day and in any order. Product fixes it found: Plex Arabic on every OS, one-line
  dashboard figures, compact Owed to lenders tile (owner's pick), tables that fit beside a Windows scrollbar, the
  Partners tab showing a payout right after Mark paid. How it all works: `.claude/LEARNINGS.md`, "CI" and "Visual
  baselines"; what's still open: Known bugs in `docs/where-things-stand.md`. Shipped to production 2026-11-03 (owner: "Ship dev"). 15 stale agent worktrees removed (~30 GB).
- **Live 2026-10-31** (was `feature/pnl-adds-up-open`) (owner 2026-10-31: "in analytics how it adds up should be open by
  default"): Analytics' "How it adds up" opens already unfolded; its header still folds it. Web only, no migration.
  Tests: `profit-and-loss-section.test.tsx` (open at first, folds and reopens — seen to fail on the old code).
  **Live 2026-10-31:** its loading skeleton now draws the open list (header, seven lines, cash paid out)
  instead of a folded bar (owner 2026-10-31: "skeleton should change as well"); the skeleton test pins it, seen to
  fail on the old one.
Later — queued, not to be built until the owner says:
- Later (owner, 2026-10-25; built 2026-10-26, NOT shipped — saved on `feature/edit-order` (`4bdbf1e`), owner 2026-10-27): **Edit order** on a confirmed order — add a
  product, change a quantity, change a price (up or down). It feels like editing; underneath, each change is a dated,
  recorded event (never an overwrite of what was confirmed): more units drawn FIFO that day, fewer units back to their
  own batches (as a return does), a price change up or down (supersedes the "lower only" GUESS of the price
  adjustment). What the shop owes, revenue (on the change's day, as price adjustments do), COGS, stock and the cycle's
  profit follow; History and the statement (with its Profit column) show each change; the invoice re-prints with the
  current lines. Refused (coded, server-side): draft, cancelled or fully returned order; an order whose cycle's
  settlement is approved or paid; an order under an active instalment contract (cancel the contract first, as for
  price cuts); a samples order (its own flow). Core partners only. One preview of the whole edit before saving
  (what the shop will owe, stock taken / given back, profit change).
  **Testing — the owner's word: "these need a lot of testing scenarios and edge cases".** Not done until every case
  below has a test that fails without the feature and passes with it (CLAUDE.md §0–§2), plus invariants in
  34-business-invariants:
  - Limits: quantity to 0 (= the line fully given back), negative, fractional where the product is whole units, more
    than is on the shelf (NOT_ENOUGH_STOCK), more than was sold when lowering; a price of 0, negative, a huge price;
    a new line for an inactive product; the same product added twice (one line or two — decide, then pin it).
  - Money: an order already part-paid — lowering below what was paid (refund or credit? decide, never a negative
    owed); raising after it was paid in full (it owes again, status back to partly paid); a payment spread over
    several orders keeps its allocations true; statement closing balance = balance after every edit.
  - Stock and cost: units taken come from the oldest batches at their cost; units given back return to the batch they
    came from at that cost; a batch emptied by another sale between preview and save (the edit must re-check, not use
    the preview's stock); a batch from a cycle re-costed later; samples at shops never counted as available.
  - Order history: an edit after a return of the same line; a return after an edit (refund at the price then in
    force, as held-price does); an edit after a price adjustment and vice versa; two edits in a row; editing back to
    the original; History's replay ends on the order's outstanding every time.
  - Dates: an edit dated before the sale or in the future (refused); revenue lands on the edit's day in P&L and the
    dashboard's This month; a back-dated sale edited today.
  - Wrong context: another customer's order id; an order on a cycle in settlement; two partners editing the same
    order at once (row lock: one wins, the other gets a clear refusal, nothing applied twice); the API called
    directly without the office (every rule server-side).
  - Readers that must agree after every case: the order popup, Sales list's value-now Total, the customer's balance
    and statement, the cycle's profit, the dashboard, Analytics, inventory and the product page's stock value,
    check-data (all zero).
  - Through the assistant/office chat too, if exposed there (same service, preview/confirm).
Standing items:
- Owner to confirm the guesses still open from the 2026-10-11/12 batches (details in the History entries, build-log/history/2026-10.md):
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
- CI watcher on a VPS (owner 2026-11-02: "I will let you know when i have the vps"; waiting on him to get one). The
  desktop app's Auto-fix only watches while his Mac is awake. Plan: Ubuntu VPS (≥ 4 vCPU / 8 GB: Postgres, API, two
  Next apps and Playwright at once), Docker, Node 22, Claude Code signed in with his subscription, the repo, no
  production secrets. A cron script checks `gh run list` every few minutes (no tokens); on a new red run of a feature
  branch or PR it runs `claude -p "CI run <id> failed on <branch>; read the log, fix, push"`, remembers handled runs,
  gives up after 2–3 attempts, never pushes to `master`, and notifies him. Deliver: setup script + watcher + cron line.

## Phases
- Walk-in + assistant sales — shipped 2026-10-11 · [decisions](build-log/decisions/walk-in-and-assistant-sales.md)
- MCP assistant — shipped 2026-09-25 · [log](build-log/decisions/mcp-assistant.md)
- Partial arrivals + UX batch — shipped 2026-10-11 · [decisions](build-log/decisions/arrivals-and-ux.md) · [waves](build-log/waves/arrivals-and-ux/)

## Notes
- [Live assistant test](build-log/notes/assistant-live-test-2026-10-11.md) — invoice image, walk-in and shop sales: pass; deliveries need a cycle in transit.
- [Backfill rehearsal](build-log/notes/backfill-rehearsal.md) — old-shape data → migrate → backfill twice → check-data zero.

## How to run things here
Moved to [build-log/how-to-run.md](build-log/how-to-run.md) on 2026-11-01: branches, Docker, ports, each
agent's own database and servers (`scripts/agent-env.sh`, `scripts/agent-servers.sh`), spec groups, production.

## Older entries
Kept here: the current stage, what waits on the owner, next up and the newest entry. Everything older —
the "Built on …" sections, "Live in production", "Known e2e debt", Next-up items already done, and "History" —
is in [build-log/history/](build-log/history/), one file per month, moved verbatim; then `git log`.
- [2026-10](build-log/history/2026-10.md) — up to 2026-10-29: everything moved out on 2026-11-01.
