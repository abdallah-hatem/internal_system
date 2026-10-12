-- L7 alignment review (BUSINESS_LOGIC §8, 2026-10-12): each running cost's
-- shares are fixed once, over the core partners active on the cost's own day,
-- and never change afterwards — a partner who leaves keeps owing his, one who
-- joins later owes nothing of it. Additive only. Running costs already in the
-- ledger get their shares the first time they are read with write access
-- (recording a cost, or Mark paid), by the same rule — no backfill here, so the
-- rule lives in one place (`common/running-costs.ts`).
-- Generated with `prisma migrate diff --from-schema-datamodel` (no database).

-- CreateTable
CREATE TABLE "running_cost_shares" (
    "id" UUID NOT NULL,
    "cost_entry_id" UUID NOT NULL,
    "partner_user_id" UUID NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "running_cost_shares_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "running_cost_shares_partner_user_id_idx" ON "running_cost_shares"("partner_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "running_cost_shares_cost_entry_id_partner_user_id_key" ON "running_cost_shares"("cost_entry_id", "partner_user_id");

-- AddForeignKey
ALTER TABLE "running_cost_shares" ADD CONSTRAINT "running_cost_shares_cost_entry_id_fkey" FOREIGN KEY ("cost_entry_id") REFERENCES "financial_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "running_cost_shares" ADD CONSTRAINT "running_cost_shares_partner_user_id_fkey" FOREIGN KEY ("partner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

