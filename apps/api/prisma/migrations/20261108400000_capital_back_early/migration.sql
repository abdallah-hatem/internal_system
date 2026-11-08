-- Capital taken back before a cycle is settled (BUSINESS_LOGIC §8, owner
-- 2026-11-08): a third kind of row beside profit drawn and what is owed.
-- Additive: one enum value and the shape rule widened to take it.
ALTER TYPE "ProfitDrawKind" ADD VALUE 'CAPITAL';

-- Compared as text: a value added in this transaction cannot be used as the
-- enum yet.
ALTER TABLE "profit_draws" DROP CONSTRAINT "profit_draws_kind_shape";
ALTER TABLE "profit_draws" ADD CONSTRAINT "profit_draws_kind_shape" CHECK (
  ("kind"::text IN ('DRAW', 'CAPITAL') AND "cycle_id" IS NOT NULL AND "carried_from_settlement_id" IS NULL)
  OR ("kind"::text = 'CARRIED' AND "cycle_id" IS NULL AND "carried_from_settlement_id" IS NOT NULL AND "ledger_entry_id" IS NULL)
);
