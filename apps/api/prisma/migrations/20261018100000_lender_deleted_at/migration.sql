-- A lender can be deleted once nothing he paid still stands (owner, 2026-10-18).
-- Additive only: a nullable column, safe to run before the code that uses it.
-- Deleting hides him; the row stays so a removed payment's history still names him.
ALTER TABLE "lenders" ADD COLUMN "deleted_at" TIMESTAMPTZ;
