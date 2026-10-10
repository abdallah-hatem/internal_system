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
  -- 12.3 used to be "stock received while a leg says it has not arrived". A
  -- shipment arrives in deliveries now (2026-10-10, §1), so a leg that is
  -- partly arrived and has stock received from its first delivery is the
  -- normal case, and the old check fired on every one. These four ask what
  -- deliveries and losses cannot do instead.
  --
  -- What a leg can deliver or lose is what entered it: the order, for the
  -- first leg; what the leg before it delivered, for a later one.
  UNION ALL SELECT 12.3, 'a leg delivered or lost more of a product than entered it',
         count(*) FROM (
           WITH legs AS (
             SELECT l.id, l.cycle_id,
                    lag(l.id) OVER (PARTITION BY l.cycle_id ORDER BY l.sequence) AS prev_id
               FROM shipping_legs l
           ), moved AS (
             SELECT d.leg_id, dl.purchase_order_item_id AS item_id, dl.qty, 0::numeric AS lost
               FROM shipment_delivery_lines dl JOIN shipment_deliveries d ON d.id = dl.delivery_id
             UNION ALL
             SELECT x.leg_id, x.purchase_order_item_id, 0, x.qty FROM shipment_losses x
           ), per_leg AS (
             SELECT leg_id, item_id, sum(qty) AS delivered, sum(lost) AS lost
               FROM moved GROUP BY leg_id, item_id
           )
           SELECT 1 FROM per_leg p
             JOIN legs g ON g.id = p.leg_id
             JOIN purchase_order_items poi ON poi.id = p.item_id
            WHERE p.delivered + p.lost > CASE
                    WHEN g.prev_id IS NULL THEN poi.ordered_qty
                    ELSE coalesce((SELECT q.delivered FROM per_leg q
                                    WHERE q.leg_id = g.prev_id AND q.item_id = p.item_id), 0)
                  END
         ) over_delivered
  -- Every unit ordered ends up in stock or lost, once. More than that is a
  -- unit counted twice — in a batch and as a loss, or as losses on two legs.
  UNION ALL SELECT 12.4, 'order line: received plus lost is more than was ordered',
         count(*) FROM purchase_order_items poi
   WHERE coalesce((SELECT sum(b.received_qty) FROM inventory_batches b
                    WHERE b.source_po_item_id = poi.id), 0)
       + coalesce((SELECT sum(x.qty) FROM shipment_losses x
                    WHERE x.purchase_order_item_id = poi.id), 0)
       > poi.ordered_qty
  -- A loss is valued when it is marked (§2) and never re-priced; its cost
  -- must be its quantity at the unit cost it was marked at.
  UNION ALL SELECT 12.5, 'a loss whose cost is not its quantity times its unit cost',
         count(*) FROM shipment_losses
   WHERE cost_egp <> round(qty * unit_cost_egp, 2)
  -- Stock on a shipped cycle exists only by being received from a delivery
  -- (§3). The backfill links every older batch; a batch without one was
  -- received some other way.
  UNION ALL SELECT 12.6, 'a batch on a cycle with legs that came from no delivery',
         count(*) FROM inventory_batches b
   WHERE b.source_delivery_line_id IS NULL
     AND EXISTS (SELECT 1 FROM shipping_legs l WHERE l.cycle_id = b.cycle_id)
  UNION ALL SELECT 13, 'payment attached to no order at all',
         count(*) FROM payments p
   WHERE p.status='RECORDED'
     AND NOT EXISTS (SELECT 1 FROM payment_allocations a WHERE a.payment_id=p.id)
  -- The other direction of 13: money on an order that no payment put there.
  -- The demo seed wrote orders as PAID and PARTIALLY_PAID with no payment at
  -- all, so the order said 45,000 had come in while Payments was empty and
  -- Collected read 0.00. What an order has been paid (total less outstanding)
  -- must equal what live payments have allocated to it; a reversed payment
  -- gives its allocation back to outstanding, so it is left out. An order with
  -- a credit-note return is skipped: the credit lowers outstanding with no
  -- allocation, clamped at zero, so its paid figure cannot be rebuilt here.
  UNION ALL SELECT 13.1, 'order shows money paid that no payment allocated to it',
         count(*) FROM sale_orders o
   WHERE o.status NOT IN ('DRAFT', 'CANCELLED')
     AND NOT EXISTS (
       SELECT 1 FROM sale_returns r
        WHERE r.sale_order_id = o.id AND r.refund_method = 'CREDIT_NOTE'
     )
     AND o.total - o.outstanding <> (
       SELECT coalesce(sum(a.amount), 0) FROM payment_allocations a
         JOIN payments p ON p.id = a.payment_id
        WHERE a.sale_order_id = o.id AND p.status <> 'REVERSED'
     )
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
