import { Injectable } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; quantities and costs must not become floats
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  NotificationsService,
  notifyLowStock,
} from '../notifications/notifications.service';
import { badRequest, notFound } from '../../common/api-error';
import { isUuid } from '../../common/uuid';
import { businessDay, chosenDay } from '../../common/dates';
import { lockCycle } from '../../common/shipment-load';
import { findLowStock } from '../../common/low-stock';
import { refreshOpenSettlementStock } from '../../common/unsold-stock';
import {
  assertInScope,
  cyclesVisibleTo,
  type ScopeViewer,
} from '../../common/investor-scope';
import {
  STOCK_DAMAGE_REFERENCE,
  assertDamageable,
  assertNotBeforeReceived,
  damageCostEgp,
  damageCycleRefusal,
  damageQty,
  damageText,
  damageableOn,
  undoDamageRefusal,
} from '../../common/stock-damage';

type Db = Prisma.TransactionClient;

const D = (v: Prisma.Decimal.Value | null | undefined) =>
  new Prisma.Decimal(v ?? 0);

export interface MarkDamagedInput {
  qty: number | string;
  /** The Cairo day the damage was found; today when not given. */
  damagedOn?: string;
  note?: string;
}

const PERSON = {
  select: {
    id: true,
    email: true,
    partner: { select: { displayName: true } },
  },
} as const;

const personOf = (
  u: {
    id: string;
    email: string;
    partner?: { displayName: string } | null;
  } | null,
) => (u ? { id: u.id, name: u.partner?.displayName ?? u.email } : null);

/**
 * Units found damaged in storage, written off (BUSINESS_LOGIC §3, §8 — owner
 * 2026-11-28).
 *
 * Marking takes the units off the batch's shelf (remaining and sellable), with
 * a WRITE_OFF movement, and records what they cost as a `StockDamage` row — a
 * loss of the batch's cycle that every profit figure subtracts through
 * `cycleWriteOffsEgp`. No ledger row: no money moves (§9). Undoing puts the
 * units back on the same batch (an ADJUSTMENT movement) and marks the row
 * undone, kept with who, when and why.
 *
 * Every write runs in one transaction under the cycle's lock, the batch taken
 * by a guarded update so two marks at once cannot take the same units. Nothing
 * else is called from inside it (LEARNINGS: a one-connection pool); the audit
 * row and the low-stock alert go after the commit.
 */
@Injectable()
export class StockDamagesService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private notifications: NotificationsService,
  ) {}

  // ─── Reads ────────────────────────────────────────────────────────────

  /**
   * A cycle's damages, newest first, each with whether it can be undone now —
   * by the same refusal the undo runs, so the button is never offered for an
   * undo the server would refuse.
   */
  async forCycle(cycleId: string, viewer: ScopeViewer = 'internal') {
    if (!isUuid(cycleId)) throw notFound('cycle');
    assertInScope(await cyclesVisibleTo(viewer, this.prisma), cycleId);
    const cycle = await this.prisma.importCycle.findUnique({
      where: { id: cycleId },
      select: { id: true, code: true, status: true },
    });
    if (!cycle) throw notFound('cycle');
    const gate = damageCycleRefusal(
      cycle,
      await this.standingSettlement(this.prisma, cycleId),
    );
    const rows = await this.prisma.stockDamage.findMany({
      where: { batch: { cycleId } },
      orderBy: [{ damagedOn: 'desc' }, { createdAt: 'desc' }],
      include: {
        batch: {
          select: {
            id: true,
            product: {
              select: { id: true, name: true, nameAr: true, sku: true },
            },
          },
        },
        creator: PERSON,
        undoer: PERSON,
      },
    });
    const refusalOf = (e: ReturnType<typeof undoDamageRefusal>) => {
      const body = e?.getResponse() as
        { code: string; params?: Record<string, string | number> } | undefined;
      return body ? { code: body.code, params: body.params ?? {} } : null;
    };
    return {
      data: {
        cycleId,
        /** Why nothing can be marked or undone on this cycle now, or null. */
        locked: refusalOf(gate),
        damages: rows.map((r) => {
          const no = gate ?? undoDamageRefusal(r);
          return {
            id: r.id,
            batchId: r.batchId,
            productId: r.batch.product.id,
            productName: r.batch.product.name,
            productNameAr: r.batch.product.nameAr,
            sku: r.batch.product.sku,
            qty: D(r.qty).toFixed(0),
            unitCostEgp: D(r.unitCostEgp).toFixed(4),
            costEgp: D(r.costEgp).toFixed(2),
            damagedOn: businessDay(r.damagedOn),
            note: r.note,
            createdAt: r.createdAt,
            createdBy: personOf(r.creator),
            undoneAt: r.undoneAt,
            undoneBy: personOf(r.undoer),
            undoReason: r.undoReason,
            undo: { allowed: !no, ...(refusalOf(no) ?? {}) },
          };
        }),
      },
    };
  }

  // ─── Writes ───────────────────────────────────────────────────────────

  async mark(batchId: string, dto: MarkDamagedInput, actorId: string) {
    if (!isUuid(batchId)) throw notFound('inventoryBatch');
    const qty = damageQty(dto?.qty);
    const day = chosenDay(dto?.damagedOn, 'STOCK_DAMAGED');
    const note = damageText(dto?.note, 'note') || null;

    const head = await this.prisma.inventoryBatch.findUnique({
      where: { id: batchId },
      select: { cycleId: true },
    });
    if (!head) throw notFound('inventoryBatch');

    const result = await this.prisma.$transaction(async (tx) => {
      await lockCycle(tx, head.cycleId);
      const batch = await tx.inventoryBatch.findUnique({
        where: { id: batchId },
        include: {
          product: { select: { id: true, name: true } },
          cycle: { select: { id: true, code: true, status: true } },
        },
      });
      if (!batch) throw notFound('inventoryBatch');
      const gate = damageCycleRefusal(
        batch.cycle,
        await this.standingSettlement(tx, batch.cycleId),
      );
      if (gate) throw gate;
      assertNotBeforeReceived(day, businessDay(batch.createdAt));

      const held = await tx.inventoryReservation.aggregate({
        where: {
          batchId,
          status: 'ACTIVE',
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        _sum: { qty: true },
      });
      const available = damageableOn({
        verificationStatus: batch.verificationStatus,
        saleableQty: batch.saleableQty,
        heldQty: D(held._sum?.qty),
      });
      assertDamageable(qty, available, batch.product.name);

      // Guarded: a sale confirming now (sales do not take the cycle's lock)
      // may have taken some of these units since they were read.
      const taken = await tx.inventoryBatch.updateMany({
        where: {
          id: batchId,
          saleableQty: { gte: qty },
          remainingQty: { gte: qty },
        },
        data: {
          saleableQty: { decrement: qty },
          remainingQty: { decrement: qty },
          version: { increment: 1 },
        },
      });
      if (taken.count !== 1) {
        throw badRequest(
          'STOCK_DAMAGE_MORE_THAN_ON_SHELF',
          `${batch.product.name} changed on the shelf while it was being marked; try again.`,
          {
            product: batch.product.name,
            available: '—',
            requested: qty.toFixed(0),
          },
        );
      }

      const costEgp = damageCostEgp({
        qty,
        unitCostEgp: batch.landedUnitCostEgp,
        final: await this.lineResidual(tx, batch),
      });

      const damage = await tx.stockDamage.create({
        data: {
          batchId,
          qty,
          unitCostEgp: batch.landedUnitCostEgp,
          costEgp,
          damagedOn: new Date(`${day}T00:00:00Z`),
          note,
          createdBy: actorId,
        },
      });
      await tx.inventoryMovement.create({
        data: {
          batchId,
          movementType: 'WRITE_OFF',
          qtyDelta: qty.neg(),
          referenceType: STOCK_DAMAGE_REFERENCE,
          referenceId: damage.id,
          createdBy: actorId,
        },
      });
      // A draft or approved settlement shows what the cycle still holds.
      await refreshOpenSettlementStock(tx, batch.cycleId);
      const lowStock = await findLowStock(tx, [batch.productId]);
      return { damage, batch, lowStock };
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'CREATE',
      entityType: 'StockDamage',
      entityId: result.damage.id,
      afterJson: {
        cycle: result.batch.cycle.code,
        batchId,
        product: result.batch.product.name,
        qty: qty.toFixed(0),
        damagedOn: day,
        costEgp: D(result.damage.costEgp).toFixed(2),
        ...(note ? { note } : {}),
      },
    });
    // The shelf just got smaller: the same alert a sale raises (§3).
    await notifyLowStock(this.prisma, this.notifications, result.lowStock);

    return {
      data: {
        id: result.damage.id,
        batchId,
        cycle: { id: result.batch.cycle.id, code: result.batch.cycle.code },
        productName: result.batch.product.name,
        qty: qty.toFixed(0),
        unitCostEgp: D(result.damage.unitCostEgp).toFixed(4),
        costEgp: D(result.damage.costEgp).toFixed(2),
        damagedOn: day,
        note,
      },
    };
  }

  /** Put the units back on their batch, keeping the record, marked undone. */
  async undo(damageId: string, reasonIn: unknown, actorId: string) {
    if (!isUuid(damageId)) throw notFound('stockDamage');
    const reason = damageText(reasonIn, 'reason');
    if (!reason) {
      throw badRequest(
        'STOCK_DAMAGE_REASON_REQUIRED',
        'Say why the damage is being undone.',
      );
    }
    const head = await this.prisma.stockDamage.findUnique({
      where: { id: damageId },
      select: { batch: { select: { cycleId: true } } },
    });
    if (!head) throw notFound('stockDamage');

    const result = await this.prisma.$transaction(async (tx) => {
      await lockCycle(tx, head.batch.cycleId);
      const damage = await tx.stockDamage.findUnique({
        where: { id: damageId },
        include: {
          batch: {
            include: {
              cycle: { select: { id: true, code: true, status: true } },
              product: { select: { name: true } },
            },
          },
        },
      });
      if (!damage) throw notFound('stockDamage');
      const no =
        undoDamageRefusal(damage) ??
        damageCycleRefusal(
          damage.batch.cycle,
          await this.standingSettlement(tx, damage.batch.cycleId),
        );
      if (no) throw no;

      // Claimed by an update only one undo can win: two at once put the
      // units back once.
      const claimed = await tx.stockDamage.updateMany({
        where: { id: damageId, undoneAt: null },
        data: { undoneAt: new Date(), undoneBy: actorId, undoReason: reason },
      });
      if (claimed.count !== 1) {
        throw badRequest(
          'STOCK_DAMAGE_ALREADY_UNDONE',
          'This damage has already been undone.',
        );
      }
      const qty = D(damage.qty);
      await tx.inventoryBatch.update({
        where: { id: damage.batchId },
        data: {
          saleableQty: { increment: qty },
          remainingQty: { increment: qty },
          version: { increment: 1 },
        },
      });
      await tx.inventoryMovement.create({
        data: {
          batchId: damage.batchId,
          movementType: 'ADJUSTMENT',
          qtyDelta: qty,
          referenceType: STOCK_DAMAGE_REFERENCE,
          referenceId: damage.id,
          createdBy: actorId,
        },
      });
      await refreshOpenSettlementStock(tx, damage.batch.cycleId);
      return damage;
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'REVERSE',
      entityType: 'StockDamage',
      entityId: result.id,
      beforeJson: { status: 'STANDING' },
      afterJson: { status: 'UNDONE', reason },
    });

    return { data: { id: result.id, status: 'UNDONE' } };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  /** An approved or paid settlement on the cycle, if any. */
  private async standingSettlement(
    db: Db | PrismaService,
    cycleId: string,
  ): Promise<'APPROVED' | 'PAID' | null> {
    const s = await db.settlement.findFirst({
      where: { cycleId, status: { in: ['APPROVED', 'PAID'] } },
      select: { status: true },
    });
    return (s?.status as 'APPROVED' | 'PAID' | undefined) ?? null;
  }

  /**
   * When this damage takes the last units of its order line, what the line
   * was booked at and what has already been drawn from its batches at cost —
   * for `damageCostEgp`'s residual (§2). Read after the batch was taken down.
   * Null when the line still has units somewhere, or anything of it was moved
   * to another cycle, or the batch did not come from an order line.
   */
  private async lineResidual(
    tx: Db,
    batch: {
      id: string;
      sourcePoItemId: string | null;
      transferredFromBatchId: string | null;
    },
  ) {
    if (!batch.sourcePoItemId || batch.transferredFromBatchId) return undefined;
    const lineId = batch.sourcePoItemId;
    const line = await tx.purchaseOrderItem.findUnique({
      where: { id: lineId },
      select: { orderedQty: true },
    });
    const batches = await tx.inventoryBatch.findMany({
      where: { sourcePoItemId: lineId },
      select: {
        id: true,
        receivedQty: true,
        remainingQty: true,
        saleableQty: true,
      },
    });
    if (!line || batches.length === 0) return undefined;
    if (
      batches.some(
        (b) => !D(b.remainingQty).isZero() || !D(b.saleableQty).isZero(),
      )
    ) {
      return undefined;
    }
    const lost = await tx.shipmentLoss.aggregate({
      where: { purchaseOrderItemId: lineId },
      _sum: { qty: true },
    });
    const received = batches.reduce((s, b) => s.add(b.receivedQty), D(0));
    if (!received.add(D(lost._sum?.qty)).eq(D(line.orderedQty)))
      return undefined;
    const ids = batches.map((b) => b.id);
    const movedOut = await tx.stockTransferLine.count({
      where: { sourceBatchId: { in: ids }, transfer: { status: 'ACTIVE' } },
    });
    if (movedOut > 0) return undefined;

    const [booked, drawn, returned, damaged] = await Promise.all([
      tx.financialTransaction.aggregate({
        where: {
          type: 'PURCHASE_COST',
          relatedType: 'PURCHASE_ORDER_ITEM',
          relatedId: lineId,
          reversalOfId: null,
        },
        _sum: { amount: true },
      }),
      tx.saleItemAllocation.aggregate({
        where: { inventoryBatchId: { in: ids } },
        _sum: { cogsEgp: true },
      }),
      tx.saleReturnItem.aggregate({
        where: { inventoryBatchId: { in: ids }, restocked: true },
        _sum: { cogsReversedEgp: true },
      }),
      tx.stockDamage.aggregate({
        where: { batchId: { in: ids }, undoneAt: null },
        _sum: { costEgp: true },
      }),
    ]);
    return {
      bookedEgp: D(booked._sum?.amount),
      drawnEgp: D(drawn._sum?.cogsEgp)
        .sub(D(returned._sum?.cogsReversedEgp))
        .add(D(damaged._sum?.costEgp)),
    };
  }
}
