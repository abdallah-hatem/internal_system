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

docker exec -i "$CONTAINER" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 <<'SQL'
\pset border 2
SELECT check_name, count FROM (
  SELECT 1 AS ord, 'ledger points at a payment that does not exist' AS check_name,
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
  UNION ALL SELECT 8, 'sale order worth less than nothing',
         count(*) FROM sale_orders WHERE total < 0
  UNION ALL SELECT 9, 'payment received on a date that has not arrived',
         count(*) FROM payments WHERE received_on > current_date
  UNION ALL SELECT 10, 'purchase order placed on a date that has not arrived',
         count(*) FROM purchase_orders WHERE ordered_on > current_date
  UNION ALL SELECT 11, 'payment allocated beyond its own amount',
         count(*) FROM payments p
   WHERE (SELECT coalesce(sum(a.amount),0) FROM payment_allocations a WHERE a.payment_id=p.id) > p.amount
  UNION ALL SELECT 12, 'order allocated beyond its own total',
         count(*) FROM sale_orders o
   WHERE (SELECT coalesce(sum(a.amount),0) FROM payment_allocations a WHERE a.sale_order_id=o.id) > o.total
  UNION ALL SELECT 13, 'payment attached to no order at all',
         count(*) FROM payments p
   WHERE p.status='RECORDED'
     AND NOT EXISTS (SELECT 1 FROM payment_allocations a WHERE a.payment_id=p.id)
) checks ORDER BY ord;
SQL
