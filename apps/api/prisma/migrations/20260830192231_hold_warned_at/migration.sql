-- When the office was nudged that a hold is about to lapse.
--
-- Without it the sweeper alerts on the same request every half hour until it
-- expires — twelve identical notifications, which is how people learn to ignore
-- the bell entirely.

ALTER TABLE "order_requests" ADD COLUMN "hold_warned_at" TIMESTAMPTZ;
