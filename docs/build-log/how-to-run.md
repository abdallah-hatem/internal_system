# How to run things here

Moved here verbatim from `docs/BUILD_LOG.md` ("How to run things here") on 2026-11-01, when the log was cut to
its current state.

- **Branches (owner 2026-10-27, CLAUDE.md §14):** build on `feature/<name>` cut from `dev`; merge into `dev` what
  ships next; the owner tests `dev`; ship = all of `dev` into `master`. The main checkout sits on `dev`.
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

