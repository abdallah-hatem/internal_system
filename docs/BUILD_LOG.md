# Build log

Run mode: fully autonomous — chosen by the user on 2026-10-10 (this run). The MCP run before it was
fully autonomous too, chosen 2026-09-19.
Goal (current): (A) "make the UI/UX easier" — the 12 recommendations and the quick wins from the
2026-10-10 UX review, with the dead search box removed. (B) "a shipment can arrive in batches — ship 40,
and it arrives 15, then 10, then 5, then 10 across 40 days or so; I have no control". The user said
"do all" to the three rule decisions.
Current stage: 4 — Build · merged: S1 U0 U3 U4b B1 U4c U4 · running: U1 B2

## Waiting on the user
_(none)_

## Blocked
_(none)_

## Next up
- Plan `docs/superpowers/plans/2026-10-10-partial-arrivals-and-ux.md` — waves 1–5, then verify and ship.

## Queued, not started
- Selling on Amazon (Egypt + UAE) — BUSINESS_LOGIC §17, PLANNED, six questions still OPEN.

## Phases
- MCP assistant — shipped 2026-09-25 · [log](build-log/decisions/mcp-assistant.md)
- Partial arrivals + UX batch — in progress · [decisions](build-log/decisions/arrivals-and-ux.md) · [waves](build-log/waves/arrivals-and-ux/)

## How to run things here
- Postgres runs in Docker: `open -a Docker`, then `docker compose up -d postgres`. Quit both afterwards.
- Port 3000 may belong to another project. Start directly: API `cd apps/api && WEB_ORIGIN=http://localhost:3003
  npm run start:dev`; web `cd apps/web && npm run dev -- -p 3003`; storefront `PORT=3002` (specs 54/59).
- Specs: `WEB_URL=http://localhost:3003 npx playwright test '<pattern>' --project=chromium`, in 4 groups:
  `tests/(0[0-9]|1[0-9])-`, `tests/(2[0-9]|3[0-4])-`, `tests/(3[5-9]|4[0-9]|5[0-4])-`, `tests/(5[5-9]|6[0-9]|7[0-9])-`.
- Production: `scripts/ship-prod.sh status|migrate|env|stranded|smoke`. Pushing `master` deploys all three
  apps. Vercel builds production only (`ignoreCommand`). Check each deploy reaches READY on the new commit.
- Auto mode blocks production steps. Ask the user to switch the session to manual for a ship.
