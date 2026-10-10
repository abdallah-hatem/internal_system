-- Partial arrivals (BUSINESS_LOGIC §1 §2 §3 §14, 2026-10-10).
--
-- Additive only. A leg's goods now arrive in deliveries; a unit marked lost is
-- a ShipmentLoss, not a ledger row; a batch is one receipt of one delivery
-- line, so the one-batch-per-order-line unique index goes.
--
-- The backfill (deliveries for legs already dated, batches linked to them,
-- short-received lines recorded as absorbed losses) is NOT in this file. It is
-- `prisma/backfill-shipment-deliveries.ts` (npm run db:backfill:deliveries),
-- built on the unit-tested `planShipmentBackfill`, and it is safe to run twice.
-- Run it straight after this migration, with `npm run db:check` before and after.

-- DropIndex
DROP INDEX "inventory_batches_source_po_item_id_key";

-- AlterTable
ALTER TABLE "inventory_batches" ADD COLUMN     "arrived_on" DATE,
ADD COLUMN     "source_delivery_line_id" UUID;

-- CreateTable
CREATE TABLE "shipment_deliveries" (
    "id" UUID NOT NULL,
    "leg_id" UUID NOT NULL,
    "arrived_on" DATE NOT NULL,
    "note" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_delivery_lines" (
    "id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "purchase_order_item_id" UUID NOT NULL,
    "qty" DECIMAL(18,3) NOT NULL,

    CONSTRAINT "shipment_delivery_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_losses" (
    "id" UUID NOT NULL,
    "leg_id" UUID NOT NULL,
    "purchase_order_item_id" UUID NOT NULL,
    "qty" DECIMAL(18,3) NOT NULL,
    "unit_cost_egp" DECIMAL(18,4) NOT NULL,
    "cost_egp" DECIMAL(18,2) NOT NULL,
    "reason" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_losses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shipment_deliveries_leg_id_idx" ON "shipment_deliveries"("leg_id");

-- CreateIndex
CREATE INDEX "shipment_delivery_lines_purchase_order_item_id_idx" ON "shipment_delivery_lines"("purchase_order_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_delivery_lines_delivery_id_purchase_order_item_id_key" ON "shipment_delivery_lines"("delivery_id", "purchase_order_item_id");

-- CreateIndex
CREATE INDEX "shipment_losses_leg_id_idx" ON "shipment_losses"("leg_id");

-- CreateIndex
CREATE INDEX "shipment_losses_purchase_order_item_id_idx" ON "shipment_losses"("purchase_order_item_id");

-- CreateIndex
CREATE INDEX "inventory_batches_source_po_item_id_idx" ON "inventory_batches"("source_po_item_id");

-- CreateIndex
CREATE INDEX "inventory_batches_source_delivery_line_id_idx" ON "inventory_batches"("source_delivery_line_id");

-- AddForeignKey
ALTER TABLE "shipment_deliveries" ADD CONSTRAINT "shipment_deliveries_leg_id_fkey" FOREIGN KEY ("leg_id") REFERENCES "shipping_legs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_delivery_lines" ADD CONSTRAINT "shipment_delivery_lines_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "shipment_deliveries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_delivery_lines" ADD CONSTRAINT "shipment_delivery_lines_purchase_order_item_id_fkey" FOREIGN KEY ("purchase_order_item_id") REFERENCES "purchase_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_losses" ADD CONSTRAINT "shipment_losses_leg_id_fkey" FOREIGN KEY ("leg_id") REFERENCES "shipping_legs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_losses" ADD CONSTRAINT "shipment_losses_purchase_order_item_id_fkey" FOREIGN KEY ("purchase_order_item_id") REFERENCES "purchase_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_batches" ADD CONSTRAINT "inventory_batches_source_delivery_line_id_fkey" FOREIGN KEY ("source_delivery_line_id") REFERENCES "shipment_delivery_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- A delivery or loss of nothing, or of a negative amount, is not a record the
-- business can produce. The service refuses it; the table refuses it too.
ALTER TABLE "shipment_delivery_lines" ADD CONSTRAINT "shipment_delivery_lines_qty_positive" CHECK ("qty" > 0);
ALTER TABLE "shipment_losses" ADD CONSTRAINT "shipment_losses_qty_positive" CHECK ("qty" > 0);
ALTER TABLE "shipment_losses" ADD CONSTRAINT "shipment_losses_cost_not_negative" CHECK ("cost_egp" >= 0 AND "unit_cost_egp" >= 0);
