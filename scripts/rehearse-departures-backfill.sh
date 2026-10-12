#!/bin/bash
# Rehearse the L8 SQL backfill on a throwaway database built like production:
# the demo seed (UAE-direct cycle departed, delivered in full, received and
# sold; China cycle with both legs departed and delivered), its departures
# then removed to give the pre-L8 shape, and the migration's backfill run
# again — twice. The departures it writes must equal what the seed wrote.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="$ROOT/apps/api"
MIG=$API/prisma/migrations/20261012140000_shipment_departures/migration.sql
DB=l8_rehearsal
PSQL="docker exec -i motorcycle_parts_db psql -U postgres -v ON_ERROR_STOP=1 -q"
URL="postgresql://postgres:postgres@localhost:5432/$DB"

$PSQL -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"
cd "$API"
DATABASE_URL="$URL" npx prisma migrate deploy >/dev/null
DATABASE_URL="$URL" npx prisma db seed 2>&1 | grep -E '^(✅|🎉)' | tail -2 || true

snapshot() {
  $PSQL -d $DB -tA -c "
    SELECT c.code, l.sequence, d.departed_on, coalesce(string_agg(dl.qty::text, ',' ORDER BY dl.qty), '')
      FROM shipment_departures d
      JOIN shipping_legs l ON l.id = d.leg_id
      JOIN import_cycles c ON c.id = l.cycle_id
      LEFT JOIN shipment_departure_lines dl ON dl.departure_id = d.id
     GROUP BY c.code, l.sequence, d.id, d.departed_on
     ORDER BY 1, 2, 3"
}

echo "── departures the seed wrote:"; snapshot | tee "${TMPDIR:-/tmp}"/l8-seeded.txt
# The pre-L8 shape: dated legs, no departure rows.
$PSQL -d $DB -c "DELETE FROM shipment_departure_lines" -c "DELETE FROM shipment_departures"
BACKFILL=$(sed -n '/^-- ─── Backfill/,$p' "$MIG")
for run in 1 2; do echo "$BACKFILL" | $PSQL -d $DB >/dev/null; done
echo "── departures the backfill wrote (run twice):"; snapshot | tee "${TMPDIR:-/tmp}"/l8-backfilled.txt
if diff "${TMPDIR:-/tmp}"/l8-seeded.txt "${TMPDIR:-/tmp}"/l8-backfilled.txt; then echo "BACKFILL MATCHES THE SEED"; else echo "BACKFILL DIFFERS"; exit 1; fi

# The L8 consistency checks, on the rehearsed data: each must be zero.
$PSQL -d $DB -tA -c "
  SELECT 'legs whose date is not their first departure', count(*) FROM shipping_legs l
   WHERE (l.departed_on AT TIME ZONE 'Africa/Cairo')::date
         IS DISTINCT FROM (SELECT min(d.departed_on) FROM shipment_departures d WHERE d.leg_id = l.id);
  SELECT 'delivered more than left', count(*) FROM (
    SELECT 1 FROM shipment_deliveries d JOIN shipment_delivery_lines dl ON dl.delivery_id = d.id
     WHERE EXISTS (SELECT 1 FROM shipment_departures x WHERE x.leg_id = d.leg_id)
     GROUP BY d.leg_id, dl.purchase_order_item_id
    HAVING sum(dl.qty) > coalesce((SELECT sum(xl.qty) FROM shipment_departure_lines xl JOIN shipment_departures x ON x.id = xl.departure_id
                                    WHERE x.leg_id = d.leg_id AND xl.purchase_order_item_id = dl.purchase_order_item_id), 0)) z;"
$PSQL -d postgres -c "DROP DATABASE $DB"
