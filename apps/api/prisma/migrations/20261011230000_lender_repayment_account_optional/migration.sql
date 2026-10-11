-- A friend's repayment no longer asks which money account it left from
-- (BUSINESS_LOGIC §18, owner 2026-10-11). Rows that already name one keep it.
ALTER TABLE "lender_repayments" ALTER COLUMN "account_id" DROP NOT NULL;
