/**
 * Ahmad Zogmar's three branches (owner, 2026-10-25; BUSINESS_LOGIC §7 "A
 * customer with branches", docs/BUILD_LOG.md): Mokattam, Master and LS2, under
 * his existing customer record, which becomes the owner.
 *
 *   cd apps/api
 *   DATABASE_URL=postgresql://…@localhost:5432/<a local copy> \
 *     npx ts-node --transpile-only --compiler-options '{"module":"commonjs"}' \
 *     prisma/one-off/2026-10-25-ahmad-zogmar-branches.ts [--plan]
 *
 *   --plan   reads and prints what it would add; writes nothing
 *
 * LOCAL ONLY. It refuses any database that is not on this machine: the branch
 * names are the owner's as he said them (spelling to confirm), and which one is
 * the default is still his to pick, so it is not for production until he has.
 * When it is, the office's Branches card does the same thing by hand.
 *
 * What it does, through `CustomerBranchesService` — the office's own rules:
 *   - finds the customer by id and checks it is still "Ahmad Zogmar";
 *   - adds each branch he does not have yet (a name once per customer,
 *     ignoring case), so running it twice adds nothing;
 *   - sets NO default. Until the owner picks one, a new order for Ahmad stays
 *     on him (GUESS, §7). His existing orders are not touched: they stay on
 *     him until someone says which branch each belongs to.
 */
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- a one-off script owns its own client
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { CustomerBranchesService } from '../../src/modules/customers/customer-branches.service';

export const CUSTOMER_ID = 'ceadced7-457a-4803-9241-3520b6bda1ac';
export const CUSTOMER_NAME = 'Ahmad Zogmar';
/** As the owner gave them, 2026-10-25. */
export const BRANCHES = ['Mokattam', 'Master', 'LS2'] as const;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** The database the URL names, refused unless it is on this machine. */
export function localTarget(url: string | undefined): {
  host: string;
  db: string;
} {
  if (!url) throw new Error('DATABASE_URL is not set.');
  const parsed = new URL(url);
  const host = parsed.hostname;
  const db = parsed.pathname.replace(/^\//, '');
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `Refusing ${db} on ${host}: this script runs only against a database on this machine. ` +
        'The owner has not yet confirmed the names or picked the default branch.',
    );
  }
  return { host, db };
}

async function main() {
  const plan = process.argv.includes('--plan');
  const url = process.env.DATABASE_URL;
  const target = localTarget(url);
  console.log(
    `Ahmad Zogmar's branches → ${target.db} on ${target.host}${plan ? ', plan only' : ''}`,
  );

  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    const customer = await prisma.customer.findUnique({
      where: { id: CUSTOMER_ID },
      select: { id: true, displayName: true },
    });
    if (!customer)
      throw new Error(`No customer ${CUSTOMER_ID} in ${target.db}.`);
    if (
      customer.displayName.trim().toLowerCase() !== CUSTOMER_NAME.toLowerCase()
    ) {
      throw new Error(
        `Customer ${CUSTOMER_ID} is "${customer.displayName}", not ${CUSTOMER_NAME}. Stopping.`,
      );
    }
    const existing = await prisma.customerBranch.findMany({
      where: { customerId: CUSTOMER_ID },
      select: { name: true },
    });
    const have = new Set(existing.map((b) => b.name.toLowerCase()));
    const missing = BRANCHES.filter((name) => !have.has(name.toLowerCase()));
    for (const name of BRANCHES) {
      console.log(`  ${missing.includes(name) ? '+ add' : '= has'} ${name}`);
    }
    if (plan || missing.length === 0) return;

    const db = prisma as unknown as PrismaService;
    const branches = new CustomerBranchesService(db, new AuditService(db));
    const actor = await prisma.user.findFirst({
      where: { role: 'CORE_PARTNER', status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!actor)
      throw new Error('No active core partner to record the change under.');
    for (const name of missing) {
      // No default: the owner picks it (open question, §7).
      await branches.create(CUSTOMER_ID, { name, isDefault: false }, actor.id);
    }
    console.log(`Added ${missing.length}. No default branch set.`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
