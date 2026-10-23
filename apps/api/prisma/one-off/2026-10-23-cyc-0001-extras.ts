/**
 * One-off correction of CYC-2026-0001 (owner, 2026-10-22/23) — see
 * docs/BUILD_LOG.md "Waiting on the owner", "Extra pieces on CYC-2026-0001".
 *
 *   cd apps/api
 *   DATABASE_URL=…/motorcycle_parts_prodcopy JWT_SECRET=… \
 *     npx ts-node --transpile-only --compiler-options '{"module":"commonjs"}' \
 *     prisma/one-off/2026-10-23-cyc-0001-extras.ts [--plan] [--production] [--resume]
 *
 *   --plan        reads, checks the starting facts, prints every change; writes nothing
 *   --production  required for any database other than the local copy
 *                 `motorcycle_parts_prodcopy` (and refused for a database on this machine)
 *   --resume      continue a run that stopped part way (each step looks first)
 *
 * What it does, in order, as the office would where the office can:
 *
 *   1. Categories Bags / Screws / Phone holders            ProductsService.createCategory
 *   2. Nine products, no prices (landed + 20% applies)     ProductsService.create
 *   3. Their lines on PO-2026-0001 at 13.85                 written here — see below
 *   4. Their 18 pieces onto leg 1's and leg 2's existing    written here — see below
 *      departure and delivery
 *      (3 + 4 + re-aligning the existing batches are one transaction)
 *   5. Received from leg 2's delivery, on 9 Sep 2026        InventoryService.verifyStock
 *   6. Leg 2 → FLAT 5,250 AED at 14, re-costing the cycle   ShippingService.updateLeg
 *   7. Ahmad Eraiby's payment removed, recorded again at    LendersService.removeFinancing / finance
 *      13,905.69 AED at 13.9066 on 15 Jul 2026
 *   8. Three repayments, 15 Aug / 15 Sep / 15 Oct           LendersService.repay (the last at quote())
 *   9. Each core partner's contribution → 67,056.33 EGP     CyclesService.updateParticipant
 *
 * The rule it steps around, once, deliberately (steps 3–4). The cycle is
 * SELLING and PO-2026-0001 CONFIRMED, so `PurchasesService.addItem` refuses a
 * new line (`PO_NOT_DRAFT`, `CYCLE_STATUS_BLOCKS_PO`) and there is no service
 * that adds lines to a departure or delivery already recorded. The goods were
 * on that order and in that shipment all along; they were left out when the
 * cycle was typed in after the fact. So the lines are written here with the
 * service's own fields and its other checks: `PurchasesService.assertLine`
 * (product exists and is active, quantity above zero, price not negative,
 * discount 0–100) and `purchaseLineTotal` for the line total; the shipment
 * lines are added to the existing records, then `syncLegStatuses` writes the
 * legs' stored reading, and the shipment position is checked (every new line
 * entered, left and arrived on both legs; dates in order). The audit rows the
 * service writes (ADD_ITEM) are written after the commit, plus one
 * CORRECTION row naming every record touched.
 *
 * And a second, which the first causes. Adding 18 pieces to a received cycle
 * changes how leg 1's flat cost spreads, so the 230 pieces already received no
 * longer sit at the cost the legs compute — and `updateLeg` (step 6) refuses a
 * re-cost then (`LEG_COST_LOCKED_OVERRIDE`, there to protect a cost typed by
 * hand). Before adding anything, the service's own `planRecost` is run and must
 * say the cycle can be re-costed (no hand-typed cost, purchase rows pair with
 * batches, no loss, transfer or settlement). After the receipt, every batch is
 * re-costed with the service's own `recost` (the arithmetic `updateLeg` uses),
 * and only then is step 6 run through `updateLeg`, whose checks then pass.
 *
 * Re-costing re-prices the units already sold, as `updateLeg` always does
 * (BUSINESS_LOGIC §2, 2026-10-17; the one exception §3 names). The report
 * shows every sale's COGS before and after.
 *
 * Never calls a service from inside a transaction it opened: the only code
 * run inside its own transaction is Prisma on `tx` and the pure helpers
 * (`planRecost`, `recost`, `syncLegStatuses`, `loadShipment`) the services run
 * inside theirs. Notifications and pushes are switched off (past events).
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type; money must not become a float
import { Prisma } from '@prisma/client';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { CyclesService } from '../../src/modules/cycles/cycles.service';
import {
  PurchasesService,
  purchaseLineTotal,
  type PurchaseLine,
} from '../../src/modules/purchases/purchases.service';
import { ShippingService } from '../../src/modules/shipping/shipping.service';
import { InventoryService } from '../../src/modules/inventory/inventory.service';
import { LendersService } from '../../src/modules/lenders/lenders.service';
import { ProductsService } from '../../src/modules/products/products.service';
import { CostingService } from '../../src/modules/costing/costing.service';
import { SettlementsService } from '../../src/modules/settlements/settlements.service';
import { AnalyticsService } from '../../src/modules/analytics/analytics.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { PushService } from '../../src/modules/notifications/push.service';
import {
  planRecost,
  recost,
  type RecostPlan,
} from '../../src/modules/costing/leg-recost';
import {
  loadShipment,
  lockCycle,
  syncLegStatuses,
} from '../../src/common/shipment-load';
import { owedOn } from '../../src/common/lender-math';
import {
  CONTRIBUTION_EGP,
  CYCLE_CODE,
  EXTRAS,
  FINANCING,
  LEG2_COST,
  LENDER_NAME,
  NEW_CATEGORIES,
  PO_REFERENCE,
  REMOVAL_REASON,
  REPAYMENTS,
  STEPS,
  assertTarget,
  decideRun,
  stepsDone,
  type CorrectionState,
  type Step,
} from './2026-10-23-cyc-0001-extras.guards';

type Db = Prisma.TransactionClient;
const D = (v: Prisma.Decimal.Value | null | undefined) =>
  new Prisma.Decimal(v ?? 0);
const day = (d: Date) => d.toISOString().slice(0, 10);
const m2 = (v: Prisma.Decimal.Value | null | undefined) => D(v).toFixed(2);

// ─── Reading the state ──────────────────────────────────────────────────

async function readState(db: PrismaService): Promise<CorrectionState> {
  const cycle = await db.importCycle.findUnique({
    where: { code: CYCLE_CODE },
    select: { id: true, code: true, status: true, originType: true },
  });
  const categories = await db.category.findMany({
    where: { name: { in: NEW_CATEGORIES.map((c) => c.name) } },
    select: { name: true },
  });
  const products = await db.product.findMany({
    where: { name: { in: EXTRAS.map((e) => e.name) } },
    select: { name: true },
  });
  const base = {
    categoriesPresent: categories.map((c) => c.name),
    productsPresent: products.map((p) => p.name),
  };
  if (!cycle) {
    return {
      cycle: null,
      orders: [],
      legs: [],
      batches: [],
      losses: 0,
      standingTransfers: 0,
      standingSettlements: 0,
      financings: [],
      bankFeesEgp: '0',
      contributions: [],
      ...base,
    };
  }
  const orders = await db.purchaseOrder.findMany({
    where: { cycleId: cycle.id },
    include: {
      items: {
        include: { product: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  const legs = await db.shippingLeg.findMany({
    where: { cycleId: cycle.id },
    orderBy: { sequence: 'asc' },
    include: {
      departures: { include: { lines: true }, orderBy: { departedOn: 'asc' } },
      deliveries: { include: { lines: true }, orderBy: { arrivedOn: 'asc' } },
    },
  });
  const batches = await db.inventoryBatch.findMany({
    where: { cycleId: cycle.id },
  });
  const losses = await db.shipmentLoss.count({
    where: { leg: { cycleId: cycle.id } },
  });
  const standingTransfers = await db.stockTransfer.count({
    where: {
      status: 'ACTIVE',
      OR: [{ fromCycleId: cycle.id }, { toCycleId: cycle.id }],
    },
  });
  const standingSettlements = await db.settlement.count({
    where: { cycleId: cycle.id, status: { in: ['DRAFT', 'APPROVED', 'PAID'] } },
  });
  const financings = await db.lenderFinancing.findMany({
    where: { cycleId: cycle.id },
    include: {
      lender: { select: { name: true } },
      repayments: { where: { reversedAt: null } },
    },
  });
  const fees = await db.financialTransaction.findMany({
    where: { cycleId: cycle.id, category: 'bank_fees', reversalOfId: null },
    select: { id: true, amount: true, direction: true },
  });
  const undone = new Set(
    (
      await db.financialTransaction.findMany({
        where: { reversalOfId: { in: fees.map((f) => f.id) } },
        select: { reversalOfId: true },
      })
    ).map((r) => r.reversalOfId),
  );
  const bankFees = fees
    .filter((f) => !undone.has(f.id))
    .reduce(
      (s, f) => (f.direction === 'OUTFLOW' ? s.add(f.amount) : s.sub(f.amount)),
      D(0),
    );
  const participants = await db.cycleParticipant.findMany({
    where: { cycleId: cycle.id },
    orderBy: { createdAt: 'asc' },
  });
  return {
    cycle,
    orders: orders.map((o) => ({
      id: o.id,
      reference: o.reference,
      currency: o.currency,
      fxRateToEgp: D(o.fxRateToEgp).toFixed(4),
      orderedOn: day(o.orderedOn),
      items: o.items.map((i) => ({
        id: i.id,
        productName: i.product.name,
        orderedQty: D(i.orderedQty).toString(),
        unitPrice: D(i.unitPrice).toString(),
        lineTotal: m2(i.lineTotal),
      })),
    })),
    legs: legs.map((l) => ({
      id: l.id,
      sequence: l.sequence,
      costBasis: l.costBasis,
      amount: l.amount === null ? null : m2(l.amount),
      currency: l.currency,
      fxRateToEgp: l.fxRateToEgp === null ? null : D(l.fxRateToEgp).toFixed(4),
      ratePerUnit: l.ratePerUnit === null ? null : D(l.ratePerUnit).toString(),
      chargeablePieces:
        l.chargeablePieces === null ? null : D(l.chargeablePieces).toString(),
      departures: l.departures.map((d) => ({
        id: d.id,
        day: day(d.departedOn),
        lines: d.lines.map((x) => ({
          purchaseOrderItemId: x.purchaseOrderItemId,
          qty: D(x.qty).toString(),
        })),
      })),
      deliveries: l.deliveries.map((d) => ({
        id: d.id,
        day: day(d.arrivedOn),
        lines: d.lines.map((x) => ({
          id: x.id,
          purchaseOrderItemId: x.purchaseOrderItemId,
          qty: D(x.qty).toString(),
        })),
      })),
    })),
    batches: batches.map((b) => ({
      id: b.id,
      sourcePoItemId: b.sourcePoItemId,
      sourceDeliveryLineId: b.sourceDeliveryLineId,
      receivedQty: D(b.receivedQty).toString(),
    })),
    losses,
    standingTransfers,
    standingSettlements,
    financings: financings.map((f) => ({
      id: f.id,
      lender: f.lender.name,
      purchaseOrderId: f.purchaseOrderId,
      amount: m2(f.amount),
      currency: f.currency,
      fxRateToEgp: D(f.fxRateToEgp).toFixed(4),
      paidOn: day(f.paidOn),
      removed: f.removedAt !== null,
      repayments: f.repayments.map((r) => ({
        paidOn: day(r.paidOn),
        amountEgp: m2(r.amountEgp),
        rateToEgp: D(r.rateToEgp).toFixed(4),
      })),
    })),
    bankFeesEgp: m2(bankFees),
    contributions: participants.map((p) => ({
      id: p.id,
      type: p.participantType,
      amount: m2(p.contributionAmount),
    })),
    ...base,
  };
}

// ─── The before/after report ────────────────────────────────────────────

interface Snapshot {
  cycleCostEgp: string;
  toFundEgp: string;
  financedEgp: string;
  batches: {
    id: string;
    product: string;
    received: string;
    remaining: string;
    unitCost: string;
  }[];
  sales: { orderNo: string; status: string; qty: string; cogs: string }[];
  revenueEgp: string;
  cogsEgp: string;
  expensesEgp: string;
  exchangeDifferenceEgp: string;
  grossProfitEgp: string;
  owed: { lender: string; currency: string; owed: string }[];
  contributions: { who: string; amount: string }[];
  cashOnHand: string;
  dashboardNetProfit: string;
  newProducts: { name: string; unitCost: string; b2b: string; b2c: string }[];
}

async function snapshot(
  app: INestApplicationContext,
  cycleId: string,
): Promise<Snapshot> {
  const db = app.get(PrismaService);
  const costing = app.get(CostingService);
  const funding = await costing.fundingFor(cycleId);
  const batches = await db.inventoryBatch.findMany({
    where: { cycleId },
    include: { product: { select: { name: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const allocations = await db.saleItemAllocation.findMany({
    where: { inventoryBatch: { cycleId } },
    include: {
      saleItem: {
        include: { saleOrder: { select: { orderNo: true, status: true } } },
      },
    },
  });
  const byOrder = new Map<
    string,
    { status: string; qty: Prisma.Decimal; cogs: Prisma.Decimal }
  >();
  for (const a of allocations) {
    const o = a.saleItem.saleOrder;
    const row = byOrder.get(o.orderNo) ?? {
      status: o.status,
      qty: D(0),
      cogs: D(0),
    };
    row.qty = row.qty.add(a.qty);
    row.cogs = row.cogs.add(a.cogsEgp);
    byOrder.set(o.orderNo, row);
  }
  const preview = (await app.get(SettlementsService).preview(cycleId)).data;
  const kpis = (await app.get(AnalyticsService).getDashboardKPIs()).data;
  const financings = await db.lenderFinancing.findMany({
    where: { cycleId, removedAt: null },
    include: {
      lender: { select: { name: true } },
      repayments: { where: { reversedAt: null } },
    },
  });
  const participants = await db.cycleParticipant.findMany({
    where: { cycleId },
    include: {
      partner: { select: { email: true } },
      investor: { select: { email: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  const products = app.get(ProductsService);
  const newProducts = [];
  for (const e of EXTRAS) {
    const p = await db.product.findFirst({
      where: { name: e.name },
      select: { id: true },
    });
    if (!p) continue;
    const found = (await products.findById(p.id)).data;
    const batch = batches.find((b) => b.productId === p.id);
    newProducts.push({
      name: e.name,
      unitCost: batch ? D(batch.landedUnitCostEgp).toFixed(4) : '—',
      b2b: found.listPrices.B2B
        ? `${found.listPrices.B2B.amount} (${found.listPrices.B2B.source})`
        : '—',
      b2c: found.listPrices.B2C
        ? `${found.listPrices.B2C.amount} (${found.listPrices.B2C.source})`
        : '—',
    });
  }
  return {
    cycleCostEgp: m2(funding.cycleCost),
    toFundEgp: m2(funding.toFund),
    financedEgp: m2(funding.financed),
    batches: batches.map((b) => ({
      id: b.id,
      product: b.product.name,
      received: D(b.receivedQty).toString(),
      remaining: D(b.remainingQty).toString(),
      unitCost: D(b.landedUnitCostEgp).toFixed(4),
    })),
    sales: [...byOrder.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([orderNo, r]) => ({
        orderNo,
        status: r.status,
        qty: r.qty.toString(),
        cogs: m2(r.cogs),
      })),
    revenueEgp: preview.revenueEgp,
    cogsEgp: preview.cogsEgp,
    expensesEgp: preview.expensesEgp,
    exchangeDifferenceEgp: preview.exchangeDifferenceEgp,
    grossProfitEgp: preview.grossProfitEgp,
    owed: financings.map((f) => ({
      lender: f.lender.name,
      currency: f.currency,
      owed: m2(owedOn(f.amount, f.repayments)),
    })),
    contributions: participants.map((p) => ({
      who: p.partner?.email ?? p.investor?.email ?? p.id,
      amount: m2(p.contributionAmount),
    })),
    cashOnHand: Number(kpis.cashOnHand).toFixed(2),
    dashboardNetProfit: Number(kpis.netProfit).toFixed(2),
    newProducts,
  };
}

function printReport(before: Snapshot, after: Snapshot) {
  const row = (label: string, a: string, b: string) =>
    console.log(
      `  ${label.padEnd(44)} ${a.padStart(14)} → ${b.padStart(14)}${a === b ? '' : '   *'}`,
    );
  console.log(
    '\n══ Before → after ══════════════════════════════════════════════',
  );
  console.log('Cycle');
  row(
    'cost (goods + legs + expenses), EGP',
    before.cycleCostEgp,
    after.cycleCostEgp,
  );
  row('partners fund, EGP', before.toFundEgp, after.toFundEgp);
  row("friends' payments, EGP", before.financedEgp, after.financedEgp);
  row('revenue, EGP', before.revenueEgp, after.revenueEgp);
  row('COGS, EGP', before.cogsEgp, after.cogsEgp);
  row(
    'expenses (incl. exchange difference), EGP',
    before.expensesEgp,
    after.expensesEgp,
  );
  row(
    'exchange difference, EGP',
    before.exchangeDifferenceEgp,
    after.exchangeDifferenceEgp,
  );
  row('gross profit, EGP', before.grossProfitEgp, after.grossProfitEgp);
  console.log('Dashboard');
  row('cash on hand, EGP', before.cashOnHand, after.cashOnHand);
  row(
    'net profit (all time), EGP',
    before.dashboardNetProfit,
    after.dashboardNetProfit,
  );
  console.log('Owed to lenders');
  for (const o of after.owed) {
    const b = before.owed.find((x) => x.lender === o.lender);
    row(`${o.lender} (${o.currency})`, b?.owed ?? '—', o.owed);
  }
  console.log('Contributions, EGP');
  for (const c of after.contributions) {
    row(
      c.who,
      before.contributions.find((x) => x.who === c.who)?.amount ?? '—',
      c.amount,
    );
  }
  console.log('Batches: landed unit cost, EGP (received / remaining)');
  for (const b of after.batches) {
    const was = before.batches.find((x) => x.id === b.id);
    row(
      `${b.product.slice(0, 34)} ${b.received}/${b.remaining}`,
      was?.unitCost ?? 'new',
      b.unitCost,
    );
  }
  console.log('Sales drawn from the cycle: COGS, EGP');
  for (const s of after.sales) {
    const was = before.sales.find((x) => x.orderNo === s.orderNo);
    row(`${s.orderNo} ${s.status} (${s.qty} units)`, was?.cogs ?? '—', s.cogs);
  }
  console.log(
    'New products: landed unit cost / default B2B / default B2C, EGP',
  );
  for (const p of after.newProducts) {
    console.log(
      `  ${p.name.padEnd(48)} ${p.unitCost.padStart(10)}  ${p.b2b.padStart(14)}  ${p.b2c.padStart(14)}`,
    );
  }
}

// ─── The plan ───────────────────────────────────────────────────────────

function printPlan(s: CorrectionState, done: Record<Step, boolean>) {
  const po = s.orders.find((o) => o.reference === PO_REFERENCE)!;
  const leg1 = s.legs.find((l) => l.sequence === 1)!;
  const leg2 = s.legs.find((l) => l.sequence === 2)!;
  const mark = (k: Step) => (done[k] ? '  [done]' : '');
  console.log(
    `\nPlan for ${CYCLE_CODE} (${s.cycle?.status}), ${PO_REFERENCE} ${po.id}:`,
  );
  console.log(
    `1. categories${mark('categories')}: ${NEW_CATEGORIES.map((c) => `${c.name} / ${c.nameAr}`).join(', ')}`,
  );
  console.log(`2. products${mark('products')} (no Arabic name, no price):`);
  for (const e of EXTRAS) console.log(`     ${e.name} — ${e.category}`);
  const total = EXTRAS.reduce(
    (t, e) =>
      t.add(purchaseLineTotal({ orderedQty: e.qty, unitPrice: e.unitPrice })),
    D(0),
  );
  console.log(
    `3. lines on ${PO_REFERENCE} at ${po.fxRateToEgp}${mark('orderLines')}: ${EXTRAS.length} lines, ${EXTRAS.reduce((t, e) => t + e.qty, 0)} pieces, ${total.toFixed(2)} ${po.currency}`,
  );
  for (const e of EXTRAS)
    console.log(
      `     ${e.qty} × ${e.unitPrice} = ${purchaseLineTotal({ orderedQty: e.qty, unitPrice: e.unitPrice }).toFixed(2)}  ${e.name}`,
    );
  console.log(
    `4. their pieces onto leg 1 departure ${leg1.departures[0]?.id} (${leg1.departures[0]?.day}) and delivery ${leg1.deliveries[0]?.id} (${leg1.deliveries[0]?.day}),`,
  );
  console.log(
    `   leg 2 departure ${leg2.departures[0]?.id} (${leg2.departures[0]?.day}) and delivery ${leg2.deliveries[0]?.id} (${leg2.deliveries[0]?.day})${mark('orderLines')}`,
  );
  console.log(
    `   (in one transaction, after planRecost confirms the cycle can be re-costed)`,
  );
  console.log(
    `5. received from leg 2's delivery on 2026-09-09, one batch per line${mark('received')}`,
  );
  console.log(
    `6. every batch re-costed with the legs as they then stand (recost), then`,
  );
  console.log(
    `   leg 2 ${leg2.id}: ${leg2.costBasis} ${leg2.amount} ${leg2.currency} at ${leg2.fxRateToEgp} → ${LEG2_COST.costBasis} ${LEG2_COST.amount} ${LEG2_COST.currency} at ${LEG2_COST.fxRateToEgp} (updateLeg, re-costs the cycle)${mark('leg2Cost')}`,
  );
  const old = s.financings.find((f) => !f.removed && f.lender === LENDER_NAME);
  console.log(
    `7. ${LENDER_NAME}: remove ${old ? `${old.id} (${old.amount} ${old.currency} at ${old.fxRateToEgp})` : '—'} — "${REMOVAL_REASON}"`,
  );
  console.log(
    `   record ${FINANCING.amount} ${FINANCING.currency} at ${FINANCING.fxRateToEgp} on ${FINANCING.paidOn} = ${D(FINANCING.amount).mul(FINANCING.fxRateToEgp).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toFixed(2)} EGP${mark('financing')}`,
  );
  console.log(`8. repayments${mark('repayments')}:`);
  for (const r of REPAYMENTS)
    console.log(
      `     ${r.paidOn} at ${r.rateToEgp}: ${r.amountEgp ?? `the pays-it-off figure (expected ${'expected' in r ? r.expected : '?'})`} EGP`,
    );
  console.log(
    `9. contributions${mark('contributions')}: ${s.contributions.map((c) => c.amount).join(' / ')} → ${CONTRIBUTION_EGP} each`,
  );
}

// ─── The steps ──────────────────────────────────────────────────────────

/** The batches of every order line, in receipt order, each paired with the purchase row its receipt booked. */
async function wholeCyclePlan(tx: Db, cycleId: string): Promise<RecostPlan> {
  const loaded = await loadShipment(tx, cycleId);
  if (!loaded) throw new Error('cycle vanished');
  const batches = await tx.inventoryBatch.findMany({ where: { cycleId } });
  const rows = await tx.financialTransaction.findMany({
    where: {
      cycleId,
      relatedType: 'PURCHASE_ORDER_ITEM',
      type: 'PURCHASE_COST',
      reversalOfId: null,
    },
  });
  const lines: RecostPlan['lines'] = [];
  for (const po of loaded.cycle.purchaseOrders) {
    for (const item of po.items) {
      const own = batches.filter((b) => b.sourcePoItemId === item.id);
      const booked = rows.filter((r) => r.relatedId === item.id);
      if (own.length === 0 && booked.length === 0) continue;
      // Every line of this cycle was received in one go; anything else is not
      // the cycle this was written for, and pairing would be a guess.
      if (own.length !== 1 || booked.length !== 1) {
        throw new Error(
          `${item.product.name}: ${own.length} batches and ${booked.length} purchase rows — expected one of each`,
        );
      }
      lines.push({
        purchaseOrderItemId: item.id,
        productName: item.product.name,
        orderedQty: D(item.orderedQty),
        batches: [
          {
            id: own[0].id,
            receivedQty: D(own[0].receivedQty),
            landedUnitCostEgp: D(own[0].landedUnitCostEgp),
            ledgerId: booked[0].id,
            ledgerAmount: D(booked[0].amount),
          },
        ],
      });
    }
  }
  return {
    state: { editable: true, reason: null, params: {}, recosts: true },
    lines,
  };
}

async function run(app: INestApplicationContext, argv: string[]) {
  const db = app.get(PrismaService);
  const products = app.get(ProductsService);
  const purchases = app.get(PurchasesService);
  const shipping = app.get(ShippingService);
  const inventory = app.get(InventoryService);
  const lenders = app.get(LendersService);
  const cycles = app.get(CyclesService);
  const costing = app.get(CostingService);
  const audit = app.get(AuditService);

  const state = await readState(db);
  const decision = decideRun(state, argv);
  if (decision.action === 'refuse') {
    console.error(`\nREFUSED. ${decision.reason}`);
    process.exitCode = 1;
    return;
  }
  const done = stepsDone(state);
  console.log(
    decision.action === 'fresh'
      ? 'Every starting fact checks out.'
      : `Resuming; done: ${decision.done.join(', ')}`,
  );
  printPlan(state, done);
  if (argv.includes('--plan')) {
    console.log('\n--plan: nothing written.');
    return;
  }

  // Past events reach nobody: no bell rows, no phone pushes (as prisma/seeds/history.ts).
  const notifications = app.get(NotificationsService);
  notifications.create = () => Promise.resolve(undefined as never);
  notifications.createForMultipleUsers = () =>
    Promise.resolve(undefined as never);
  app.get(PushService).sendToUsers = () => Promise.resolve(undefined as never);

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
  const actorId = actor.id;
  const cycleId = state.cycle!.id;
  const po = state.orders.find((o) => o.reference === PO_REFERENCE)!;
  const leg1 = state.legs.find((l) => l.sequence === 1)!;
  const leg2 = state.legs.find((l) => l.sequence === 2)!;
  console.log(`\nRecording as ${actor.email}.`);

  const before = await snapshot(app, cycleId);

  // 1. Categories.
  const categoryId = new Map<string, string>();
  for (const c of NEW_CATEGORIES) {
    const found = await db.category.findFirst({
      where: { name: { equals: c.name, mode: 'insensitive' } },
    });
    if (found) {
      categoryId.set(c.name, found.id);
      continue;
    }
    const made = await products.createCategory(
      { name: c.name, nameAr: c.nameAr },
      actorId,
    );
    categoryId.set(c.name, made.data.id);
    console.log(`  + category ${c.name} (${made.data.id})`);
  }

  // 2. Products.
  const productId = new Map<string, string>();
  for (const e of EXTRAS) {
    const found = await db.product.findFirst({ where: { name: e.name } });
    if (found) {
      productId.set(e.name, found.id);
      continue;
    }
    const made = await products.create(
      { name: e.name, categoryId: categoryId.get(e.category) },
      actorId,
    );
    productId.set(e.name, made.data.id);
    console.log(`  + product ${made.data.sku} ${e.name}`);
  }

  // 3 + 4. Lines on the order and on the shipment, and the batches re-aligned — one transaction.
  if (!done.orderLines) {
    const leg1Dep = leg1.departures[0];
    const leg1Del = leg1.deliveries[0];
    const leg2Dep = leg2.departures[0];
    const leg2Del = leg2.deliveries[0];
    // The goods went on one order and one shipment: the dates must already be in that order.
    const days = [
      po.orderedOn,
      leg1Dep.day,
      leg1Del.day,
      leg2Dep.day,
      leg2Del.day,
    ];
    if (days.some((d, i) => i > 0 && d < days[i - 1]))
      throw new Error(`shipment dates out of order: ${days.join(' → ')}`);

    const written = await db.$transaction(async (tx) => {
      await lockCycle(tx, cycleId);
      const pre = await loadShipment(tx, cycleId);
      // The service's own check, before anything moves: the cycle can be re-costed.
      const can = await planRecost(tx, costing, pre!.cycle, pre!.position);
      if (!can.state.editable || !can.state.recosts) {
        throw new Error(
          `the cycle cannot be re-costed: ${can.state.reason ?? 'nothing received'}`,
        );
      }
      const items = [];
      for (const e of EXTRAS) {
        const line: PurchaseLine = {
          productId: productId.get(e.name)!,
          orderedQty: e.qty,
          unitPrice: e.unitPrice,
          discount: 0,
        };
        // Every check addItem makes except PO_NOT_DRAFT and CYCLE_STATUS_BLOCKS_PO.
        await purchases['assertLine'](tx, line);
        const item = await tx.purchaseOrderItem.create({
          data: {
            purchaseOrderId: po.id,
            productId: line.productId,
            orderedQty: line.orderedQty,
            unitPrice: line.unitPrice,
            discount: 0,
            lineTotal: purchaseLineTotal(line),
          },
        });
        const shipped = { purchaseOrderItemId: item.id, qty: e.qty };
        const lines = {
          leg1Departure: await tx.shipmentDepartureLine.create({
            data: { departureId: leg1Dep.id, ...shipped },
          }),
          leg1Delivery: await tx.shipmentDeliveryLine.create({
            data: { deliveryId: leg1Del.id, ...shipped },
          }),
          leg2Departure: await tx.shipmentDepartureLine.create({
            data: { departureId: leg2Dep.id, ...shipped },
          }),
          leg2Delivery: await tx.shipmentDeliveryLine.create({
            data: { deliveryId: leg2Del.id, ...shipped },
          }),
        };
        items.push({ item, lines });
      }
      await syncLegStatuses(tx, cycleId);

      // The shipment must read as the goods travelled: every new line entered,
      // left and arrived on both legs, none on the way, all waiting in Egypt.
      const post = (await loadShipment(tx, cycleId))!;
      for (const { item } of items) {
        const qty = Number(item.orderedQty);
        for (const leg of post.position.legs) {
          const l = leg.lines.find((x) => x.purchaseOrderItemId === item.id);
          if (
            !l ||
            l.entered !== qty ||
            l.departed !== qty ||
            l.delivered !== qty ||
            l.onTheWay !== 0 ||
            l.atOrigin !== 0
          ) {
            throw new Error(
              `leg ${leg.sequence} does not carry ${qty} of line ${item.id}: ${JSON.stringify(l)}`,
            );
          }
        }
        const line = post.position.lines.find(
          (x) => x.purchaseOrderItemId === item.id,
        );
        if (!line || line.waiting !== qty)
          throw new Error(
            `line ${item.id} is not waiting in Egypt: ${JSON.stringify(line)}`,
          );
      }
      if (post.position.legs.some((l) => l.status !== 'ARRIVED')) {
        throw new Error(
          `legs read ${post.position.legs.map((l) => l.status).join(', ')}, not ARRIVED`,
        );
      }
      return items;
    });
    for (const { item, lines } of written) {
      await audit.log({
        actorUserId: actorId,
        action: 'ADD_ITEM',
        entityType: 'PurchaseOrderItem',
        entityId: item.id,
        afterJson: {
          ...item,
          note: 'One-off correction 2026-10-23: a line left out when the cycle was entered',
        },
      });
      console.log(
        `  + line ${item.orderedQty.toString()} × ${item.unitPrice.toString()} = ${item.lineTotal.toString()} (${item.id}) on both legs`,
      );
      void lines;
    }
    await audit.log({
      actorUserId: actorId,
      action: 'CORRECTION',
      entityType: 'ImportCycle',
      entityId: cycleId,
      afterJson: {
        note: `${CYCLE_CODE}: ${EXTRAS.length} lines left out when the cycle was entered, added to ${PO_REFERENCE} and to the existing departures and deliveries of both legs (owner 2026-10-23)`,
        lines: written.map(({ item, lines }) => ({
          purchaseOrderItemId: item.id,
          qty: item.orderedQty.toString(),
          departureLines: [lines.leg1Departure.id, lines.leg2Departure.id],
          deliveryLines: [lines.leg1Delivery.id, lines.leg2Delivery.id],
        })),
      },
    });
  }

  // 5. Received from leg 2's delivery, on the day it reached Cairo.
  const fresh = await readState(db);
  if (!stepsDone(fresh).received) {
    const leg2Now = fresh.legs.find((l) => l.sequence === 2)!;
    const delivery = leg2Now.deliveries[0];
    const newItems = fresh.orders
      .find((o) => o.reference === PO_REFERENCE)!
      .items.filter((i) => EXTRAS.some((e) => e.name === i.productName));
    const received = await inventory.verifyStock(
      cycleId,
      {
        deliveryId: delivery.id,
        receivedOn: '2026-09-09',
        items: newItems.map((i) => {
          const line = delivery.lines.find(
            (l) => l.purchaseOrderItemId === i.id,
          )!;
          return { deliveryLineId: line.id, receivedQty: Number(line.qty) };
        }),
      },
      actorId,
    );
    console.log(
      `  + received ${received.data.length} batches from delivery ${delivery.id} on 2026-09-09`,
    );
  }

  // 6. Leg 2's cost: every batch first put at the cost the legs give now (the
  //    18 pieces moved leg 1's spread), then corrected through updateLeg.
  if (!stepsDone(await readState(db)).leg2Cost) {
    const realigned = await db.$transaction(async (tx) => {
      await lockCycle(tx, cycleId);
      const plan = await wholeCyclePlan(tx, cycleId);
      return recost(tx, costing, cycleId, plan);
    });
    await audit.log({
      actorUserId: actorId,
      action: 'CORRECTION',
      entityType: 'ImportCycle',
      entityId: cycleId,
      afterJson: {
        note: `${CYCLE_CODE}: batches re-costed after the ${EXTRAS.length} lines were added (leg 1's cost now spread over 248 pieces), before leg 2's correction`,
        batches: realigned,
      },
    });
    console.log(
      `  ~ ${realigned.filter((b) => b.oldUnitCostEgp !== b.newUnitCostEgp).length} batches re-aligned`,
    );
    await shipping.updateLeg(
      leg2.id,
      {
        costBasis: LEG2_COST.costBasis,
        amount: LEG2_COST.amount,
        currency: LEG2_COST.currency,
        fxRateToEgp: LEG2_COST.fxRateToEgp,
      },
      actorId,
    );
    console.log(
      `  ~ leg 2 → ${LEG2_COST.costBasis} ${LEG2_COST.amount} ${LEG2_COST.currency} at ${LEG2_COST.fxRateToEgp}`,
    );
  }

  // 7. Ahmad Eraiby's payment, recorded again.
  const lender = await db.lender.findFirst({
    where: { name: LENDER_NAME, deletedAt: null },
  });
  if (!lender) throw new Error(`${LENDER_NAME} not found`);
  const standing = () =>
    db.lenderFinancing.findFirst({
      where: { lenderId: lender.id, purchaseOrderId: po.id, removedAt: null },
    });
  let financing = await standing();
  if (financing && !D(financing.amount).equals(FINANCING.amount)) {
    await lenders.removeFinancing(financing.id, REMOVAL_REASON, actorId);
    console.log(
      `  - removed ${LENDER_NAME}'s ${m2(financing.amount)} ${financing.currency} (${financing.id})`,
    );
    financing = null;
  }
  if (!financing) {
    const made = await lenders.finance(
      po.id,
      {
        lenderId: lender.id,
        amount: FINANCING.amount,
        currency: FINANCING.currency,
        fxRateToEgp: FINANCING.fxRateToEgp,
        paidOn: FINANCING.paidOn,
        note: FINANCING.note,
      },
      actorId,
    );
    financing = await standing();
    console.log(
      `  + ${LENDER_NAME} paid ${made.data.amount} ${made.data.currency} at ${FINANCING.fxRateToEgp} = ${m2(financing!.amountEgp)} EGP (${financing!.id})`,
    );
  }

  // 8. The three repayments.
  for (const r of REPAYMENTS) {
    const had = await db.lenderRepayment.findFirst({
      where: {
        financingId: financing!.id,
        paidOn: new Date(`${r.paidOn}T00:00:00Z`),
        reversedAt: null,
      },
    });
    if (had) continue;
    const amountEgp =
      r.amountEgp ??
      (await lenders.quote(financing!.id, r.rateToEgp)).data.settlingEgp;
    await lenders.repay(
      financing!.id,
      {
        amountEgp: Number(amountEgp),
        rateToEgp: r.rateToEgp,
        paidOn: r.paidOn,
      },
      actorId,
    );
    console.log(`  + repaid ${amountEgp} EGP at ${r.rateToEgp} on ${r.paidOn}`);
  }

  // 9. The partners' contributions.
  const participants = await db.cycleParticipant.findMany({
    where: { cycleId },
    orderBy: { createdAt: 'asc' },
  });
  for (const p of participants) {
    if (D(p.contributionAmount).equals(CONTRIBUTION_EGP)) continue;
    await cycles.updateParticipant(
      p.id,
      { contributionAmount: Number(CONTRIBUTION_EGP) },
      actorId,
    );
    console.log(
      `  ~ contribution ${m2(p.contributionAmount)} → ${CONTRIBUTION_EGP} (${p.id})`,
    );
  }

  const end = stepsDone(await readState(db));
  const missing = STEPS.filter((k) => !end[k]);
  if (missing.length > 0)
    throw new Error(`steps not done at the end: ${missing.join(', ')}`);
  printReport(before, await snapshot(app, cycleId));
  console.log('\nDone. Run scripts/check-data.sh against this database next.');
}

async function main() {
  const argv = process.argv.slice(2);
  const target = assertTarget(process.env.DATABASE_URL, argv);
  console.log(
    `CYC-2026-0001 correction → ${target.db} on ${target.host}${target.production ? ' (PRODUCTION)' : ''}${argv.includes('--plan') ? ', plan only' : ''}`,
  );

  // One connection, as on the deployed API: a service that reached for a
  // second one inside a transaction would hang here too, not only there.
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
    // A laptop talking to a hosted database takes a network hop per query;
    // the default 5 s for a transaction is a figure for a local one.
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
