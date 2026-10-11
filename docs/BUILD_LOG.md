# Build log

Run mode: fully autonomous — chosen by the user on 2026-10-10 (this run). The MCP run before it was
fully autonomous too, chosen 2026-09-19.
Goal (current): walk-in sales paid on the spot + the assistant records sales; then test the assistant with real receipt
photos and spoken sales. Plan `docs/superpowers/plans/2026-10-11-walk-in-and-assistant-sales.md`.
Current stage: resumed 2026-10-11 — first agent died after `bcdd701` (status button on details, slide-over gone) and the alignment measurements (41 states, all 0px deltas, `.ui-audit/rowfix/`); second agent finishing: Details-column nit, spec 94, specs 29/80, lint/unit, full e2e · in flight: branch `fix/row-alignment-and-cycle-nav` (field rows misalign when one shows its error; clicking a cycle should open its details with a separate Continue setup) — merge, verify on screen, test, ship

## Waiting on the user
_(none)_

## Blocked
_(none)_

## Next up
- Resume: branch `fix/row-alignment-and-cycle-nav` @ `96f15ee` (WIP, typecheck passes). DONE in it: shared
  `field-row` (equal 38px boxes, top-aligned; error lines can't move neighbours) on ~20 rows; `RowAction`; cycle
  row/card → details; `ContinueSetupLink` (row, card, details header; `cycle.create` + WIZARD_STATUSES); wizard
  "Back to the cycle". LEFT: on-screen check with bounding-box measurements in error and normal states (1440/390,
  en/ar) + screenshots under `.ui-audit/rowfix/`; Vitest; spec 94; lint; test:unit; update specs 29 and 80 (they
  click a row expecting the wizard → click Continue setup); DECIDED: status changes move to a button on the cycle
  details page and the phone slide-over goes (it is now unreachable). Then full e2e and ship.
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
  npm run start:dev`; web `cd apps/web && npm run dev -- -p 3003`; storefront `PORT=3002` (specs 54/59).
- Specs: `WEB_URL=http://localhost:3003 npx playwright test '<pattern>' --project=chromium`, in 4 groups:
  `tests/(0[0-9]|1[0-9])-`, `tests/(2[0-9]|3[0-4])-`, `tests/(3[5-9]|4[0-9]|5[0-4])-`, `tests/(5[5-9]|6[0-9]|7[0-9])-`.
- Production: `scripts/ship-prod.sh status|migrate|env|stranded|smoke`. Pushing `master` deploys all three
  apps. Vercel builds production only (`ignoreCommand`). Check each deploy reaches READY on the new commit.
- Auto mode blocks production steps. Ask the user to switch the session to manual for a ship.
