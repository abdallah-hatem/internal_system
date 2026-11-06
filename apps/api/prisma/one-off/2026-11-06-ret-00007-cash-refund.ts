/**
 * One-off, owner 2026-11-06: Fares returned ORD-2026-00016 (Sameh, one Y30,
 * 2,000, already paid in cash) as RET-2026-00007 and handed the 2,000 back —
 * "yes he gave it back". The form left the refund on its default, a credit
 * note, and a credit note only lowers what is owed: the order owed nothing, so
 * the 2,000 vanished (Sameh's balance 0, no credit anywhere) and no cash left
 * the ledger, so cash on hand stayed 2,000 too high.
 *
 * This records the return as what happened, once and checked: its refund
 * method becomes CASH and the cash-out row the returns service writes for a
 * cash refund (`REFUND_PAID`, `refund`, OUTFLOW) is added, dated the return's
 * day, by Fares. The order (already RETURNED, owing 0), the stock and the
 * SALE_RETURN row are already right and are not touched. The audit log
 * records it. Running it again does nothing.
 *
 *   DATABASE_URL=… npx ts-node --transpile-only \
 *     --compiler-options '{"module":"commonjs"}' \
 *     prisma/one-off/2026-11-06-ret-00007-cash-refund.ts [--plan] [--production]
 */
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- a one-off script owns its own client
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { assertTarget } from './2026-10-23-cyc-0001-extras.guards';

const RETURN_REF = 'RET-2026-00007';
const ORDER_NO = 'ORD-2026-00016';
const AMOUNT = '2000';
const NOTE =
  'Cash handed back to Sameh for RET-2026-00007; it was saved as a credit note on a paid order and the credit vanished (owner, 2026-11-06)';

async function main() {
  const argv = process.argv.slice(2);
  const target = assertTarget(process.env.DATABASE_URL, argv);
  const plan = argv.includes('--plan');
  console.log(
    `${RETURN_REF} → cash refund → ${target.db} at ${target.host}${target.production ? ' (PRODUCTION)' : ''}${plan ? ', plan only' : ''}`,
  );
  const prisma = new PrismaClient();
  try {
    const owner = await prisma.user.findFirst({
      where: { role: 'CORE_PARTNER', email: { startsWith: 'abdallah@' } },
      select: { id: true },
    });
    if (!owner) throw new Error('No core partner abdallah@….');
    const ret = await prisma.saleReturn.findUnique({
      where: { reference: RETURN_REF },
      select: {
        id: true,
        refundMethod: true,
        refundEgp: true,
        returnedOn: true,
        createdBy: true,
        saleOrder: { select: { orderNo: true, currency: true, outstanding: true, status: true } },
      },
    });
    if (!ret) throw new Error(`${RETURN_REF} not found.`);
    const cashRows = await prisma.financialTransaction.count({
      where: { relatedType: 'SALE_RETURN', relatedId: ret.id, type: 'REFUND_PAID' },
    });
    if (ret.refundMethod === 'CASH' && cashRows === 1) {
      console.log('Already a cash refund with its cash-out row. Nothing to do.');
      return;
    }
    const facts = [
      ret.saleOrder.orderNo === ORDER_NO,
      ret.refundMethod === 'CREDIT_NOTE',
      ret.refundEgp.toFixed(2) === '2000.00',
      ret.saleOrder.currency === 'EGP',
      ret.saleOrder.status === 'RETURNED',
      ret.saleOrder.outstanding.toFixed(2) === '0.00',
      cashRows === 0,
    ];
    if (facts.some((ok) => !ok))
      throw new Error(
        `Starting facts do not match: order ${ret.saleOrder.orderNo}, method ${ret.refundMethod}, refund ${ret.refundEgp.toFixed(2)} ${ret.saleOrder.currency}, status ${ret.saleOrder.status}, owing ${ret.saleOrder.outstanding.toFixed(2)}, ${cashRows} cash rows.`,
      );
    const day = ret.returnedOn.toISOString().slice(0, 10);
    console.log(
      `Plan: ${RETURN_REF} refund method CREDIT_NOTE → CASH; add REFUND_PAID OUTFLOW ${AMOUNT} EGP dated ${day}, by the return's creator. Cash on hand −${AMOUNT}.`,
    );
    if (plan) return console.log('--plan: nothing written.');

    const row = await prisma.$transaction(async (tx) => {
      await tx.saleReturn.update({ where: { id: ret.id }, data: { refundMethod: 'CASH' } });
      return tx.financialTransaction.create({
        data: {
          type: 'REFUND_PAID',
          category: 'refund',
          direction: 'OUTFLOW',
          amount: AMOUNT,
          currency: 'EGP',
          occurredOn: new Date(`${day}T00:00:00Z`),
          relatedType: 'SALE_RETURN',
          relatedId: ret.id,
          reason: `Cash refunded for ${RETURN_REF}`,
          createdBy: ret.createdBy ?? owner.id,
        },
        select: { id: true },
      });
    });
    await new AuditService(prisma as unknown as PrismaService).log({
      actorUserId: owner.id,
      action: 'UPDATE',
      entityType: 'SaleReturn',
      entityId: ret.id,
      beforeJson: { refundMethod: 'CREDIT_NOTE', refundPaidRow: null },
      afterJson: { refundMethod: 'CASH', refundPaidRow: row.id, amount: AMOUNT, reason: NOTE },
    });
    console.log(`Done: ${RETURN_REF} is a cash refund; ledger row ${row.id}.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('\nFAILED:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
