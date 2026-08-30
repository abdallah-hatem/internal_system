# Customer storefront — design

**Date:** 2026-08-30
**Status:** approved by the owner, 2026-08-30

Phase 2, held since 2026-08-20 because a portal showing a shop a balance
derived from settlement logic that could not settle would be worse than no
portal. The four blockers it waited behind — settlements, ledger reversals,
stock quantities, notifications — are done.

A shop owner gets a public catalogue, an order request the owner approves, a
way to ask for something imported that isn't stocked yet, and notifications
when either is answered.

---

## Decisions

Every one of these was put to the owner and answered on 2026-08-30. They are
repeated in `docs/business-rules.md` where they are business rules rather than
architecture.

| # | Decision | Chosen |
|---|---|---|
| 1 | Who sees the catalogue | Public, at B2C prices. Ordering needs an account. A verified shop sees its B2B prices instead. |
| 2 | Does a request hold stock | Yes — a reservation is taken when the request is submitted. |
| 3 | How long the hold lasts | 48 hours, then the units release and the request stays answerable. |
| 4 | What approval can change | Quantities and prices, and lines can be dropped. What is approved becomes the order. |
| 5 | Notifications | Web push from the start, with the in-app bell as the fallback that always works. |
| 6 | Where the backend lives | Portal endpoints inside the existing API. New repo is the PWA only. |
| 7 | Where a signup lands | `Customer` with `verificationStatus = UNVERIFIED`, plus a `SHOP_OWNER_PORTAL` user. |
| 8 | Language | Arabic default, English available. |
| 9 | Stock on screen | A band — in stock / low / out. Never a count. |
| 10 | Image storage | Local disk behind a storage interface, with a real upload pipeline. |

Decision 7 was recommended against and chosen anyway, knowingly: it reuses a
column the schema already has, at the cost of letting a stranger create a row
in the table that orders and balances hang off. Contained rather than argued —
see *Unverified customers* below.

---

## What the schema already anticipated, and what it gets wrong

The original schema was drawn with a portal in mind. Most of it is usable; three
things are not, and each fails at insert time rather than quietly.

**Present and usable:** `ProductRequest`, `Customer.shopOwnerUserId`,
`UserRole.SHOP_OWNER_PORTAL`, `Customer.verificationStatus`, `Notification`.

**`InternalOnlyGuard` exists and is applied to nothing.** A portal token issued
today reads settlements, partner payouts, supplier costs and margins. This is
the single most important fact in this document, and it is why P0 lands whether
or not the rest of the work proceeds.

**`file_assets.owner_id` has a foreign key to `products.id`**
(`20260818000000_init/migration.sql:599`). The `owner_type` column is
decorative: only a product can own a file. A photo attached to a customer's
request fails the foreign key today.

**`InventoryReservation.saleOrderId` is a required FK to `SaleOrder`.** It
cannot hold stock for something that is not yet an order — which is exactly
what decision 2 requires.

---

## Data model

### An order request is not an order

New tables rather than a `REQUESTED` value on `OrderStatus`.

A status on `SaleOrder` looks cheaper and is not: outstanding balances,
analytics, payment allocation, settlement projection and the customer balance
screen all read sale orders, and every one of them would need to learn to
exclude the new status. The one that forgets is silently wrong money, which is
the failure this repository has spent the most time on.

```
OrderRequest
  id, requestNo            REQ-2026-0001, unique
  customerId
  status                   PENDING | APPROVED | DECLINED | CANCELLED
  note                     from the shop
  decisionNote             from the owner, shown to the shop
  holdExpiresAt            48h from submission
  holdReleasedAt           set by the sweeper; the request stays answerable
  saleOrderId              set on approval
  createdAt, decidedAt, decidedBy

OrderRequestItem
  id, orderRequestId, productId
  qtyRequested
  qtyApproved              null until decided; 0 means the line was dropped
  unitPrice                snapshot at request time
```

`unitPrice` is a snapshot on purpose. A price that moves between request and
approval must not change what the shop believed they were asking for; the
approval screen shows both if they differ.

Approving calls the existing `sales.create` and `confirmOrder`. There is one
definition of how an order comes into being and this is not a second one.

### Reservations can hold for a request

`InventoryReservation.saleOrderId` becomes nullable and gains `orderRequestId`,
with a check constraint that exactly one of the two is set. `status` gains
`RELEASED` and `CONSUMED`.

This introduces a rule that must exist once:

```ts
availableQty(batch) = sellableQty − sum(active reservations)
```

Read by the public catalogue, the internal inventory screen, and the sales
create flow. One exported function, three call sites. Two copies and the
storefront promises stock the internal app has already sold — the same shape as
the `CAPITALISED_CATEGORIES` drift in rule 11.

A scheduled sweeper releases holds past `holdExpiresAt`. The request is not
closed by expiry; the owner can still approve it if the stock is still there,
and the approval re-checks availability rather than trusting the old hold.

### Files can belong to a request

`file_assets` loses the foreign key to `products` and gains two explicit
nullable ones, `product_id` and `product_request_id`, with a check that exactly
one is set. Referential integrity is kept; a polymorphic `owner_id` with no
constraint would not keep it.

Derivatives point at their original through `parent_asset_id`, plus `variant`
(`ORIGINAL` | `THUMB` | `CARD`). `mime_type` is what the bytes actually are,
sniffed on upload, not what the caller claimed.

`ProductRequest.assetId` — one photo, no relation — is retired in favour of the
new foreign key, which allows several.

### Push subscriptions

```
PushSubscription
  id, userId
  endpoint                 unique
  p256dh, auth
  userAgent
  createdAt, lastSuccessAt, failureCount
```

Deleted on a 404 or 410 from the push service. Dead endpoints otherwise
accumulate for every phone that ever uninstalled the app, and each one is a
failed request on every send.

---

## Security

### P0, the fence

Lands first and independently. Until it exists nothing is exposed.

- `InternalOnlyGuard` on every existing controller.
- Portal tokens carry `aud: "portal"`, internal tokens `aud: "internal"`. The
  JWT strategy verifies audience per route group, so a portal token is refused
  on an internal route even if a guard is one day forgotten. Rule 12 in
  `CLAUDE.md` exists because the guard defaults to allowing when nothing is
  set: silence means open, so this is belt and braces on purpose.
- Rate limits on the three unauthenticated routes: signup, login, catalogue.
- The reverse proxy publishes `/api/v1/portal/*`, `/api/v1/auth/portal/*` and
  the public product-image path. Nothing else reaches the internet.

### Scoping

**No portal endpoint accepts a customer id.** It is derived from the token on
every request. There is no portal route on which a shop can name another shop —
not as a body field, not as a path parameter, not as a query filter. Ownership
is the thing checked far less often than amounts, and the way to not forget it
is to make it unrepresentable.

### Unverified customers

The containment for decision 7:

- The internal Customers list filters to verified by default, with the
  unverified ones behind their own tab and a count.
- `sales.create`, `payments.create` and `paymentPlans.create` refuse a customer
  that is not verified, with a coded error. A spam row can exist; it can never
  touch money.
- An unverified customer's portal session can browse and can submit an import
  request. It cannot submit an order request — there is nothing to hold stock
  for yet.

### Uploads

The current upload endpoint writes any buffer to a path built from caller
input, with `mimeType` and `sizeBytes` taken on trust. That is survivable while
only the owner can reach it and unacceptable the day a stranger can post to it.

```
receive → cap size at the multipart layer
        → sniff the real type from the leading bytes
        → reject anything that is not jpeg / png / webp
        → strip EXIF          (phone photos carry GPS)
        → re-encode to webp at THUMB, CARD, ORIGINAL
        → write through StorageAdapter
        → one FileAsset row per variant
```

Re-encoding is what makes this safe rather than the type check: a file that
survives a decode and re-encode is an image, whatever it claimed to be.

`StorageAdapter` is an interface with a local-disk implementation. Moving to R2
or S3 later is a new implementation and a config value, not a rewrite.

`uploads/` must be added to the backup script. It is not in the database, and a
`pg_dump` restore would bring back every product with a broken image.

---

## The storefront

New repository, `storefront`. Next.js App Router, next-intl with Arabic as the
default locale, Tailwind, react-query — the same stack as the internal web app
so there is one set of idioms to hold in mind, and the shared conventions from
`CLAUDE.md` rule 9 (coded errors translated client-side) apply unchanged.

### Screens

| Route | Who | What |
|---|---|---|
| `/` | anyone | Catalogue: search, category filter, stock band, B2C price |
| `/p/[sku]` | anyone | Product: photos, compatibility, description, price |
| `/request` | verified | The basket, submitted as one order request |
| `/orders` | signed in | Requests and their outcomes; approved ones show the order |
| `/imports` | signed in | Ask for something not stocked, with photos |
| `/account` | signed in | Details, language, notification permission |
| `/login`, `/signup` | anyone | |

A signed-in verified shop sees B2B prices everywhere a price appears. The price
shown is resolved server-side from the token, once, in the portal service —
never chosen in a component. Two price tiers decided per-screen is how a
storefront ends up quoting one price on the card and another in the basket.

### PWA

Manifest, icons, an offline shell, and `next-pwa`-style service worker
registration. The service worker handles push and notification clicks; the
catalogue is cached stale-while-revalidate, and nothing that shows a price or a
stock band is served from cache without revalidation.

An iPhone shop gets no push until the app is added to the home screen. The
account screen says so plainly, with the instructions, rather than leaving a
permission prompt that silently does nothing.

---

## Notifications

| Event | To |
|---|---|
| Order request submitted | the owner and partners |
| Order request approved / declined | the shop |
| Hold about to expire (6h left) | the owner |
| Import request submitted | the owner and partners |
| Import request answered | the shop |
| New signup awaiting verification | the owner |

Every one writes a `Notification` row first and attempts push second. The bell
is the record; push is a delivery attempt that may fail, and a failed push must
never mean a lost notification.

---

## Testing

`CLAUDE.md` rule 0 applies: a suite that only shows the happy path is untested.
Beyond each feature working, these must be pinned.

**The fence.** For every internal controller, a portal token is refused. For
every one, an internal token still works — a guard that refuses everybody
passes half a suite. A portal token with `aud: portal` presented to an internal
route is refused even where the guard is present, and vice versa.

**Ownership.** For every portal endpoint: shop A cannot read, cancel or alter
anything of shop B's, whether by body, path or query. Attempting it is a coded
404 or 403, never a 500 from a foreign key failing deep in Prisma.

**Holds.**
- Two shops requesting the same last units: the second is refused, not queued.
- A hold expires, the units come back, and the request is still answerable.
- Approving after expiry re-checks stock and refuses if it has gone.
- Approving consumes the hold rather than double-counting it.
- The catalogue, the internal inventory page and the sales create flow agree on
  what is available while a hold is live.

**Approval.**
- Part-fill: 10 requested, 6 approved, the order is for 6 and the shop is told.
- A dropped line does not appear on the order.
- Approving twice is refused.
- An approved request cannot be edited afterwards.
- The price snapshot is what the shop asked at, and a price that moved is shown.

**Unverified.**
- An unverified customer cannot submit an order request, take a payment, or be
  given a payment plan.
- They do not appear in the default Customers list.
- They can submit an import request.

**Uploads.**
- A `.exe` renamed `.jpg` is refused.
- An SVG containing a script is refused.
- A file larger than the cap is refused at the multipart layer, not after it is
  read into memory.
- EXIF GPS is gone from what is stored.
- A photo on a request survives the request being answered.

**Prices.** A verified shop sees B2B on the card, the product page, the basket
and the resulting order, and the four agree. An anonymous visitor sees B2C in
all four. This is one test across four surfaces on purpose.

**Browser.** The flows are proven in a browser as a person walks them, per rule
2 — reaching each screen the way a person does, asserting on what they would
see, not on what the API returned underneath.

---

## Sequence

| | Where | Gate |
|---|---|---|
| **P0** Fence | `internal_system/apps/api` | Nothing is exposed before this |
| **P1** Portal API + schema + uploads | `internal_system/apps/api` | The storefront has nothing to call without it |
| **P2** Storefront PWA | `storefront`, new repo | |
| **P3** Internal screens | `internal_system/apps/web` | You cannot run P2 without somewhere to answer it |

P3 could precede P2; it is placed after because the internal screens are easier
to design once the shape of a real request exists.

---

## Deliberately not in this

- Payment online. Shops settle the way they already do, and the portal shows
  the balance the internal system computes.
- Email and WhatsApp. The BRD scopes V1 to in-app, and web push is the one
  addition here.
- A public product-review or rating surface.
- Self-service returns. Returns have rules the shop cannot be trusted to apply
  and the internal flow already handles them.
