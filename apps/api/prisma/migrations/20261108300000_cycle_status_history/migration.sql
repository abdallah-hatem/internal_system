-- When each cycle's status changed (BUSINESS_LOGIC §8, owner 2026-11-08: a
-- running cost goes "by day its dated, we need to know when statuses moved").
-- Additive: one table, one trigger, and the past filled in from the audit log.
--
-- The trigger writes a row when a cycle is created and whenever its status
-- changes, whatever path changed it (a transition, a settlement approved, paid
-- or reversed, a departure undone, a seed or a one-off script), so the history
-- cannot miss one. clock_timestamp(), not now(): a receipt walks a cycle
-- through two statuses in one transaction, and they must keep their order.

-- CreateTable
CREATE TABLE "cycle_status_changes" (
    "id" UUID NOT NULL,
    "cycle_id" UUID NOT NULL,
    "from_status" "CycleStatus",
    "to_status" "CycleStatus" NOT NULL,
    "changed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cycle_status_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cycle_status_changes_cycle_id_changed_at_idx" ON "cycle_status_changes"("cycle_id", "changed_at");

-- AddForeignKey
ALTER TABLE "cycle_status_changes" ADD CONSTRAINT "cycle_status_changes_cycle_id_fkey" FOREIGN KEY ("cycle_id") REFERENCES "import_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Rows the trigger writes need an id of their own.
ALTER TABLE "cycle_status_changes" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();

-- ─── The past, from the audit log ──────────────────────────────────────────
-- Status changes the office made (TRANSITION, before → after), and the ones a
-- settlement made: approved → Settlement, paid → Closed, reversed → Selling.
CREATE TEMP TABLE _cycle_events AS
SELECT a.entity_id AS cycle_id,
       a.before_json ->> 'status' AS from_s,
       a.after_json ->> 'status' AS to_s,
       a.occurred_at AS at
  FROM audit_logs a
 WHERE a.action = 'TRANSITION' AND a.entity_type = 'ImportCycle'
UNION ALL
SELECT s.cycle_id,
       NULL,
       CASE a.action WHEN 'APPROVE' THEN 'SETTLEMENT' WHEN 'PAY' THEN 'CLOSED' ELSE 'SELLING' END,
       a.occurred_at
  FROM audit_logs a
  JOIN settlements s ON s.id = a.entity_id
 WHERE a.entity_type = 'Settlement' AND a.action IN ('APPROVE', 'PAY', 'REVERSE');

-- Only real statuses of real cycles.
DELETE FROM _cycle_events e
 WHERE NOT EXISTS (SELECT 1 FROM import_cycles c WHERE c.id = e.cycle_id)
    OR e.to_s IS NULL
    OR e.to_s NOT IN (SELECT unnest(enum_range(NULL::"CycleStatus"))::text)
    OR (e.from_s IS NOT NULL AND e.from_s NOT IN (SELECT unnest(enum_range(NULL::"CycleStatus"))::text));

-- Created: in the status its first recorded change left from, else the one it
-- has now (nothing was recorded, so it has had only that one).
INSERT INTO cycle_status_changes (cycle_id, from_status, to_status, changed_at)
SELECT c.id, NULL,
       COALESCE(
         (SELECT e.from_s FROM _cycle_events e
           WHERE e.cycle_id = c.id ORDER BY e.at ASC LIMIT 1),
         c.status::text
       )::"CycleStatus",
       c.created_at
  FROM import_cycles c;

-- Each recorded change, from whatever it was in before.
INSERT INTO cycle_status_changes (cycle_id, from_status, to_status, changed_at)
SELECT e.cycle_id,
       COALESCE(
         LAG(e.to_s) OVER (PARTITION BY e.cycle_id ORDER BY e.at),
         (SELECT h.to_status::text FROM cycle_status_changes h
           WHERE h.cycle_id = e.cycle_id AND h.from_status IS NULL
           ORDER BY h.changed_at ASC, h.id ASC LIMIT 1)
       )::"CycleStatus",
       e.to_s::"CycleStatus",
       e.at
  FROM _cycle_events e;

-- Where the record and the cycle disagree (a change nothing audited), the
-- status it has now, from its last update.
INSERT INTO cycle_status_changes (cycle_id, from_status, to_status, changed_at)
SELECT c.id, last.to_status, c.status, GREATEST(c.updated_at, last.changed_at)
  FROM import_cycles c
  JOIN LATERAL (
    SELECT h.to_status, h.changed_at FROM cycle_status_changes h
     WHERE h.cycle_id = c.id ORDER BY h.changed_at DESC LIMIT 1
  ) last ON TRUE
 WHERE last.to_status <> c.status;

DROP TABLE _cycle_events;

-- ─── From now on, the database keeps it ────────────────────────────────────
CREATE FUNCTION record_cycle_status_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO cycle_status_changes (cycle_id, from_status, to_status, changed_at)
    VALUES (NEW.id, NULL, NEW.status, LEAST(NEW.created_at, clock_timestamp()));
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO cycle_status_changes (cycle_id, from_status, to_status, changed_at)
    VALUES (NEW.id, OLD.status, NEW.status, clock_timestamp());
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER import_cycles_status_history
AFTER INSERT OR UPDATE OF status ON import_cycles
FOR EACH ROW EXECUTE FUNCTION record_cycle_status_change();
