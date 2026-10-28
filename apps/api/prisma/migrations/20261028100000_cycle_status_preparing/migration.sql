-- A Preparing cycle status (owner, 2026-10-27; BUSINESS_LOGIC §1): the supplier
-- or website prepares the confirmed order, before anything has left.
-- Additive only, safe to run before the code that uses it: one new enum value,
-- placed after PURCHASING so the database sorts statuses in the order a cycle
-- passes through them. No existing row is changed or backfilled.

-- AlterEnum
ALTER TYPE "CycleStatus" ADD VALUE 'PREPARING' AFTER 'PURCHASING';
