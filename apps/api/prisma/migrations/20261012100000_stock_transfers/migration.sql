-- L5 (BUSINESS_LOGIC §8, 2026-10-11): leftover stock moved to another cycle at its cost.
-- Written with prisma migrate diff from the schema, no database. Adds only; nothing
-- existing is changed or backfilled.
-- CreateEnum
CREATE TYPE "StockTransferStatus" AS ENUM ('ACTIVE', 'REVERSED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "InventoryMovementType" ADD VALUE 'TRANSFER_OUT';
ALTER TYPE "InventoryMovementType" ADD VALUE 'TRANSFER_IN';

-- AlterTable
ALTER TABLE "inventory_batches" ADD COLUMN     "transferred_from_batch_id" UUID;

-- CreateTable
CREATE TABLE "stock_transfers" (
    "id" UUID NOT NULL,
    "from_cycle_id" UUID NOT NULL,
    "to_cycle_id" UUID NOT NULL,
    "moved_on" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "StockTransferStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversed_at" TIMESTAMPTZ,
    "reversed_by" UUID,
    "reversal_reason" TEXT,

    CONSTRAINT "stock_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_transfer_lines" (
    "id" UUID NOT NULL,
    "transfer_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "source_batch_id" UUID NOT NULL,
    "dest_batch_id" UUID,
    "qty" DECIMAL(18,3) NOT NULL,
    "unit_cost_egp" DECIMAL(18,4) NOT NULL,
    "cost_egp" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "stock_transfer_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_transfers_from_cycle_id_idx" ON "stock_transfers"("from_cycle_id");

-- CreateIndex
CREATE INDEX "stock_transfers_to_cycle_id_idx" ON "stock_transfers"("to_cycle_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfer_lines_dest_batch_id_key" ON "stock_transfer_lines"("dest_batch_id");

-- CreateIndex
CREATE INDEX "stock_transfer_lines_transfer_id_idx" ON "stock_transfer_lines"("transfer_id");

-- CreateIndex
CREATE INDEX "stock_transfer_lines_source_batch_id_idx" ON "stock_transfer_lines"("source_batch_id");

-- CreateIndex
CREATE INDEX "inventory_batches_transferred_from_batch_id_idx" ON "inventory_batches"("transferred_from_batch_id");

-- AddForeignKey
ALTER TABLE "inventory_batches" ADD CONSTRAINT "inventory_batches_transferred_from_batch_id_fkey" FOREIGN KEY ("transferred_from_batch_id") REFERENCES "inventory_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_from_cycle_id_fkey" FOREIGN KEY ("from_cycle_id") REFERENCES "import_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_to_cycle_id_fkey" FOREIGN KEY ("to_cycle_id") REFERENCES "import_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_reversed_by_fkey" FOREIGN KEY ("reversed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_transfer_id_fkey" FOREIGN KEY ("transfer_id") REFERENCES "stock_transfers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_source_batch_id_fkey" FOREIGN KEY ("source_batch_id") REFERENCES "inventory_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_dest_batch_id_fkey" FOREIGN KEY ("dest_batch_id") REFERENCES "inventory_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

