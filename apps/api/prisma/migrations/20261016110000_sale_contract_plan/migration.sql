-- A payment plan agreed from a sale's Contract button names that sale
-- (BUSINESS_LOGIC §7, 2026-10-16). Additive: every existing plan keeps NULL.
ALTER TABLE "payment_plans" ADD COLUMN "sale_order_id" UUID;

-- One plan per sale.
CREATE UNIQUE INDEX "payment_plans_sale_order_id_key" ON "payment_plans"("sale_order_id");

ALTER TABLE "payment_plans" ADD CONSTRAINT "payment_plans_sale_order_id_fkey" FOREIGN KEY ("sale_order_id") REFERENCES "sale_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
