# Build log

Run mode: fully autonomous — chosen by the user on 2026-09-19
Graft: wired in 2026-09-19
Goal: "an MCP for this application — we talk to it and it does what we want. Send a receipt from
the merchant I bought the products from and it knows what to do, and asks the right questions."
Current stage: 2 — Feature spec

## Waves

_(none yet)_

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

## Findings

- **Preview deployments use the production database and Blob store.** `DATABASE_URL` and
  `BLOB_READ_WRITE_TOKEN` are scoped to Production *and* Preview with the same value. Nothing has
  used a preview yet because the repo only pushes `master`, but any branch pushed to GitHub would
  get a preview wired to live data. Not changed in this run — it is infrastructure the goal does not
  cover — but it must be fixed before a `dev` branch exists.

## Blocked

_(none)_
