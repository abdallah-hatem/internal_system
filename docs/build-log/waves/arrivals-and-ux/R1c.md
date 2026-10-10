# R1c — Warnings that translate; a catalogue an investor only reads

Branch `fix/r1c-warnings-and-catalogue`, from `78810b2`. Code commits `c8d70cf`
(api) and `81cf962` (web). Picks up R1b's "Left for others".

## 1. Settlement warnings are codes (rule 9)

`POST /settlements/calculate/:cycleId` returned `warnings` as English
sentences, and the settlements page printed them as they came. They are now
built in one place, `apps/api/src/modules/settlements/settlement-warnings.ts`,
as `{ code, params }`, with params numbers only:

| Code | Params | Was |
|---|---|---|
| `UNSOLD_STOCK` | `units`, `valueEgp` | "N units are still in stock (X EGP at landed cost). Their cost stays with the cycle until they sell, so this profit covers sold units only." |
| `NO_REALISED_SALES` | — | "This cycle has no realised sales yet." |

The amount was a server-formatted string ("1,250,000.50"); it is a number now
and the client groups it the way `Money` does (2dp for `…Egp`, up to 3dp for a
count). Meaning unchanged.

Web: `components/settlements/settlement-warnings.tsx` says each code under
`settlementsPage.warnings.<code>` (en + ar). A code this build has never heard
of — or a bare string from an older API — shows `warnings.unknown` ("…a warning
this version of the app cannot show. Refresh the page."), never the raw code.
The namespace is `settlementsPage`, not `settlements`, because that is the
page's namespace already.

### The sweep for other English in response bodies

Grepped `apps/api/src` for `warnings`, `message`, `notes`, `reason`,
`description`, `summary`, `title` built from literals or templates outside
refusals. What the web renders was fixed; the rest:

- **Costing warnings** (`costing.service.ts`: "Cycle has shipping cost but no
  purchased items…", "Leg N (A->B) is weight-based but … Allocated by piece
  instead.", "Leg N could not be allocated…") reach `GET /costing/:cycleId` and
  the receive-into-stock plan. **The web renders neither**; the assistant's
  receive tool prints them to Claude in English, which is correct for that
  reader. Left; if a screen ever shows them they need the same treatment.
- **Ledger `reason` written by the system** — shown in the ledger's Reason
  column and its CSV: `payments.service.ts` ("Auto: Payment received from
  customer <uuid> via CASH" — a raw customer id, too), `inventory.service.ts`
  ("Auto: N units received at X EGP/unit landed"), `returns.service.ts`
  ("Return R against O: …", "Cash refunded for R"), `settlements.service.ts`
  ("Reversal of C settlement: …"), `purchases.service.ts` ("Refund undone: …").
  These are **stored**, so fixing them is U5's notification pattern — a code
  and params column on the ledger row, a migration, and a fallback for every
  row already written. Not done here: a schema change is bigger than this task.
- Refusal messages and `notification-messages.ts` titles are English by design
  (the log line and the fallback); the codes are what clients show.

### Found on the way, not fixed (web, English literals)

- `settlements/page.tsx`: `COMPONENT_LABEL` (unused — lint already warns) and
  `'Unknown'` as a participant's name fallback.
- `products/page.tsx`: `StatusBadge` says "Active"/"Inactive".
- `products/[id]/page.tsx`: `t('currentPrices') ?? 'Current Prices'`.
- `categories/page.tsx`: "product"/"products" after the count; the tree indents
  with `paddingLeft`, which does not mirror in Arabic.
- Fixed while there: the price row's "not set" is `products.priceNotSet`.

## 2. Catalogue pages hide partner-only actions

18 actions added to `ACTION_ROLES` (`apps/web/src/lib/permissions.ts`), each
copied from its endpoint's `@Roles` — all CORE_PARTNER — and each pinned in
`unit/can-roles.test.mjs` to the controller it calls:

| Page | Hidden for any other role | Endpoint |
|---|---|---|
| Products | New product (header + empty state), Edit | `POST /products`, `PUT /products/:id` |
| Product details | Set price (both channels — shown as a read-only amount instead), Add photo (+ its hint), Delete photo | `POST /products/:id/prices`, `POST /files/products/:productId`, `DELETE /files/:id` |
| Categories | New, Edit, Delete | `POST/PUT/DELETE /categories` |
| Suppliers | New, Edit, Delete (desktop + phone) | `POST/PUT/DELETE /suppliers` |
| Providers | New, Edit, Delete (desktop + phone) | `POST/PUT/DELETE /providers` |
| Purchases | New order (header + empty state), Record refund in an opened order | `POST /cycles/:cycleId/purchases`, `POST /purchases/:id/refunds` |
| Shipments | New leg (header + empty state), Edit (desktop button; the phone card is no longer clickable) | `POST /cycles/:cycleId/shipping-legs`, `PUT /shipping/legs/:id` |

The Actions column is dropped when a role has no row action in it, and the
empty-state `colSpan` follows. View links (products, purchase orders) stay.
Admin support loses the same buttons — every one of these writes was already
CORE_PARTNER only. Each write button gained `type="button"`, `cursor-pointer`
and a test id (`create-action`, `edit-action`, `delete-action`,
`record-refund-action`, `set-price-action`, `add-photo-action`,
`delete-photo-action`).

## Lint

`eslint . --prune-suppressions` in web: counts only went down (the warning box
left the settlements page; its replacement uses the `accent` token, not
`amber`). Both apps: 0 errors.

## Tests

- `apps/api/src/modules/settlements/settlement-warnings.spec.ts` (jest, 6):
  both codes with numeric params and no two-word English run in any string; a
  fully sold cycle warns nothing; a seven-figure value stays a number; every
  code UPPER_SNAKE; the service builds its warnings there and has no
  `warnings.push(`. **Revert check**: the old service plus the old sentence as
  a code → 3 of 6 fail.
- `apps/web/src/components/settlements/settlement-warnings.test.tsx` (Vitest,
  6): Arabic shows Arabic with grouped numbers and no Latin word; English reads
  as before; an unknown code and an old bare string show the fallback, not the
  code; empty → nothing; en/ar keys equal the API's `SETTLEMENT_WARNING_CODES`
  with matching params.
- `apps/web/src/lib/catalogue-readonly.test.tsx` (Vitest, 21): for each of the
  six lists, an investor sees the rows and no create/edit/delete (by test id
  and by the create button's name); a core partner on the same rows sees all;
  an empty list shows an investor its line without the add button, a partner
  with it. An opened purchase order: Record refund for the partner only. A
  product: investor reads both prices, no set-price/add/delete photo; partner
  the reverse. **Revert check**: against the pre-R1c pages all 21 fail — the
  investor cases on the visible create/edit buttons (the right reason), the
  partner cases only because the test ids did not exist yet.
- `unit/can-roles.test.mjs`: 39 cases (was 21) — every new action against its
  controller's `@Roles`, investor none, partner all.
- `apps/web/tests/90-catalogue-readonly.spec.ts` (Playwright, **not run**):
  investor walks the six lists from the menu — rows, no writes, no 403/5xx;
  partner on the same rows has create and edit; opened purchase order and
  product details, both directions.
- web: test:unit Vitest 213 + node 84 pass, lint 0 errors, typecheck clean.
  api: jest 806 passed (9 skipped), lint 0 errors, typecheck clean.

## Guesses

- The Arabic wording of both warnings and of the fallback line.
- An investor sees a product's price as a plain amount where a partner has the
  input; photos are shown without the add/remove controls or the upload hint.
- On phones a shipment card stops being a tap target for a role that cannot
  edit, rather than opening a form it cannot save.

## Left for others

- Ledger reasons written by the system are English and stored (above).
- Costing warnings, if a screen ever shows them.
- Quick-create `+` buttons on pages an investor cannot open (sales, customers)
  were not audited; the catalogue pages' forms are no longer reachable for them.
