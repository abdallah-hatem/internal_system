-- CreateTable
CREATE TABLE "sale_price_adjustments" (
    "id" UUID NOT NULL,
    "sale_order_id" UUID NOT NULL,
    "sale_item_id" UUID NOT NULL,
    "adjusted_on" DATE NOT NULL,
    "previous_unit_price" DECIMAL(18,4) NOT NULL,
    "new_unit_price" DECIMAL(18,2) NOT NULL,
    "qty" DECIMAL(18,3) NOT NULL,
    "amount_egp" DECIMAL(18,2) NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "sale_price_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_price_adjustment_items" (
    "id" UUID NOT NULL,
    "adjustment_id" UUID NOT NULL,
    "inventory_batch_id" UUID NOT NULL,
    "qty" DECIMAL(18,3) NOT NULL,
    "amount_egp" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "sale_price_adjustment_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sale_price_adjustments_sale_order_id_idx" ON "sale_price_adjustments"("sale_order_id");

-- CreateIndex
CREATE INDEX "sale_price_adjustments_adjusted_on_idx" ON "sale_price_adjustments"("adjusted_on");

-- CreateIndex
CREATE INDEX "sale_price_adjustment_items_inventory_batch_id_idx" ON "sale_price_adjustment_items"("inventory_batch_id");

-- AddForeignKey
ALTER TABLE "sale_price_adjustments" ADD CONSTRAINT "sale_price_adjustments_sale_order_id_fkey" FOREIGN KEY ("sale_order_id") REFERENCES "sale_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_price_adjustments" ADD CONSTRAINT "sale_price_adjustments_sale_item_id_fkey" FOREIGN KEY ("sale_item_id") REFERENCES "sale_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_price_adjustments" ADD CONSTRAINT "sale_price_adjustments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_price_adjustment_items" ADD CONSTRAINT "sale_price_adjustment_items_adjustment_id_fkey" FOREIGN KEY ("adjustment_id") REFERENCES "sale_price_adjustments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_price_adjustment_items" ADD CONSTRAINT "sale_price_adjustment_items_inventory_batch_id_fkey" FOREIGN KEY ("inventory_batch_id") REFERENCES "inventory_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

