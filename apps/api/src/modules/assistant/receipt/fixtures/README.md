# Receipt fixtures from real-image tests

`guangzhou-invoice.png` and `gulf-freight-delivery-note.png` were read by Claude on 2026-10-11 and sent to the live
assistant. What Claude extracted from the invoice (what `match_receipt` received):

```json
{ "supplierName": "Guangzhou Auto Parts Trading Co., Ltd", "currency": "USD", "date": "2026-10-09",
  "invoiceNumber": "GZ-24-10-0917",
  "lines": [
    { "description": "Honda CBR brake pads (front)", "quantity": 120, "unitPrice": 4.5, "sku": null },
    { "description": "Full face helmet, matt black, size L", "quantity": 30, "unitPrice": 18, "sku": "FFH-L" },
    { "description": "Chain kit 428H 132L", "quantity": 40, "unitPrice": 9.25, "sku": "CK-428-132" } ],
  "charges": [ { "kind": "shipping", "label": "Inland freight to port", "amount": 35 } ],
  "statedSubtotal": 1450, "statedTotal": 1485 }
```

Live result: totals and freight right; line 1 matched nothing (should offer "Honda CBR Brake Pad"); line 2
auto-matched "Full Face Helmet" on a weak contains-match (should ask). Task W3 fixes both and pins this fixture.
The delivery note: 15 of 40 Full Face Helmet delivered, 25 to follow (UAE → Egypt).
