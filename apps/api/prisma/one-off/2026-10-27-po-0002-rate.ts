/**
 * One-off, owner 2026-10-27: PO-2026-0002 (CYC-2026-0002's Alibaba receipt) was
 * entered at 14.8026; the partners bought the dirhams at 15.20 and repaid the
 * friend who paid by card (Mohamed Youssef) in AED and USD. The order's rate
 * moves to 15.20, as leg 1's did (update_leg_cost). The office has no way to
 * change an order's rate, so this does it once, checked: the order is still at
 * 14.8026, nothing of it was received, and no friend's payment is recorded on it
 * yet. One field changes; the audit log records it.
 *
 *   DATABASE_URL=… npx ts-node --transpile-only \
 *     --compiler-options '{"module":"commonjs"}' \
 *     prisma/one-off/2026-10-27-po-0002-rate.ts [--plan] [--production]
 */
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- a one-off script owns its own client
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { assertTarget } from './2026-10-23-cyc-0001-extras.guards';

const REFERENCE = 'PO-2026-0002';
const BEFORE = '14.8026';
const AFTER = '15.2000';

async function main() {
  const argv = process.argv.slice(2);
  const target = assertTarget(process.env.DATABASE_URL, argv);
  const plan = argv.includes('--plan');
  console.log(
    `${REFERENCE} rate → 15.20 on ${target.db} at ${target.host}${target.production ? ' (PRODUCTION)' : ''}${plan ? ', plan only' : ''}`,
  );
  const prisma = new PrismaClient();
  try {
    const po = await prisma.purchaseOrder.findFirst({
      where: { reference: REFERENCE },
      select: { id: true, status: true, fxRateToEgp: true, cycleId: true },
    });
    if (!po) throw new Error(`${REFERENCE} not found.`);
    const rate = Number(po.fxRateToEgp).toFixed(4);
    if (rate === AFTER) {
      console.log('Already 15.20. Nothing to do.');
      return;
    }
    const received = await prisma.inventoryBatch.count({
      where: { cycleId: po.cycleId },
    });
    const financed = await prisma.lenderFinancing.count({
      where: { purchaseOrderId: po.id },
    });
    const problems: string[] = [];
    if (rate !== BEFORE) problems.push(`the rate is ${rate}, not ${BEFORE}`);
    if (received > 0) problems.push(`${received} batches were received`);
    if (financed > 0) problems.push('a friend’s payment is recorded on it');
    if (problems.length)
      throw new Error(`Starting facts do not match: ${problems.join('; ')}.`);
    console.log(`Plan: ${REFERENCE} (${po.status}) rate ${rate} → ${AFTER}.`);
    if (plan) return console.log('--plan: nothing written.');

    const actor = await prisma.user.findFirst({
      where: {
        role: 'CORE_PARTNER',
        status: 'ACTIVE',
        email: { startsWith: 'abdallah@' },
      },
      select: { id: true },
    });
    if (!actor) throw new Error('No active core partner abdallah@….');
    await prisma.purchaseOrder.update({
      where: { id: po.id },
      data: { fxRateToEgp: AFTER },
    });
    await new AuditService(prisma as unknown as PrismaService).log({
      actorUserId: actor.id,
      action: 'UPDATE',
      entityType: 'PurchaseOrder',
      entityId: po.id,
      beforeJson: { fxRateToEgp: rate },
      afterJson: {
        fxRateToEgp: AFTER,
        reason: 'The partners bought the dirhams at 15.20 (owner, 2026-10-27)',
      },
    });
    console.log(`Done: ${REFERENCE} is at 15.20.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('\nFAILED:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
