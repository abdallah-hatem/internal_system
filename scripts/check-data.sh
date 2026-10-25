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
  --
  -- One exception, by design (§2, amendment 9): the event that accounts for
  -- the last units of an order line takes the rounding residual, so the
  -- batches and losses of the line re-sum to its landed total. That loss
  -- stores the residual as its cost and the residual over its quantity (to
  -- four places) as its unit cost, so the two can differ by the four-place
  -- rounding — never by more than half a piastre plus half a ten-thousandth
  -- per unit. It is allowed only on the final event of the line: fully
  -- accounted for, and no batch or loss on it recorded after this one.
  UNION ALL SELECT 12.5, 'a loss whose cost is not its quantity times its unit cost',
         count(*) FROM shipment_losses x
   WHERE x.cost_egp <> round(x.qty * x.unit_cost_egp, 2)
     AND NOT (
       abs(x.cost_egp - x.qty * x.unit_cost_egp) <= 0.005 + x.qty * 0.00005
       AND (SELECT poi.ordered_qty FROM purchase_order_items poi
             WHERE poi.id = x.purchase_order_item_id)
         = coalesce((SELECT sum(b.received_qty) FROM inventory_batches b
                      WHERE b.source_po_item_id = x.purchase_order_item_id), 0)
         + (SELECT sum(y.qty) FROM shipment_losses y
             WHERE y.purchase_order_item_id = x.purchase_order_item_id)
       AND NOT EXISTS (SELECT 1 FROM shipment_losses y
                        WHERE y.purchase_order_item_id = x.purchase_order_item_id
                          AND y.created_at > x.created_at)
       AND NOT EXISTS (SELECT 1 FROM inventory_batches b
                        WHERE b.source_po_item_id = x.purchase_order_item_id
                          AND b.created_at > x.created_at)
     )
  -- Stock on a shipped cycle exists only by being received from a delivery
  -- (§3). The backfill links every older batch; a batch without one was
  -- received some other way.
  UNION ALL SELECT 12.6, 'a batch on a cycle with legs that came from no delivery',
         count(*) FROM inventory_batches b
   WHERE b.source_delivery_line_id IS NULL
     -- Leftovers moved in from another cycle (§8, L5) came from a delivery of the cycle that gave them.
     AND b.transferred_from_batch_id IS NULL
     AND EXISTS (SELECT 1 FROM shipping_legs l WHERE l.cycle_id = b.cycle_id)
  -- A delivery line is received in as many goes as it takes, never past what
  -- it brought (§3, 2026-10-10). Two receipts racing past each other are the
  -- way this would happen; a receipt locks the cycle row against it.
  UNION ALL SELECT 12.7, 'a delivery line received more than it brought',
         count(*) FROM shipment_delivery_lines dl
   WHERE (SELECT coalesce(sum(b.received_qty), 0) FROM inventory_batches b
           WHERE b.source_delivery_line_id = dl.id) > dl.qty
  -- Compensation recovers a loss, it does not make a profit on one (§6,
  -- 2026-10-10): refunds on a loss, each in EGP to the cent as its ledger row
  -- holds it, never total more than the loss cost. A loss refund locks the
  -- cycle row, so two sent at once cannot both fit under the cap. (No
  -- apostrophes in these comments: bash 3.2 reads them as quotes here.)
  UNION ALL SELECT 12.8, 'refunds on a loss exceed its cost',
         count(*) FROM shipment_losses x
   WHERE (SELECT coalesce(sum(round(r.amount * r.fx_rate_to_egp, 2)), 0)
            FROM supplier_refunds r
           WHERE r.shipment_loss_id = x.id
             AND r.reversed_at IS NULL) > x.cost_egp
  -- An undone refund (B5b, 9) is balanced in the ledger: its inflow has a
  -- reversal pointing back at it. Otherwise the money handed back never left
  -- the books and the cycle still shows the recovery.
  UNION ALL SELECT 12.9, 'an undone refund whose ledger inflow was not balanced',
         count(*) FROM supplier_refunds r
    JOIN financial_transactions f
      ON f.related_type = 'SUPPLIER_REFUND' AND f.related_id = r.id
     AND f.reversal_of_id IS NULL
   WHERE r.reversed_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM financial_transactions v
                      WHERE v.reversal_of_id = f.id)
  -- Goods leave in departures (L8, 2026-10-12). A leg can only send on what
  -- entered it: the order, for the first leg; what the leg before delivered,
  -- for a later one. (No apostrophes in these comments: bash 3.2.)
  UNION ALL SELECT 12.91, 'a leg sent off more of a product than entered it',
         count(*) FROM (
           WITH legs AS (
             SELECT l.id,
                    lag(l.id) OVER (PARTITION BY l.cycle_id ORDER BY l.sequence) AS prev_id
               FROM shipping_legs l
           ), departed AS (
             SELECT d.leg_id, dl.purchase_order_item_id AS item_id, sum(dl.qty) AS qty
               FROM shipment_departure_lines dl JOIN shipment_departures d ON d.id = dl.departure_id
              GROUP BY d.leg_id, dl.purchase_order_item_id
           )
           SELECT 1 FROM departed p
             JOIN legs g ON g.id = p.leg_id
             JOIN purchase_order_items poi ON poi.id = p.item_id
            WHERE p.qty > CASE
                    WHEN g.prev_id IS NULL THEN poi.ordered_qty
                    ELSE coalesce((SELECT sum(dl.qty) FROM shipment_delivery_lines dl
                                     JOIN shipment_deliveries d ON d.id = dl.delivery_id
                                    WHERE d.leg_id = g.prev_id
                                      AND dl.purchase_order_item_id = p.item_id), 0)
                  END
         ) over_departed
  -- Only what left can arrive or be lost on the way. Legs with no departure
  -- row at all are the B1 backfill (an arrival date and no departure date)
  -- and are left out: they predate departures.
  UNION ALL SELECT 12.92, 'a leg delivered more of a product than left on it',
         count(*) FROM (
           SELECT 1 FROM shipment_deliveries d
             JOIN shipment_delivery_lines dl ON dl.delivery_id = d.id
            WHERE EXISTS (SELECT 1 FROM shipment_departures x WHERE x.leg_id = d.leg_id)
            GROUP BY d.leg_id, dl.purchase_order_item_id
           HAVING sum(dl.qty) > coalesce((SELECT sum(xl.qty) FROM shipment_departure_lines xl
                                            JOIN shipment_departures x ON x.id = xl.departure_id
                                           WHERE x.leg_id = d.leg_id
                                             AND xl.purchase_order_item_id = dl.purchase_order_item_id), 0)
         ) over_arrived
  -- The departure date on a leg is a reading of its first departure, written
  -- by every change; a leg whose date disagrees was written some other way.
  UNION ALL SELECT 12.93, 'a leg whose departure date is not its first departure',
         count(*) FROM shipping_legs l
   WHERE (l.departed_on AT TIME ZONE 'Africa/Cairo')::date
         IS DISTINCT FROM (SELECT min(d.departed_on) FROM shipment_departures d WHERE d.leg_id = l.id)
  UNION ALL SELECT 13,'payment attached to no order at all',
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
  -- A price lowered after the sale (§4, 2026-10-22) lowers outstanding with no
  -- allocation too, never below zero, so it is added back exactly.
  UNION ALL SELECT 13.1, 'order shows money paid that no payment allocated to it',
         count(*) FROM sale_orders o
   WHERE o.status NOT IN ('DRAFT', 'CANCELLED')
     AND NOT EXISTS (
       SELECT 1 FROM sale_returns r
        WHERE r.sale_order_id = o.id AND r.refund_method = 'CREDIT_NOTE'
     )
     AND o.total - o.outstanding - (
       SELECT coalesce(sum(pa.amount_egp), 0) FROM sale_price_adjustments pa
        WHERE pa.sale_order_id = o.id
     ) <> (
       SELECT coalesce(sum(a.amount), 0) FROM payment_allocations a
         JOIN payments p ON p.id = a.payment_id
        WHERE a.sale_order_id = o.id AND p.status <> 'REVERSED'
     )
  -- The per-batch shares of a price adjustment must add up to it (§4, 2026-10-22).
  -- (No apostrophe in these comments: macOS bash 3.2 reads one inside a
  -- heredoc inside $(...) as an open quote and the whole script fails to parse.)
  UNION ALL SELECT 13.2, 'price adjustment whose batch shares do not add up to it',
         count(*) FROM sale_price_adjustments pa
   WHERE pa.amount_egp <> (
           SELECT coalesce(sum(i.amount_egp), 0) FROM sale_price_adjustment_items i
            WHERE i.adjustment_id = pa.id)
      OR pa.qty <> (
           SELECT coalesce(sum(i.qty), 0) FROM sale_price_adjustment_items i
            WHERE i.adjustment_id = pa.id)
      OR pa.new_unit_price < 0 OR pa.new_unit_price >= pa.previous_unit_price
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
  -- A walk-in sale is paid on the spot and is never a draft (§4, 2026-10-11).
  UNION ALL SELECT 16, 'the walk-in record owes money or holds a draft',
         count(*) FROM sale_orders o
           JOIN customers c ON c.id = o.customer_id
          WHERE c.is_walk_in
            AND (o.status = 'DRAFT'
                 OR (o.status IN ('CONFIRMED', 'PARTIALLY_PAID') AND o.outstanding > 0))
  UNION ALL SELECT 16.1, 'the walk-in record can sign in',
         count(*) FROM customers WHERE is_walk_in AND shop_owner_user_id IS NOT NULL
  -- A PO reference has no unique index; two orders placed at once were both
  -- given the same one until F9 (2026-10-11). Zero here, on production too,
  -- is what would let a unique index be added safely.
  UNION ALL SELECT 17, 'two purchase orders share a reference',
         count(*) FROM (
           SELECT reference FROM purchase_orders GROUP BY reference HAVING count(*) > 1
         ) shared
  -- RETURNED means every sold unit came back (§5). Until 2026-10-11 a return
  -- counted its own lines twice, so bringing back half an order marked it
  -- RETURNED — and a RETURNED order owes nothing, so what the shop still owed
  -- on the other half vanished from its balance. Found by the statement
  -- invariant (34, TC-INV-26). An order here needs its status put back.
  UNION ALL SELECT 18, 'order marked returned with units never returned',
         count(*) FROM sale_orders o
   WHERE o.status = 'RETURNED'
     AND EXISTS (
           SELECT 1 FROM sale_items i
            WHERE i.sale_order_id = o.id
              AND coalesce((SELECT sum(ri.qty) FROM sale_return_items ri
                             WHERE ri.sale_item_id = i.id), 0) < i.quantity)
  -- A friend who paid a supplier (§18, L1 2026-10-11): what standing
  -- repayments cleared can never exceed what he paid — a debt below zero
  -- means he was repaid twice.
  UNION ALL SELECT 19, 'friend repaid more than he paid (debt below zero)',
         count(*) FROM lender_financings f
   WHERE (SELECT coalesce(sum(r.cleared), 0) FROM lender_repayments r
           WHERE r.financing_id = f.id AND r.reversed_at IS NULL) > f.amount
  -- Compared in pounds, exactly (2026-10-16): friends may pay in different
  -- currencies, each at the rate on the day he paid. The cap is the cycle
  -- cost (§18, owner 2026-10-16): every orders goods, every leg, and the
  -- manual expenses charged to the cycle (type EXPENSE, a reversal taking
  -- its row back off). A leg corrected down or a fee reversed after he paid
  -- can trip this legitimately — look at that cycle, do not "fix" the payment.
  UNION ALL SELECT 19.1, 'friends paid more towards a cycle than its cost',
         count(*) FROM import_cycles c
   WHERE (SELECT coalesce(sum(f.amount * f.fx_rate_to_egp), 0) FROM lender_financings f
           WHERE f.cycle_id = c.id AND f.removed_at IS NULL)
       > (SELECT coalesce(sum(i.line_total * o.fx_rate_to_egp), 0)
            FROM purchase_orders o JOIN purchase_order_items i ON i.purchase_order_id = o.id
           WHERE o.cycle_id = c.id)
       + (SELECT coalesce(sum(CASE l.cost_basis
                                WHEN 'PER_PIECE' THEN coalesce(l.rate_per_unit, 0) * coalesce(l.chargeable_pieces, 0)
                                WHEN 'PER_WEIGHT' THEN coalesce(l.rate_per_unit, 0) * coalesce(l.chargeable_weight_kg, 0)
                                ELSE coalesce(l.amount, 0) END * l.fx_rate_to_egp), 0)
            FROM shipping_legs l WHERE l.cycle_id = c.id)
       + (SELECT coalesce(sum(CASE WHEN t.direction = 'OUTFLOW' THEN t.amount ELSE -t.amount END), 0)
            FROM financial_transactions t
           WHERE t.cycle_id = c.id AND t.type = 'EXPENSE'
             AND (t.direction = 'OUTFLOW' OR t.reversal_of_id IS NOT NULL))
  -- What he paid in pounds is his amount at his own rate, half up.
  UNION ALL SELECT 19.6, 'friend''s payment whose pounds are not its amount at its rate',
         count(*) FROM lender_financings
   WHERE amount_egp <> round(amount * fx_rate_to_egp, 2)
  UNION ALL SELECT 19.2, 'repayment to a friend dated in the future or before he paid',
         count(*) FROM lender_repayments r JOIN lender_financings f ON f.id = r.financing_id
   WHERE r.paid_on > (now() AT TIME ZONE 'Africa/Cairo')::date OR r.paid_on < f.paid_on
  UNION ALL SELECT 19.3, 'friend''s payment or repayment with no ledger row',
         (SELECT count(*) FROM lender_financings f
           WHERE NOT EXISTS (SELECT 1 FROM financial_transactions t WHERE t.id = f.ledger_transaction_id))
       + (SELECT count(*) FROM lender_repayments r
           WHERE NOT EXISTS (SELECT 1 FROM financial_transactions t WHERE t.id = r.ledger_transaction_id))
  UNION ALL SELECT 19.4, 'ledger points at a friend''s payment or repayment that does not exist',
         count(*) FROM financial_transactions t
   WHERE (t.related_type = 'LENDER_FINANCING'
          AND NOT EXISTS (SELECT 1 FROM lender_financings f WHERE f.id = t.related_id))
      OR (t.related_type = 'LENDER_REPAYMENT'
          AND NOT EXISTS (SELECT 1 FROM lender_repayments r WHERE r.id = t.related_id))
  UNION ALL SELECT 19.5, 'cycle settled or closed while a friend is still owed',
         count(*) FROM lender_financings f JOIN import_cycles c ON c.id = f.cycle_id
   WHERE f.removed_at IS NULL AND c.status IN ('SETTLEMENT', 'CLOSED')
     AND f.amount > (SELECT coalesce(sum(r.cleared), 0) FROM lender_repayments r
                      WHERE r.financing_id = f.id AND r.reversed_at IS NULL)
  -- Leftovers moved to another cycle at their cost (§8, L5, 2026-10-11).
  UNION ALL SELECT 20, 'moved stock re-priced (its batch cost differs from the source batch)',
         count(*) FROM stock_transfer_lines l
           JOIN stock_transfers t ON t.id = l.transfer_id
           JOIN inventory_batches d ON d.id = l.dest_batch_id
           JOIN inventory_batches s ON s.id = l.source_batch_id
   WHERE t.status = 'ACTIVE'
     AND (d.landed_unit_cost_egp <> s.landed_unit_cost_egp OR l.unit_cost_egp <> s.landed_unit_cost_egp)
  UNION ALL SELECT 20.1, 'transfer that stands with no moved batch, or a batch of another size',
         count(*) FROM stock_transfer_lines l
           JOIN stock_transfers t ON t.id = l.transfer_id
           LEFT JOIN inventory_batches d ON d.id = l.dest_batch_id
   WHERE t.status = 'ACTIVE'
     AND (d.id IS NULL OR d.received_qty <> l.qty OR d.cycle_id <> t.to_cycle_id)
  UNION ALL SELECT 20.2, 'transfer whose ledger pair does not match its lines',
         count(*) FROM stock_transfers t
   WHERE (SELECT coalesce(sum(CASE WHEN f.direction = 'INFLOW' THEN f.amount ELSE -f.amount END), 0)
            FROM financial_transactions f
           WHERE f.related_type = 'STOCK_TRANSFER' AND f.related_id = t.id AND f.cycle_id = t.from_cycle_id)
       <> CASE WHEN t.status = 'ACTIVE'
               THEN (SELECT coalesce(sum(l.cost_egp), 0) FROM stock_transfer_lines l WHERE l.transfer_id = t.id)
               ELSE 0 END
      OR (SELECT coalesce(sum(CASE WHEN f.direction = 'OUTFLOW' THEN f.amount ELSE -f.amount END), 0)
            FROM financial_transactions f
           WHERE f.related_type = 'STOCK_TRANSFER' AND f.related_id = t.id AND f.cycle_id = t.to_cycle_id)
       <> CASE WHEN t.status = 'ACTIVE'
               THEN (SELECT coalesce(sum(l.cost_egp), 0) FROM stock_transfer_lines l WHERE l.transfer_id = t.id)
               ELSE 0 END
  UNION ALL SELECT 20.3, 'transfer dated in the future, or from a cycle to itself',
         count(*) FROM stock_transfers
   WHERE moved_on > (now() AT TIME ZONE 'Africa/Cairo')::date OR from_cycle_id = to_cycle_id
  UNION ALL SELECT 20.4, 'stock moved into a cycle that is cancelled',
         count(*) FROM stock_transfers t JOIN import_cycles c ON c.id = t.to_cycle_id
   WHERE t.status = 'ACTIVE' AND c.status = 'CANCELLED'
  UNION ALL SELECT 20.5, 'ledger points at a transfer that does not exist',
         count(*) FROM financial_transactions f
   WHERE f.related_type = 'STOCK_TRANSFER'
     AND NOT EXISTS (SELECT 1 FROM stock_transfers t WHERE t.id = f.related_id)
  -- A manual entry (§9, L6 2026-10-11): the kind fixes the direction, the
  -- amount is above zero and the day has arrived. Rows from before L6 have no
  -- occurred_on and were free text, so they are left alone.
  UNION ALL SELECT 21, 'manual ledger entry with the wrong direction, no amount or a future date',
         count(*) FROM financial_transactions t
   WHERE t.occurred_on IS NOT NULL AND t.reversal_of_id IS NULL
     AND t.type IN ('EXPENSE', 'OTHER_INCOME')
     AND ((t.type = 'EXPENSE' AND t.direction <> 'OUTFLOW')
       OR (t.type = 'OTHER_INCOME' AND t.direction <> 'INFLOW')
       OR t.amount <= 0
       OR t.occurred_on > (now() AT TIME ZONE 'Africa/Cairo')::date)
  -- Running costs taken from payouts (§8, L7 2026-10-12). A cost is charged
  -- once in total: what stands against it never exceeds it, net of any
  -- reversal; a charge stands only on a paid settlement and only on a cost
  -- with no cycle; and what the lines of a settlement say was taken is what its
  -- charges say.
  UNION ALL SELECT 22, 'running cost charged more than it cost',
         count(*) FROM (
           SELECT c.cost_entry_id
             FROM running_cost_charges c
             JOIN financial_transactions f ON f.id = c.cost_entry_id
            WHERE c.released_at IS NULL
            GROUP BY c.cost_entry_id, f.amount
           HAVING sum(c.amount) > f.amount - coalesce((
             SELECT sum(r.amount) FROM financial_transactions r
              WHERE r.reversal_of_id = c.cost_entry_id), 0)
         ) over_charged
  UNION ALL SELECT 22.1, 'running-cost charge standing on a settlement that is not paid',
         count(*) FROM running_cost_charges c JOIN settlements s ON s.id = c.settlement_id
   WHERE c.released_at IS NULL AND s.status <> 'PAID'
  UNION ALL SELECT 22.2, 'running-cost charge against a cost charged to a cycle',
         count(*) FROM running_cost_charges c
         JOIN financial_transactions f ON f.id = c.cost_entry_id
   WHERE f.cycle_id IS NOT NULL
  -- Fixed shares (review 2026-10-12): they add up to the cost, and nobody is
  -- charged more of a cost than his own fixed share.
  UNION ALL SELECT 22.4, 'running cost whose fixed shares do not add up to it',
         count(*) FROM (
           SELECT x.cost_entry_id FROM running_cost_shares x
             JOIN financial_transactions f ON f.id = x.cost_entry_id
            GROUP BY x.cost_entry_id, f.amount
           HAVING sum(x.amount) <> f.amount
         ) uneven
  UNION ALL SELECT 22.5, 'partner charged more of a running cost than his fixed share',
         count(*) FROM (
           SELECT c.cost_entry_id, c.partner_user_id
             FROM running_cost_charges c
             LEFT JOIN running_cost_shares x
               ON x.cost_entry_id = c.cost_entry_id AND x.partner_user_id = c.partner_user_id
            WHERE c.released_at IS NULL
            GROUP BY c.cost_entry_id, c.partner_user_id, x.amount
           HAVING sum(c.amount) > coalesce(x.amount, 0)
         ) over_share
  UNION ALL SELECT 22.3, 'settlement running-cost lines disagree with its charges',
         count(*) FROM settlements s
   WHERE s.status = 'PAID'
     AND coalesce((SELECT -sum(l.amount) FROM settlement_lines l
                   WHERE l.settlement_id = s.id AND l.component = 'RUNNING_COSTS'), 0)
      <> coalesce((SELECT sum(c.amount) FROM running_cost_charges c
                   WHERE c.settlement_id = s.id AND c.released_at IS NULL), 0)
  -- An Arabic name is searched through its stored key (section 3, 2026-10-15).
  -- The API writes the key with arabicSearchKey; arabic_search_key() is the
  -- same rule in SQL. A row here was written by a path that forgot the key,
  -- or the two definitions have drifted: either way search misses it.
  UNION ALL SELECT 23, 'product whose Arabic search key is not its Arabic name',
         count(*) FROM products
   WHERE name_ar_search IS DISTINCT FROM NULLIF(arabic_search_key(name_ar), '')
  -- A suppliers country is an ISO code (section 21, 2026-10-16). The API
  -- refuses anything else; a row here is free text from before the codes that
  -- the migration could not read ("Egypt (Cairo)"). Open the supplier on the
  -- Suppliers page and choose its country: the picker will not save it until
  -- one is chosen.
  UNION ALL SELECT 24, 'supplier whose country is not a country code',
         count(*) FROM suppliers WHERE country !~ '^[A-Z]{2}$'
  -- A sale carries its own day (section 4, 2026-10-16). A day that has not
  -- arrived is revenue in a period that has not happened.
  UNION ALL SELECT 25, 'sale dated on a day that has not arrived',
         count(*) FROM sale_orders
   WHERE (ordered_at AT TIME ZONE 'Africa/Cairo')::date > (now() AT TIME ZONE 'Africa/Cairo')::date
  -- A sale dated before the day it was entered draws only stock received by
  -- the end of its own day. A row here sold goods that had not arrived yet.
  UNION ALL SELECT 25.1, 'back-dated sale drew stock received after its day',
         count(*) FROM sale_item_allocations a
         JOIN sale_items i ON i.id = a.sale_item_id
         JOIN sale_orders o ON o.id = i.sale_order_id
         JOIN inventory_batches b ON b.id = a.inventory_batch_id
   WHERE (o.ordered_at AT TIME ZONE 'Africa/Cairo')::date < (o.created_at AT TIME ZONE 'Africa/Cairo')::date
     AND (b.created_at AT TIME ZONE 'Africa/Cairo')::date > (o.ordered_at AT TIME ZONE 'Africa/Cairo')::date
  -- Money cannot pay for a sale that had not happened yet (section 7a,
  -- 2026-10-16).
  UNION ALL SELECT 25.2, 'payment allocated to a sale made after it was received',
         count(*) FROM payment_allocations a
         JOIN payments p ON p.id = a.payment_id
         JOIN sale_orders o ON o.id = a.sale_order_id
   WHERE p.received_on < (o.ordered_at AT TIME ZONE 'Africa/Cairo')::date
  -- Received stock carries the day it was counted in (section 3, 2026-10-16),
  -- never before the delivery that brought it reached Egypt.
  UNION ALL SELECT 25.3, 'stock received before its delivery arrived',
         count(*) FROM inventory_batches b
   WHERE b.arrived_on IS NOT NULL
     AND (b.created_at AT TIME ZONE 'Africa/Cairo')::date < b.arrived_on
  UNION ALL SELECT 25.4, 'stock received on a day that has not arrived',
         count(*) FROM inventory_batches
   WHERE (created_at AT TIME ZONE 'Africa/Cairo')::date > (now() AT TIME ZONE 'Africa/Cairo')::date
  -- Samples left at a shop are not a sale (section 4, samples at shops,
  -- 2026-10-18): open, returned or written off, they are worth nothing as a
  -- sale and owe nothing, and no money is ever allocated to them.
  UNION ALL SELECT 26, 'samples order with a total, a balance or money allocated',
         count(*) FROM sale_orders o
   WHERE o.status IN ('SAMPLES', 'SAMPLES_RETURNED', 'SAMPLES_WRITTEN_OFF')
     AND (o.total <> 0 OR o.outstanding <> 0
          OR EXISTS (SELECT 1 FROM payment_allocations a WHERE a.sale_order_id = o.id))
  -- Units at a shop are counted from the allocations of the open samples order:
  -- they must be exactly the units on its lines, or "Samples" lies.
  UNION ALL SELECT 26.1, 'open samples order whose batches do not hold its lines',
         count(*) FROM sale_items i
         JOIN sale_orders o ON o.id = i.sale_order_id
   WHERE o.status = 'SAMPLES'
     AND i.quantity <> coalesce((SELECT sum(a.qty) FROM sale_item_allocations a
                                  WHERE a.sale_item_id = i.id), 0)
  UNION ALL SELECT 26.2, 'samples order with no day it was left',
         count(*) FROM sale_orders
   WHERE status IN ('SAMPLES', 'SAMPLES_RETURNED', 'SAMPLES_WRITTEN_OFF')
     AND samples_left_at IS NULL
  -- A branch is its owner's (§7, 2026-10-25): an order on another customer's
  -- branch would put one shop's sale on another's books.
  UNION ALL SELECT 27.1, 'sale order on another customer''s branch',
         count(*) FROM sale_orders o
         JOIN customer_branches b ON b.id = o.branch_id
   WHERE b.customer_id <> o.customer_id
  UNION ALL SELECT 27.2, 'customer with more than one default branch',
         count(*) FROM (SELECT customer_id FROM customer_branches
                         WHERE is_default GROUP BY customer_id HAVING count(*) > 1) d
  UNION ALL SELECT 27.3, 'archived branch that is the default',
         count(*) FROM customer_branches WHERE archived_at IS NOT NULL AND is_default
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
