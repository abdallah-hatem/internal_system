-- Units of a batch found damaged in storage and written off (BUSINESS_LOGIC
-- §3, §8 — owner 2026-11-28). Additive: a new table, nothing existing changes.
CREATE TABLE "stock_damages" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "qty" DECIMAL(18,3) NOT NULL,
    "unit_cost_egp" DECIMAL(18,4) NOT NULL,
    "cost_egp" DECIMAL(18,2) NOT NULL,
    "damaged_on" DATE NOT NULL,
    "note" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undone_at" TIMESTAMPTZ,
    "undone_by" UUID,
    "undo_reason" TEXT,

    CONSTRAINT "stock_damages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stock_damages_batch_id_idx" ON "stock_damages"("batch_id");

-- AddForeignKey
ALTER TABLE "stock_damages" ADD CONSTRAINT "stock_damages_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "inventory_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_damages" ADD CONSTRAINT "stock_damages_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_damages" ADD CONSTRAINT "stock_damages_undone_by_fkey" FOREIGN KEY ("undone_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Whole units, more than zero (§3, GUESS 2026-11-28); undone with its reason or not at all.
ALTER TABLE "stock_damages" ADD CONSTRAINT "stock_damages_shape" CHECK (
  "qty" > 0 AND "qty" = trunc("qty") AND "cost_egp" >= 0
  AND (("undone_at" IS NULL AND "undo_reason" IS NULL)
    OR ("undone_at" IS NOT NULL AND "undo_reason" IS NOT NULL))
);
