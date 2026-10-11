import { Injectable } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; quantities and costs must not become floats
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { badRequest, notFound } from '../../common/api-error';
import { assertUuid, isUuid } from '../../common/uuid';
import {
  assertInScope,
  cyclesVisibleTo,
  type ScopeViewer,
} from '../../common/investor-scope';
import { lockCycle } from '../../common/shipment-load';
import { shipmentUnaccounted } from '../../common/shipment-accounted';
import { refreshOpenSettlementStock } from '../../common/unsold-stock';
import {
  assertNotFuture,
  businessDay,
  businessToday,
} from '../../common/dates';
import { TRANSFER_CATEGORY } from '../../common/ledger-categories';
import { formatMoney } from '../../common/money';
import {
  fifo,
  movableOn,
  planTransferLines,
  sourceRefusal,
  targetRefusal,
  transferTotalEgp,
  undoRefusal,
  type ShelfBatch,
} from '../../common/stock-transfers';

type Db = Prisma.TransactionClient;

export interface CreateTransferInput {
  toCycleId: string;
  /** The Cairo day the units moved; today when not given. */
  movedOn?: string;
  reason: string;
  lines: { productId: string; qty: number | string }[];
}

const D = (v: Prisma.Decimal.Value | null | undefined) =>
  new Prisma.Decimal(v ?? 0);

/** The rows a transfer's ledger pair and movements point back at. */
const REFERENCE = 'STOCK_TRANSFER';

const dayOf = (value?: string) =>
  new Date(`${value ? businessDay(value) : businessToday()}T00:00:00Z`);

/**
 * Leftover stock moved to another cycle at its cost (BUSINESS_LOGIC §8 — owner
 * 2026-10-11, built L5).
 *
 * The giving cycle's batches drop, a new batch on the receiving cycle carries
 * the same unit cost and the same check-in, and two `cycle_transfer` ledger
 * rows record that the cost moved with the goods — no cash, no income, no
 * expense. Undone, never edited (§9).
 *
 * Every write runs in one transaction holding both cycles' locks, in id order
 * so two transfers between the same pair cannot deadlock. Nothing else is
 * called from inside it (LEARNINGS: a one-connection pool); the audit row is
 * written after the commit.
 */
@Injectable()
export class StockTransfersService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  // ─── Reads ────────────────────────────────────────────────────────────

  /**
   * Transfers out of and into a cycle, newest first, each with whether it can
   * still be undone — by the same `undoRefusal` the undo itself runs, so the
   * button is never offered for a move the server would refuse.
   */
  async forCycle(cycleId: string, viewer: ScopeViewer = 'internal') {
    if (!isUuid(cycleId)) throw notFound('cycle');
    assertInScope(await cyclesVisibleTo(viewer, this.prisma), cycleId);
    const cycle = await this.prisma.importCycle.findUnique({
      where: { id: cycleId },
      select: { id: true },
    });
    if (!cycle) throw notFound('cycle');

    const rows = await this.prisma.stockTransfer.findMany({
      where: { OR: [{ fromCycleId: cycleId }, { toCycleId: cycleId }] },
      orderBy: [{ movedOn: 'desc' }, { createdAt: 'desc' }],
      include: TRANSFER_INCLUDE,
    });
    const paid = await this.paidCycles(
      rows.map((r) => r.fromCycleId),
      this.prisma,
    );

    const shape = (r: (typeof rows)[number]) => {
      const refusal = undoRefusal(undoInput(r, paid.has(r.fromCycleId)));
      const body = refusal?.getResponse() as
        { code: string; params?: Record<string, string | number> } | undefined;
      return {
        id: r.id,
        status: r.status,
        movedOn: r.movedOn,
        reason: r.reason,
        createdAt: r.createdAt,
        createdBy: personOf(r.actor),
        reversedAt: r.reversedAt,
        reversalReason: r.reversalReason,
        reversedBy: r.reverser ? personOf(r.reverser) : null,
        fromCycle: { id: r.fromCycle.id, code: r.fromCycle.code },
        toCycle: { id: r.toCycle.id, code: r.toCycle.code },
        totalCostEgp: transferTotalEgp(r.lines).toFixed(2),
        lines: r.lines.map((l) => ({
          id: l.id,
          productId: l.productId,
          productName: l.product.name,
          sku: l.product.sku,
          sourceBatchId: l.sourceBatchId,
          destBatchId: l.destBatchId,
          qty: D(l.qty).toFixed(3),
          unitCostEgp: D(l.unitCostEgp).toFixed(4),
          costEgp: D(l.costEgp).toFixed(2),
        })),
        undo: body
          ? { allowed: false, code: body.code, params: body.params ?? {} }
          : { allowed: true },
      };
    };

    return {
      data: {
        out: rows.filter((r) => r.fromCycleId === cycleId).map(shape),
        in: rows.filter((r) => r.toCycleId === cycleId).map(shape),
      },
    };
  }

  /**
   * What `cycleId` could hand on now, per product, oldest check-in first —
   * and, when it cannot hand anything on, why (the same refusal `create`
   * throws), so the dialog says it instead of offering a form that will fail.
   */
  async movable(cycleId: string, viewer: ScopeViewer = 'internal') {
    if (!isUuid(cycleId)) throw notFound('cycle');
    assertInScope(await cyclesVisibleTo(viewer, this.prisma), cycleId);
    const cycle = await this.prisma.importCycle.findUnique({
      where: { id: cycleId },
      select: { id: true, code: true, status: true },
    });
    if (!cycle) throw notFound('cycle');

    const refusal = await this.sourceGate(this.prisma, cycle);
    const shelf = await this.shelf(this.prisma, cycleId);
    const products = new Map<
      string,
      {
        productId: string;
        productName: string;
        sku: string;
        available: Prisma.Decimal;
        batches: {
          id: string;
          available: string;
          unitCostEgp: string;
          arrivedOn: Date | null;
        }[];
      }
    >();
    for (const b of shelf) {
      const free = movableOn(b);
      if (free.lte(0)) continue;
      const p = products.get(b.productId) ?? {
        productId: b.productId,
        productName: b.productName,
        sku: b.sku,
        available: D(0),
        batches: [],
      };
      p.available = p.available.add(free);
      p.batches.push({
        id: b.id,
        available: free.toFixed(3),
        unitCostEgp: D(b.landedUnitCostEgp).toFixed(4),
        arrivedOn: b.arrivedOn,
      });
      products.set(b.productId, p);
    }
    const body = refusal?.getResponse() as
      | { code: string; message: string; params?: Record<string, unknown> }
      | undefined;
    return {
      data: {
        cycle: { id: cycle.id, code: cycle.code, status: cycle.status },
        refusal: body ?? null,
        products: [...products.values()].map((p) => ({
          ...p,
          available: p.available.toFixed(3),
        })),
      },
    };
  }

  // ─── Writes ───────────────────────────────────────────────────────────

  async create(fromCycleId: string, dto: CreateTransferInput, actorId: string) {
    assertUuid(fromCycleId, 'cycleId');
    if (!isUuid(dto?.toCycleId)) throw notFound('cycle');
    const reason = String(dto.reason ?? '').trim();
    if (!reason) {
      throw badRequest(
        'TRANSFER_REASON_REQUIRED',
        'Say why the leftovers are moving.',
      );
    }
    assertNotFuture(dto.movedOn, 'STOCK_MOVED');
    const wanted = Array.isArray(dto.lines) ? dto.lines : [];
    for (const w of wanted) {
      if (!isUuid(w?.productId)) throw notFound('product');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      for (const id of [...new Set([fromCycleId, dto.toCycleId])].sort()) {
        await lockCycle(tx, id);
      }
      const from = await tx.importCycle.findUnique({
        where: { id: fromCycleId },
        select: { id: true, code: true, status: true },
      });
      if (!from) throw notFound('cycle');
      const to = await tx.importCycle.findUnique({
        where: { id: dto.toCycleId },
        select: { id: true, code: true, status: true },
      });
      if (!to) throw notFound('cycle');

      const sourceNo = await this.sourceGate(tx, from);
      if (sourceNo) throw sourceNo;
      const targetNo = targetRefusal(from, to);
      if (targetNo) throw targetNo;

      const shelf = await this.shelf(tx, from.id);
      const names = await this.productNames(
        tx,
        wanted.map((w) => w.productId),
      );
      const lines = planTransferLines(shelf, wanted, names);
      const total = transferTotalEgp(lines);

      const transfer = await tx.stockTransfer.create({
        data: {
          fromCycleId: from.id,
          toCycleId: to.id,
          movedOn: dayOf(dto.movedOn),
          reason,
          createdBy: actorId,
        },
      });

      const byId = new Map(shelf.map((b) => [b.id, b]));
      for (const line of lines) {
        const source = byId.get(line.sourceBatchId)!;
        // Guarded: a sale confirmed since the shelf was read (sales do not
        // take the cycle's lock) may have taken some of these units.
        const taken = await tx.inventoryBatch.updateMany({
          where: { id: source.id, saleableQty: { gte: line.qty } },
          data: {
            saleableQty: { decrement: line.qty },
            remainingQty: { decrement: line.qty },
          },
        });
        if (taken.count !== 1) {
          throw badRequest(
            'TRANSFER_MORE_THAN_ON_SHELF',
            `${line.productName} changed on the shelf while it was being moved; try again.`,
            {
              product: line.productName,
              available: '—',
              requested: line.qty.toFixed(3),
            },
          );
        }
        await tx.inventoryMovement.create({
          data: {
            batchId: source.id,
            movementType: 'TRANSFER_OUT',
            qtyDelta: line.qty.neg(),
            referenceType: REFERENCE,
            referenceId: transfer.id,
            createdBy: actorId,
          },
        });

        // The same goods on the other cycle: same cost, same check-in, so
        // they still sell first (§3), and a link back to where they came from.
        const dest = await tx.inventoryBatch.create({
          data: {
            cycleId: to.id,
            productId: line.productId,
            transferredFromBatchId: source.id,
            arrivedOn: source.arrivedOn,
            createdAt: source.createdAt,
            receivedQty: line.qty,
            remainingQty: line.qty,
            saleableQty: line.qty,
            landedUnitCostEgp: line.unitCostEgp,
            verificationStatus: 'VERIFIED',
          },
        });
        await tx.inventoryMovement.create({
          data: {
            batchId: dest.id,
            movementType: 'TRANSFER_IN',
            qtyDelta: line.qty,
            referenceType: REFERENCE,
            referenceId: transfer.id,
            createdBy: actorId,
          },
        });
        await tx.stockTransferLine.create({
          data: {
            transferId: transfer.id,
            productId: line.productId,
            sourceBatchId: source.id,
            destBatchId: dest.id,
            qty: line.qty,
            unitCostEgp: line.unitCostEgp,
            costEgp: line.costEgp,
          },
        });
      }

      // The cost moves with the goods: A recovers it, B takes it on. Not
      // cash, not income, not an expense (ledger-categories.ts).
      await this.ledgerPair(tx, {
        transferId: transfer.id,
        from,
        to,
        total,
        actorId,
        type: 'STOCK_TRANSFER',
        reason: `Leftover stock moved from ${from.code} to ${to.code} at landed cost (${formatMoney(total)} EGP)`,
      });

      await refreshOpenSettlementStock(tx, from.id);
      await refreshOpenSettlementStock(tx, to.id);

      return { transfer, from, to, lines, total };
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'CREATE',
      entityType: 'StockTransfer',
      entityId: result.transfer.id,
      afterJson: {
        from: result.from.code,
        to: result.to.code,
        movedOn: result.transfer.movedOn,
        reason,
        totalCostEgp: result.total.toFixed(2),
        lines: result.lines.map((l) => ({
          productId: l.productId,
          sourceBatchId: l.sourceBatchId,
          qty: l.qty.toFixed(3),
          unitCostEgp: l.unitCostEgp.toFixed(4),
        })),
      },
    });

    return {
      data: {
        id: result.transfer.id,
        fromCycle: { id: result.from.id, code: result.from.code },
        toCycle: { id: result.to.id, code: result.to.code },
        totalCostEgp: result.total.toFixed(2),
        lines: result.lines.map((l) => ({
          productId: l.productId,
          productName: l.productName,
          sourceBatchId: l.sourceBatchId,
          qty: l.qty.toFixed(3),
          unitCostEgp: l.unitCostEgp.toFixed(4),
          costEgp: l.costEgp.toFixed(2),
        })),
      },
    };
  }

  /**
   * Put the units back where they came from (§8: only while none of them has
   * sold in B and A has not been paid out). B's batches go — nothing depends
   * on them, which is what the gate establishes — and the ledger pair is
   * balanced by its mirror, never edited (§9).
   */
  async undo(transferId: string, reasonIn: string, actorId: string) {
    if (!isUuid(transferId)) throw notFound('stockTransfer');
    const reason = String(reasonIn ?? '').trim();
    if (!reason) {
      throw badRequest(
        'TRANSFER_REASON_REQUIRED',
        'Say why the move is being undone.',
      );
    }
    const head = await this.prisma.stockTransfer.findUnique({
      where: { id: transferId },
      select: { fromCycleId: true, toCycleId: true },
    });
    if (!head) throw notFound('stockTransfer');

    const result = await this.prisma.$transaction(async (tx) => {
      for (const id of [
        ...new Set([head.fromCycleId, head.toCycleId]),
      ].sort()) {
        await lockCycle(tx, id);
      }
      const t = await tx.stockTransfer.findUnique({
        where: { id: transferId },
        include: TRANSFER_INCLUDE,
      });
      if (!t) throw notFound('stockTransfer');
      const paid = await this.paidCycles([t.fromCycleId], tx);
      const refusal = undoRefusal(undoInput(t, paid.has(t.fromCycleId)));
      if (refusal) throw refusal;

      for (const line of t.lines) {
        const qty = D(line.qty);
        // Remove the moved batch only as it was made: untouched since.
        await tx.inventoryMovement.deleteMany({
          where: { batchId: line.destBatchId! },
        });
        await tx.stockTransferLine.update({
          where: { id: line.id },
          data: { destBatchId: null },
        });
        const gone = await tx.inventoryBatch.deleteMany({
          where: {
            id: line.destBatchId!,
            remainingQty: qty,
            saleableQty: qty,
            saleItemAllocations: { none: {} },
            reservations: { none: {} },
          },
        });
        if (gone.count !== 1) {
          throw badRequest(
            'TRANSFER_UNITS_SOLD',
            `Some of the ${line.product.name} moved to ${t.toCycle.code} has been sold or used there; the move is permanent now.`,
            { product: line.product.name, cycle: t.toCycle.code },
          );
        }
        await tx.inventoryBatch.update({
          where: { id: line.sourceBatchId },
          data: {
            saleableQty: { increment: qty },
            remainingQty: { increment: qty },
          },
        });
        await tx.inventoryMovement.create({
          data: {
            batchId: line.sourceBatchId,
            movementType: 'TRANSFER_IN',
            qtyDelta: qty,
            referenceType: REFERENCE,
            referenceId: t.id,
            createdBy: actorId,
          },
        });
      }

      const originals = await tx.financialTransaction.findMany({
        where: {
          relatedType: REFERENCE,
          relatedId: t.id,
          reversalOfId: null,
          type: 'STOCK_TRANSFER',
        },
      });
      for (const o of originals) {
        await tx.financialTransaction.create({
          data: {
            type: 'STOCK_TRANSFER_REVERSAL',
            category: TRANSFER_CATEGORY,
            direction: o.direction === 'INFLOW' ? 'OUTFLOW' : 'INFLOW',
            amount: o.amount,
            currency: o.currency,
            cycleId: o.cycleId,
            relatedType: REFERENCE,
            relatedId: t.id,
            reversalOfId: o.id,
            reason: `Undone: ${reason}`,
            createdBy: actorId,
          },
        });
      }

      await tx.stockTransfer.update({
        where: { id: t.id },
        data: {
          status: 'REVERSED',
          reversedAt: new Date(),
          reversedBy: actorId,
          reversalReason: reason,
        },
      });

      await refreshOpenSettlementStock(tx, t.fromCycleId);
      await refreshOpenSettlementStock(tx, t.toCycleId);
      return t;
    });

    await this.audit.log({
      actorUserId: actorId,
      action: 'REVERSE',
      entityType: 'StockTransfer',
      entityId: result.id,
      beforeJson: { status: 'ACTIVE' },
      afterJson: { status: 'REVERSED', reason },
    });

    return { data: { id: result.id, status: 'REVERSED' } };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  /** Why this cycle cannot hand leftovers on now, or null. */
  private async sourceGate(
    db: Db | PrismaService,
    cycle: { id: string; code: string; status: string },
  ) {
    const paid = await this.paidCycles([cycle.id], db);
    const no = sourceRefusal(cycle, { paid: paid.has(cycle.id) });
    if (no) return no;
    const open = await shipmentUnaccounted(db, cycle.id);
    if (open) {
      return badRequest(
        'TRANSFER_SOURCE_NOT_ACCOUNTED',
        `Cycle ${open.cycle} still has ${open.onTheWay} unit(s) on the way and ${open.waiting} delivered but not received; account for every unit before moving leftovers.`,
        { cycle: open.cycle, onTheWay: open.onTheWay, waiting: open.waiting },
      );
    }
    return null;
  }

  /** Cycles among `ids` with a PAID settlement — paid out (§8). */
  private async paidCycles(ids: string[], db: Db | PrismaService) {
    const out = new Set<string>();
    for (const id of new Set(ids)) {
      const paid = await db.settlement.findFirst({
        where: { cycleId: id, status: { in: ['PAID'] } },
        select: { id: true },
      });
      if (paid) out.add(id);
    }
    return out;
  }

  /** The cycle's verified, sellable batches, each with its live holds. */
  private async shelf(
    db: Db | PrismaService,
    cycleId: string,
  ): Promise<(ShelfBatch & { sku: string; arrivedOn: Date | null })[]> {
    const batches = await db.inventoryBatch.findMany({
      where: {
        cycleId,
        verificationStatus: 'VERIFIED',
        saleableQty: { gt: 0 },
      },
      include: { product: { select: { name: true, sku: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const holds =
      batches.length === 0
        ? []
        : await db.inventoryReservation.findMany({
            where: {
              status: 'ACTIVE',
              batchId: { in: batches.map((b) => b.id) },
              OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
            },
            select: { batchId: true, qty: true },
          });
    const held = new Map<string, Prisma.Decimal>();
    for (const h of holds) {
      held.set(h.batchId, (held.get(h.batchId) ?? D(0)).add(h.qty));
    }
    return fifo(
      batches.map((b) => ({
        id: b.id,
        productId: b.productId,
        productName: b.product?.name ?? b.productId,
        sku: b.product?.sku ?? '',
        saleableQty: b.saleableQty,
        heldQty: held.get(b.id) ?? D(0),
        landedUnitCostEgp: b.landedUnitCostEgp,
        createdAt: b.createdAt,
        arrivedOn: b.arrivedOn ?? null,
      })),
    );
  }

  /** Names for products the cycle has none of, so the refusal names them. */
  private async productNames(db: Db, ids: string[]) {
    const names = new Map<string, string>();
    for (const id of new Set(ids)) {
      const p = await db.product.findUnique({
        where: { id },
        select: { name: true },
      });
      if (!p) throw notFound('product');
      names.set(id, p.name);
    }
    return names;
  }

  private async ledgerPair(
    tx: Db,
    p: {
      transferId: string;
      from: { id: string; code: string };
      to: { id: string; code: string };
      total: Prisma.Decimal;
      actorId: string;
      type: string;
      reason: string;
    },
  ) {
    const amount = p.total.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    for (const [cycleId, direction] of [
      [p.from.id, 'INFLOW'],
      [p.to.id, 'OUTFLOW'],
    ] as const) {
      await tx.financialTransaction.create({
        data: {
          type: p.type,
          category: TRANSFER_CATEGORY,
          direction,
          amount,
          currency: 'EGP',
          cycleId,
          relatedType: REFERENCE,
          relatedId: p.transferId,
          reason: p.reason,
          createdBy: p.actorId,
        },
      });
    }
  }
}

const PERSON = {
  select: {
    id: true,
    email: true,
    partner: { select: { displayName: true } },
  },
} as const;

const TRANSFER_INCLUDE = {
  fromCycle: { select: { id: true, code: true, status: true } },
  toCycle: { select: { id: true, code: true, status: true } },
  actor: PERSON,
  reverser: PERSON,
  lines: {
    orderBy: { id: 'asc' },
    include: {
      product: { select: { name: true, sku: true } },
      destBatch: {
        select: {
          remainingQty: true,
          saleableQty: true,
          reservedQty: true,
          _count: {
            select: {
              saleItemAllocations: true,
              reservations: true,
              returnItems: true,
              // Moved on again by a transfer that stands.
              transferLinesOut: { where: { transfer: { status: 'ACTIVE' } } },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.StockTransferInclude;

type LoadedTransfer = Prisma.StockTransferGetPayload<{
  include: typeof TRANSFER_INCLUDE;
}>;

function personOf(u: {
  id: string;
  email: string;
  partner?: { displayName: string } | null;
}) {
  return { id: u.id, name: u.partner?.displayName ?? u.email };
}

/** A loaded transfer as `undoRefusal` reads it. */
function undoInput(t: LoadedTransfer, fromPaid: boolean) {
  return {
    status: t.status,
    from: t.fromCycle,
    fromPaid,
    to: t.toCycle,
    lines: t.lines.map((l) => ({
      productName: l.product.name,
      qty: l.qty,
      dest: l.destBatch
        ? {
            remainingQty: l.destBatch.remainingQty,
            saleableQty: l.destBatch.saleableQty,
            reservedQty: l.destBatch.reservedQty,
            allocations: l.destBatch._count.saleItemAllocations,
            reservations: l.destBatch._count.reservations,
            returns: l.destBatch._count.returnItems,
            movedOn: l.destBatch._count.transferLinesOut,
          }
        : null,
    })),
  };
}
