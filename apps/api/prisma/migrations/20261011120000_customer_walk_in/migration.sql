-- The shared walk-in record (BUSINESS_LOGIC §4, 2026-10-11). Additive: every
-- existing customer is a real one, so the column defaults to false.
--
-- Written with `prisma migrate diff`, plus the partial unique index by hand:
-- Prisma's schema cannot say "unique where true", and without the index two
-- first walk-in sales arriving together would each create a walk-in record.
-- `walkInCustomer` inserts with ON CONFLICT DO NOTHING against this index.
--
-- A future `migrate diff` will offer to DROP this index because the schema does
-- not describe it. Delete that line from the generated SQL.

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "is_walk_in" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "customers_one_walk_in" ON "customers"("is_walk_in") WHERE "is_walk_in";
