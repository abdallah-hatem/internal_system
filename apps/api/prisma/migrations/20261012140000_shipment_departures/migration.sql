-- Goods can leave in parts (BUSINESS_LOGIC §1, owner 2026-10-12, L8).
--
-- A leg records each departure the way it records each delivery: the day it
-- left and how many of each ordered product left on it. `shipping_legs.departed_on`
-- stays, as a reading of the first departure (written by `syncLegStatuses`).

-- CreateTable
CREATE TABLE "shipment_departures" (
    "id" UUID NOT NULL,
    "leg_id" UUID NOT NULL,
    "departed_on" DATE NOT NULL,
    "note" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shipment_departures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_departure_lines" (
    "id" UUID NOT NULL,
    "departure_id" UUID NOT NULL,
    "purchase_order_item_id" UUID NOT NULL,
    "qty" DECIMAL(18,3) NOT NULL,

    CONSTRAINT "shipment_departure_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shipment_departures_leg_id_idx" ON "shipment_departures"("leg_id");

-- CreateIndex
CREATE INDEX "shipment_departure_lines_purchase_order_item_id_idx" ON "shipment_departure_lines"("purchase_order_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_departure_lines_departure_id_purchase_order_item_i_key" ON "shipment_departure_lines"("departure_id", "purchase_order_item_id");

-- AddForeignKey
ALTER TABLE "shipment_departures" ADD CONSTRAINT "shipment_departures_leg_id_fkey" FOREIGN KEY ("leg_id") REFERENCES "shipping_legs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_departure_lines" ADD CONSTRAINT "shipment_departure_lines_departure_id_fkey" FOREIGN KEY ("departure_id") REFERENCES "shipment_departures"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_departure_lines" ADD CONSTRAINT "shipment_departure_lines_purchase_order_item_id_fkey" FOREIGN KEY ("purchase_order_item_id") REFERENCES "purchase_order_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A departure of nothing, or of a negative amount, is not a record the
-- business can produce. The service refuses it; the table refuses it too.
ALTER TABLE "shipment_departure_lines" ADD CONSTRAINT "shipment_departure_lines_qty_positive" CHECK ("qty" > 0);

-- ─── Backfill ──────────────────────────────────────────────────────────────
-- Every leg that already has a departure date and no departure row gets one
-- departure on that day (its Cairo calendar day) carrying everything that had
-- entered the leg: what was ordered, for the cycle's first leg; what the leg
-- before it delivered, for a later leg. That is what a single departure date
-- meant before (§1: "existing legs with one departure and no lines are read as
-- everything that entered it left on that day"), so every leg keeps its status,
-- its "on the way" and its deliveries' meaning. Idempotent: a leg that already
-- has a departure row is skipped. Mirrored by `planDepartureBackfill`
-- (common/departure-backfill.ts), which is unit-tested on the same cases.

CREATE TEMP TABLE "_l8_departures" AS
SELECT
  gen_random_uuid() AS "id",
  l."id" AS "leg_id",
  l."cycle_id",
  l."sequence",
  (l."departed_on" AT TIME ZONE 'Africa/Cairo')::date AS "day",
  (
    SELECT p."id" FROM "shipping_legs" p
    WHERE p."cycle_id" = l."cycle_id" AND p."sequence" < l."sequence"
    ORDER BY p."sequence" DESC
    LIMIT 1
  ) AS "previous_leg_id"
FROM "shipping_legs" l
WHERE l."departed_on" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "shipment_departures" d WHERE d."leg_id" = l."id");

INSERT INTO "shipment_departures" ("id", "leg_id", "departed_on", "note")
SELECT "id", "leg_id", "day", 'Recorded before departures were per product: everything that had entered the leg'
FROM "_l8_departures";

-- The first leg: everything ordered on the cycle.
INSERT INTO "shipment_departure_lines" ("id", "departure_id", "purchase_order_item_id", "qty")
SELECT gen_random_uuid(), d."id", i."id", i."ordered_qty"
FROM "_l8_departures" d
JOIN "purchase_orders" po ON po."cycle_id" = d."cycle_id"
JOIN "purchase_order_items" i ON i."purchase_order_id" = po."id"
WHERE d."previous_leg_id" IS NULL
  AND i."ordered_qty" > 0;

-- A later leg: what the leg before it delivered.
INSERT INTO "shipment_departure_lines" ("id", "departure_id", "purchase_order_item_id", "qty")
SELECT gen_random_uuid(), d."id", dl."purchase_order_item_id", SUM(dl."qty")
FROM "_l8_departures" d
JOIN "shipment_deliveries" sd ON sd."leg_id" = d."previous_leg_id"
JOIN "shipment_delivery_lines" dl ON dl."delivery_id" = sd."id"
WHERE d."previous_leg_id" IS NOT NULL
GROUP BY d."id", dl."purchase_order_item_id"
HAVING SUM(dl."qty") > 0;

DROP TABLE "_l8_departures";
