-- Running costs shared to the selling cycles (BUSINESS_LOGIC §8, owner 2026-11-08).
-- Additive: one table. An expense with no cycle is split equally over the cycles
-- selling when it is recorded (or waits for the next one that starts selling),
-- and comes off each one's profit, so investors bear it too. The old
-- partners-only charges (running_cost_charges/_shares) stay for history.

-- CreateTable
CREATE TABLE "running_cost_allocations" (
    "id" UUID NOT NULL,
    "cost_entry_id" UUID NOT NULL,
    "cycle_id" UUID NOT NULL,
    "amount_egp" DECIMAL(18,2) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "running_cost_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "running_cost_allocations_cycle_id_idx" ON "running_cost_allocations"("cycle_id");

-- CreateIndex
CREATE UNIQUE INDEX "running_cost_allocations_cost_entry_id_cycle_id_key" ON "running_cost_allocations"("cost_entry_id", "cycle_id");

-- AddForeignKey
ALTER TABLE "running_cost_allocations" ADD CONSTRAINT "running_cost_allocations_cost_entry_id_fkey" FOREIGN KEY ("cost_entry_id") REFERENCES "financial_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "running_cost_allocations" ADD CONSTRAINT "running_cost_allocations_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "import_cycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A part is never zero or negative.

ALTER TABLE "running_cost_allocations" ADD CONSTRAINT "running_cost_allocations_amount_positive" CHECK ("amount_egp" > 0);
