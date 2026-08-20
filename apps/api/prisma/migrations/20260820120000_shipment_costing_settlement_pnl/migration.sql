-- CreateEnum
CREATE TYPE "ParticipantType" AS ENUM ('CORE_PARTNER', 'TEMP_INVESTOR');

-- CreateEnum
CREATE TYPE "ShippingCostBasis" AS ENUM ('PER_PIECE', 'PER_WEIGHT', 'FLAT');

-- AlterTable
-- participant_type was free-form text and held both 'PARTNER' and
-- 'CORE_PARTNER' for the same thing. Prisma's default plan drops and re-adds
-- the column, which would discard those values; normalise and cast in place so
-- this migration is safe against a populated database.
UPDATE "cycle_participants" SET "participant_type" = 'TEMP_INVESTOR'
  WHERE upper("participant_type") LIKE '%INVESTOR%';
UPDATE "cycle_participants" SET "participant_type" = 'CORE_PARTNER'
  WHERE "participant_type" <> 'TEMP_INVESTOR';
ALTER TABLE "cycle_participants"
  ALTER COLUMN "participant_type" TYPE "ParticipantType"
  USING "participant_type"::"ParticipantType";

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "unit_weight_kg" DECIMAL(18,3);

-- AlterTable
ALTER TABLE "settlements" ADD COLUMN     "cogs_egp" DECIMAL(18,2),
ADD COLUMN     "expenses_egp" DECIMAL(18,2),
ADD COLUMN     "gross_profit_egp" DECIMAL(18,2),
ADD COLUMN     "revenue_egp" DECIMAL(18,2),
ADD COLUMN     "units_remaining" DECIMAL(18,3),
ADD COLUMN     "units_sold" DECIMAL(18,3),
ADD COLUMN     "unsold_value_egp" DECIMAL(18,2);

-- AlterTable
ALTER TABLE "shipping_legs" ADD COLUMN     "amount_egp" DECIMAL(18,2),
ADD COLUMN     "chargeable_pieces" DECIMAL(18,3),
ADD COLUMN     "chargeable_weight_kg" DECIMAL(18,3),
ADD COLUMN     "cost_basis" "ShippingCostBasis" NOT NULL DEFAULT 'FLAT',
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'EGP',
ADD COLUMN     "fx_rate_to_egp" DECIMAL(18,4) NOT NULL DEFAULT 1,
ADD COLUMN     "provider_id" UUID,
ADD COLUMN     "rate_per_unit" DECIMAL(18,4);

-- CreateTable
CREATE TABLE "providers" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "contact_person" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "providers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cycle_participants_cycle_id_partner_user_id_key" ON "cycle_participants"("cycle_id", "partner_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "cycle_participants_cycle_id_investor_user_id_key" ON "cycle_participants"("cycle_id", "investor_user_id");

-- AddForeignKey
ALTER TABLE "shipping_legs" ADD CONSTRAINT "shipping_legs_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "providers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

