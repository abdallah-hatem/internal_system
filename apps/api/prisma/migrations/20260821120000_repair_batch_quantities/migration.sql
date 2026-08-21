-- Repair batch quantities left inconsistent by the old sale behaviour.
--
-- Confirming a sale used to move saleable -> reserved without reducing
-- remaining_qty, and nothing ever released the reservation. So remaining_qty
-- still counted goods that had left, inflating inventory value and the
-- unsold-stock figure a cycle is closed on, and a returned unit could push a
-- batch above the quantity that ever arrived.
--
-- Rebuild the three quantities from the movements that actually happened:
--   remaining = received - sold + returned
--   saleable  = remaining        (nothing holds a reservation today)
--   reserved  = 0
WITH sold AS (
  SELECT b.id AS batch_id, COALESCE(SUM(a.qty), 0) AS qty
  FROM inventory_batches b
  LEFT JOIN sale_item_allocations a ON a.inventory_batch_id = b.id
  LEFT JOIN sale_items si ON si.id = a.sale_item_id
  LEFT JOIN sale_orders so ON so.id = si.sale_order_id
   AND so.status IN ('CONFIRMED', 'PARTIALLY_PAID', 'PAID', 'RETURNED')
  GROUP BY b.id
),
returned AS (
  SELECT b.id AS batch_id, COALESCE(SUM(ri.qty) FILTER (WHERE ri.restocked), 0) AS qty
  FROM inventory_batches b
  LEFT JOIN sale_return_items ri ON ri.inventory_batch_id = b.id
  GROUP BY b.id
)
UPDATE inventory_batches b
SET remaining_qty = GREATEST(b.received_qty - s.qty + r.qty, 0),
    saleable_qty  = GREATEST(b.received_qty - s.qty + r.qty, 0),
    reserved_qty  = 0
FROM sold s, returned r
WHERE s.batch_id = b.id
  AND r.batch_id = b.id;
