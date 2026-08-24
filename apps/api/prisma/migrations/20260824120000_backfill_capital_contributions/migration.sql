-- Record the capital that funded existing cycles.
--
-- The ledger recorded a cycle spending its capital but never recorded that
-- capital arriving. Netting financial_transactions gave -62,325 on a cycle
-- settled in full and owing nobody anything: the purchase went out, the money
-- that paid for it appeared nowhere, and any cash position taken from this
-- table was understated by exactly what the partners had put in.
--
-- New contributions are posted as they happen. This is for the ones already on
-- the books, and it posts the participant's CURRENT figure as a single opening
-- entry rather than trying to reconstruct a history of edits nobody kept.
--
-- Idempotent: a participant that already has a contribution entry is skipped,
-- so re-running this cannot double-count the capital.
INSERT INTO financial_transactions (
  id, type, category, direction, amount, currency,
  cycle_id, related_type, related_id, reason, created_at, created_by
)
SELECT
  gen_random_uuid(),
  'CAPITAL_CONTRIBUTION',
  'contribution',
  'INFLOW',
  cp.contribution_amount,
  'EGP',
  cp.cycle_id,
  'CYCLE_PARTICIPANT',
  cp.id,
  'Capital put into ' || c.code || ' by ' ||
    CASE WHEN cp.participant_type = 'TEMP_INVESTOR' THEN 'investor' ELSE 'partner' END
    || ' (recorded retrospectively)',
  cp.created_at,
  COALESCE(cp.partner_user_id, cp.investor_user_id)
FROM cycle_participants cp
JOIN import_cycles c ON c.id = cp.cycle_id
WHERE cp.contribution_amount > 0
  AND NOT EXISTS (
    SELECT 1 FROM financial_transactions ft
    WHERE ft.related_type = 'CYCLE_PARTICIPANT'
      AND ft.related_id = cp.id
  );
