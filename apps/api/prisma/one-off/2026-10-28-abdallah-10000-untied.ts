/**
 * One-off, owner 2026-10-28: "I put 65,000 in cycle 1, but I should only put
 * 55,000 so I should get my 10,000 back from cycle 1 … it stays in my account
 * until i take it back". His account holds a standing 10,000 ADVANCE on
 * CYC-2026-0001 (15 Aug; the rest of that day's 65,000 was reversed when his
 * cycle-1 capital was entered as 55,000 on 2026-10-27). Tied to cycle 1 it can
 * neither be taken out (`ACCOUNT_MONEY_TIED_TO_CYCLES`) nor be drawn by another
 * cycle, and it would be stranded once cycle 1 settles. The office has no way
 * to untie an advance, so this does it once, checked: the same row, its cycle
 * cleared, so it reads as untied money (`potsOf`). His balance does not move;
 * cycle 1's funding is its participants' contributions and does not move.
 * One field and the note change; the audit log records it.
 *
 *   DATABASE_URL=… npx ts-node --transpile-only \
 *     --compiler-options '{"module":"commonjs"}' \
 *     prisma/one-off/2026-10-28-abdallah-10000-untied.ts [--plan] [--production]
 */
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- a one-off script owns its own client
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { assertTarget } from './2026-10-23-cyc-0001-extras.guards';

const CYCLE_CODE = 'CYC-2026-0001';
const AMOUNT = '10000';
const DAY = '2026-08-15';
const NOTE =
  'Paid 65,000 for CYC-2026-0001; his share there is 55,000, so the business owes him 10,000 back (owner, 2026-10-28)';

async function main() {
  const argv = process.argv.slice(2);
  const target = assertTarget(process.env.DATABASE_URL, argv);
  const plan = argv.includes('--plan');
  console.log(
    `Abdallah's 10,000 off ${CYCLE_CODE} → ${target.db} at ${target.host}${target.production ? ' (PRODUCTION)' : ''}${plan ? ', plan only' : ''}`,
  );
  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findFirst({
      where: { role: 'CORE_PARTNER', email: { startsWith: 'abdallah@' } },
      select: { id: true },
    });
    if (!user) throw new Error('No core partner abdallah@….');
    const cycle = await prisma.importCycle.findFirst({
      where: { code: CYCLE_CODE },
      select: { id: true },
    });
    if (!cycle) throw new Error(`${CYCLE_CODE} not found.`);
    const standing = await prisma.partnerAccountMovement.findMany({
      where: {
        partnerUserId: user.id,
        kind: 'ADVANCE',
        reversedAt: null,
        amountEgp: AMOUNT,
        occurredOn: new Date(`${DAY}T00:00:00Z`),
      },
      select: { id: true, cycleId: true, note: true, participantId: true },
    });
    const done = standing.filter((m) => m.cycleId === null && m.note === NOTE);
    if (done.length === 1) {
      console.log('Already untied. Nothing to do.');
      return;
    }
    const onCycle = standing.filter((m) => m.cycleId === cycle.id);
    if (onCycle.length !== 1)
      throw new Error(
        `Starting facts do not match: ${onCycle.length} standing 10,000 advances of his on ${CYCLE_CODE} dated ${DAY}, expected 1.`,
      );
    const row = onCycle[0];
    if (row.participantId)
      throw new Error('That advance names a cycle line. Stopping.');
    console.log(
      `Plan: movement ${row.id} — cycle ${CYCLE_CODE} → none (untied); note "${row.note ?? ''}" → "${NOTE}".`,
    );
    if (plan) return console.log('--plan: nothing written.');

    await prisma.partnerAccountMovement.update({
      where: { id: row.id },
      data: { cycleId: null, note: NOTE },
    });
    await new AuditService(prisma as unknown as PrismaService).log({
      actorUserId: user.id,
      action: 'UPDATE',
      entityType: 'PartnerAccountMovement',
      entityId: row.id,
      beforeJson: { cycleId: cycle.id, cycle: CYCLE_CODE, note: row.note },
      afterJson: { cycleId: null, note: NOTE, reason: NOTE },
    });
    console.log('Done: the 10,000 is untied money in his account.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('\nFAILED:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
