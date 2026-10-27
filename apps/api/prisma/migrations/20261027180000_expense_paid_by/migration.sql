-- "Paid by" on an expense (BUSINESS_LOGIC §9, owner 2026-10-26/27).
-- Additive only: one enum value, one nullable column on the ledger, one
-- nullable unique column on the partners' account movements.
--
-- An expense a partner paid from his own pocket is booked as the same expense
-- (operating expense, a cycle's cost or a running cost), names him in
-- paid_by_user_id — so no business cash moved — and credits his running
-- account with an EXPENSE_PAID movement pointing back at it.

ALTER TYPE "PartnerAccountMovementKind" ADD VALUE 'EXPENSE_PAID';

ALTER TABLE "financial_transactions" ADD COLUMN "paid_by_user_id" UUID;
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_paid_by_user_id_fkey" FOREIGN KEY ("paid_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "partner_account_movements" ADD COLUMN "expense_entry_id" UUID;
CREATE UNIQUE INDEX "partner_account_movements_expense_entry_id_key" ON "partner_account_movements"("expense_entry_id");
ALTER TABLE "partner_account_movements" ADD CONSTRAINT "partner_account_movements_expense_entry_id_fkey" FOREIGN KEY ("expense_entry_id") REFERENCES "financial_transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
