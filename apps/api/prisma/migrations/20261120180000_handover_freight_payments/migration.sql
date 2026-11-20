-- A handover's freight paid in parts (BUSINESS_LOGIC §2, §18 — owner 2026-11-20).
--
-- CYC-2026-0002's lot of 400 cost 8,000 AED: Mohammed Youssef paid 4,000 on
-- the day at 14.8, the other 4,000 is paid to the forwarder later at a rate
-- nobody knows yet. A handover now holds its freight in full
-- (`shipment_departures.freight_amount`, its currency) and each payment of it
-- here; what is not paid yet is counted at the Exchange rates page's rate
-- (`shipment_departures.freight_rate_to_egp`) until it is.
--
-- Additive and safe on production: a new table, a new nullable column, an
-- index made non-unique (a handover can now have two partner-paid payments,
-- each its own debt). The backfill gives every existing handover one payment
-- of exactly its freight, rate, payer and day, so every handover reads fully
-- paid and every leg's cost stays to the piastre what it was.

-- DropIndex
DROP INDEX "lender_financings_departure_id_key";

-- AlterTable
ALTER TABLE "lender_financings" ADD COLUMN     "freight_payment_id" UUID;

-- CreateTable
CREATE TABLE "handover_freight_payments" (
    "id" UUID NOT NULL,
    "departure_id" UUID NOT NULL,
    "paid_on" DATE NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "rate_to_egp" DECIMAL(18,4) NOT NULL,
    "amount_egp" DECIMAL(18,2) NOT NULL,
    "paid_by_user_id" UUID,
    "note" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "handover_freight_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "handover_freight_payments_departure_id_idx" ON "handover_freight_payments"("departure_id");

-- CreateIndex
CREATE UNIQUE INDEX "lender_financings_freight_payment_id_key" ON "lender_financings"("freight_payment_id");

-- CreateIndex
CREATE INDEX "lender_financings_departure_id_idx" ON "lender_financings"("departure_id");

-- AddForeignKey
ALTER TABLE "handover_freight_payments" ADD CONSTRAINT "handover_freight_payments_departure_id_fkey" FOREIGN KEY ("departure_id") REFERENCES "shipment_departures"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handover_freight_payments" ADD CONSTRAINT "handover_freight_payments_paid_by_user_id_fkey" FOREIGN KEY ("paid_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lender_financings" ADD CONSTRAINT "lender_financings_freight_payment_id_fkey" FOREIGN KEY ("freight_payment_id") REFERENCES "handover_freight_payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A payment is money that moved: above zero, at a rate above zero.
ALTER TABLE "handover_freight_payments" ADD CONSTRAINT "handover_freight_payments_amounts"
  CHECK ("amount" > 0 AND "rate_to_egp" > 0 AND "amount_egp" >= 0);

-- Backfill: one payment per handover = its freight as stored, on its day, by
-- whoever it said paid it. A free lot (freight 0) paid nothing and gets none.
-- Written to be harmless if run twice: a handover that has a payment is left.
INSERT INTO "handover_freight_payments"
  ("id", "departure_id", "paid_on", "amount", "rate_to_egp", "amount_egp",
   "paid_by_user_id", "created_by", "created_at")
SELECT gen_random_uuid(), d."id", d."departed_on", d."freight_amount",
       d."freight_rate_to_egp", d."freight_amount_egp", d."paid_by_user_id",
       d."created_by", d."created_at"
FROM "shipment_departures" d
WHERE d."handover" = true AND d."freight_amount" > 0
  AND NOT EXISTS (
    SELECT 1 FROM "handover_freight_payments" x WHERE x."departure_id" = d."id"
  );

-- A partner's standing debt for a handover is now the debt of its one payment.
UPDATE "lender_financings" f
SET "freight_payment_id" = p."id"
FROM "handover_freight_payments" p
WHERE f."departure_id" = p."departure_id" AND f."removed_at" IS NULL
  AND f."freight_payment_id" IS NULL;
