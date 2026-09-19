# Build log

Run mode: fully autonomous — chosen by the user on 2026-09-19
Graft: wired in 2026-09-19
Goal: "an MCP for this application — we talk to it and it does what we want. Send a receipt from
the merchant I bought the products from and it knows what to do, and asks the right questions."
Current stage: 4 — Build · Waves 1–3 merged, reviewed ALIGNED, full suite green · **HELD by the user 2026-09-19 before T10** — see Handoff

## Waves

- Wave 1: T0 T1 T2 T3 in parallel, each in its own worktree. T0 is the house lint chore (all three
  package.json files); T1 schema + purchases; T2 surface guard + auth tokens; T3 a new pure module.
  No shared files. T4 T5 wait on T1+T2 · T6-T9 wait on T5.

- Wave 1 merged: T3 `1db5944` → T2 `2079d1a` → T1 `72a271d`, then T0 rebased on top as `f4375ce`
  with violations re-frozen (api pruned, web +new). Re-checked, not trusted: api jest 165/165, lint +
  typecheck green in api, web and storefront. Translations `d59a062`. Prisma client regenerated locally.

- Wave 1 verified on the merged branch: local DB migrated; e2e 82/82 (41, 02, 04, 35, 43, 48, 58, 63, 64).
  Alignment review: T1 ALIGNED, T2 ALIGNED, T3 DOC OUT OF DATE → §16 updated in `e8178e4`.
  Rule-2 on T1's race test **failed** — it passed with the mapping off (HTTP sends never overlap), and
  the same sends also collide on the unique PO `reference`, which the mapping ignored → a 500.
  Fixed in `e8178e4`, pinned by a unit test that fails on the old code. The plain PO-reference race
  (two different POs at once → 500) predates this build; offered as a separate task.

- Wave 2: T4 ‖ T5 in parallel worktrees cut from `2ab2713`. T4 owns `main.ts` + `modules/oauth`; T5 owns
  `modules/assistant` (except `receipt/`) + the MCP SDK dependency. Both add one import to
  `app.module.ts` — resolved by the main thread at merge. T6-T9 wait on T5.

- Wave 2 merged: T5 `8e3cb32`, T4 `bad46ae`, resolution `5c5de24` (duplicate `isUniqueViolation`,
  `publicBaseUrl` and test JWT signer each folded into one). Re-checked: api jest 290/290, lint + typecheck
  green; e2e 93/93 (01, 04, 41, 63, 64, 65, 66). Codes translated `9935f48`.
- Wave 2 alignment review: T4 ALIGNED, T5 ALIGNED, no findings. The 1-hour unrevocable access token
  does not break §16 "loses it at once": the surface guard re-checks role and status on every request.
- Wave 3: T6 ‖ T7 ‖ T8 ‖ T9 from `9935f48`, each in its own worktree. T6/T7/T8 fill their own
  `tools/*.ts`; T9 is auth + the office app and alone edits the locale files (its screen text).
  T10 waits on all four.

- Wave 3 merged: T9 `1323de1`, T6 `b77309c`, T7 `c535aca`, T8 `6964a88`; api jest 409/409, lint +
  typecheck green in api and web. Review: T6, T7, T8, T9 ALIGNED. Main-thread fixes `c39f873`: preview
  binding (`PREVIEW_CHANGED` — transition_cycle locked drafts created after the preview; verify_stock
  would book at a landed cost changed since), wizard skips 0-received lines (T8 made the server refuse
  empty batches), BUSINESS_LOGIC §15/§16 updated with the office-app rules T7/T8 added.
- **Cross-session collision, 16:23-16:26 local.** The side-task session (customer-list balance) ran
  Playwright on the same DB while mine ran; its globalSetup restored my in-progress snapshot mid-run.
  My e2e results from that run are void (they also hit that session's API on :3001). The DB now holds
  test rows instead of the pre-test state. Fixed for the future with a run lock (`tests/support`).

- DB repaired on the user's OK: restored from `13-24-01-594Z-unrestored.sql` (matches exactly; the
  leftover state archived as `2026-09-19-current-before-repair.sql`); check-data all zero.
- Side task merged: customer-list balance `49fcbca` (+ lint `608ccc4`); api jest 416/416.
- Verified on this branch's own API: wave-3 specs 67-71 + 41 → 59/59. Full suite: chromium 583 passed
  (4 groups), 2 skipped (already skipped before this build), 0 failed; storefront 21/21.

## Decisions

- **[Stage 0] Where it runs — hosted, reachable from the Claude phone app.** User's choice.
  Why: the receipt is photographed at the supplier, on a phone.
  Alternatives: local-only (stdio) inside Claude Desktop — simpler, no phone.

- **[Stage 0] Write scope — reads + the receipt flow + cycles.** User's choice, extending the
  recommended option with cycles. Interpreted as: create cycles, add shipping legs, transition
  cycles, and verify stock in — the whole intake path up to sellable stock. Sales, payments and
  settlements stay manual. Every write is previewed and confirmed.
  Alternatives: read-only; reads + everything.

- **[Stage 1] Feature mode, not new-app mode.** The repo is an existing product with a business
  doc. It was named `docs/business-rules.md`; renamed to `docs/BUSINESS_LOGIC.md` (the name the
  pipeline and its reviewer read) and every live reference updated, rather than keeping two docs
  that would drift. Dated historical plans keep the old name as written.

- **[Stage 1] OAuth, built into the API — no third-party identity provider.**
  Why: claude.ai connects to a hosted MCP server either with no authentication or with OAuth, and
  offers nowhere to paste an API key. No-auth is unacceptable for a system that moves money. A
  hosted provider (Auth0, WorkOS, Clerk) means a new account — which an autonomous run cannot
  create. The API already holds the users, the password hashes and the JWT signing.
  Alternatives: a hosted IdP; local-only with a static key.

- **[Stage 1] The MCP lives inside `apps/api`, not a new app.**
  Why: one deployment, no second domain, and the MCP SDK (1.30.0) requires cleanly as CommonJS —
  checked by requiring it, per the deploying-to-vercel skill, because an ESM-only dependency took
  this API down twice before.
  Alternatives: a separate `apps/mcp` Next.js app with `mcp-handler`, calling the REST API.

- **[Stage 1] Branching follows the repo, not the skill's dev → production flow.**
  Why: the repo ships by pushing `master`, and — see Findings — Preview shares the production
  database, so a `dev` preview would run against live data. The skill defers to the repo's own
  branching. Work happens on a local `feature/mcp-assistant` branch, is verified fully, merged to
  `master`, then smoke-tested in production with rollback ready. Feature branches are not pushed.
  Alternatives: create `dev` and a separate preview database first.

- **[Stage 3] Plan approved after one review round.** Alignment review: CONFLICTS (4 gaps), fixed —
  two plan cases added, two doc wording fixes — then ALIGNED.

- **[Stage 4] E2E cases run by the main thread, not in worktrees.** Parallel worktrees share one
  machine and one database; subagents write their e2e cases but only unit tests run in the worktree.

- **[Stage 4] Locale files belong to the main thread.** Subagents report new error codes with English
  and Arabic text; the main thread adds them after each wave, avoiding a four-way merge conflict.

- **[Stage 4] Port 3000 belongs to another project today** (the Aesthetica session's API). `dev.sh`
  frees ports by killing their holders, so it was not used; the API and web were started directly,
  web on :3003 with `WEB_ORIGIN`, specs run with `WEB_URL=http://localhost:3003`.

- **[Stage 4] Wave 2 implementer decisions accepted:** confirmation token spent before the commit (a
  refused commit needs a new preview — never a double write); `GET /mcp` → 405 (stateless, JSON only);
  a replayed refresh token revokes that partner's tokens on that client; redirects only to claude.ai,
  claude.com and loopback. `PUBLIC_BASE_URL` must be set in production (forwarded host is spoofable).

## Findings

- **Preview deployments use the production database and Blob store.** `DATABASE_URL` and
  `BLOB_READ_WRITE_TOKEN` are scoped to Production *and* Preview with the same value. Nothing has
  used a preview yet because the repo only pushes `master`, but any branch pushed to GitHub would
  get a preview wired to live data. Not changed in this run — it is infrastructure the goal does not
  cover — but it must be fixed before a `dev` branch exists.

## Blocked

_(none)_

## Handoff — 2026-09-19 (second hold), before T10

**Resume:** run `/build-software` in this repo when the user says to. State is all on the local
`feature/mcp-assistant` branch (nothing pushed); `master` still has its 5 older unpushed commits.

### Done
T0–T9 merged and verified, plus the customer-list balance fix. api jest 416/416; lint + typecheck green
in api, web, storefront. Alignment review ALIGNED for T1–T9. Full e2e green (chromium 583 passed,
2 skipped; storefront 21/21). Local DB restored to its pre-test state; check-data all zero.

### Next, in order
1. **T10** — `apps/web/tests/72-assistant-end-to-end.spec.ts` (plan says 63; that number is taken). The MCP
   SDK client over HTTP: register → sign in → code → token → `tools/list` → `match_receipt` on a realistic
   receipt → answer its questions → preview → commit → the PO exists with the invoice number, attributed
   to the partner; then the assistant token on REST endpoints is refused. Class `logic`; run it on this
   branch with the servers below.
2. Release alignment review over everything since `master`; flip BUSINESS_LOGIC §15/§16 PLANNED → built.
3. Ship — **needs the user's go-ahead**: merge to `master`, push (deploys). Production needs: the two
   migrations applied to Neon (`20260919120000_supplier_invoice_ref_and_oauth` + the older `CANCELLED`
   one), `PUBLIC_BASE_URL` set on the API (forwarded host is spoofable), `scripts/confirm-stranded-orders.sh
   --fix` against Neon, then a production smoke check. Then the user adds the connector in Claude
   (Settings → Connectors → `<api>/mcp`) and signs in.

### How to run things here
- Port 3000 may belong to another project (Aesthetica's API). Don't use `npm run dev`/`dev.sh` — it
  kills port holders. Start directly: API `cd apps/api && WEB_ORIGIN=http://localhost:3003 npm run
  start:dev`; web `cd apps/web && npm run dev -- -p 3003`; storefront (only for 59/54) `PORT=3002`.
- Specs: `WEB_URL=http://localhost:3003 npx playwright test '<pattern>' --project=chromium`. Pass
  patterns, not a zsh file list. Full suite in 4 groups: `tests/(0[0-9]|1[0-9])-`, `tests/(2[0-9]|3[0-4])-`,
  `tests/(3[5-9]|4[0-9]|5[0-4])-`, `tests/(5[5-9]|6[0-9]|7[0-9])-`.
- One Playwright run at a time: globalSetup now holds `/tmp/motoparts-e2e.lock`. Check other sessions
  (ListAgents, `pgrep -fl "playwright test"`, `lsof -ti:3001`) before starting servers.
- Leftover worktrees to clean when convenient: `.claude/worktrees/sharp-boyd-ae107e` (side task;
  uncommitted `.claude/settings.json` statusLine change — not ours to commit), the `chore/lint` one
  (untracked files), and the wave-2/3 agent worktrees (all merged).

### Things a fresh session will not know

- Graft's MCP tools load in a new session and ask for approval once; the CLI works regardless
  (`DO_NOT_TRACK=1 graft ask "…"`).
- Test logins and URLs: `CREDENTIALS.local.md` (gitignored). The office app is at
  `internal-system-web-three.vercel.app` — `-web` is a stranger's app.
- Preview deployments share the production database (Findings). Do not push feature branches.
- Commits end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`; author
  `ahkortam@gmail.com`.
