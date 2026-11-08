-- Profit taken before a cycle is settled (BUSINESS_LOGIC §8, owner 2026-11-08).
-- Additive only: one enum, one table. Nothing existing changes.
--
-- A core partner takes part of his share of a cycle's profit in cash: a ledger
-- OUTFLOW (`profit_draw`, not an expense) takes it out of cash, the cycle's
-- profit is unchanged, and the settlement takes it off his payout. If his
-- payout comes to less than he took, what is left over is a CARRIED row,
-- taken off his next payout on any cycle.

-- CreateEnum
CREATE TYPE "ProfitDrawKind" AS ENUM ('DRAW', 'CARRIED');

-- CreateTable
CREATE TABLE "profit_draws" (
    "id" UUID NOT NULL,
    "kind" "ProfitDrawKind" NOT NULL DEFAULT 'DRAW',
    "cycle_id" UUID,
    "partner_user_id" UUID NOT NULL,
    "amount_egp" DECIMAL(18,2) NOT NULL,
    "drawn_on" DATE NOT NULL,
    "note" TEXT,
    "ledger_entry_id" UUID,
    "settled_by_id" UUID,
    "carried_from_settlement_id" UUID,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversed_at" TIMESTAMPTZ,
    "reversed_by" UUID,
    "reversal_reason" TEXT,

    CONSTRAINT "profit_draws_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "profit_draws_ledger_entry_id_key" ON "profit_draws"("ledger_entry_id");

-- CreateIndex
CREATE INDEX "profit_draws_cycle_id_idx" ON "profit_draws"("cycle_id");

-- CreateIndex
CREATE INDEX "profit_draws_partner_user_id_idx" ON "profit_draws"("partner_user_id");

-- AddForeignKey
ALTER TABLE "profit_draws" ADD CONSTRAINT "profit_draws_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "import_cycles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profit_draws" ADD CONSTRAINT "profit_draws_partner_user_id_fkey" FOREIGN KEY ("partner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profit_draws" ADD CONSTRAINT "profit_draws_ledger_entry_id_fkey" FOREIGN KEY ("ledger_entry_id") REFERENCES "financial_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profit_draws" ADD CONSTRAINT "profit_draws_settled_by_id_fkey" FOREIGN KEY ("settled_by_id") REFERENCES "settlements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profit_draws" ADD CONSTRAINT "profit_draws_carried_from_settlement_id_fkey" FOREIGN KEY ("carried_from_settlement_id") REFERENCES "settlements"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- The rules the rows must keep, whatever writes them.
ALTER TABLE "profit_draws" ADD CONSTRAINT "profit_draws_amount_positive" CHECK ("amount_egp" > 0);
ALTER TABLE "profit_draws" ADD CONSTRAINT "profit_draws_kind_shape" CHECK (
  ("kind" = 'DRAW' AND "cycle_id" IS NOT NULL AND "carried_from_settlement_id" IS NULL)
  OR ("kind" = 'CARRIED' AND "cycle_id" IS NULL AND "carried_from_settlement_id" IS NOT NULL AND "ledger_entry_id" IS NULL)
);
