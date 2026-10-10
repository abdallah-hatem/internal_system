/**
 * Writes the deliveries, batch links and absorbed losses that
 * `planShipmentBackfill` works out for every cycle (spec 2026-10-10,
 * amendment 10). Run it once after `prisma migrate deploy` applies
 * 20261010120000_shipment_deliveries:
 *
 *   cd apps/api && npm run db:backfill:deliveries
 *
 * Safe to run twice: the plan is keyed on what is already stored, so a second
 * run finds every leg delivered, every batch linked and every loss recorded,
 * and writes nothing. Each cycle is written in its own transaction under an
 * advisory lock, so two runs at once cannot both insert for the same cycle.
 * Run `npm run db:check` before and after.
 */
import { randomUUID } from 'node:crypto';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- a standalone script, like seed.ts: prisma/ is a Prisma zone, but the process.env block in eslint.config.mjs re-bans the import for prisma/**
import { PrismaClient } from '@prisma/client';
import { planShipmentBackfill } from '../src/common/shipment-backfill';

const LOCK_KEY = 20261010;

async function main() {
  const prisma = new PrismaClient();
  try {
    const cycles = await prisma.importCycle.findMany({
      select: { id: true, code: true },
    });
    let deliveries = 0;
    let links = 0;
    let losses = 0;
    for (const { id, code } of cycles) {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_KEY})`;
        const legs = await tx.shippingLeg.findMany({
          where: { cycleId: id },
          select: { id: true, sequence: true, arrivedOn: true },
        });
        const items = await tx.purchaseOrderItem.findMany({
          where: { purchaseOrder: { cycleId: id } },
          select: { id: true, orderedQty: true },
        });
        const batches = await tx.inventoryBatch.findMany({
          where: { cycleId: id },
          select: {
            id: true,
            sourcePoItemId: true,
            sourceDeliveryLineId: true,
            receivedQty: true,
            createdAt: true,
          },
        });
        const existing = await tx.shipmentDelivery.findMany({
          where: { leg: { cycleId: id } },
          select: {
            id: true,
            legId: true,
            arrivedOn: true,
            lines: { select: { id: true, purchaseOrderItemId: true } },
          },
        });
        const existingLosses = await tx.shipmentLoss.findMany({
          where: { leg: { cycleId: id } },
          select: { legId: true, purchaseOrderItemId: true, reason: true },
        });

        const plan = planShipmentBackfill(
          {
            legs,
            items,
            batches,
            deliveries: existing,
            losses: existingLosses,
          },
          randomUUID,
        );

        for (const d of plan.deliveries) {
          await tx.shipmentDelivery.create({
            data: {
              id: d.id,
              legId: d.legId,
              arrivedOn: new Date(`${d.arrivedOn}T00:00:00Z`),
              note: d.note,
              lines: {
                create: d.lines.map((l) => ({
                  id: l.id,
                  purchaseOrderItemId: l.purchaseOrderItemId,
                  qty: l.qty,
                })),
              },
            },
          });
        }
        for (const u of plan.legUpdates) {
          await tx.shippingLeg.update({
            where: { id: u.legId },
            data: {
              arrivedOn: new Date(`${u.arrivedOn}T00:00:00Z`),
              status: u.status,
            },
          });
        }
        for (const b of plan.batchLinks) {
          await tx.inventoryBatch.update({
            where: { id: b.batchId },
            data: {
              sourceDeliveryLineId: b.sourceDeliveryLineId,
              arrivedOn: new Date(`${b.arrivedOn}T00:00:00Z`),
            },
          });
        }
        if (plan.losses.length) {
          await tx.shipmentLoss.createMany({ data: plan.losses });
        }

        const n =
          plan.deliveries.length + plan.batchLinks.length + plan.losses.length;
        if (n) {
          process.stdout.write(
            `  ${code}: ${plan.deliveries.length} deliveries, ${plan.batchLinks.length} batches linked, ${plan.losses.length} absorbed losses\n`,
          );
        }
        deliveries += plan.deliveries.length;
        links += plan.batchLinks.length;
        losses += plan.losses.length;
      });
    }
    process.stdout.write(
      `Backfill: ${cycles.length} cycles, ${deliveries} deliveries, ${links} batches linked, ${losses} absorbed losses.\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
