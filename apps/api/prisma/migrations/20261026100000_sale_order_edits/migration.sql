-- Editing a confirmed order (BUSINESS_LOGIC §4, owner 2026-10-25). Additive.

-- CreateTable
CREATE TABLE "sale_order_edits" (
    "id" UUID NOT NULL,
    "sale_order_id" UUID NOT NULL,
    "edited_on" DATE NOT NULL,
    "reason" TEXT,
    "owed_before" DECIMAL(18,2) NOT NULL,
    "owed_after" DECIMAL(18,2) NOT NULL,
    "amount_egp" DECIMAL(18,2) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "sale_order_edits_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "sale_items" ADD COLUMN "edit_id" UUID;
ALTER TABLE "sale_returns" ADD COLUMN "edit_id" UUID;
ALTER TABLE "sale_price_adjustments" ADD COLUMN "edit_id" UUID;

-- CreateIndex
CREATE INDEX "sale_order_edits_sale_order_id_idx" ON "sale_order_edits"("sale_order_id");

-- CreateIndex
CREATE INDEX "sale_order_edits_edited_on_idx" ON "sale_order_edits"("edited_on");

-- AddForeignKey
ALTER TABLE "sale_order_edits" ADD CONSTRAINT "sale_order_edits_sale_order_id_fkey" FOREIGN KEY ("sale_order_id") REFERENCES "sale_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_order_edits" ADD CONSTRAINT "sale_order_edits_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_edit_id_fkey" FOREIGN KEY ("edit_id") REFERENCES "sale_order_edits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_edit_id_fkey" FOREIGN KEY ("edit_id") REFERENCES "sale_order_edits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_price_adjustments" ADD CONSTRAINT "sale_price_adjustments_edit_id_fkey" FOREIGN KEY ("edit_id") REFERENCES "sale_order_edits"("id") ON DELETE SET NULL ON UPDATE CASCADE;
