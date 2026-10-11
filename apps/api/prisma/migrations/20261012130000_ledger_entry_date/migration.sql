-- L6 (BUSINESS_LOGIC §9, 2026-10-11): a manual ledger entry carries the day
-- the money moved, and what was paid when it was not pounds. All nullable:
-- rows written before this, and rows a flow writes, keep reading created_at.
-- Generated with `prisma migrate diff --from-schema-datamodel` (no database).

-- AlterTable
ALTER TABLE "financial_transactions" ADD COLUMN     "occurred_on" DATE,
ADD COLUMN     "original_amount" DECIMAL(18,2),
ADD COLUMN     "original_currency" TEXT;
