-- L7 (BUSINESS_LOGIC §8, owner 2026-10-11): general running costs come out of
-- the core partners' payouts. One row per (cost, settlement, partner) records
-- what each payout took, so a cost is charged once in total; reversing the
-- settlement releases its rows (released_at), it never deletes them. A
-- settlement also keeps its cycle costs line by line, so a payout explains
-- itself. Additive only: nothing that exists changes.
-- Generated with `prisma migrate diff --from-schema-datamodel` (no database).

-- AlterTable
ALTER TABLE "settlements" ADD COLUMN     "cost_breakdown" JSONB;

-- CreateTable
CREATE TABLE "running_cost_charges" (
    "id" UUID NOT NULL,
    "cost_entry_id" UUID NOT NULL,
    "settlement_id" UUID NOT NULL,
    "participant_id" UUID NOT NULL,
    "partner_user_id" UUID NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMPTZ,

    CONSTRAINT "running_cost_charges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "running_cost_charges_partner_user_id_idx" ON "running_cost_charges"("partner_user_id");

-- CreateIndex
CREATE INDEX "running_cost_charges_settlement_id_idx" ON "running_cost_charges"("settlement_id");

-- CreateIndex
CREATE UNIQUE INDEX "running_cost_charges_cost_entry_id_settlement_id_partner_us_key" ON "running_cost_charges"("cost_entry_id", "settlement_id", "partner_user_id");

-- AddForeignKey
ALTER TABLE "running_cost_charges" ADD CONSTRAINT "running_cost_charges_cost_entry_id_fkey" FOREIGN KEY ("cost_entry_id") REFERENCES "financial_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "running_cost_charges" ADD CONSTRAINT "running_cost_charges_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "running_cost_charges" ADD CONSTRAINT "running_cost_charges_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "cycle_participants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "running_cost_charges" ADD CONSTRAINT "running_cost_charges_partner_user_id_fkey" FOREIGN KEY ("partner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

