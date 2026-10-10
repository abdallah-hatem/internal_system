import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma, ShippingCostBasis } from '@prisma/client';

import { badRequest, notFound } from '../../common/api-error';
import {
  assertInScope,
  cyclesVisibleTo,
  type ScopeViewer,
} from '../../common/investor-scope';
import { isUuid } from '../../common/uuid';
const D = (v: Prisma.Decimal.Value | null | undefined) =>
  new Prisma.Decimal(v ?? 0);

const ZERO = new Prisma.Decimal(0);

/** Money rounds to 2dp, unit costs to 4dp, quantities to 3dp. */
const money = (v: Prisma.Decimal) =>
  v.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
const unitCost = (v: Prisma.Decimal) =>
  v.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);

export interface LegCost {
  legId: string;
  sequence: number;
  origin: string;
  destination: string;
  costBasis: ShippingCostBasis;
  amountEgp: Prisma.Decimal;
}

export interface ItemLandedCost {
  purchaseOrderItemId: string;
  productId: string;
  productName: string;
  qty: Prisma.Decimal;
  weightKg: Prisma.Decimal | null;
  /** Goods cost in EGP (unit price x PO fx rate), net of line discount. */
  goodsCostEgp: Prisma.Decimal;
  /** Shipping allocated to this line across all cycle legs. */
  shippingCostEgp: Prisma.Decimal;
  totalLandedCostEgp: Prisma.Decimal;
  landedUnitCostEgp: Prisma.Decimal;
}

export interface CycleLandedCostResult {
  cycleId: string;
  legs: LegCost[];
  totalGoodsEgp: Prisma.Decimal;
  totalShippingEgp: Prisma.Decimal;
  totalLandedEgp: Prisma.Decimal;
  totalPieces: Prisma.Decimal;
  totalWeightKg: Prisma.Decimal;
  items: ItemLandedCost[];
  warnings: string[];
}

@Injectable()
export class CostingService {
  constructor(private prisma: PrismaService) {}

  /**
   * Resolve a shipping leg's cost in EGP from its costing basis.
   *
   * PER_PIECE   -> ratePerUnit x chargeablePieces
   * PER_WEIGHT  -> ratePerUnit x chargeableWeightKg
   * FLAT        -> amount
   *
   * The result is converted with the leg's fx rate; legs recorded in EGP use a
   * rate of 1.
   */
  computeLegAmountEgp(leg: {
    costBasis: ShippingCostBasis;
    ratePerUnit: Prisma.Decimal | null;
    chargeablePieces: Prisma.Decimal | null;
    chargeableWeightKg: Prisma.Decimal | null;
    amount: Prisma.Decimal | null;
    fxRateToEgp: Prisma.Decimal | null;
  }): Prisma.Decimal {
    const fx = leg.fxRateToEgp ? D(leg.fxRateToEgp) : new Prisma.Decimal(1);
    let native: Prisma.Decimal;

    switch (leg.costBasis) {
      case 'PER_PIECE':
        native = D(leg.ratePerUnit).mul(D(leg.chargeablePieces));
        break;
      case 'PER_WEIGHT':
        native = D(leg.ratePerUnit).mul(D(leg.chargeableWeightKg));
        break;
      default:
        native = D(leg.amount);
    }

    return money(native.mul(fx));
  }

  /**
   * Compute landed cost per purchase-order item for a cycle, per unit ORDERED
   * (BUSINESS_LOGIC §2, DECIDED 2026-10-10).
   *
   * Every shipping leg in the cycle is allocated across the cycle's purchased
   * items. A PER_WEIGHT leg allocates by line weight; PER_PIECE and FLAT legs
   * allocate by piece count. Both shipment shapes fall out of this naturally:
   * a China cycle has two legs (China->UAE, UAE->Egypt) and a UAE-direct cycle
   * has one (UAE->Egypt).
   *
   * The quantities are always what was ordered. They used to be what was
   * received, so a short delivery made every unit that came dearer and quietly
   * charged the missing goods to them; a unit now costs the same whichever
   * delivery brought it, and goods that never come are a loss (§2). The unit
   * cost is the line's landed total over the units ordered, to four places;
   * `lineEventCost` gives the event that accounts for a line's last units the
   * rounding residual.
   */
  /**
   * The landed cost a caller may read: their own cycle's, or 404 (R1). An id
   * that is not a uuid is no such cycle, not a cast failure.
   */
  async landedCostFor(
    cycleId: string,
    viewer: ScopeViewer,
  ): Promise<CycleLandedCostResult> {
    if (!isUuid(cycleId)) throw notFound('cycle');
    assertInScope(await cyclesVisibleTo(viewer, this.prisma), cycleId);
    return this.computeCycleLandedCosts(cycleId);
  }

  async computeCycleLandedCosts(
    cycleId: string,
    opts: {
      /**
       * The transaction to read in, when the caller holds one. On a serverless
       * host the pool is one connection, so a read on `this.prisma` from
       * inside a transaction waits for a connection that transaction holds.
       */
      db?: Pick<Prisma.TransactionClient, 'importCycle'>;
    } = {},
  ): Promise<CycleLandedCostResult> {
    const cycle = await (opts.db ?? this.prisma).importCycle.findUnique({
      where: { id: cycleId },
      include: {
        shippingLegs: { orderBy: { sequence: 'asc' } },
        purchaseOrders: {
          include: { items: { include: { product: true } } },
        },
      },
    });

    if (!cycle) throw notFound('cycle');

    const warnings: string[] = [];

    // --- Lines: goods cost in EGP, pieces, weight -------------------------
    type Line = ItemLandedCost & { weightKg: Prisma.Decimal | null };
    const lines: Line[] = [];

    for (const po of cycle.purchaseOrders) {
      const fx = D(po.fxRateToEgp);
      for (const item of po.items) {
        // What was ordered, never what was received (§2, 2026-10-10).
        const qty = D(item.orderedQty);
        const goods = money(D(item.lineTotal).mul(fx));

        const unitWeight = item.product.unitWeightKg;
        const weightKg = unitWeight !== null ? D(unitWeight).mul(qty) : null;

        lines.push({
          purchaseOrderItemId: item.id,
          productId: item.productId,
          productName: item.product.name,
          qty,
          weightKg,
          goodsCostEgp: goods,
          shippingCostEgp: ZERO,
          totalLandedCostEgp: ZERO,
          landedUnitCostEgp: ZERO,
        });
      }
    }

    const totalPieces = lines.reduce((s, l) => s.add(l.qty), ZERO);
    const totalWeightKg = lines.reduce(
      (s, l) => s.add(l.weightKg ?? ZERO),
      ZERO,
    );

    // --- Legs --------------------------------------------------------------
    const legs: LegCost[] = cycle.shippingLegs.map((leg) => ({
      legId: leg.id,
      sequence: leg.sequence,
      origin: leg.origin,
      destination: leg.destination,
      costBasis: leg.costBasis,
      amountEgp: this.computeLegAmountEgp(leg),
    }));

    const totalShippingEgp = legs.reduce((s, l) => s.add(l.amountEgp), ZERO);

    if (lines.length === 0) {
      if (totalShippingEgp.gt(0)) {
        warnings.push(
          'Cycle has shipping cost but no purchased items; shipping cannot be allocated yet.',
        );
      }
      return {
        cycleId,
        legs,
        totalGoodsEgp: ZERO,
        totalShippingEgp,
        totalLandedEgp: totalShippingEgp,
        totalPieces: ZERO,
        totalWeightKg: ZERO,
        items: [],
        warnings,
      };
    }

    // --- Allocate each leg over the lines -----------------------------------
    for (const leg of legs) {
      if (leg.amountEgp.isZero()) continue;

      let basis: 'weight' | 'piece' =
        leg.costBasis === 'PER_WEIGHT' ? 'weight' : 'piece';

      if (basis === 'weight') {
        const missing = lines.filter((l) => l.weightKg === null);
        if (missing.length > 0 || totalWeightKg.isZero()) {
          const names = [...new Set(missing.map((l) => l.productName))].join(
            ', ',
          );
          warnings.push(
            `Leg ${leg.sequence} (${leg.origin}->${leg.destination}) is weight-based but ` +
              (totalWeightKg.isZero()
                ? 'total weight is zero'
                : `these products have no unit weight: ${names}`) +
              '. Allocated by piece instead.',
          );
          basis = 'piece';
        }
      }

      const denominator = basis === 'weight' ? totalWeightKg : totalPieces;
      if (denominator.isZero()) {
        warnings.push(
          `Leg ${leg.sequence} could not be allocated: allocation basis totals zero.`,
        );
        continue;
      }

      // Largest-remainder style: allocate to all but the last line, then give
      // the last line the residual so the parts always re-sum to the total.
      let allocated = ZERO;
      lines.forEach((line, idx) => {
        const numerator =
          basis === 'weight' ? (line.weightKg ?? ZERO) : line.qty;
        let share: Prisma.Decimal;

        if (idx === lines.length - 1) {
          share = leg.amountEgp.sub(allocated);
        } else {
          share = money(leg.amountEgp.mul(numerator).div(denominator));
          allocated = allocated.add(share);
        }

        line.shippingCostEgp = line.shippingCostEgp.add(share);
      });
    }

    // --- Totals -------------------------------------------------------------
    for (const line of lines) {
      line.totalLandedCostEgp = money(
        line.goodsCostEgp.add(line.shippingCostEgp),
      );
      line.landedUnitCostEgp = line.qty.isZero()
        ? ZERO
        : unitCost(line.totalLandedCostEgp.div(line.qty));
    }

    const totalGoodsEgp = lines.reduce((s, l) => s.add(l.goodsCostEgp), ZERO);

    return {
      cycleId,
      legs,
      totalGoodsEgp: money(totalGoodsEgp),
      totalShippingEgp,
      totalLandedEgp: money(totalGoodsEgp.add(totalShippingEgp)),
      totalPieces,
      totalWeightKg,
      items: lines,
      warnings,
    };
  }

  /** Landed unit cost for one purchase-order item, per unit ordered. */
  async landedUnitCostForItem(
    cycleId: string,
    purchaseOrderItemId: string,
  ): Promise<Prisma.Decimal> {
    const result = await this.computeCycleLandedCosts(cycleId);
    const line = result.items.find(
      (i) => i.purchaseOrderItemId === purchaseOrderItemId,
    );
    if (!line) {
      throw badRequest(
        'PO_ITEM_NOT_IN_CYCLE',
        `Purchase order item ${purchaseOrderItemId} is not part of cycle ${cycleId}`,
      );
    }
    return line.landedUnitCostEgp;
  }
}

/** Quantities compared in whole thousandths, as `shipmentPosition` sums them. */
const milli = (q: Prisma.Decimal.Value) =>
  Math.round(Number(new Prisma.Decimal(q).toString()) * 1000);

/**
 * What one receipt or loss on an order line costs (BUSINESS_LOGIC §2 —
 * DECIDED 2026-10-10).
 *
 * Every unit of a line costs the same, `unitCostEgp` (the line's landed total
 * over the units ordered, to four places), so an event is `qty × unit`
 * rounded to the piastre. Rounding twice — the unit to four places, each event
 * to two — would leave the line a few piastres off its landed total, so the
 * event that accounts for the line's LAST units (received + lost reaches
 * ordered) takes the residual instead: the landed total less what every
 * earlier event on the line cost. Batches and losses then re-sum to the line's
 * landed total exactly.
 *
 * Earlier batches are counted at the standard `qty × unit`, not at whatever a
 * partner may have typed over it: a manual cost applies to that batch only and
 * must not be pushed onto the final one.
 *
 * Pure: the caller loads the line's earlier batches and losses.
 */
export function lineEventCost(input: {
  orderedQty: Prisma.Decimal.Value;
  landedTotalEgp: Prisma.Decimal.Value;
  unitCostEgp: Prisma.Decimal.Value;
  /** Every batch already received on this line. */
  priorReceivedQtys: Prisma.Decimal.Value[];
  /** Every loss already recorded on this line, any leg. */
  priorLosses: { qty: Prisma.Decimal.Value; costEgp: Prisma.Decimal.Value }[];
  qty: Prisma.Decimal.Value;
}): { unitCostEgp: Prisma.Decimal; costEgp: Prisma.Decimal; final: boolean } {
  const unit = D(input.unitCostEgp);
  const qty = D(input.qty);
  const accountedAfter =
    input.priorReceivedQtys.reduce<number>((s, q) => s + milli(q), 0) +
    input.priorLosses.reduce<number>((s, l) => s + milli(l.qty), 0) +
    milli(qty);
  const final = accountedAfter === milli(input.orderedQty) && qty.gt(0);
  if (!final) {
    return { unitCostEgp: unit, costEgp: money(qty.mul(unit)), final };
  }
  const before = input.priorReceivedQtys
    .reduce<Prisma.Decimal>((s, q) => s.add(money(D(q).mul(unit))), ZERO)
    .add(
      input.priorLosses.reduce<Prisma.Decimal>(
        (s, l) => s.add(D(l.costEgp)),
        ZERO,
      ),
    );
  const costEgp = money(D(input.landedTotalEgp).sub(before));
  return { unitCostEgp: unitCost(costEgp.div(qty)), costEgp, final };
}
