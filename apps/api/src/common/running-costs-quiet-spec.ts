import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { TAKES_RUNNING_COSTS } from './running-cost-allocation';

/**
 * For suites on a throwaway Postgres (CLAUDE.md rule 6). Since 2026-11-08 a
 * running cost — an expense with no cycle — is shared to every cycle selling
 * (§8), so one suite's rent would land on another suite's cycle and move its
 * profit. Before each test: costs still waiting are parked on a closed cycle of
 * their own, and (`closeSelling`) the cycles other tests left running are
 * closed. Never used outside a test database.
 */
export async function quietRunningCosts(
  prisma: PrismaClient,
  opts: { closeSelling?: boolean } = {},
) {
  if (opts.closeSelling) {
    await prisma.importCycle.updateMany({
      where: { status: { in: [...TAKES_RUNNING_COSTS] } },
      data: { status: 'CLOSED' },
    });
  }
  const sink = await prisma.importCycle.create({
    data: {
      code: `PARK-${randomUUID().slice(0, 8)}`,
      originType: 'UAE_DIRECT',
      currency: 'EGP',
      status: 'CLOSED',
    },
  });
  await prisma.$executeRaw`
    UPDATE financial_transactions f SET cycle_id = ${sink.id}::uuid
     WHERE f.cycle_id IS NULL AND f.direction = 'OUTFLOW'
       AND NOT EXISTS (SELECT 1 FROM running_cost_allocations a WHERE a.cost_entry_id = f.id)`;
}
