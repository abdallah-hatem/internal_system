-- Samples into the current order (owner, 2026-10-27; BUSINESS_LOGIC §4).
-- Additive only, safe to run before the code that uses it: one new order
-- status and one nullable column with its index and foreign key. Nothing
-- existing is changed or backfilled; no existing row can hold the new values.

-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'SAMPLES_BOUGHT';

-- AlterTable
ALTER TABLE "sale_items" ADD COLUMN "from_samples_order_id" UUID;

-- CreateIndex
CREATE INDEX "sale_items_from_samples_order_id_idx" ON "sale_items"("from_samples_order_id");

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_from_samples_order_id_fkey" FOREIGN KEY ("from_samples_order_id") REFERENCES "sale_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
