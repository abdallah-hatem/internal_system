/**
 * One-off, owner 2026-10-27: "can we update the zogmars ORD-2026-00006 which is
 * sample, and make it mokattam branch?" The samples were left on 18 Oct, before
 * branches existed, so the order sits on the owner with no branch. The office
 * has no way to move an order to a branch, so this does it once, checked:
 * the order is ORD-2026-00006, still open SAMPLES, Ahmad Zogmar's, on no branch;
 * Mokattam is his and not archived. One field changes; the audit log records it.
 *
 *   DATABASE_URL=… npx ts-node --transpile-only \
 *     --compiler-options '{"module":"commonjs"}' \
 *     prisma/one-off/2026-10-27-ord-00006-to-mokattam.ts [--plan] [--production]
 */
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- a one-off script owns its own client
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { assertTarget } from './2026-10-23-cyc-0001-extras.guards';

const ORDER_NO = 'ORD-2026-00006';
const CUSTOMER_ID = 'ceadced7-457a-4803-9241-3520b6bda1ac'; // Ahmad Zogmar
const BRANCH_NAME = 'Mokattam';

async function main() {
  const argv = process.argv.slice(2);
  const target = assertTarget(process.env.DATABASE_URL, argv);
  const plan = argv.includes('--plan');
  console.log(
    `${ORDER_NO} → ${BRANCH_NAME} on ${target.db} at ${target.host}${target.production ? ' (PRODUCTION)' : ''}${plan ? ', plan only' : ''}`,
  );
  const prisma = new PrismaClient();
  try {
    const order = await prisma.saleOrder.findFirst({
      where: { orderNo: ORDER_NO },
      select: { id: true, status: true, customerId: true, branchId: true },
    });
    if (!order) throw new Error(`${ORDER_NO} not found.`);
    const branch = await prisma.customerBranch.findFirst({
      where: {
        customerId: CUSTOMER_ID,
        name: { equals: BRANCH_NAME, mode: 'insensitive' },
      },
      select: { id: true, name: true, archivedAt: true },
    });
    if (!branch) throw new Error(`Ahmad Zogmar has no ${BRANCH_NAME} branch.`);
    if (order.branchId === branch.id) {
      console.log('Already on Mokattam. Nothing to do.');
      return;
    }
    const problems: string[] = [];
    if (order.customerId !== CUSTOMER_ID)
      problems.push('the order is not Ahmad Zogmar’s');
    if (order.status !== 'SAMPLES')
      problems.push(`the order is ${order.status}, not open SAMPLES`);
    if (order.branchId) problems.push('the order is already on another branch');
    if (branch.archivedAt) problems.push(`${BRANCH_NAME} is archived`);
    if (problems.length)
      throw new Error(`Starting facts do not match: ${problems.join('; ')}.`);
    console.log(
      `Plan: set ${ORDER_NO}'s branch to ${branch.name} (${branch.id}).`,
    );
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
    await prisma.saleOrder.update({
      where: { id: order.id },
      data: { branchId: branch.id },
    });
    await new AuditService(prisma as unknown as PrismaService).log({
      actorUserId: actor.id,
      action: 'UPDATE',
      entityType: 'SaleOrder',
      entityId: order.id,
      beforeJson: { branchId: null },
      afterJson: {
        branchId: branch.id,
        branch: branch.name,
        reason:
          'Samples left before branches existed; at Mokattam (owner, 2026-10-27)',
      },
    });
    console.log(`Done: ${ORDER_NO} is on ${branch.name}.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('\nFAILED:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
