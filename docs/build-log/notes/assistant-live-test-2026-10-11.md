# Live assistant test — 2026-10-11 (production, previews only, nothing confirmed)

Claude (this session, through the owner's internal-system connector after a reconnect) read real images and spoke
sales, the way the owner will from the phone.

| Input | Result | Verdict |
|---|---|---|
| Supplier invoice image (`apps/api/src/modules/assistant/receipt/fixtures/guangzhou-invoice.png`) | Totals checked (1,450 = stated); freight 35 kept off the lines and asked about; FX 50.86 offered; new supplier → country asked; no open cycle → China/UAE asked; "Honda CBR brake pads (front)" → "close to Honda CBR Brake Pad — that product or new?"; "Full face helmet, matt black, size L" → asked, not auto-matched; chain kit → new | Pass (before W3 both matches were wrong) |
| "Sold 25 helmets at 2,400 to a walk-in" | "helmets" → asks which product (Full Face Helmet offered); then preview 25 × 2,400 = 60,000 EGP, 128 in stock, B2C, PAID by cash, nothing owed | Pass |
| "Sold 3 brake pads to El-Sayed" (no price) | "El-Sayed" → asks which customer; preview at trade list price 320 flagged "confirm or give the price", 960 owed, no payment | Pass |
| Delivery note image (15 of 40 helmets, 25 to follow) | Not runnable in production: no cycle is in transit there, so there is nothing a delivery can be recorded against. `record_delivery` is present after the reconnect; covered by e2e 81/83 on local data | Not testable live yet |

Note: a connector keeps the tool list from when it connected. After a deploy that adds tools, the owner toggles the
connector off and on (Settings → connectors) to see them.
