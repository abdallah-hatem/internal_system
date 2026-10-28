/**
 * One-off, owner 2026-10-29: Shady paid 63,100 for CYC-2026-0002, not 72,100 —
 * "its 45,600 not 44,600, and i added 10,000 by mistake". His four advances
 * (all dated 24 Oct) read 10,000 · 44,600 · 7,500 · 10,000; the second 10,000
 * (entered 27 Oct 18:13) was entered by mistake and the 44,600 was 45,600.
 *
 * Through the app's own account service, each step skipped when already done:
 *   1. record 45,600 EGP for CYC-2026-0002, paid 2026-10-24 (`recordAdvance`);
 *   2. reverse the 44,600 (`reverse`, with the reason);
 *   3. reverse the 10,000 entered on 27 Oct (`reverse`, with the reason).
 * His standing advances then read 10,000 · 45,600 · 7,500 = 63,100.
 *
 *   DATABASE_URL=… JWT_SECRET=… npx ts-node --transpile-only \
 *     --compiler-options '{"module":"commonjs"}' \
 *     prisma/one-off/2026-10-29-shady-cyc-0002-advances.ts [--plan] [--production]
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PartnerAccountsService } from '../../src/modules/partner-accounts/partner-accounts.service';
import { assertTarget } from './2026-10-23-cyc-0001-extras.guards';

const CYCLE_CODE = 'CYC-2026-0002';
const DAY = '2026-10-24';
const EXPECTED_BEFORE = '72100';
const EXPECTED_AFTER = '63100';
const REASON_TYPO =
  'Entered as 44,600; Shady paid 45,600 (owner, 2026-10-29)';
const REASON_MISTAKE =
  'Entered by mistake — Shady paid 63,100 for CYC-2026-0002, not 72,100 (owner, 2026-10-29)';

async function main() {
  const argv = process.argv.slice(2);
  const target = assertTarget(process.env.DATABASE_URL, argv);
  const plan = argv.includes('--plan');
  console.log(
    `Shady's ${CYCLE_CODE} advances → ${target.db} at ${target.host}${target.production ? ' (PRODUCTION)' : ''}${plan ? ', plan only' : ''}`,
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
    const accounts = app.get(PartnerAccountsService);
    const shady = await db.user.findFirst({
      where: { role: 'CORE_PARTNER', email: { startsWith: 'shady@' } },
      select: { id: true },
    });
    const actor = await db.user.findFirst({
      where: {
        role: 'CORE_PARTNER',
        status: 'ACTIVE',
        email: { startsWith: 'abdallah@' },
      },
      select: { id: true },
    });
    const cycle = await db.importCycle.findFirst({
      where: { code: CYCLE_CODE },
      select: { id: true },
    });
    if (!shady || !actor || !cycle)
      throw new Error('Shady, Abdallah or the cycle not found.');

    const standing = () =>
      db.partnerAccountMovement.findMany({
        where: {
          partnerUserId: shady.id,
          kind: 'ADVANCE',
          cycleId: cycle.id,
          reversedAt: null,
        },
        orderBy: { createdAt: 'asc' },
        select: { id: true, amountEgp: true, createdAt: true },
      });
    const sum = (rows: { amountEgp: Prisma.Decimal }[]) =>
      rows.reduce((s, r) => s.add(r.amountEgp), new Prisma.Decimal(0));

    const before = await standing();
    const total = sum(before);
    console.log(
      `Standing: ${before.map((r) => r.amountEgp.toString()).join(' · ')} = ${total.toString()}`,
    );
    if (total.eq(EXPECTED_AFTER) && before.some((r) => r.amountEgp.eq(45600))) {
      console.log('Already 63,100. Nothing to do.');
      return;
    }
    const has456 = before.find((r) => r.amountEgp.eq(45600));
    const typo = before.find((r) => r.amountEgp.eq(44600));
    const tens = before.filter((r) => r.amountEgp.eq(10000));
    // The later of the two 10,000s (entered 27 Oct) is the mistaken one.
    const mistake = tens.length === 2 ? tens[1] : null;
    // Either the starting facts, or a run that stopped part way.
    const fresh = total.eq(EXPECTED_BEFORE) && typo && tens.length === 2;
    const partial = has456 && (typo || tens.length === 2);
    if (!fresh && !partial)
      throw new Error(
        `Starting facts do not match (standing ${total.toString()}). Stopping.`,
      );
    console.log(
      `Plan: ${has456 ? '' : 'record 45,600 on ' + DAY + '; '}${typo ? 'reverse the 44,600; ' : ''}${mistake ? `reverse the 10,000 entered ${mistake.createdAt.toISOString().slice(0, 16)}` : ''}`,
    );
    if (plan) return console.log('--plan: nothing written.');

    if (!has456)
      await accounts.recordAdvance(
        shady.id,
        { cycleId: cycle.id, amount: 45600, paidOn: DAY },
        actor.id,
      );
    if (typo) await accounts.reverse(shady.id, typo.id, REASON_TYPO, actor.id);
    if (mistake)
      await accounts.reverse(shady.id, mistake.id, REASON_MISTAKE, actor.id);

    const after = await standing();
    const now = sum(after);
    console.log(
      `Done: ${after.map((r) => r.amountEgp.toString()).join(' · ')} = ${now.toString()}`,
    );
    if (!now.eq(EXPECTED_AFTER))
      throw new Error(`Expected ${EXPECTED_AFTER}, got ${now.toString()}.`);
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error('\nFAILED:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
