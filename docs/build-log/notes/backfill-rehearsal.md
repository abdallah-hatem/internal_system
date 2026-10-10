# Delivery backfill rehearsal — 2026-10-10

Production runs `scripts/ship-prod.sh migrate` then `backfill` on data written before deliveries existed.
That path was only unit-tested, so it was rehearsed on a throwaway database:

1. The pre-B1 code (`ac393ed`) seeded the old demo level into `rehearsal`: 2 cycles, 3 batches, and no leg
   with an arrival date. That is the hard case, where deliveries are dated from the batches' receipt day.
2. The current code applied the 5 new migrations.
3. `npm run db:backfill:deliveries` gave 2 cycles, 3 deliveries, 3 batches linked and 0 absorbed losses.
4. A second run changed nothing (idempotent).
5. `DB=rehearsal scripts/check-data.sh` came back all zero.

Found on the way: the npm script's `--compiler-options {"module":"commonjs"}` lost its quotes in npm's
shell, so `db:backfill:deliveries` (and `ship-prod.sh backfill`, which calls it) crashed. Fixed in `apps/api/package.json`.
