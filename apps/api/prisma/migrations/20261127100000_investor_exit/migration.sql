-- A temporary investor paid out and taken off a cycle before it settles
-- (BUSINESS_LOGIC §8, owner 2026-11-27). Additive: nullable columns on the
-- participant, frozen at exit, and a pointer from the draw rows that paid him
-- out to the participant whose exit they were.
ALTER TABLE "cycle_participants"
  ADD COLUMN "exited_on" DATE,
  ADD COLUMN "exit_capital_egp" DECIMAL(18,2),
  ADD COLUMN "exit_gross_profit_egp" DECIMAL(18,2),
  ADD COLUMN "exit_fee_egp" DECIMAL(18,2),
  ADD COLUMN "exit_profit_egp" DECIMAL(18,2),
  ADD COLUMN "exit_share_pct" DECIMAL(8,4),
  ADD COLUMN "exit_cycle_profit_egp" DECIMAL(18,2),
  ADD COLUMN "exit_paid_egp" DECIMAL(18,2),
  ADD COLUMN "exited_at" TIMESTAMPTZ,
  ADD COLUMN "exited_by" UUID;

-- All the frozen figures together, or none; only a temporary investor exits;
-- nothing negative is paid.
ALTER TABLE "cycle_participants" ADD CONSTRAINT "cycle_participants_exit_shape" CHECK (
  ("exited_on" IS NULL AND "exit_capital_egp" IS NULL AND "exit_gross_profit_egp" IS NULL
    AND "exit_fee_egp" IS NULL AND "exit_profit_egp" IS NULL AND "exit_share_pct" IS NULL
    AND "exit_cycle_profit_egp" IS NULL AND "exit_paid_egp" IS NULL AND "exited_at" IS NULL)
  OR ("exited_on" IS NOT NULL AND "exit_capital_egp" IS NOT NULL AND "exit_gross_profit_egp" IS NOT NULL
    AND "exit_fee_egp" IS NOT NULL AND "exit_profit_egp" IS NOT NULL AND "exit_share_pct" IS NOT NULL
    AND "exit_cycle_profit_egp" IS NOT NULL AND "exit_paid_egp" IS NOT NULL AND "exited_at" IS NOT NULL
    AND "participant_type" = 'TEMP_INVESTOR' AND "exit_paid_egp" >= 0)
);

ALTER TABLE "profit_draws" ADD COLUMN "exit_participant_id" UUID;
ALTER TABLE "profit_draws" ADD CONSTRAINT "profit_draws_exit_participant_id_fkey"
  FOREIGN KEY ("exit_participant_id") REFERENCES "cycle_participants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "profit_draws_exit_participant_id_idx" ON "profit_draws"("exit_participant_id");
