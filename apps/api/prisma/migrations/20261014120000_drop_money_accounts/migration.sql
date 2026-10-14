-- Money accounts removed (owner 2026-10-14: "we don't need money accounts").
-- BUSINESS_LOGIC §9 and §18. Generated with `prisma migrate diff`; the guard
-- below is the only hand-written part.
--
-- Guard: refuse, loudly, rather than drop a link that still means something.
-- Production's two accounts were deleted before this and nothing pointed at
-- them. If a ledger row, a lender repayment or a reconciliation entry still
-- names an account, this migration stops and changes nothing: whoever runs it
-- decides what to do with that row first. An account nothing points at is
-- dropped with its table — that is the owner's decision.
DO $$
DECLARE
  ledger_rows     bigint;
  repayment_rows  bigint;
  reconciliations bigint;
BEGIN
  SELECT count(*) INTO ledger_rows FROM "financial_transactions" WHERE "account_id" IS NOT NULL;
  SELECT count(*) INTO repayment_rows FROM "lender_repayments" WHERE "account_id" IS NOT NULL;
  SELECT count(*) INTO reconciliations FROM "reconciliation_entries";
  IF ledger_rows > 0 OR repayment_rows > 0 OR reconciliations > 0 THEN
    RAISE EXCEPTION
      'drop_money_accounts refused: % ledger row(s) and % lender repayment(s) still name a money account, and % reconciliation entr(ies) exist. Nothing was changed.',
      ledger_rows, repayment_rows, reconciliations;
  END IF;
END $$;

-- DropForeignKey
ALTER TABLE "financial_transactions" DROP CONSTRAINT "financial_transactions_account_id_fkey";

-- DropForeignKey
ALTER TABLE "reconciliation_entries" DROP CONSTRAINT "reconciliation_entries_account_id_fkey";

-- DropForeignKey
ALTER TABLE "lender_repayments" DROP CONSTRAINT "lender_repayments_account_id_fkey";

-- AlterTable
ALTER TABLE "financial_transactions" DROP COLUMN "account_id";

-- AlterTable
ALTER TABLE "lender_repayments" DROP COLUMN "account_id";

-- DropTable
DROP TABLE "money_accounts";

-- DropTable
DROP TABLE "reconciliation_entries";
