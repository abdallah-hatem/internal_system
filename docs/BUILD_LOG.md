# Build log

Run mode: fully autonomous — chosen by the user on 2026-10-10 (this run). The MCP run before it was
fully autonomous too, chosen 2026-09-19.
Goal (current): walk-in sales paid on the spot + the assistant records sales; then test the assistant with real receipt
photos and spoken sales. Plan `docs/superpowers/plans/2026-10-11-walk-in-and-assistant-sales.md`.
Current stage: production wiped at the owner's request 2026-10-11 6:30 PM — kept the three core-partner logins (+ partner rows, assistant connection), money accounts, FX rates; removed the investor and shop-owner logins and all business data. Backup `.backups/prod-before-wipe-20261011-182759.sql` (pg_dump 18). Smoke ok after.

## Waiting on the user
_(none)_

## Blocked
_(none)_

## Next up
- L1 building (2026-10-11): §18 a purchase paid by a friend, repaid in EGP at each day's rate — branch `feature/l1-lender-financing`. §18 guesses await the owner.
- I3 nit: a leg that hasn't left reads "Not departed" twice in its header (badge + date slot).
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
