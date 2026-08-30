#!/usr/bin/env bash
# Look for records the business could not have produced.
#
# Written after a cleanup found payments dated in the future, 9,300 of money
# attached to no order, and five ledger rows pointing at payments that had been
# deleted. Guards in the code stop new ones; this finds what is already there,
# including anything written before a rule existed.
#
# Every count should be zero. Run it after a data fix, after restoring a
# backup, or whenever a figure on screen looks wrong.
set -euo pipefail
DB=${DB:-motorcycle_parts}
CONTAINER=${CONTAINER:-motorcycle_parts_db}
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

# The checks, defined once. Printed as a table for a person, and summed for an
# exit code so a script can act on it — parsing the table to decide whether
# anything failed is how the reset script came to warn on every clean run.
CHECKS=$(cat <<'SQL'
SELECT 1::numeric AS ord, 'ledger points at a payment that does not exist' AS check_name,
         count(*) FROM financial_transactions f
   WHERE f.related_type='PAYMENT'
     AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.id=f.related_id)
  UNION ALL SELECT 2, 'ledger points at a sale order that does not exist',
         count(*) FROM financial_transactions f
   WHERE f.related_type='SALE_ORDER'
     AND NOT EXISTS (SELECT 1 FROM sale_orders o WHERE o.id=f.related_id)
  UNION ALL SELECT 3, 'ledger points at a cycle that does not exist',
         count(*) FROM financial_transactions f
   WHERE f.cycle_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM import_cycles c WHERE c.id=f.cycle_id)
  UNION ALL SELECT 4, 'batch points at a cycle that does not exist',
         count(*) FROM inventory_batches b
   WHERE NOT EXISTS (SELECT 1 FROM import_cycles c WHERE c.id=b.cycle_id)
  UNION ALL SELECT 5, 'movement points at a batch that does not exist',
         count(*) FROM inventory_movements m
   WHERE NOT EXISTS (SELECT 1 FROM inventory_batches b WHERE b.id=m.batch_id)
  UNION ALL SELECT 6, 'batch holds more than was ever received',
         count(*) FROM inventory_batches WHERE remaining_qty > received_qty
  UNION ALL SELECT 7, 'batch holds a negative quantity',
         count(*) FROM inventory_batches WHERE remaining_qty < 0
  UNION ALL SELECT 7.1, 'batch: sellable plus held does not equal what is there',
         count(*) FROM inventory_batches
   WHERE saleable_qty + reserved_qty <> remaining_qty
  UNION ALL SELECT 7.2, 'batch: sellable quantity is negative',
         count(*) FROM inventory_batches WHERE saleable_qty < 0
  UNION ALL SELECT 8, 'sale order worth less than nothing',
         count(*) FROM sale_orders WHERE total < 0
  UNION ALL SELECT 9, 'payment received on a date that has not arrived',
         count(*) FROM payments WHERE received_on > (now() AT TIME ZONE 'Africa/Cairo')::date
  UNION ALL SELECT 10, 'purchase order placed on a date that has not arrived',
         count(*) FROM purchase_orders WHERE ordered_on > (now() AT TIME ZONE 'Africa/Cairo')::date
  UNION ALL SELECT 11, 'payment allocated beyond its own amount',
         count(*) FROM payments p
   WHERE (SELECT coalesce(sum(a.amount),0) FROM payment_allocations a WHERE a.payment_id=p.id) > p.amount
  UNION ALL SELECT 12, 'order allocated beyond its own total',
         count(*) FROM sale_orders o
   WHERE (SELECT coalesce(sum(a.amount),0) FROM payment_allocations a WHERE a.sale_order_id=o.id) > o.total
  UNION ALL SELECT 12.1, 'money allocated to a cancelled or returned order',
         count(*) FROM payment_allocations a
    JOIN sale_orders o ON o.id = a.sale_order_id
   WHERE o.status IN ('CANCELLED', 'RETURNED')
  UNION ALL SELECT 12.2, 'cancelled order still showing a balance',
         count(*) FROM sale_orders
   WHERE status = 'CANCELLED' AND outstanding <> 0
  UNION ALL SELECT 12.3, 'stock received while a shipping leg says it has not arrived',
         count(DISTINCT b.cycle_id) FROM inventory_batches b
   WHERE EXISTS (
     SELECT 1 FROM shipping_legs l
      WHERE l.cycle_id = b.cycle_id AND l.status <> 'ARRIVED'
   )
  UNION ALL SELECT 13, 'payment attached to no order at all',
         count(*) FROM payments p
   WHERE p.status='RECORDED'
     AND NOT EXISTS (SELECT 1 FROM payment_allocations a WHERE a.payment_id=p.id)
  UNION ALL SELECT 14, 'partner capital declared but never recorded as arriving',
         count(*) FROM cycle_participants cp
   WHERE cp.contribution_amount > 0
     AND NOT EXISTS (
       SELECT 1 FROM financial_transactions f
        WHERE f.related_type='CYCLE_PARTICIPANT' AND f.related_id=cp.id
     )
  UNION ALL SELECT 14.1, 'ledger contributions disagree with the participant rows',
         count(*) FROM (
           SELECT cp.id
             FROM cycle_participants cp
             LEFT JOIN (
               SELECT related_id,
                      sum(CASE WHEN direction='INFLOW' THEN amount ELSE -amount END) AS net
                 FROM financial_transactions
                WHERE related_type='CYCLE_PARTICIPANT'
                GROUP BY related_id
             ) f ON f.related_id = cp.id
            WHERE cp.contribution_amount <> COALESCE(f.net, 0)
         ) drifted
  UNION ALL SELECT 15, 'a shop account is a participant on a cycle',
         count(*) FROM cycle_participants cp
           JOIN users u ON u.id = COALESCE(cp.partner_user_id, cp.investor_user_id)
          WHERE u.role = 'SHOP_OWNER_PORTAL'
SQL
)

# ── Images on disk ───────────────────────────────────────────────────
#
# The one check that cannot be a SQL query: file_assets rows point at files in
# apps/api/uploads, which is not in the database. Restoring a pg_dump on its own
# brings the rows back and leaves a catalogue of broken pictures — the exact
# failure that adding uploads to the backup in reset-db.sh is meant to prevent,
# and this is what notices when it has happened anyway.
UPLOADS="$ROOT/apps/api/uploads"
MISSING=0
while IFS= read -r key; do
  [ -z "$key" ] && continue
  [ -f "$UPLOADS/$key" ] || MISSING=$((MISSING + 1))
done < <(docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -t -A -v ON_ERROR_STOP=1 <<'SQL'
SELECT object_key FROM file_assets;
SQL
)

docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 <<SQL
\pset border 2
SELECT check_name, count FROM ($CHECKS) checks ORDER BY ord;
SQL

FAILING=$(docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -t -A -v ON_ERROR_STOP=1 <<SQL
SELECT coalesce(sum(count), 0) FROM ($CHECKS) checks;
SQL
)

if [ "$MISSING" -gt 0 ]; then
  echo
  echo "$MISSING image(s) recorded in the database are not on disk."
  echo "  Restore the matching .backups/*-uploads.tar.gz into apps/api/."
fi

if [ "${FAILING:-0}" -gt 0 ] || [ "$MISSING" -gt 0 ]; then
  echo
  # A count, not a record count: one bad row can break more than one rule.
  echo "$FAILING check(s) found records the business could not have produced."
  exit 1
fi
exit 0
