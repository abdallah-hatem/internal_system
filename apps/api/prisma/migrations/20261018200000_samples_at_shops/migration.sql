-- Samples left at shops (owner, 2026-10-18; BUSINESS_LOGIC §4 "Samples at shops").
-- Additive only, safe to run before the code that uses it: three new order
-- statuses, two new stock movement types and three nullable columns. Nothing
-- existing is changed or backfilled; no existing row can hold the new values.

-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'SAMPLES';
ALTER TYPE "OrderStatus" ADD VALUE 'SAMPLES_RETURNED';
ALTER TYPE "OrderStatus" ADD VALUE 'SAMPLES_WRITTEN_OFF';

-- AlterEnum
ALTER TYPE "InventoryMovementType" ADD VALUE 'SAMPLE_OUT';
ALTER TYPE "InventoryMovementType" ADD VALUE 'SAMPLE_BACK';

-- AlterTable
ALTER TABLE "sale_orders" ADD COLUMN "samples_left_at" TIMESTAMPTZ,
ADD COLUMN "samples_decided_at" TIMESTAMPTZ,
ADD COLUMN "samples_reminded_at" TIMESTAMPTZ;
