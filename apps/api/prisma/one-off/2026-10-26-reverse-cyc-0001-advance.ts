/**
 * One-off, owner 2026-10-26: "just remove the funding i added". Abdallah
 * recorded 65,000 EGP as an advance on CYC-2026-0001 (dated 15 Aug, the first
 * repayment to Ahmad Eraiby), but that repayment is already inside his
 * 67,056.33 contribution — so it counted twice. Reverses that one advance
 * through PartnerAccountsService.reverse, with a reason, as the office's
 * Reverse button would.
 *
 *   DATABASE_URL=… JWT_SECRET=… npx ts-node --transpile-only \
 *     --compiler-options '{"module":"commonjs"}' \
 *     prisma/one-off/2026-10-26-reverse-cyc-0001-advance.ts [--plan] [--production]
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PartnerAccountsService } from '../../src/modules/partner-accounts/partner-accounts.service';
import { assertTarget } from './2026-10-23-cyc-0001-extras.guards';

const REASON =
  'Recorded by mistake: this repayment to Ahmad Eraiby is already in the 67,056.33 contribution (owner, 2026-10-26)';

async function main() {
  const argv = process.argv.slice(2);
  const target = assertTarget(process.env.DATABASE_URL, argv);
  console.log(
    `Reverse CYC-2026-0001's 65,000 advance → ${target.db} on ${target.host}${target.production ? ' (PRODUCTION)' : ''}${argv.includes('--plan') ? ', plan only' : ''}`,
  );
  const url = new URL(process.env.DATABASE_URL!);
  if (!url.searchParams.has('connection_limit'))
    url.searchParams.set('connection_limit', '1');
  process.env.DATABASE_URL = url.toString();

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const db = app.get(PrismaService);
    const cycle = await db.importCycle.findFirst({
      where: { code: 'CYC-2026-0001' },
      select: { id: true },
    });
    if (!cycle) throw new Error('CYC-2026-0001 not found.');
    const owner = await db.user.findFirst({
      where: {
        role: 'CORE_PARTNER',
        status: 'ACTIVE',
        email: { startsWith: 'abdallah@' },
      },
      select: { id: true, email: true },
    });
    if (!owner) throw new Error('No active core partner abdallah@….');
    const found = await db.partnerAccountMovement.findMany({
      where: {
        cycleId: cycle.id,
        partnerUserId: owner.id,
        kind: 'ADVANCE',
        amountEgp: 65000,
        reversedAt: null,
      },
      select: { id: true, occurredOn: true, amountEgp: true },
    });
    if (found.length === 0) {
      console.log(
        'Nothing to reverse: no standing 65,000 advance of Abdallah on CYC-2026-0001.',
      );
      return;
    }
    if (found.length > 1)
      throw new Error(`${found.length} matching advances; expected one.`);
    const m = found[0];
    console.log(
      `Plan: reverse advance ${m.id} (${String(m.amountEgp)} EGP, ${m.occurredOn?.toISOString().slice(0, 10)}): "${REASON}"`,
    );
    if (argv.includes('--plan')) {
      console.log('--plan: nothing written.');
      return;
    }
    await app
      .get(PartnerAccountsService)
      .reverse(owner.id, m.id, REASON, owner.id);
    const after = await db.partnerAccountMovement.findUnique({
      where: { id: m.id },
      select: { reversedAt: true },
    });
    console.log(
      after?.reversedAt
        ? `Reversed at ${after.reversedAt.toISOString()}.`
        : 'NOT reversed — check.',
    );
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error('\nFAILED:', err instanceof Error ? err.message : err);
  if (err && typeof err === 'object' && 'response' in err)
    console.error(JSON.stringify(err.response));
  process.exitCode = 1;
});
