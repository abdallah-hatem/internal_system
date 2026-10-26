-- A running account per partner (BUSINESS_LOGIC §8, owner 2026-10-25).
-- Additive only: a new table, a new enum and three nullable columns on a cycle.
-- None of it is a ledger row: an advance is paid straight to a supplier, so the
-- business's cash does not move.

CREATE TYPE "PartnerAccountMovementKind" AS ENUM ('ADVANCE', 'PAYOUT_LEFT_IN', 'CONTRIBUTION', 'WITHDRAWAL');

ALTER TABLE "import_cycles"
  ADD COLUMN "funding_target_amount" DECIMAL(18,2),
  ADD COLUMN "funding_target_currency" TEXT,
  ADD COLUMN "funding_target_rate" DECIMAL(18,4);

CREATE TABLE "partner_account_movements" (
    "id" UUID NOT NULL,
    "partner_user_id" UUID NOT NULL,
    "kind" "PartnerAccountMovementKind" NOT NULL,
    "amount_egp" DECIMAL(18,2) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "fx_rate_to_egp" DECIMAL(18,4) NOT NULL DEFAULT 1,
    "occurred_on" DATE NOT NULL,
    "cycle_id" UUID,
    "participant_id" UUID,
    "settlement_id" UUID,
    "note" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversed_at" TIMESTAMPTZ,
    "reversed_by" UUID,
    "reversal_reason" TEXT,

    CONSTRAINT "partner_account_movements_pkey" PRIMARY KEY ("id"),
    -- Every movement is money: never zero, never negative (the kind gives the sign).
    CONSTRAINT "partner_account_movements_amount_positive" CHECK ("amount_egp" > 0 AND "amount" > 0)
);

CREATE INDEX "partner_account_movements_partner_user_id_idx" ON "partner_account_movements"("partner_user_id");
CREATE INDEX "partner_account_movements_cycle_id_idx" ON "partner_account_movements"("cycle_id");
CREATE INDEX "partner_account_movements_settlement_id_idx" ON "partner_account_movements"("settlement_id");

ALTER TABLE "partner_account_movements" ADD CONSTRAINT "partner_account_movements_partner_user_id_fkey" FOREIGN KEY ("partner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "partner_account_movements" ADD CONSTRAINT "partner_account_movements_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "import_cycles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "partner_account_movements" ADD CONSTRAINT "partner_account_movements_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "cycle_participants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "partner_account_movements" ADD CONSTRAINT "partner_account_movements_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "settlements"("id") ON DELETE SET NULL ON UPDATE CASCADE;
