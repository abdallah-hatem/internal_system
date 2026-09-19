# The assistant — an MCP server for MotoParts

2026-09-19 · feature mode · fully autonomous run · decisions logged in `docs/BUILD_LOG.md`

## What it does

A partner adds MotoParts to Claude (claude.ai, the phone app, Claude Desktop) as a connector,
signs in once with their partner login, and can then:

- **Ask anything** about cycles, purchase orders, stock, sales, payments, balances and FX rates.
- **Send a supplier's receipt or invoice** — a photo or a PDF — and have it turned into a purchase
  order: Claude reads the document, the server matches it against what the system already knows,
  Claude asks exactly the questions that matching could not settle, shows a preview, and creates
  the records only after the partner says yes.
- **Run a cycle's intake** by conversation: start a cycle, add shipping legs, move it through its
  statuses, and verify stock in.

Everything else — sales, payments, instalments, settlements, returns, the ledger — stays in the
office app. The assistant can read them but not change them.

## Who

**Core partners only.** A temporary investor or a shop owner is refused at the sign-in page. Every
action the assistant takes is recorded under the partner who signed in, exactly as if they had used
the office app.

## How it fits

```
Claude  ──OAuth──▶  API /oauth/*          sign in with the partner login, once
Claude  ──MCP───▶   API /mcp              tools; each call carries a token only /mcp accepts
                        │
                        └─▶ the same services the office app's controllers call
```

- **Inside `apps/api`**, one deployment. The MCP SDK requires cleanly as CommonJS.
- **Tools call services, not HTTP.** Validation lives in the services (CLAUDE.md rule 3), so the
  assistant is refused everything the office app would be refused, with the same coded refusals.
- **Its own token audience, `mcp`.** SurfaceGuard already refuses a token presented to the wrong
  surface, and every REST endpoint defaults to `internal` — so an assistant token is useless
  anywhere except `/mcp`, and `/mcp` only offers the tools in scope. The write scope is enforced by
  the server, not by the model's good behaviour.

## The receipt flow

Claude does the reading; the server does the knowing.

1. The partner sends a receipt. Claude extracts supplier name, invoice number, date, currency, the
   lines (description, model/SKU if printed, quantity, unit price, discount), any non-goods charges
   (shipping, fees, tax) and the stated totals.
2. **`match_receipt`** receives that extraction and returns, deterministically:
   - the supplier: matched, a short list of candidates, or unknown
   - each line: matched product, candidates, or unknown
   - a duplicate check: the same supplier and invoice number already recorded
   - an arithmetic check: the lines against the stated subtotal
   - the non-goods charges, flagged as not purchase-order lines
   - the currency: the stored FX rate to suggest, or none on file
   - the cycles a purchase order can still be added to, and any draft order from this supplier
     already on one of them
   - **`questions`** — each unresolved point as a question with its options. The server decides
     what must be asked; Claude decides how to phrase it.
3. Claude asks. Answers resolve every question.
4. **`create_purchase_order`** with no confirmation token validates the complete order — new
   supplier and new products included — writes nothing, and returns a readable summary with totals
   in the receipt's currency and in EGP, plus a confirmation token.
5. Claude shows the summary. The partner says yes.
6. The same call with the token creates everything in one transaction: any new supplier, any new
   products, the purchase order and its lines.

### What `match_receipt` asks about

| Situation | Question | Blocking |
|---|---|---|
| Supplier not found | create it as new? which country? | yes |
| Several suppliers match | which one? | yes |
| Same supplier + invoice number already recorded | is this a different receipt? (show the existing order) | yes — cannot be created twice |
| A line matches no product | one of these, or a new product? | yes |
| A line matches several products | which one? | yes |
| Lines don't add up to the stated subtotal | discount, or a misread line? | yes |
| Shipping / fees / tax on the receipt | leave off, or record on a shipping leg? | no |
| No FX rate on file for the currency | what rate was paid? | yes |
| FX rate on file | use it, or the rate actually paid? | no |
| No cycle is open for purchasing | start a new cycle? which route? | yes |
| Several cycles are open | which cycle? | yes |
| A draft order from this supplier is on that cycle | add to it, or a separate order? | yes |
| Receipt date is in the future | — refused, the date must be corrected | yes |

## Confirmation

Every write tool works in two calls:

- **Without `confirmationToken`**: validates exactly as the real write would, writes nothing,
  returns a summary and a token.
- **With it**: commits — only if the token was issued to this partner, for this tool, for this exact
  input, less than 15 minutes ago, and has not been used before.

What is committed is what was previewed. A changed quantity, a different cycle, or a replayed token
is refused.

## Tools

**Read** — `readOnlyHint: true`

| Tool | Answers |
|---|---|
| `find_suppliers` | suppliers by name |
| `find_products` | products by name or SKU, with prices and stock |
| `list_cycles` | cycles, optionally by status |
| `get_cycle` | one cycle by code or id: legs, purchase orders, participants, status |
| `get_stock` | stock per product, with batch arrival and receipt dates |
| `list_sales` | sale orders, by date range or customer |
| `get_customer` | a customer's balance, open orders and payment plans |
| `list_payments` | payments, by date range or customer |
| `get_dashboard` | the dashboard figures |
| `get_fx_rates` | the stored rates to EGP |

**Receipt** — `match_receipt` (read), `create_purchase_order`, `create_supplier`, `create_product`

**Cycles** — `create_cycle`, `add_shipping_leg`, `transition_cycle`, `verify_stock`

Every write tool: `readOnlyHint: false`, `destructiveHint: false`, so Claude clients ask before
running it as well.

## Data model

| Change | Why |
|---|---|
| `PurchaseOrder.supplierInvoiceRef` — optional, unique per supplier | the only way to recognise the same receipt sent twice |
| `OAuthClient` | clients Claude registers dynamically, with their redirect URIs |
| `OAuthRefreshToken` — hashed, per partner and client, revocable | a phone can be lost; access must be revocable without changing the password |
| `UsedNonce` | single use for authorization codes and confirmation tokens |

Access tokens and authorization codes are signed JWTs, not stored.

## Endpoints

| Method | Path | |
|---|---|---|
| GET | `/.well-known/oauth-protected-resource` | points Claude at the authorization server |
| GET | `/.well-known/oauth-authorization-server` | OAuth metadata: PKCE S256, `none` client auth |
| POST | `/oauth/register` | dynamic client registration |
| GET | `/oauth/authorize` | sign-in page |
| POST | `/oauth/authorize` | checks the partner login, redirects with a code |
| POST | `/oauth/token` | code → tokens; refresh → rotated tokens |
| POST | `/oauth/revoke` | revokes a refresh token |
| POST · GET · DELETE | `/mcp` | the MCP endpoint, stateless Streamable HTTP |
| GET | `/api/v1/auth/assistant-connections` | the office app lists a partner's connections |
| DELETE | `/api/v1/auth/assistant-connections/:id` · `/api/v1/auth/assistant-connections` | disconnect one, or all |

`/.well-known/*`, `/oauth/*` and `/mcp` sit outside the `api/v1` prefix, where OAuth and MCP clients
look for them.

## Defaults decided

- **Redirect URIs are limited to Claude** — `claude.ai`, `claude.com`, and `localhost` for Claude
  Desktop and Claude Code. Registration is open by design (claude.ai registers itself), so without
  this anyone could register a client that redirects a partner's code to their own site.
- **Access tokens live 1 hour; refresh tokens 30 days and rotate on use.** Refreshing re-checks the
  partner is still a core partner.
- **Only core partners can sign in.** Investors and shop owners are refused on the sign-in page.
- **The receipt image is not stored.** The model cannot pass the bytes of an image it was shown into
  a tool call. The order records the supplier's invoice number; the photo stays in the chat.
- **No new rate limiting.** In-memory throttling does nothing across serverless instances, and a
  shared store means a new account. The sign-in page is no weaker than the existing `/auth/login`.
  Recorded as a known gap.
- **Server instructions carry the receipt workflow**, so any Claude client follows the same steps
  without a prompt being chosen.

## Screens

- **The sign-in page** — served by the API, plain HTML, English and Arabic, the office app's look.
  Says what Claude will be able to do before asking for a password.
- **Settings → Claude connections** in the office app — each connected client with when it last
  refreshed, and Disconnect / Disconnect all.

## Out of scope

- Writing sales, payments, instalments, settlements, returns or ledger entries.
- Storing the receipt image.
- A mobile app, WhatsApp or email intake — Claude is the only client.
- Rate limiting — see Defaults.
- Separating the preview database from production — a finding, not part of this goal.

## The edit to `docs/BUSINESS_LOGIC.md`

A new section, **16. The assistant**, stating: who may connect; what it may read and change; the
confirmation invariant; attribution to the signed-in partner; revocation; and one new invariant for
purchasing — **a supplier's invoice number is recorded once per supplier.** Written in the same
commit as the code that makes it true.
