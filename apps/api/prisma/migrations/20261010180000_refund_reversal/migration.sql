-- B5b: a supplier refund can be undone (§6, §9). Additive: nullable columns, so
-- every existing refund reads as not reversed.
-- AlterTable
ALTER TABLE "supplier_refunds" ADD COLUMN     "reversal_reason" TEXT,
ADD COLUMN     "reversal_transaction_id" UUID,
ADD COLUMN     "reversed_at" TIMESTAMPTZ,
ADD COLUMN     "reversed_by" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "supplier_refunds_reversal_transaction_id_key" ON "supplier_refunds"("reversal_transaction_id");

-- AddForeignKey
ALTER TABLE "supplier_refunds" ADD CONSTRAINT "supplier_refunds_reversal_transaction_id_fkey" FOREIGN KEY ("reversal_transaction_id") REFERENCES "financial_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

