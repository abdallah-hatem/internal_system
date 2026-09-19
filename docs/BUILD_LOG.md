# Build log

Run mode: fully autonomous — chosen by the user on 2026-09-19
Graft: wired in 2026-09-19
Goal: "an MCP for this application — we talk to it and it does what we want. Send a receipt from
the merchant I bought the products from and it knows what to do, and asks the right questions."
Current stage: 4 — Build · Wave 1 of 4 in flight · **HELD by the user 2026-09-19** — see Handoff

## Waves

- Wave 1: T0 T1 T2 T3 in parallel, each in its own worktree. T0 is the house lint chore (all three
  package.json files); T1 schema + purchases; T2 surface guard + auth tokens; T3 a new pure module.
  No shared files. T4 T5 wait on T1+T2 · T6-T9 wait on T5.

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
| `chore/lint` (T0) | **`ce41763` — a stale master** | was running | house lint + `typecheck`. **Rebase onto `feature/mcp-assistant` before merging**, then re-run `eslint --suppress-all` so files added since are covered |
| `feature/mcp-t1-invoice-tables` (T1) | `a232603` | was running | invoice number, OAuth + nonce tables, migration, `63-supplier-invoice.spec.ts` |
| `feature/mcp-t2-surface` (T2) | `a232603` | was running | `mcp` audience, `issueAssistantToken`, `64-assistant-surface.spec.ts` |
| `feature/mcp-t3-receipt-analysis` (T3) | `a232603` | was running | `analyzeReceipt` pure function + its 25 cases |

Each wave-1 task runs in `.claude/worktrees/agent-*` (`git worktree list`). None is pushed.

### Resume steps, in order

1. **Did each task commit?** `git log a232603..<branch> --oneline` (T0: `ce41763..chore/lint`).
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
