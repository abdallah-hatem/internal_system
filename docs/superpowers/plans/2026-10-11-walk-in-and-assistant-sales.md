# Plan — walk-in sales + assistant sales
Spec `docs/specs/2026-10-11-walk-in-and-assistant-sales.md` · BUSINESS_LOGIC §4, §16 (*Building*)

| Wave | Tasks |
|---|---|
| 1 | W1 (backend · logic) |
| 2 | W2 (web · logic) ‖ W3 (assistant · logic) |

### W1 — Walk-in sale on the server (backend · logic)
Edge cases:
- [ ] Walk-in sale of 2 at retail → one CONFIRMED order on the walk-in record, a payment of the full total allocated, stock down by 2, outstanding 0   (§4)
- [ ] Not enough stock → `NOT_ENOUGH_STOCK`; no order, no payment, no walk-in record left half-made   (§4: one step or nothing)
- [ ] `walkIn` + `customerId` → `VALIDATION_FAILED`; `walkIn` with `confirm:false` → `WALK_IN_NOT_DRAFT`   (§4)
- [ ] Two walk-in sales at once on a database without the record → exactly one walk-in customer exists afterwards   (race)
- [ ] Editing or deleting the walk-in customer → `WALK_IN_RESERVED`   (§4)
- [ ] The walk-in record never shows a balance; the customers list and pickers don't list it; revenue and the dashboard include its sales   (§4, rule 11)
- [ ] Return on a walk-in order → refunded in money; asking for credit → refused   (§4, §5)
- [ ] Repeated idempotency key → the same order, one payment   (§4)
- [ ] Discount larger than the line, or negative → refused as usual   (§7a)
- [ ] Investor or shop → refused with a code   (rule 12)
- [ ] Payment dated now, in Cairo   (§7a)

### W2 — Walk-in on the sale form (web · logic)
Cases: the switch hides the customer and shows the method; B2C prices fill in, but a typed price is kept; only "Sell & take payment"; a refusal keeps the values; double submit → one sale; RTL; 390px.

### W3 — `record_sale` for the assistant, and better product matching (assistant · logic)
Found by testing the live assistant with a real invoice image (2026-10-11): "Honda CBR brake pads (front)" matched
nothing though "Honda CBR Brake Pad" is on file (plural + extra words), and "Full face helmet, matt black, size L" was
auto-matched to "Full Face Helmet" on a weak contains-match (score 0.5) with no question — §16 says a close name is never
the same thing until the partner says so. One shared matcher (`receipt/name-matching.ts`) serves both receipts and sales:
token-based (case, plurals, punctuation, word order, extra descriptors), returning ranked candidates; only an exact or
SKU match is "matched"; anything weaker is a question with candidates.

Edge cases (matching):
- [ ] "Honda CBR brake pads (front)" → candidate "Honda CBR Brake Pad", asked (not "new", not auto-matched)   (§16)
- [ ] "Full face helmet, matt black, size L" → candidate "Full Face Helmet", asked, not auto-matched   (§16)
- [ ] An exact name, ignoring case and spacing, or a SKU → matched without a question   (§16)
- [ ] Nothing similar → LINE_NEW_OR_EXISTING with no candidates   (§16)
- [ ] The two test images' extractions (kept as fixtures in the repo) give exactly the expected questions   (regression from a real image)

Edge cases (sales):
Edge cases:
- [ ] "Sold 25 of <product> at 300 to anyone" → a walk-in preview with 25 × 300 and stock shown; confirm writes one paid order   (§16)
- [ ] A close product name → candidates, nothing written   (§16)
- [ ] An unknown customer name → a question, not a new customer   (§16)
- [ ] No price → the preview offers the list price and asks   (§16)
- [ ] More than in stock → `NOT_ENOUGH_STOCK` in the preview   (§4)
- [ ] Stock sold elsewhere between preview and confirm → `PREVIEW_CHANGED` or `NOT_ENOUGH_STOCK`; nothing written   (§16)
- [ ] Replay → `CONFIRMATION_USED`   (§16)
- [ ] A named customer → a CONFIRMED order that is owed, no payment   (§16)
- [ ] `tools/list` has `record_sale` and still no payment, return or settlement tool   (§16)
