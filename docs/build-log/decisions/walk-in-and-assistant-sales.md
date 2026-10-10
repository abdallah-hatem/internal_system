# Walk-in + assistant sales — decisions

- **[Owner, 2026-10-11] Walk-in sales are paid on the spot.** The owner picked "Walk-in, paid now" over "may owe" and
  "optional name/phone". A shared system-kept Walk-in record holds them, so reports still add up.
- **[Owner, 2026-10-11] The assistant records sales.** His words: test the assistant with "i sold 25 qty of a product
  with price of any to anyone". That extends §16's write scope (sales were manual-only) to create & confirm a sale,
  and walk-in sales with their payment. Named customers' payments, returns and settlements stay in the office app.
- **[Decided] A walk-in return is refunded in money** — there is no account for a credit note.
- **[Decided] No stated price → the list price for that kind of buyer, asked, not assumed.**
- **[Decided] No questions to the owner on this project.** He said "did not i say autonmous ????? shit" when I asked
  about walk-in and the test record. Recorded in project memory.
- **[Done 2026-10-11] Production test data removed** (the owner asked). The E2E-203236 trail from spec 62 (Sept 8) plus
  a stray confirmed test sale a local run's browser half made on 2026-10-10 (cancelled through the app first) is gone:
  the test shop, part, supplier, test cycle CYC-2026-0001 and everything referencing them (18 tables, one checked
  transaction). Before → after: cycles 4→3, customers 2→1, products 3→2, suppliers 3→2. Smoke 6/6. Backup of every
  deleted row: `~/.config/internal_system/backups/e2e-prod-backup-2026-10-11.json` (mode 600, not in the repo).
  Cause fixed in `ca166d5`: production specs 56/60/61/62 now run only with PRODUCTION_CHECKS=1.
