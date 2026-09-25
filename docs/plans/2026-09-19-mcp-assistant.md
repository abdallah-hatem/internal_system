# Plan — the assistant (MCP)

Spec: `docs/specs/2026-09-19-mcp-assistant.md` · Branch: `feature/mcp-assistant` (local, not pushed)

Every new error code is listed by the task that throws it and translated by the main thread after
each wave — subagents do not edit locale files (they would collide, and `41-error-messages` fails on
a translation for a code nothing throws yet).

`docs/BUSINESS_LOGIC.md` §15 and §16 are written by the main thread before Wave 1, marked
**Planned**, and flipped to built after Verify — so no two subagents edit the doc.

## Waves

| Wave | Tasks | Why this grouping |
|---|---|---|
| 1 | T1 ‖ T2 ‖ T3 | no shared files: schema+purchases · surface guard+auth tokens · a new pure module |
| 2 | T4 ‖ T5 | both need T1+T2. T4 owns `main.ts`; T5 owns `app.module.ts` wiring for `assistant` |
| 3 | T6 ‖ T7 ‖ T8 ‖ T9 | each fills its own tool file that T5 pre-created; T9 is the office app |
| 4 | T10 | end-to-end over HTTP — needs the servers, so it runs on the merged branch, not a worktree |

---

### T1 — Supplier invoice number, and the tables OAuth and confirmation need (backend · logic)
Depends on: —

- `PurchaseOrder.supplierInvoiceRef` (optional). Stored trimmed and upper-cased; empty string is
  absent. Unique per supplier. `POST /cycles/:id/purchases` accepts it; the office app is unchanged.
- `OAuthClient`, `OAuthRefreshToken` (token stored hashed), `UsedNonce` (`jti` primary key, `kind`).
- One migration, additive only.
- New code: `DUPLICATE_SUPPLIER_INVOICE`.

Edge cases:
- [ ] Same supplier, same invoice number twice → second refused `DUPLICATE_SUPPLIER_INVOICE`, nothing written   (invariant §15: once per supplier)
- [ ] ` inv-001 ` then `INV-001` for one supplier → second refused   (invariant: the same receipt, differently typed)
- [ ] Same invoice number, different suppliers → both accepted   (invariant: numbers are per supplier)
- [ ] No invoice number, twice, same supplier → both accepted   (receipts without numbers exist)
- [ ] Empty string → stored as absent   (contract: empty ≠ a value)
- [ ] A purchase order created without the field (the office app today) → still works   (backward compatibility)
- [ ] Invoice number longer than 64 characters → refused   (contract: limit)

### T2 — The `mcp` token audience (backend · logic)
Depends on: —

- `Surface` gains `'mcp'`. `SurfaceGuard` accepts an `mcp`-audience token only on routes declared
  `@Surface('mcp')`; every existing route stays `internal` by default.
- `AuthService.issueAssistantToken(user)` — 1-hour JWT, audience `mcp`, subject the user.
- Per-request check that the token's user is still an active core partner.
- New codes: `ASSISTANT_PARTNERS_ONLY`.

Edge cases:
- [ ] `mcp` token on `GET /api/v1/payments` → 403 `WRONG_SURFACE`   (spec: scope enforced by the server)
- [ ] `mcp` token on `POST /api/v1/sales/orders` → 403 `WRONG_SURFACE`   (spec: no sales writes)
- [ ] `mcp` token on payment plans, sale returns, settlements and the ledger → 403 `WRONG_SURFACE` each   (§16: instalments, returns, settlements, ledger)
- [ ] `internal` token on an `mcp` route → 403 `WRONG_SURFACE`
- [ ] `portal` token on an `mcp` route → 403 `WRONG_SURFACE`
- [ ] `mcp` token for a partner since demoted or deactivated → 403 `ASSISTANT_PARTNERS_ONLY`   (role)
- [ ] Expired `mcp` token → 401
- [ ] Existing `internal` and `portal` behaviour unchanged → the whole suite stays green   (regression)

### T3 — Receipt analysis, as a pure function (backend · logic)
Depends on: —

`analyzeReceipt(extraction, snapshot)` in `modules/assistant/receipt/`. `snapshot` is plain data —
suppliers, products, cycles open for purchasing, draft orders, FX rates, recorded invoice numbers —
so every case is a unit test with no database. Returns matches, findings and `questions[]`, each
question with a stable `id`, `blocking`, `options`.

Edge cases:
- [ ] Supplier exact, ignoring case and spacing → matched, no question   (spec table)
- [ ] Supplier near-miss (`Guangzou Parts` / `Guangzhou Parts`) → candidates, `SUPPLIER_WHICH`, blocking
- [ ] Supplier unknown → `SUPPLIER_NEW` asking country, blocking
- [ ] Same supplier + invoice already recorded → `DUPLICATE_INVOICE`, blocking, names the existing order   (invariant §15)
- [ ] Line matches a product by SKU → matched
- [ ] Line matches by name → matched, or candidates when several
- [ ] Line matches nothing → `LINE_NEW_OR_EXISTING`, blocking
- [ ] Line matches several → `LINE_WHICH`, blocking
- [ ] Lines ≠ stated subtotal by more than 0.01 → `TOTALS_MISMATCH`, blocking, both figures   (money)
- [ ] Lines = subtotal once line discounts are applied → no question   (money)
- [ ] Shipping / fees / tax present → `CHARGES_WHERE`, not blocking
- [ ] Currency with no stored rate → `FX_RATE_NEEDED`, blocking
- [ ] Currency with a stored rate → `FX_RATE_CONFIRM` with the rate, not blocking
- [ ] Currency EGP → no FX question, rate 1
- [ ] No cycle open for purchasing → `CYCLE_NEW` with the two routes, blocking
- [ ] Exactly one open cycle → suggested, `CYCLE_CONFIRM`, not blocking
- [ ] Several open cycles → `CYCLE_WHICH`, blocking
- [ ] A draft order from this supplier on the cycle → `ADD_OR_SEPARATE`, blocking
- [ ] Receipt date in the future → `FUTURE_DATE`, blocking   (invariant: records cannot be dated forward)
- [ ] Line quantity zero or negative → `LINE_QTY_INVALID`, blocking   (money)
- [ ] Line unit price negative → `LINE_PRICE_INVALID`, blocking   (money)
- [ ] A line discount larger than the line → `LINE_DISCOUNT_INVALID`, blocking   (money: the −9,899 order)
- [ ] No lines → refused   (contract)
- [ ] Fractional quantity (2.5) → accepted   (data: quantities are decimal)

### T4 — OAuth authorization server and sign-in page (backend · logic)
Depends on: T1, T2. Owns `main.ts`.

`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/oauth/register`,
`GET` + `POST /oauth/authorize`, `/oauth/token`, `/oauth/revoke`. PKCE S256 required. Codes are signed
JWTs, 5 minutes, single use. Refresh tokens 30 days, rotating, re-checking the role. Sign-in page in
English and Arabic, core partners only. `main.ts` excludes `.well-known`, `oauth` and `mcp` from
the `api/v1` prefix. Base URL from `PUBLIC_BASE_URL`, else the forwarded host and protocol.

Edge cases:
- [ ] Register with `https://evil.example/cb` → 400 `invalid_redirect_uri`   (spec default: Claude only)
- [ ] Register with `https://claude.ai/api/mcp/auth_callback` → 201 with a `client_id`
- [ ] Register with `http://localhost:6274/callback` → accepted   (Claude Desktop / Code)
- [ ] Authorize with an unknown `client_id` → error page, **no redirect**
- [ ] Authorize with a `redirect_uri` not registered to that client → error page, **no redirect**   (never redirect somewhere unverified)
- [ ] Authorize without `code_challenge`, or with method `plain` → error   (PKCE S256)
- [ ] Wrong password → page shown again with an error, no code
- [ ] Investor signs in → refused on the page   (role: core partners only)
- [ ] Shop owner signs in → refused on the page   (role)
- [ ] Core partner signs in → 302 to the redirect URI with a code and the exact `state`
- [ ] Token with the wrong `code_verifier` → `invalid_grant`
- [ ] Code used twice → second `invalid_grant`   (single use)
- [ ] Code older than 5 minutes → `invalid_grant`
- [ ] `redirect_uri` at the token step differs from authorize → `invalid_grant`
- [ ] Code issued to client A, redeemed by client B → `invalid_grant`
- [ ] Refresh → new access and refresh tokens; the old refresh token then fails   (rotation)
- [ ] Refresh a revoked token → `invalid_grant`
- [ ] Refresh after the partner was demoted → `invalid_grant`   (role)
- [ ] Refresh older than 30 days → `invalid_grant`
- [ ] `/oauth/revoke` → that refresh token no longer works
- [ ] Metadata carries absolute URLs on the public host   (deployment)

### T5 — The MCP endpoint, the confirmation pattern, and the tool files (backend · logic)
Depends on: T1, T2. Owns `app.module.ts` wiring for the `assistant` module.

`/mcp` as a Nest controller, `@Surface('mcp')`, stateless `StreamableHTTPServerTransport`, a fresh
`McpServer` per request carrying the partner. No token → 401 with
`WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"`. Server
`instructions` describe the receipt workflow. The confirmation helper: preview returns a token bound
to partner, tool and a hash of the canonical input, 15 minutes, single use via `UsedNonce`. A
service refusal becomes a tool error carrying its code and English message. Creates
`tools/read.ts`, `tools/receipt.ts`, `tools/cycle.ts` with empty `register…` functions already wired.

New codes: `CONFIRMATION_INVALID`, `CONFIRMATION_EXPIRED`, `CONFIRMATION_USED`, `CONFIRMATION_MISMATCH`.

Edge cases:
- [ ] Write tool without a token → preview, nothing written   (invariant §16: never writes without a confirmed preview)
- [ ] With a valid token → commits once
- [ ] The same token twice → `CONFIRMATION_USED`
- [ ] A token from a different tool → `CONFIRMATION_MISMATCH`
- [ ] The token with one input changed → `CONFIRMATION_MISMATCH`   (invariant: commits what was previewed)
- [ ] Partner A's token presented by partner B → `CONFIRMATION_MISMATCH`
- [ ] A token older than 15 minutes → `CONFIRMATION_EXPIRED`
- [ ] A service refusal → tool error with the code, not a 500
- [ ] Input that fails the tool's schema → tool error, not a crash
- [ ] No token → 401 with the resource-metadata header
- [ ] No tool's input schema accepts file or image content, and no assistant tool writes a stored file   (§16: the receipt image is not kept)

### T6 — Read tools (backend · logic)
Depends on: T5.

`find_suppliers`, `find_products`, `list_cycles`, `get_cycle`, `get_stock`, `list_sales`, `get_customer`,
`list_payments`, `get_dashboard`, `get_fx_rates` — each calling the service the office app's
controller calls.

Edge cases:
- [ ] `get_cycle` by code and by id → the same cycle; unknown → tool error `NOT_FOUND`
- [ ] `get_stock` arrival and receipt dates equal `/inventory`'s   (§14: one definition)
- [ ] `get_customer` balance equals the office app's for the same customer   (money: one definition)
- [ ] `find_products` is case-insensitive and matches part of a SKU
- [ ] `list_sales` with `from` after `to` → tool error
- [ ] `tools/list` offers no tool that writes sales, payments, instalments, settlements, returns or the ledger   (§16: what it may change)

### T7 — Receipt tools (backend · logic)
Depends on: T3, T5, T1.

`match_receipt` (wraps T3 with a snapshot from the database), `create_purchase_order` (new supplier
and new products inline, one transaction), `create_supplier`, `create_product`.

Edge cases:
- [ ] `create_purchase_order` preview → row counts unchanged   (invariant §16)
- [ ] Commit with a new supplier and two new products → all created together
- [ ] A line fails at commit → no supplier or product left behind   (atomic)
- [ ] The invoice recorded by someone else between preview and commit → refused, nothing written   (invariant §15)
- [ ] Cycle past PURCHASING → the service's refusal, surfaced
- [ ] Add to an existing draft order → lines appended; to a confirmed order → `PO_NOT_DRAFT`   (§15)
- [ ] `orderedOn` in the future → refused
- [ ] FX rate zero or negative → refused   (money)
- [ ] A line discount making the line negative → refused   (money)
- [ ] Unit price zero → accepted (free goods); negative → refused   (money)
- [ ] The audit log names the signed-in partner   (§16: attribution)
- [ ] `create_supplier` with an existing name, any case → refused, naming the existing one
- [ ] `create_product` with an existing SKU → refused

### T8 — Cycle tools (backend · logic)
Depends on: T5.

`create_cycle`, `add_shipping_leg`, `transition_cycle`, `verify_stock`.

Edge cases:
- [ ] `create_cycle` for each route → created with the right number of legs expected
- [ ] Transition that skips a status → the service's refusal, surfaced
- [ ] Transition to an arrival with the leg undated → `LEG_NOT_ARRIVED`, surfaced
- [ ] Preview of a transition past PURCHASING says which orders it will confirm and lock   (§15)
- [ ] Preview of a cancel says it is final
- [ ] `add_shipping_leg` with `arrivedOn` in the future → refused
- [ ] `verify_stock` twice for one order line → `STOCK_ALREADY_VERIFIED`, surfaced
- [ ] `verify_stock` preview shows the landed unit cost per line before anything is written   (money)

### T9 — Claude connections in Settings (backend · logic + frontend · ui)
Depends on: T4.

`GET /api/v1/auth/assistant-connections`, `DELETE …/:id`, `DELETE …` (all). A Settings section listing
each connection — client name, connected, last refreshed — with Disconnect and Disconnect all.

Edge cases:
- [ ] A partner sees only their own connections   (role)
- [ ] Disconnecting another partner's connection id → 404   (role)
- [ ] Disconnect all → only this partner's tokens revoked
- [ ] Two Claude apps signed in by one partner → two separate connections, each disconnectable alone   (§16: each app is its own connection)
- [ ] After disconnecting, refresh fails   (§16: revocable)
- [ ] (ui) No connections → an empty state that says how to connect
- [ ] (ui) The list updates after a disconnect without a reload
- [ ] (ui) Arabic, right to left

### T10 — End to end over HTTP (backend · logic)
Depends on: T4–T9, merged.

`apps/web/tests/72-assistant-end-to-end.spec.ts` (63 was taken), using the MCP SDK's client over HTTP: register → sign in → code
→ token → `tools/list` → `match_receipt` on a realistic receipt → answer its questions →
preview → commit → the purchase order exists with the invoice number, attributed to the partner.
Then the scope check from outside: the assistant token on REST endpoints.

- [x] Done 2026-09-25 — `e806f54`, 13/13; rule-2 reverts (preview rollback, single-use nonce) each fail it.
