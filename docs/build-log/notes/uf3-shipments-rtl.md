# UF3 — shipments in Arabic (2026-10-10)

Fixes UI audit rows #6, #11, #12, #23, #24, #25, #34 and #29 (shipments table).

## Arabic wording (#25)

"دفعة" was doing three jobs. One word per thing from now on:

| Thing | Arabic | Plural | Not |
|---|---|---|---|
| A payment (money from a shop, to a supplier) | دفعة | دفعات | — |
| A delivery (part of a leg arriving) | تسليمة | تسليمات | دفعة، دفعة واصلة |
| A stock batch (FIFO lot) | تشغيلة | تشغيلات | دفعة |

"تسليمة" is what an Egyptian warehouse calls a consignment that turns up; it
cannot be read as money, so "حذف التسليمة" no longer sounds like deleting a
payment. Applied across `shipment.*` and `shipments.*`; a unit test
(`shipment-rtl.test.tsx`) fails if a delivery string uses "دفع" again.
"تشغيلة" is the guess for batches; none appear in the shipment screens, so it
is recorded here for the next screen that names one.

A shipping leg is "مرحلة شحن" everywhere ("خط شحن" in the create button was
the odd one out).

## Bidi

- `components/shipment/LegRoute.tsx` is the one route renderer: origin,
  arrow, destination as flex items, each name a `<bdi>`, arrow `rtl:rotate-180`.
  In Arabic it reads right to left, origin first, arrow pointing at the
  destination.
- Product and payer names inside Arabic sentences are wrapped by a `<name>`
  tag in the message and rendered as `<bdi>` through `t.rich`.
- Refund amounts are `<amount></amount>` tags rendered as `Money`; no locale
  string carries a currency.
- Cost basis is `shipments.basisPerPiece` / `basisPerWeight` with the unit
  translated (قطعة، كجم) and Latin digits.
