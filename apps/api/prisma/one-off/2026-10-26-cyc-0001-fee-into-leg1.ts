/**
 * One-off correction, owner 2026-10-26: CYC-2026-0001's Alibaba card
 * processing fee (241.07 AED = 3,338.82 EGP at 13.85) is part of the China →
 * UAE shipping, not a separate expense. "b for the fee its a part of the
 * shipping fee at this part"; "do it yourself with the script".
 *
 *   DATABASE_URL=…/motorcycle_parts_prodcopy JWT_SECRET=… \
 *     npx ts-node --transpile-only --compiler-options '{"module":"commonjs"}' \
 *     prisma/one-off/2026-10-26-cyc-0001-fee-into-leg1.ts [--plan] [--production]
 *
 *   --plan        checks the starting facts, prints the change; writes nothing
 *   --production  required for any database other than the local copy
 *
 * Two steps, both through the app's own services:
 *   1. LedgerService.reverse — the `bank_fees` expense, with a reason;
 *   2. ShippingService.updateLeg — leg 1 FLAT 1,551.74 → 1,792.81 AED at 13.85,
 *      which re-costs the cycle (every batch, its purchase entry, every sale's
 *      COGS — BUSINESS_LOGIC §2).
 * The cycle's total cost does not change: 3,338.82 leaves its expenses and
 * enters its leg 1. Each step is skipped when already done, so a run that
 * stopped part way is finished by running it again.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { LedgerService } from '../../src/modules/ledger/ledger.service';
import { ShippingService } from '../../src/modules/shipping/shipping.service';
import { CostingService } from '../../src/modules/costing/costing.service';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { PushService } from '../../src/modules/notifications/push.service';
import { assertTarget } from './2026-10-23-cyc-0001-extras.guards';

const CYCLE = 'CYC-2026-0001';
const FEE_EGP = '3338.82';
const LEG1_BEFORE = '1551.74';
const LEG1_AFTER = '1792.81'; // + 241.07 AED, the fee in the leg's own currency
const LEG1_RATE = '13.85';
const REASON =
  'Moved into leg 1 (China → UAE): the Alibaba card fee is part of that shipping (owner, 2026-10-26)';

const money = (v: unknown) => Number(v).toFixed(2);

async function state(app: INestApplicationContext) {
  const db = app.get(PrismaService);
  const cycle = await db.importCycle.findFirst({
    where: { code: CYCLE },
    select: { id: true, status: true },
  });
  if (!cycle) throw new Error(`${CYCLE} not found.`);
  const leg1 = await db.shippingLeg.findFirst({
    where: { cycleId: cycle.id, sequence: 1 },
  });
  if (!leg1) throw new Error(`${CYCLE} has no leg 1.`);
  const fees = await db.financialTransaction.findMany({
    where: { cycleId: cycle.id, category: 'bank_fees', reversalOfId: null },
  });
  const reversals = await db.financialTransaction.findMany({
    where: { reversalOfId: { in: fees.map((f) => f.id) } },
    select: { reversalOfId: true },
  });
  const reversed = new Set(reversals.map((r) => r.reversalOfId));
  return { cycle, leg1, fees, reversed };
}

async function figures(app: INestApplicationContext, cycleId: string) {
  const db = app.get(PrismaService);
  const leg1 = await db.shippingLeg.findFirst({
    where: { cycleId, sequence: 1 },
    select: { amount: true, amountEgp: true },
  });
  const cost = await app.get(CostingService).cycleCost(cycleId);
  const batches = await db.inventoryBatch.findMany({
    where: { cycleId },
    select: {
      landedUnitCostEgp: true,
      receivedQty: true,
      remainingQty: true,
      product: { select: { name: true } },
    },
    orderBy: { product: { name: 'asc' } },
  });
  const cogs = await db.saleItemAllocation.aggregate({
    where: { inventoryBatch: { cycleId } },
    _sum: { cogsEgp: true },
  });
  return { leg1, cost, batches, cogs: money(cogs._sum.cogsEgp ?? 0) };
}

async function run(app: INestApplicationContext, argv: string[]) {
  const s = await state(app);
  const standing = s.fees.filter((f) => !s.reversed.has(f.id));
  const legDone = money(s.leg1.amount) === LEG1_AFTER;
  const feeDone = standing.length === 0;

  // The starting facts — stop on anything this was not written for.
  const problems: string[] = [];
  if (['SETTLEMENT', 'CLOSED', 'CANCELLED'].includes(s.cycle.status))
    problems.push(`the cycle is ${s.cycle.status}`);
  if (s.leg1.costBasis !== 'FLAT' || s.leg1.currency !== 'AED')
    problems.push(
      `leg 1 is ${s.leg1.costBasis} in ${s.leg1.currency}, not FLAT AED`,
    );
  if (Number(s.leg1.fxRateToEgp).toFixed(2) !== LEG1_RATE)
    problems.push(
      `leg 1's rate is ${String(s.leg1.fxRateToEgp)}, not ${LEG1_RATE}`,
    );
  if (!legDone && money(s.leg1.amount) !== LEG1_BEFORE)
    problems.push(
      `leg 1 is ${money(s.leg1.amount)} AED, neither ${LEG1_BEFORE} nor ${LEG1_AFTER}`,
    );
  if (standing.length > 1)
    problems.push(
      `${standing.length} standing bank_fees entries, expected one`,
    );
  if (standing.length === 1 && money(standing[0].amount) !== FEE_EGP)
    problems.push(
      `the fee is ${money(standing[0].amount)} EGP, not ${FEE_EGP}`,
    );
  if (standing.length === 1 && standing[0].type !== 'EXPENSE')
    problems.push(`the fee entry is ${standing[0].type}, not EXPENSE`);
  if (problems.length)
    throw new Error(`Starting facts do not match: ${problems.join('; ')}.`);
  if (legDone && feeDone) {
    console.log(
      'Already applied: the fee is reversed and leg 1 is 1,792.81 AED. Nothing to do.',
    );
    return;
  }

  console.log(`\nPlan for ${CYCLE} (${s.cycle.status}):`);
  console.log(
    feeDone
      ? '1. bank_fees expense — already reversed'
      : `1. reverse the bank_fees expense ${money(standing[0].amount)} EGP (${standing[0].id}): "${REASON}"`,
  );
  console.log(
    legDone
      ? '2. leg 1 — already 1,792.81 AED'
      : `2. leg 1 ${s.leg1.id}: FLAT ${LEG1_BEFORE} → ${LEG1_AFTER} AED at ${LEG1_RATE} (updateLeg, re-costs the cycle)`,
  );
  if (argv.includes('--plan')) {
    console.log('\n--plan: nothing written.');
    return;
  }

  // A correction of the past reaches nobody's phone.
  const notifications = app.get(NotificationsService);
  notifications.create = () => Promise.resolve(undefined as never);
  notifications.createForMultipleUsers = () =>
    Promise.resolve(undefined as never);
  app.get(PushService).sendToUsers = () => Promise.resolve(undefined as never);

  const db = app.get(PrismaService);
  const actor = await db.user.findFirst({
    where: {
      role: 'CORE_PARTNER',
      status: 'ACTIVE',
      email: { startsWith: 'abdallah@' },
    },
    select: { id: true, email: true },
  });
  if (!actor)
    throw new Error(
      'No active core partner abdallah@… to record the correction as.',
    );
  console.log(`\nRecording as ${actor.email}.`);

  const before = await figures(app, s.cycle.id);
  if (!feeDone) {
    await app.get(LedgerService).reverse(standing[0].id, REASON, actor.id);
    console.log('  - reversed the bank_fees expense');
  }
  if (!legDone) {
    await app
      .get(ShippingService)
      .updateLeg(s.leg1.id, { amount: Number(LEG1_AFTER) }, actor.id);
    console.log(`  ~ leg 1 → ${LEG1_AFTER} AED at ${LEG1_RATE}`);
  }
  const after = await figures(app, s.cycle.id);

  console.log('\n══ Before → after ══');
  console.log(
    `  leg 1, EGP              ${money(before.leg1?.amountEgp)} → ${money(after.leg1?.amountEgp)}`,
  );
  console.log(
    `  cycle cost, EGP         ${JSON.stringify(before.cost)} → ${JSON.stringify(after.cost)}`,
  );
  console.log(`  COGS of sales, EGP      ${before.cogs} → ${after.cogs}`);
  console.log('  batches (received/remaining): landed unit cost, EGP');
  after.batches.forEach((b, i) => {
    console.log(
      `    ${b.product.name.slice(0, 40).padEnd(40)} ${String(Number(b.receivedQty))}/${String(Number(b.remainingQty))}  ${Number(before.batches[i]?.landedUnitCostEgp).toFixed(4)} → ${Number(b.landedUnitCostEgp).toFixed(4)}`,
    );
  });
  console.log('\nDone. Run scripts/check-data.sh against this database next.');
}

async function main() {
  const argv = process.argv.slice(2);
  const target = assertTarget(process.env.DATABASE_URL, argv);
  console.log(
    `${CYCLE} fee into leg 1 → ${target.db} on ${target.host}${target.production ? ' (PRODUCTION)' : ''}${argv.includes('--plan') ? ', plan only' : ''}`,
  );
  const url = new URL(process.env.DATABASE_URL!);
  if (!url.searchParams.has('connection_limit'))
    url.searchParams.set('connection_limit', '1');
  if (!url.searchParams.has('pool_timeout'))
    url.searchParams.set('pool_timeout', '20');
  process.env.DATABASE_URL = url.toString();

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const db = app.get(PrismaService);
    const original = db.$transaction.bind(db) as (
      ...a: unknown[]
    ) => Promise<unknown>;
    (db as unknown as { $transaction: unknown }).$transaction = (
      arg: unknown,
      opts?: object,
    ) =>
      typeof arg === 'function'
        ? original(arg, { maxWait: 30_000, timeout: 120_000, ...opts })
        : original(arg, opts);
    await run(app, argv);
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('\nFAILED:', err instanceof Error ? err.message : err);
    if (err && typeof err === 'object' && 'response' in err)
      console.error(JSON.stringify(err.response));
    process.exitCode = 1;
  });
}
