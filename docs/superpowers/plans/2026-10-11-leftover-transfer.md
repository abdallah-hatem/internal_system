# L5 — leftover transfer: plan

> Done: L5 shipped 2026-10-12; BUSINESS_LOGIC §8 is the current authority.

Spec: `docs/superpowers/specs/2026-10-11-leftover-transfer.md`. Rules: BUSINESS_LOGIC §8 (2026-10-11).

## Phase 1 — no database, no servers (this run)

1. **Schema + migration** — `StockTransfer`, `StockTransferLine`, `StockTransferStatus`, movement types
   `TRANSFER_OUT`/`TRANSFER_IN`, `InventoryBatch.transferredFromBatchId`. Migration written with
   `prisma migrate diff --from-schema-datamodel <old> --to-schema-datamodel <new> --script`; checked with
   `prisma validate` and `prisma format`.
2. **One definition each** (CLAUDE.md §11)
   - `common/ledger-categories.ts`: `cycle_transfer` in `CAPITALISED_CATEGORIES`; `NOT_CASH_CATEGORIES`;
     `transferNetEgp` (signed, for analytics' investment).
   - `common/stock-transfers.ts`: status sets, `sourceRefusal`, `targetRefusal`, `planTransferLines`,
     `undoRefusal`, `cycleTransfersInEgp`, `toFundEgp`.
   - `common/cash-position.ts`: cash in / out / on hand, excluding `NOT_CASH_CATEGORIES`.
   - `common/shipment-accounted.ts`: `shipmentUnaccounted` (the figures), `assertShipmentAccounted` uses it.
   - `common/unsold-stock.ts`: a cycle's units remaining and unsold value — read by `project()`, `markPaid` and
     the settlement-snapshot refresh.
3. **Service + controller** — `modules/stock-transfers`: `GET /cycles/:id/transfers`,
   `GET /cycles/:id/transfers/movable`, `POST /cycles/:id/transfers`, `POST /stock-transfers/:id/undo`.
   Core partners write; reads scoped like the cycle.
4. **Callers** — `CostingService.fundingFor` (+ transferred in; `transferredInEgp` on the landed-cost totals),
   `SettlementsService.project/markPaid`, `AnalyticsService` (cash, investment), `CyclesService.findById`
   (transfers in/out), cancel guard, `DATE_FIELDS.STOCK_MOVED`.
5. **Web** — `goods-location.ts` (moved bucket, from-other-cycles), `goods-location-cards.tsx`,
   `MoveLeftoversDialog`, `CycleTransfers` section, settlements prompt fix button, wizard return link,
   permissions (`stockTransfer.create`, `stockTransfer.undo`), en + ar.
6. **Tests** — jest (pure + in-memory fake), Vitest (dialog, refusal fix, goods-location). Each seen failing first.
7. **Docs** — BUSINESS_LOGIC §8 guesses, §9 ledger, §16 planned, check-data 20.x.
8. lint, typecheck, jest `--forceExit` (DB-free suites), web unit. Commit.

## Phase 2 — when the database is free

- Apply the migration (`prisma migrate deploy` on the local DB, with no Playwright run in flight).
- Playwright `tests/9x-leftover-transfer.spec.ts`, reaching every screen through the menu: move from A's page;
  the unsold-stock refusal's fix on Settlements, then pay closes with no prompt; Transfers on both pages; undo;
  undo refused after a sale in B; investor sees and cannot act; RTL.
- `34-business-invariants`: moved units' cost leaves A and lands on B exactly; cash on hand unchanged; dashboard
  profit unchanged; preview = approve = partners page = analytics for A and B.
- `41-error-messages` covers the new codes.
- `scripts/check-data.sh` 20.x zero after the run.
- Screenshots: A's dialog, Transfers on A and B, goods cards with both new buckets, the settlement fix — light/dark,
  LTR/RTL, phone.
