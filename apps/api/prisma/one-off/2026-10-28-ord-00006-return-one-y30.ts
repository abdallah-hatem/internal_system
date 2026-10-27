/**
 * One-off, owner 2026-10-28: "I need to return 1 Y30 Headset from zogmars
 * samples he has 2 just return one in prod". Returning only part of a samples
 * order is queued (BUILD_LOG Next up, "Return some samples, not all"), so this
 * does it once with the samples code "They're buying" already uses: the unit
 * is taken off ORD-2026-00006 (`takeFromSamples`), put back on the shelf of the
 * batch it left (`sampleBack`, a SAMPLE_BACK movement), and the order's lines
 * rewritten (`settleSamplesLeft`) — one Y30 stays at the shop, the order stays
 * open with its day left and reminder. One transaction; the audit log records it.
 *
 *   DATABASE_URL=… JWT_SECRET=… npx ts-node --transpile-only \
 *     --compiler-options '{"module":"commonjs"}' \
 *     prisma/one-off/2026-10-28-ord-00006-return-one-y30.ts [--plan] [--production]
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { SalesService } from '../../src/modules/sales/sales.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { assertTarget } from './2026-10-23-cyc-0001-extras.guards';

const ORDER_NO = 'ORD-2026-00006';
const CUSTOMER_ID = 'ceadced7-457a-4803-9241-3520b6bda1ac'; // Ahmad Zogmar
const PRODUCT_ID = 'b0902f05-4c05-492c-bc1d-1dd8e778e71e'; // Y30 Headset
const EXPECTED_BEFORE = 2;

type Source = {
  id: string;
  items: {
    id: string;
    productId: string;
    quantity: Prisma.Decimal.Value;
    allocations: { inventoryBatchId: string; qty: Prisma.Decimal.Value }[];
  }[];
};
type SamplesInternals = {
  claimOpenSamples(tx: unknown, id: string): Promise<unknown>;
  readOpenSamples(tx: unknown, id: string): Promise<Source>;
  takeFromSamples(
    tx: unknown,
    source: Source,
    productId: string,
    batchId: string,
    qty: Prisma.Decimal,
  ): Promise<void>;
  sampleBack(
    tx: unknown,
    orderId: string,
    batchId: string,
    qty: Prisma.Decimal,
    actorId: string,
  ): Promise<void>;
  settleSamplesLeft(tx: unknown, source: Source): Promise<string>;
};

const unitsOf = (s: Source) =>
  s.items
    .filter((i) => i.productId === PRODUCT_ID)
    .flatMap((i) => i.allocations)
    .reduce((n, a) => n.add(a.qty), new Prisma.Decimal(0));

async function main() {
  const argv = process.argv.slice(2);
  const target = assertTarget(process.env.DATABASE_URL, argv);
  const plan = argv.includes('--plan');
  console.log(
    `${ORDER_NO}: return 1 Y30 → ${target.db} on ${target.host}${target.production ? ' (PRODUCTION)' : ''}${plan ? ', plan only' : ''}`,
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
    const sales = app.get(SalesService) as unknown as SamplesInternals;
    const order = await db.saleOrder.findFirst({
      where: { orderNo: ORDER_NO },
      select: { id: true, status: true, customerId: true },
    });
    if (!order) throw new Error(`${ORDER_NO} not found.`);
    if (order.customerId !== CUSTOMER_ID)
      throw new Error(`${ORDER_NO} is not Ahmad Zogmar's.`);
    if (order.status !== 'SAMPLES')
      throw new Error(`${ORDER_NO} is ${order.status}, not open samples.`);
    const before = await sales.readOpenSamples(db, order.id);
    const held = unitsOf(before);
    if (!held.eq(EXPECTED_BEFORE)) {
      throw new Error(
        `${ORDER_NO} holds ${held.toString()} Y30, not ${EXPECTED_BEFORE} — already done, or changed. Stopping.`,
      );
    }
    const draw = before.items
      .filter((i) => i.productId === PRODUCT_ID)
      .flatMap((i) => i.allocations)
      .find((a) => new Prisma.Decimal(a.qty).gt(0))!;
    console.log(
      `Plan: 1 Y30 back to batch ${draw.inventoryBatchId}; ${ORDER_NO} keeps 1 Y30 and stays open.`,
    );
    if (plan) return console.log('--plan: nothing written.');

    const actor = await db.user.findFirst({
      where: {
        role: 'CORE_PARTNER',
        status: 'ACTIVE',
        email: { startsWith: 'abdallah@' },
      },
      select: { id: true },
    });
    if (!actor) throw new Error('No active core partner abdallah@….');
    const one = new Prisma.Decimal(1);
    const status = await db.$transaction(
      async (tx) => {
        await sales.claimOpenSamples(tx, order.id);
        const source = await sales.readOpenSamples(tx, order.id);
        if (!unitsOf(source).eq(EXPECTED_BEFORE))
          throw new Error('The order changed while this ran. Nothing written.');
        await sales.takeFromSamples(
          tx,
          source,
          PRODUCT_ID,
          draw.inventoryBatchId,
          one,
        );
        await sales.sampleBack(
          tx,
          order.id,
          draw.inventoryBatchId,
          one,
          actor.id,
        );
        return sales.settleSamplesLeft(tx, source);
      },
      { maxWait: 30_000, timeout: 120_000 },
    );
    await app.get(AuditService).log({
      actorUserId: actor.id,
      action: 'UPDATE',
      entityType: 'SaleOrder',
      entityId: order.id,
      beforeJson: { y30AtShop: EXPECTED_BEFORE },
      afterJson: {
        y30AtShop: 1,
        returnedToBatch: draw.inventoryBatchId,
        status,
        reason: 'The shop returned 1 of its 2 Y30 samples (owner, 2026-10-28)',
      },
    });
    const after = await sales.readOpenSamples(db, order.id);
    console.log(
      `Done: ${ORDER_NO} is ${status}, holding ${unitsOf(after).toString()} Y30.`,
    );
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error('\nFAILED:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
