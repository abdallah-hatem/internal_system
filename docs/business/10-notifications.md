> Part of the [business rules](../BUSINESS_LOGIC.md) — the index there lists every section. Moved here verbatim 2026-11-01.

## 10. Notifications

**V1 is in-app only**, as the BRD scopes. Email and WhatsApp are deliberately
out. (Superseded in part 2026-10-18: every in-app notification is also pushed to
the partners' phones — below. Email and WhatsApp are still out.)

Raised on: low stock (after a receipt, and since 2026-10-11 after a sale that
takes a product into low stock — §3), a shipment arriving, a cycle created or
changing state, a purchase order created, a partner added to a cycle, an
instalment falling behind (checked daily since 2026-10-11 — §7), and samples
still at a shop 14 days after they were left (daily, once per order, since
2026-10-18 — §4 "Samples at shops").

**What one partner did reaches the others — DECIDED 2026-10-25 (owner), built 2026-10-25, live 2026-10-26.** "a sale and payment
should trigger notifications as well", then "yes i want them add" for returns, reversals and cancellations. Found when
Fares recorded a sale and the owner was not told.

- Raised on: a sale confirmed (one-step, walk-in, a draft confirmed, samples bought), a payment recorded, a return, a
  payment reversed, and a **confirmed** order cancelled. A draft is not news, and neither is cancelling one.
- Read by every active core partner except the one who did it — not an investor, not an inactive login. Each says who
  did it (the partner's name, else the login's email).
- What each says: the sale — shop, order number, total; the payment — amount, shop, method, the orders it went on; the
  return — reference, shop, order, products and units, refund and whether it came off what they owe or was paid in
  cash, the reason; the reversal — amount, shop, reason; the cancel — order number, shop, what it was worth.
- The walk-in's payment is part of its sale, so a walk-in is one notification, not two.
- Raised after the commit through `NotificationsService`, so the push follows (below). A failure is logged and never
  fails the sale, payment or return. One place: `common/partner-news.ts`.
- The assistant and the office chat record through the same services, so they notify the same way.
- GUESS 2026-10-25, not asked: a tap opens the order on Sales for a sale, return or cancel, and Payments for a payment
  or reversal. The payment method is said in the reader's language (bell and push).

**Every office notification is also pushed to the reader's phone** — built
2026-10-18, after the owner's test sale took a product below its minimum, the
bell rang on the desktop and his phone (alerts on, test alert arriving) stayed
silent. Until then only the storefront's requests were ever pushed; every other
notification was only a row.

- DECIDED (as before): the row is the record, the push an attempt. It is
  written first; a push that fails, times out or finds no device loses nothing
  and never fails or rolls back what raised it. It is sent after the commit,
  never inside a transaction.
- The words are the bell's own (`renderNotification` for the stored code), and
  a tap opens the page the bell links to (`/notifications/open`, which asks the
  bell's mapping). A device the push service calls gone (404/410) is forgotten.
- Bounded: every device is tried at once, each gets 2.5 s, the whole delivery
  3 s, so a slow push service cannot hold a sale's response for longer.
- **GUESS 2026-10-18, not asked — the language.** Nothing records which language
  a partner reads (no user, session or device stores one), so a push with no
  stored language goes out in **Arabic**, the business's language — the office's
  included, and the storefront's office alerts too, which were English before.
  The office app itself still opens in English. When a tap opens the app it uses
  the language of a window already open, else the push's. If a partner wants
  English pushes, the fix is to store the language with the device when alerts
  are turned on (the page knows it then).
- GUESSED: a new alert about the same thing replaces the earlier one on the
  phone rather than stacking. The push's tag is the bell's link for it
  (`bellLink` in `common/notification-messages.ts`: the event plus the payload's
  plain string and number values), so "the same thing" is the same event with
  the same values; the storefront's request alerts set their own tags
  (`order-request-<id>` and the like).
- Push needs `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` on the API (set in
  production 2026-10-16); with either missing, push is off with a warning in the
  log and the bell still works. `VAPID_SUBJECT` defaults to a placeholder
  mailto (`push.service.ts`).

---

