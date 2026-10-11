# Build log

Run mode: fully autonomous — chosen by the user on 2026-10-10 (this run). The MCP run before it was
fully autonomous too, chosen 2026-09-19.
Goal (current): walk-in sales paid on the spot + the assistant records sales; then test the assistant with real receipt
photos and spoken sales. Plan `docs/superpowers/plans/2026-10-11-walk-in-and-assistant-sales.md`.
Current stage: L4 (below-cost warning) live in production 2026-10-12 (`4180b37`, no migration, three deploys READY, smoke ok) · L5 phase 2 (e2e) running · then L6 phase 2, L8 phase 2, L7

## Waiting on the user
_(none)_

## Blocked
_(none)_

## Next up
- L8 phase 1 building: departures in parts (owner 2026-10-12) + wizard only through Purchasing + Add next leg / edit leg cost on the cycle page. Phase 2 after L5.
- L6 phase 1 built on `feature/l6-ledger-entry` (migration 20261011220000_ledger_entry_date); phase 2 after L4.
  Fixed on the way: cycle profitability ignored cycle-charged expenses while settlement subtracted them; reversed
  expenses stayed in Expenses. §9 guesses: foreign amounts stored in pounds (+ original_*), other income into net
  profit, a cycle in SETTLEMENT still takes a late cost.
- Investigate (money): the dashboard's Expenses may count a sale return's money-out `revenue` row and the cash
  `refund` row while Revenue already nets returns — possible double count. Reproduce + test before any fix.
- L7 queued (owner said build, 2026-10-11): running costs come out of the core partners' payouts + a payout that explains itself line by line (§8). Starts once L5 (leftovers) and L6 (ledger form) are merged — all three touch settlement.
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
- Specs: `WEB_URL=http://localhost:3003 npx playwright test '<pattern>' --project=chromium`, in 4 groups:
  `tests/(0[0-9]|1[0-9])-`, `tests/(2[0-9]|3[0-4])-`, `tests/(3[5-9]|4[0-9]|5[0-4])-`, `tests/(5[5-9]|6[0-9]|7[0-9])-`, `tests/(8[0-9]|9[0-9])-` (the fifth group: 80–94 were missing from "full" runs until 2026-10-11).
- Production: `scripts/ship-prod.sh status|migrate|env|stranded|smoke`. Pushing `master` deploys all three
  apps. Vercel builds production only (`ignoreCommand`). Check each deploy reaches READY on the new commit.
- Auto mode blocks production steps: switch this session to manual (set_session_permission_mode), let the owner
  approve each step, switch back to auto.
