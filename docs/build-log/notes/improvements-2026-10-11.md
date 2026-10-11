# Improvement survey — 2026-10-11

From a read-only pass over BUSINESS_LOGIC, the build log and the code. "Owner?" = needs his business decision first.

## Makes daily work easier
| # | Idea | Effort | Owner? |
|---|---|---|---|
| 1 | Assistant `record_payment` ("El-Sayed paid 5,000 cash"), preview then confirm | M | Yes — widens what the assistant may write (§16) |
| 2 | Assistant read tool: who owes / what is overdue, sorted by balance | S | No — **I1** |
| 3 | Printable Arabic invoice / delivery note for a sale | M | Yes — layout, what it shows |
| 4 | Customer statement (opening balance, sales, payments, running balance), print/CSV | M | No |
| 5 | Date range filter + CSV on Sales and Payments | S | No — **I1** |
| 6 | Basket launcher on every storefront catalogue page (§13 OPEN) | S | Yes, small |
| 7 | Live delivery-note test once a cycle is in transit | S | No |

## Reduces the risk of wrong money
| # | Idea | Effort | Owner? |
|---|---|---|---|
| 8 | Rotate seeded `password123` on partner accounts | S | He changes it |
| 9 | Test a backup restore; keep an off-host copy | S–M | Yes — where copies live |
| 10 | Daily cron flags overdue payments and notifies every partner (today: only on page view, only the viewer) | S | No — **I1** |
| 11 | Low-stock alert after a sale, not only after receiving (`inventory.service.ts` findLowStock) | S | No — **I1** |
| 12 | Lost-in-transit goods shown in the ledger | M | Yes — which account |
| 13 | §3 vs §12 reservations contradiction | S after decision | Yes |
| 14 | "Still open" rules: deposit before an order, selling to shops behind on payment, investor fee split | S each | Yes |
| 15 | Confirm guessed rules: investor visibility (R1), walk-in edges, matcher strictness | S | Yes |

## Housekeeping
| # | Idea | Effort | Owner? |
|---|---|---|---|
| 16 | UI audit leftovers: /shipments layout regression, Arabic phone numbers "201…+" (notes/ui-audit-2026-10-10.md) | M | No |
| 17 | System-written ledger reasons stored in English → code + params | M (migration) | No |
| 18 | Quick-create dialog ignores Escape | S | No — **I1** |
| 19 | Flaky customer-row click, TC-RP-06 / TC-VER-01 | S | No — **I1** |
| 20 | Dark theme | M | Yes — whether wanted |
| 21 | Amazon EG/UAE (§17) | L | Yes — seven questions |
