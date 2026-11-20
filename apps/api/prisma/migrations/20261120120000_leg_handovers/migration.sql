-- UAE legs in handovers (BUSINESS_LOGIC §1, §2, §18 — owner 2026-11-20).
--
-- A leg leaving the UAE goes in lots handed to the forwarder, each with its own
-- freight, whose products are known only as each batch arrives. A handover is a
-- departure (`shipment_departures.handover`) carrying its freight, its piece
-- count when known, the forwarder, who paid and when it was all arrived; an
-- arrival is a delivery naming the handover it came from; the pieces that never
-- came are losses naming it. Freight a partner paid himself is owed to him in
-- its own currency as a lender's payment (`lender_financings.departure_id`).
--
-- Additive only: every new column is nullable or defaults to false, so every
-- existing leg, departure, delivery, loss and friend's payment reads exactly
-- as it did. No data is rewritten.

-- AlterTable
ALTER TABLE "lender_financings" ADD COLUMN     "departure_id" UUID,
ALTER COLUMN "purchase_order_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "lenders" ADD COLUMN     "partner_user_id" UUID;

-- AlterTable
ALTER TABLE "shipment_deliveries" ADD COLUMN     "departure_id" UUID;

-- AlterTable
ALTER TABLE "shipment_departures" ADD COLUMN     "all_arrived_by" UUID,
ADD COLUMN     "all_arrived_on" DATE,
ADD COLUMN     "freight_amount" DECIMAL(18,2),
ADD COLUMN     "freight_amount_egp" DECIMAL(18,2),
ADD COLUMN     "freight_currency" TEXT,
ADD COLUMN     "freight_rate_to_egp" DECIMAL(18,4),
ADD COLUMN     "handover" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "paid_by_user_id" UUID,
ADD COLUMN     "pieces" INTEGER,
ADD COLUMN     "provider_id" UUID;

-- AlterTable
ALTER TABLE "shipment_losses" ADD COLUMN     "departure_id" UUID;

-- AlterTable
ALTER TABLE "shipping_legs" ADD COLUMN     "uses_handovers" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "lender_financings_departure_id_key" ON "lender_financings"("departure_id");

-- CreateIndex
CREATE UNIQUE INDEX "lenders_partner_user_id_key" ON "lenders"("partner_user_id");

-- CreateIndex
CREATE INDEX "shipment_deliveries_departure_id_idx" ON "shipment_deliveries"("departure_id");

-- AddForeignKey
ALTER TABLE "shipment_departures" ADD CONSTRAINT "shipment_departures_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_departures" ADD CONSTRAINT "shipment_departures_paid_by_user_id_fkey" FOREIGN KEY ("paid_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_deliveries" ADD CONSTRAINT "shipment_deliveries_departure_id_fkey" FOREIGN KEY ("departure_id") REFERENCES "shipment_departures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_losses" ADD CONSTRAINT "shipment_losses_departure_id_fkey" FOREIGN KEY ("departure_id") REFERENCES "shipment_departures"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lenders" ADD CONSTRAINT "lenders_partner_user_id_fkey" FOREIGN KEY ("partner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lender_financings" ADD CONSTRAINT "lender_financings_departure_id_fkey" FOREIGN KEY ("departure_id") REFERENCES "shipment_departures"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- A friend's payment is for an order; a partner's freight is for a handover.
-- Never both. Neither only once it was removed: a handover undone lets go of
-- its removed payment so the handover row can go.
ALTER TABLE "lender_financings" ADD CONSTRAINT "lender_financings_order_or_handover"
  CHECK (
    NOT ("purchase_order_id" IS NOT NULL AND "departure_id" IS NOT NULL)
    AND ("purchase_order_id" IS NOT NULL OR "departure_id" IS NOT NULL OR "removed_at" IS NOT NULL)
  );

-- Freight and pieces as a handover has them: all freight fields together, never
-- below zero; a piece count above zero. An ordinary departure has none of them.
ALTER TABLE "shipment_departures" ADD CONSTRAINT "shipment_departures_handover_freight"
  CHECK (
    ("handover" = false AND "freight_amount" IS NULL AND "pieces" IS NULL AND "all_arrived_on" IS NULL)
    OR ("handover" = true AND "freight_amount" >= 0 AND "freight_currency" IS NOT NULL
        AND "freight_rate_to_egp" > 0 AND "freight_amount_egp" >= 0
        AND ("pieces" IS NULL OR "pieces" > 0))
  );
