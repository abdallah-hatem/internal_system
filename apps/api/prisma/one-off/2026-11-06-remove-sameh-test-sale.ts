/**
 * One-off, owner 2026-11-06: "we did not have any new sale to sameh, that was
 * just a test, remove any sale related thing from sameh today, so no 2000".
 * ORD-2026-00016 (Sameh, one Y30, 2,000), its cash payment, and its return
 * RET-2026-00007 (made a cash refund earlier the same day by
 * 2026-11-06-ret-00007-cash-refund.ts) never happened as business. This removes
 * every record of them, checked first: the order, its line, its stock
 * allocations and reservations, the payment and its allocation, the return and
 * its line, their three ledger rows (payment in, sale undone, cash refund out),
 * their stock movements, the partners' notifications about them and their
 * audit rows. One audit row records the removal.
 *
 * Stock does not move: the unit went out with the sale and came back with the
 * restocking return, so its batch already holds it; the movements removed sum
 * to zero per batch (checked). Cash on hand, revenue and collected each lose
 * the test's 2,000 in and out, and net to what they were before it.
 *
 *   DATABASE_URL=… npx ts-node --transpile-only \
 *     --compiler-options '{"module":"commonjs"}' \
 *     prisma/one-off/2026-11-06-remove-sameh-test-sale.ts [--plan] [--production]
 */
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- a one-off script owns its own client
import { PrismaClient, Prisma } from '@prisma/client';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { assertTarget } from './2026-10-23-cyc-0001-extras.guards';

const ORDER_NO = 'ORD-2026-00016';
const RETURN_REF = 'RET-2026-00007';
const REASON =
  'A test sale, not business: Sameh had no sale on 2026-11-05/06 (owner, 2026-11-06)';

async function main() {
  const argv = process.argv.slice(2);
  const target = assertTarget(process.env.DATABASE_URL, argv);
  const plan = argv.includes('--plan');
  console.log(
    `Remove ${ORDER_NO} → ${target.db} at ${target.host}${target.production ? ' (PRODUCTION)' : ''}${plan ? ', plan only' : ''}`,
  );
  const prisma = new PrismaClient();
  try {
    const owner = await prisma.user.findFirst({
      where: { role: 'CORE_PARTNER', email: { startsWith: 'abdallah@' } },
      select: { id: true },
    });
    if (!owner) throw new Error('No core partner abdallah@….');
    const order = await prisma.saleOrder.findUnique({
      where: { orderNo: ORDER_NO },
      select: {
        id: true,
        status: true,
        total: true,
        customer: { select: { displayName: true } },
        items: { select: { id: true, quantity: true, product: { select: { sku: true } } } },
      },
    });
    if (!order) {
      console.log(`${ORDER_NO} is not there. Nothing to do.`);
      return;
    }
    const itemIds = order.items.map((i) => i.id);
    const returns = await prisma.saleReturn.findMany({
      where: { saleOrderId: order.id },
      select: { id: true, reference: true, items: { select: { qty: true, restocked: true } } },
    });
    const allocations = await prisma.paymentAllocation.findMany({
      where: { saleOrderId: order.id },
      select: { id: true, paymentId: true },
    });
    const paymentIds = [...new Set(allocations.map((a) => a.paymentId))];
    const payments = await prisma.payment.findMany({
      where: { id: { in: paymentIds } },
      select: { id: true, amount: true, allocations: { select: { saleOrderId: true } } },
    });
    const returnIds = returns.map((r) => r.id);
    const ledger = await prisma.financialTransaction.findMany({
      where: { relatedId: { in: [...paymentIds, ...returnIds, order.id] } },
      select: { id: true, type: true, amount: true, reversalOfId: true },
    });
    const reversals = await prisma.financialTransaction.count({
      where: { reversalOfId: { in: ledger.map((l) => l.id) } },
    });
    const movements = await prisma.inventoryMovement.findMany({
      where: { referenceId: { in: [order.id, ...returnIds, ...itemIds] } },
      select: { id: true, batchId: true, movementType: true, qtyDelta: true },
    });
    const plans = await prisma.paymentPlan.count({ where: { saleOrderId: order.id } });
    const requests = await prisma.orderRequest.count({ where: { saleOrderId: order.id } });
    const sampleLines = await prisma.saleItem.count({ where: { fromSamplesOrderId: order.id } });

    // Net stock per batch from the SALE / RETURN movements must be zero.
    const net = new Map<string, Prisma.Decimal>();
    for (const m of movements)
      if (m.movementType === 'SALE' || m.movementType === 'RETURN')
        net.set(m.batchId, (net.get(m.batchId) ?? new Prisma.Decimal(0)).add(m.qtyDelta));

    const facts: [string, boolean][] = [
      ['customer is Sameh', order.customer.displayName === 'Sameh'],
      ['order RETURNED', order.status === 'RETURNED'],
      ['order total 2,000', order.total.toFixed(2) === '2000.00'],
      ['one line, one Y30', order.items.length === 1 && order.items[0].product.sku === 'PRD-000001' && order.items[0].quantity.toFixed(0) === '1'],
      ['one return, RET-2026-00007, restocked', returns.length === 1 && returns[0].reference === RETURN_REF && returns[0].items.every((i) => i.restocked)],
      ['one payment of 2,000, only on this order', payments.length === 1 && payments[0].amount.toFixed(2) === '2000.00' && payments[0].allocations.every((a) => a.saleOrderId === order.id)],
      ['three ledger rows: payment, sale undone, cash refund', ledger.length === 3 && ['PAYMENT_RECEIVED', 'SALE_RETURN', 'REFUND_PAID'].every((t) => ledger.some((l) => l.type === t)) && ledger.every((l) => l.amount.toFixed(2) === '2000.00' && !l.reversalOfId)],
      ['no ledger row undone', reversals === 0],
      ['stock movements net to zero', [...net.values()].every((v) => v.isZero()) && net.size > 0],
      ['no payment plan, order request or sample line', plans === 0 && requests === 0 && sampleLines === 0],
    ];
    const failed = facts.filter(([, ok]) => !ok).map(([what]) => what);
    if (failed.length) throw new Error(`Starting facts do not match: ${failed.join('; ')}.`);

    const ids = [order.id, ...itemIds, ...returnIds, ...paymentIds];
    const like = [ORDER_NO, RETURN_REF, ...ids].map((v) => `%${v}%`);
    const notifications: { id: string }[] = await prisma.$queryRaw`
      SELECT id FROM notifications
       WHERE title LIKE ANY(${like}) OR coalesce(params::text,'') LIKE ANY(${like})
          OR coalesce(payload_json::text,'') LIKE ANY(${like})`;
    const audits = await prisma.auditLog.count({ where: { entityId: { in: ids } } });

    console.log(
      `Plan: delete ${ORDER_NO} (1 line), ${RETURN_REF} (1 line), 1 payment + ${allocations.length} allocation, ${ledger.length} ledger rows, ${movements.length} stock movements (net 0), ${notifications.length} notifications, ${audits} audit rows. Stock unchanged; cash, revenue and collected each lose the 2,000 test in and out.`,
    );
    if (plan) return console.log('--plan: nothing written.');

    await prisma.$transaction(async (tx) => {
      const del = (sql: string, list: string[]) =>
        list.length ? tx.$executeRawUnsafe(sql, list) : Promise.resolve(0);
      await del('DELETE FROM notifications WHERE id = ANY($1::uuid[])', notifications.map((n) => n.id));
      await del('DELETE FROM audit_logs WHERE entity_id = ANY($1::uuid[])', ids);
      await del('DELETE FROM inventory_movements WHERE id = ANY($1::uuid[])', movements.map((m) => m.id));
      await del('DELETE FROM financial_transactions WHERE id = ANY($1::uuid[])', ledger.map((l) => l.id));
      await del('DELETE FROM sale_return_items WHERE sale_return_id = ANY($1::uuid[])', returnIds);
      await del('DELETE FROM sale_returns WHERE id = ANY($1::uuid[])', returnIds);
      await del('DELETE FROM payment_allocations WHERE id = ANY($1::uuid[])', allocations.map((a) => a.id));
      await del('DELETE FROM payments WHERE id = ANY($1::uuid[])', paymentIds);
      await del('DELETE FROM sale_item_allocations WHERE sale_item_id = ANY($1::uuid[])', itemIds);
      await del('DELETE FROM inventory_reservations WHERE sale_order_id = ANY($1::uuid[])', [order.id]);
      await del('DELETE FROM sale_price_adjustments WHERE sale_item_id = ANY($1::uuid[])', itemIds);
      await del('DELETE FROM sale_items WHERE id = ANY($1::uuid[])', itemIds);
      await del('DELETE FROM sale_orders WHERE id = ANY($1::uuid[])', [order.id]);
    });
    await new AuditService(prisma as unknown as PrismaService).log({
      actorUserId: owner.id,
      action: 'DELETE',
      entityType: 'SaleOrder',
      entityId: order.id,
      beforeJson: { orderNo: ORDER_NO, customer: 'Sameh', total: '2000.00', return: RETURN_REF, payment: '2000.00 cash' },
      afterJson: { removed: true, reason: REASON },
    });
    console.log(`Done: ${ORDER_NO}, its payment and ${RETURN_REF} are gone.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('\nFAILED:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
