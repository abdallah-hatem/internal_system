# Build log

Run mode: fully autonomous — chosen by the user on 2026-09-19
Graft: wired in 2026-09-19
Goal: "an MCP for this application — we talk to it and it does what we want. Send a receipt from
the merchant I bought the products from and it knows what to do, and asks the right questions."
Current stage: 4 — Build · Waves 1–2 merged and verified · **Wave 3 running: T6 ‖ T7 ‖ T8 ‖ T9**

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
- Wave 3: T6 ‖ T7 ‖ T8 ‖ T9 from `9935f48`, each in its own worktree. T6/T7/T8 fill their own
  `tools/*.ts`; T9 is auth + the office app and alone edits the locale files (its screen text).
  T10 waits on all four.

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

## Handoff — 2026-09-19, held by the user mid-Wave 1

**Resume:** open a new session in this repo and run `/build-software`. It reads this file and carries
on from here without asking the run mode again. Resume only when the user says to — the hold was
theirs.

### Where the code is

| Branch | Base | State | Holds |
|---|---|---|---|
| `master` | — | **5 commits unpushed** | the PO-confirmation fix, `CANCELLED`, the test-config fix, the state doc, this build's setup |
| `feature/mcp-assistant` | `master` | 3 commits, local only | spec, plan, BUSINESS_LOGIC §15/§16 (PLANNED), this log |
| `chore/lint` (T0) | **`ce41763` — a stale master** | **done — `8d28a92`**; lint + typecheck pass in all three apps, violations frozen (api 1184, web 2525, storefront 460), no source touched. API typecheck needs `prisma generate` first, which needs a `DATABASE_URL` | house lint + `typecheck`. **Rebase onto `feature/mcp-assistant` before merging**, then re-run `eslint --suppress-all` so files added since are covered |
| `feature/mcp-t1-invoice-tables` (T1) | `a232603` | **done — `9854c5d`**, jest 89/89, tsc + eslint clean. Migration `20260919120000_supplier_invoice_ref_and_oauth` **not applied anywhere**. `63-supplier-invoice.spec.ts` (10 cases incl. a 3-way concurrent send) **not run, not rule-2 checked** — the P2002 → coded-refusal mapping is unproven until it is | invoice number, OAuth + nonce tables. New code `DUPLICATE_SUPPLIER_INVOICE` {ref, supplier, purchaseOrder} — EN "Invoice {ref} from {supplier} is already recorded on {purchaseOrder}." AR "الفاتورة {ref} من {supplier} مسجلة بالفعل على {purchaseOrder}." Also: the create-PO endpoint now validates its whole body with a DTO (a non-uuid supplier id or a missing order date is refused up front instead of a 500) — worth a look at review |
| `feature/mcp-t2-surface` (T2) | `a232603` | **done — `d330da5`**, jest 97/97, tsc + eslint clean; rule-2 checked (7 tests fail with the partner check off). Playwright not yet run | `mcp` audience, `issueAssistantToken`, `64-assistant-surface.spec.ts` (11 REST routes refused). New code `ASSISTANT_PARTNERS_ONLY` — EN "Only core partners can use the assistant." AR "المساعد متاح للشركاء الأساسيين فقط." |
| `feature/mcp-t3-receipt-analysis` (T3) | `a232603` | **done — `f72be3d`**, jest 58/58, tsc + eslint clean; 9 deliberate bugs each caught | `analyzeReceipt`. Match threshold: similarity ≥ 0.8 (offered, never auto-accepted). Extra blocking questions: `RECEIPT_NO_LINES`, `DATE_UNREADABLE`, `CURRENCY_UNREADABLE`. **For T7:** the open-for-purchasing statuses are written inline at `purchases.service.ts:100` — move to a shared constant (rule 11) |

Each wave-1 task runs in `.claude/worktrees/agent-*` (`git worktree list`). None is pushed.

### Resume steps, in order

1. **All four committed** (T0 `8d28a92`, T1 `9854c5d`, T2 `d330da5`, T3 `f72be3d`) — confirmed with `git branch --contains`. Step kept for safety: **Did each task commit?** `git log a232603..<branch> --oneline` (T0: `ce41763..chore/lint`).
   Empty means it stopped before committing — its files are still in its worktree:
   `git -C <worktree> status`. Salvage and finish, or re-dispatch from the plan.
2. **Check, don't trust.** In each worktree: `npx jest` and `npx tsc --noEmit -p tsconfig.json`
   in `apps/api`, quiet output, summary lines only.
3. **Merge into `feature/mcp-assistant`**: T3 (pure, no overlap) → T2 → T1 → T0 last, rebased.
4. **Translate the new error codes** in `apps/web/src/i18n/locales/{en,ar}.json` — subagents were told
   not to. Expected: `DUPLICATE_SUPPLIER_INVOICE`, `ASSISTANT_PARTNERS_ONLY`. Find any others:
   codes thrown in `apps/api/src` that `en.json` lacks.
5. **Migrate the local database** (`apps/api`: `npx prisma migrate deploy`), restart the API.
6. **Run the database-backed tests on the merged branch**: `63-supplier-invoice`,
   `64-assistant-surface`, `41-error-messages`, and the purchases and cycles suites. Rule 2: each new
   test must fail with its fix reverted.
7. **Alignment review** (`abdallah-skills:business-alignment-reviewer`) on the T1, T2 and T3 diffs.
8. **Wave 2** — T4 (OAuth) ‖ T5 (the `/mcp` endpoint and the confirmation pattern), per the plan.

### Not part of this build, still owed to production

From before this run (`docs/where-things-stand.md` → Not yet in production), on `master`:
push the 5 commits; apply the `CANCELLED` migration to Neon; run
`scripts/confirm-stranded-orders.sh --fix` against Neon for the two stranded purchase orders.

### Things a fresh session will not know

- Graft's MCP tools load in a new session and ask for approval once; the CLI works regardless
  (`DO_NOT_TRACK=1 graft ask "…"`).
- Test logins and URLs: `CREDENTIALS.local.md` (gitignored). The office app is at
  `internal-system-web-three.vercel.app` — `-web` is a stranger's app.
- Preview deployments share the production database (Findings). Do not push feature branches.
- Commits end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`; author
  `ahkortam@gmail.com`.
