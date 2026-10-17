/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- an in-memory stand-in for Prisma answers loosely-shaped query objects */
import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { HttpException, type ExecutionContext } from '@nestjs/common';
import { RolesGuard } from './guards/roles.guard';
import {
  cyclesVisibleTo,
  ownParticipantIds,
  type Viewer,
} from './investor-scope';
import { fakeDb, type Tables } from './investor-scope-fake-spec';
import { CyclesService } from '../modules/cycles/cycles.service';
import { CyclesController } from '../modules/cycles/cycles.controller';
import { PurchasesService } from '../modules/purchases/purchases.service';
import {
  CyclePurchasesController,
  PurchasesController,
} from '../modules/purchases/purchases.controller';
import { ShippingService } from '../modules/shipping/shipping.service';
import {
  CycleShippingController,
  ShippingController,
} from '../modules/shipping/shipping.controller';
import { InventoryService } from '../modules/inventory/inventory.service';
import { InventoryController } from '../modules/inventory/inventory.controller';
import { CostingService } from '../modules/costing/costing.service';
import { CostingController } from '../modules/costing/costing.controller';
import { SettlementsService } from '../modules/settlements/settlements.service';
import { SettlementsController } from '../modules/settlements/settlements.controller';
import { SuppliersService } from '../modules/suppliers/suppliers.service';
import { SuppliersController } from '../modules/suppliers/suppliers.controller';
import { ProvidersService } from '../modules/providers/providers.service';
import { ProvidersController } from '../modules/providers/providers.controller';
import { ProductsService } from '../modules/products/products.service';
import { ProductsController } from '../modules/products/products.controller';
import { FilesService } from '../modules/files/files.service';
import { FilesController } from '../modules/files/files.controller';
import { AnalyticsService } from '../modules/analytics/analytics.service';
import { AnalyticsController } from '../modules/analytics/analytics.controller';
import { CustomersController } from '../modules/customers/customers.controller';
import { PaymentPlansController } from '../modules/payment-plans/payment-plans.controller';
import { ReturnsController } from '../modules/returns/returns.controller';

/**
 * R1 — a temporary investor sees only their own cycles (BUSINESS_LOGIC roles,
 * decided by the owner 2026-10-10; plan task R1). Every edge case in the plan
 * is a test named after it below.
 *
 * The services run against an in-memory set of rows, so "only their cycles"
 * is what actually comes back, not a `where` the service built and may never
 * have used. The guards are read off the real controllers.
 */

// ─── The business, in rows ──────────────────────────────────────────────
//
// C1: the investor and a partner.  C2: the partner alone.  C3: the investor
// and a second investor.  Each cycle bought, shipped, received and (C1, C2)
// settled, so every read has something on both sides of the line.

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [C1, C2, C3] = [id(1), id(2), id(3)];
const [PARTNER, INVESTOR, OTHER_INVESTOR, EMPTY_INVESTOR, ADMIN] = [
  id(11),
  id(12),
  id(13),
  id(14),
  id(15),
];
const [P1, P2, P3, P4, P5] = [id(21), id(22), id(23), id(24), id(25)];
const [PO1, PO2, PO3] = [id(31), id(32), id(33)];
const [S1, S2] = [id(41), id(42)];
const [V1, V2] = [id(51), id(52)];
const [L1, L2] = [id(61), id(62)];
const [B1, B2] = [id(71), id(72)];
const [ST1, ST2] = [id(81), id(82)];
const PROD = id(91);

const partner: Viewer = { id: PARTNER, role: 'CORE_PARTNER' };
const admin: Viewer = { id: ADMIN, role: 'ADMIN_SUPPORT' };
const investor: Viewer = { id: INVESTOR, role: 'TEMP_INVESTOR' };
const emptyInvestor: Viewer = { id: EMPTY_INVESTOR, role: 'TEMP_INVESTOR' };

function tables(): Tables {
  const cycle = (cid: string, code: string) => ({
    id: cid,
    code,
    status: 'SELLING',
    originType: 'UAE_DIRECT',
    createdAt: new Date(),
  });
  const user = (uid: string, role: string) => ({
    id: uid,
    email: `${role.toLowerCase()}@x.test`,
    role,
    passwordHash: 'bcrypt-secret',
    partnerId: null,
  });
  const participant = (
    pid: string,
    cid: string,
    who: string,
    type: string,
  ) => ({
    id: pid,
    cycleId: cid,
    participantType: type,
    partnerUserId: type === 'CORE_PARTNER' ? who : null,
    investorUserId: type === 'TEMP_INVESTOR' ? who : null,
    contributionAmount: '50000.00',
    createdAt: new Date(),
  });
  return {
    importCycle: [cycle(C1, 'CYC-1'), cycle(C2, 'CYC-2'), cycle(C3, 'CYC-3')],
    user: [
      user(PARTNER, 'CORE_PARTNER'),
      user(INVESTOR, 'TEMP_INVESTOR'),
      user(OTHER_INVESTOR, 'TEMP_INVESTOR'),
      user(EMPTY_INVESTOR, 'TEMP_INVESTOR'),
    ],
    cycleParticipant: [
      participant(P1, C1, INVESTOR, 'TEMP_INVESTOR'),
      participant(P2, C1, PARTNER, 'CORE_PARTNER'),
      participant(P3, C2, PARTNER, 'CORE_PARTNER'),
      participant(P4, C3, INVESTOR, 'TEMP_INVESTOR'),
      participant(P5, C3, OTHER_INVESTOR, 'TEMP_INVESTOR'),
    ],
    supplier: [
      { id: S1, name: 'Shared Supplier', country: 'AE' },
      { id: S2, name: 'Partners-only Supplier', country: 'CN' },
    ],
    purchaseOrder: [
      { id: PO1, cycleId: C1, supplierId: S1, createdAt: new Date() },
      { id: PO2, cycleId: C2, supplierId: S2, createdAt: new Date() },
      { id: PO3, cycleId: C3, supplierId: S1, createdAt: new Date() },
    ],
    provider: [
      { id: V1, name: 'Investor Freight' },
      { id: V2, name: 'Partners Freight' },
    ],
    shippingLeg: [
      { id: L1, cycleId: C1, providerId: V1, sequence: 1 },
      { id: L2, cycleId: C2, providerId: V2, sequence: 1 },
    ],
    product: [
      { id: PROD, name: 'Brake pad', sku: 'BP-1', createdAt: new Date() },
    ],
    supplierProduct: [{ id: id(95), supplierId: S2, productId: PROD }],
    inventoryBatch: [
      {
        id: B1,
        cycleId: C1,
        productId: PROD,
        receivedQty: '10',
        remainingQty: '4',
        reservedQty: '0',
        saleableQty: '4',
        landedUnitCostEgp: '100',
        arrivedOn: new Date(),
        createdAt: new Date(),
      },
      {
        id: B2,
        cycleId: C2,
        productId: PROD,
        receivedQty: '20',
        remainingQty: '20',
        reservedQty: '0',
        saleableQty: '20',
        landedUnitCostEgp: '90',
        arrivedOn: new Date(),
        createdAt: new Date(),
      },
    ],
    inventoryMovement: [
      { id: id(101), batchId: B1, movementType: 'RECEIPT', qtyDelta: '10' },
      { id: id(102), batchId: B2, movementType: 'RECEIPT', qtyDelta: '20' },
    ],
    settlement: [
      {
        id: ST1,
        cycleId: C1,
        status: 'APPROVED',
        grossProfitEgp: '90000.00',
        createdAt: new Date(),
      },
      {
        id: ST2,
        cycleId: C2,
        status: 'DRAFT',
        grossProfitEgp: '30000.00',
        createdAt: new Date(),
      },
    ],
    settlementLine: [
      {
        id: id(111),
        settlementId: ST1,
        participantId: P1,
        component: 'PROFIT',
        amount: '45000.00',
      },
      {
        id: id(112),
        settlementId: ST1,
        participantId: P2,
        component: 'PROFIT',
        amount: '45000.00',
      },
      {
        id: id(113),
        settlementId: ST2,
        participantId: P3,
        component: 'PROFIT',
        amount: '30000.00',
      },
    ],
    fileAsset: [
      {
        id: id(121),
        objectKey: 'products/p/photo.webp',
        productId: PROD,
        mimeType: 'image/webp',
      },
      {
        id: id(122),
        objectKey: 'product-requests/r/shop.webp',
        productId: null,
        productRequestId: id(123),
        mimeType: 'image/webp',
      },
    ],
  };
}

// ─── Services over the rows ─────────────────────────────────────────────

function services() {
  const db = fakeDb(tables()) as any;
  const costing = new CostingService(db);
  const cycles = new CyclesService(db, {} as never, {} as never);
  const files = new FilesService(db);
  (files as any).storage = {
    get: jest.fn().mockResolvedValue(Buffer.from('img')),
  };
  return {
    db,
    costing,
    cycles,
    purchases: new PurchasesService(db, {} as never, {} as never),
    shipping: new ShippingService(db, {} as never, costing, {} as never),
    inventory: new InventoryService(
      db,
      {} as never,
      {} as never,
      costing,
      cycles,
    ),
    settlements: new SettlementsService(db, {} as never),
    suppliers: new SuppliersService(db, {} as never),
    providers: new ProvidersService(db, {} as never),
    products: new ProductsService(db, {} as never, {} as never),
    analytics: new AnalyticsService(db),
    files,
  };
}

async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    const err = e as HttpException;
    return {
      status: err.getStatus(),
      body: err.getResponse() as Record<string, any>,
    };
  }
  throw new Error('expected a refusal');
}

const ids = (r: { data: { id: string }[] }) => r.data.map((x) => x.id).sort();

// ─── Guards, read off the controllers ───────────────────────────────────

const guard = new RolesGuard(new Reflector());
function canCall(cls: any, method: string, role: string | undefined) {
  const handler = Object.getOwnPropertyDescriptor(cls.prototype, method)!.value;
  const ctx = {
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({
      getRequest: () => ({ user: role ? { id: 'u', role } : undefined }),
    }),
  } as unknown as ExecutionContext;
  try {
    return guard.canActivate(ctx);
  } catch (e) {
    const err = e as HttpException;
    return { status: err.getStatus(), body: err.getResponse() };
  }
}
const refusedWithCode = {
  status: 403,
  body: expect.objectContaining({ code: 'ROLE_NOT_ALLOWED' }),
};

// ═══ The helper ═════════════════════════════════════════════════════════

describe('cyclesVisibleTo — the one definition', () => {
  it('core partner and admin support: no restriction (null)', async () => {
    const { db } = services();
    expect(await cyclesVisibleTo(partner, db)).toBeNull();
    expect(await cyclesVisibleTo(admin, db)).toBeNull();
  });

  it('a temporary investor: exactly the cycles they participate in', async () => {
    const { db } = services();
    expect([...(await cyclesVisibleTo(investor, db))!].sort()).toEqual([
      C1,
      C3,
    ]);
  });

  it('a shop, a role nobody planned for, or no user at all → nothing, never everything', async () => {
    const { db } = services();
    expect(
      await cyclesVisibleTo({ id: 'x', role: 'SHOP_OWNER_PORTAL' }, db),
    ).toEqual([]);
    expect(
      await cyclesVisibleTo({ id: 'x', role: 'SOMETHING_NEW' }, db),
    ).toEqual([]);
    expect(await cyclesVisibleTo(undefined, db)).toEqual([]);
    expect(await cyclesVisibleTo(null, db)).toEqual([]);
  });

  it('an internal caller (the assistant, partners only) is unrestricted', async () => {
    const { db } = services();
    expect(await cyclesVisibleTo('internal', db)).toBeNull();
  });

  it("an investor's own participant rows — not the other investor's on the shared cycle", async () => {
    const { db } = services();
    expect([...(await ownParticipantIds(investor, db))!].sort()).toEqual([
      P1,
      P4,
    ]);
  });
});

// ═══ Cycles ═════════════════════════════════════════════════════════════

describe('An investor on GET /cycles sees only cycles they participate in; GET /cycles/:otherId → 404', () => {
  it('GET /cycles lists C1 and C3, never the partners-only C2', async () => {
    const { cycles } = services();
    expect(ids(await cycles.findAll({}, investor))).toEqual([C1, C3]);
  });

  it('GET /cycles/:otherId → 404 NOT_FOUND cycle, the same as a cycle that does not exist', async () => {
    const { cycles } = services();
    const r = await refusal(cycles.findById(C2, investor));
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({
      code: 'NOT_FOUND',
      params: { entity: 'cycle' },
    });
    const missing = await refusal(cycles.findById(id(999), investor));
    expect(missing.body).toEqual(r.body);
  });

  it('GET /cycles/:id for their own cycle → the cycle', async () => {
    const { cycles } = services();
    expect((await cycles.findById(C1, investor)).data.id).toBe(C1);
  });

  it('GET /cycles/:otherId/shipment and /participants → 404 too', async () => {
    const { cycles } = services();
    expect((await refusal(cycles.getShipment(C2, investor))).status).toBe(404);
    expect((await refusal(cycles.getParticipants(C2, investor))).status).toBe(
      404,
    );
  });

  it('GET /cycles/:id/shipment now lets an investor in (deliveries and losses are theirs to see)', () => {
    expect(canCall(CyclesController, 'getShipment', 'TEMP_INVESTOR')).toBe(
      true,
    );
    expect(
      canCall(CyclesController, 'getShipment', 'SHOP_OWNER_PORTAL'),
    ).toEqual(refusedWithCode);
  });

  it("on a shared cycle an investor sees their own participation, not the others' contributions", async () => {
    const { cycles } = services();
    const one = (await cycles.findById(C3, investor)).data as any;
    expect(one.participants.map((p: any) => p.id)).toEqual([P4]);
    const list = (await cycles.findAll({}, investor)).data as any[];
    expect(
      list.find((c) => c.id === C1).participants.map((p: any) => p.id),
    ).toEqual([P1]);
    const rows = (await cycles.getParticipants(C3, investor)).data;
    expect(rows.map((p) => p.id)).toEqual([P4]);
  });

  it('GET /cycles/:id/participants never sends a password hash (it used to include the whole user)', async () => {
    const { cycles } = services();
    const rows = (await cycles.getParticipants(C1, partner)).data as any[];
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(JSON.stringify(r)).not.toContain('bcrypt-secret');
    }
  });

  it('an id that is not a uuid → 404, not a 500 from a failed cast', async () => {
    const { cycles } = services();
    expect((await refusal(cycles.findById('CYC-1', partner))).status).toBe(404);
  });
});

// ═══ Business-wide and customer data: refused ═══════════════════════════

describe('An investor on /customers, /payment-plans, /payment-plans/overdue, /returns → refused with a code', () => {
  const reads: [string, any, string][] = [
    ['GET /customers', CustomersController, 'findAll'],
    ['GET /customers/:id', CustomersController, 'findById'],
    ['GET /payment-plans', PaymentPlansController, 'findAll'],
    ['GET /payment-plans/overdue', PaymentPlansController, 'overdue'],
    ['GET /payment-plans/:id', PaymentPlansController, 'findOne'],
    ['GET /returns', ReturnsController, 'findAll'],
    ['GET /returns/:id', ReturnsController, 'findOne'],
  ];
  it.each(reads)('%s: investor → 403 ROLE_NOT_ALLOWED', (_n, cls, m) => {
    expect(canCall(cls, m, 'TEMP_INVESTOR')).toEqual(refusedWithCode);
  });
  it.each(reads)('%s: a role nobody planned for → refused', (_n, cls, m) => {
    expect(canCall(cls, m, 'SOMETHING_NEW')).toEqual(refusedWithCode);
  });
  it.each(reads)(
    '%s: core partner and admin support still let in (the other direction)',
    (_n, cls, m) => {
      expect(canCall(cls, m, 'CORE_PARTNER')).toBe(true);
      expect(canCall(cls, m, 'ADMIN_SUPPORT')).toBe(true);
    },
  );
});

describe("An investor on /analytics/* business-wide figures → refused; their own cycles' profitability → allowed and scoped", () => {
  const businessWide: [string, string][] = [
    ['GET /analytics/dashboard', 'getDashboardKPIs'],
    ['GET /analytics/revenue-by-month', 'getRevenueByMonth'],
    ['GET /analytics/top-products', 'getTopProducts'],
    ['GET /analytics/recent-activity', 'getRecentActivity'],
  ];
  it.each(businessWide)('%s: investor → 403 ROLE_NOT_ALLOWED', (_n, m) => {
    expect(canCall(AnalyticsController, m, 'TEMP_INVESTOR')).toEqual(
      refusedWithCode,
    );
  });
  it.each(businessWide)(
    '%s: core partner and admin support let in',
    (_n, m) => {
      expect(canCall(AnalyticsController, m, 'CORE_PARTNER')).toBe(true);
      expect(canCall(AnalyticsController, m, 'ADMIN_SUPPORT')).toBe(true);
    },
  );

  it('GET /analytics/cycle-profitability: open to an investor', () => {
    expect(
      canCall(AnalyticsController, 'getCycleProfitability', 'TEMP_INVESTOR'),
    ).toBe(true);
  });

  it('GET /analytics/cycle-profitability: an investor gets only their cycles with stock (C1), a partner every one', async () => {
    const { analytics } = services();
    const codes = (r: { data: { cycleCode: string }[] }) =>
      r.data.map((x) => x.cycleCode).sort();
    expect(codes(await analytics.getCycleProfitability(investor))).toEqual([
      'CYC-1',
    ]);
    expect(codes(await analytics.getCycleProfitability(partner))).toEqual([
      'CYC-1',
      'CYC-2',
    ]);
  });
});

// ═══ Cycle-scoped lists ═════════════════════════════════════════════════

describe('An investor on /purchases, /shipping/legs, /costing, /inventory → only rows of their cycles', () => {
  it("GET /purchases → only their cycles' orders", async () => {
    const { purchases } = services();
    expect(ids(await purchases.findAll({}, investor))).toEqual([PO1, PO3]);
  });

  it("GET /purchases?cycleId=<another cycle> → empty, not the other cycle's orders", async () => {
    const { purchases } = services();
    expect((await purchases.findAll({ cycleId: C2 }, investor)).data).toEqual(
      [],
    );
  });

  it('GET /purchases/:id of another cycle → 404 purchaseOrder; GET /cycles/:other/purchases → 404', async () => {
    const { purchases } = services();
    const r = await refusal(purchases.findById(PO2, investor));
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ params: { entity: 'purchaseOrder' } });
    expect((await refusal(purchases.findByCycle(C2, investor))).status).toBe(
      404,
    );
    expect((await purchases.findById(PO1, investor)).data.id).toBe(PO1);
  });

  it("GET /shipping/legs → only their cycles' legs; GET /cycles/:other/shipping-legs → 404", async () => {
    const { shipping } = services();
    expect(ids(await shipping.findAll({}, investor))).toEqual([L1]);
    expect((await shipping.findAll({ cycleId: C2 }, investor)).data).toEqual(
      [],
    );
    expect((await refusal(shipping.findByCycle(C2, investor))).status).toBe(
      404,
    );
  });

  it('GET /costing/cycles/:other/landed-cost → 404 without computing anything', async () => {
    const { costing } = services();
    const compute = jest
      .spyOn(costing, 'computeCycleLandedCosts')
      .mockResolvedValue({} as never);
    expect((await refusal(costing.landedCostFor(C2, investor))).status).toBe(
      404,
    );
    expect(compute).not.toHaveBeenCalled();
    await costing.landedCostFor(C1, investor);
    expect(compute).toHaveBeenCalledWith(C1);
  });

  it('GET /inventory → only batches their cycles brought in', async () => {
    const { inventory } = services();
    const stock = (await inventory.getStock({}, investor)).data;
    expect(stock.flatMap((p) => p.batches.map((b: any) => b.id))).toEqual([B1]);
    // The product total is their stock, not the business's.
    expect(stock[0].totalStock).toBe(4);
    expect((await inventory.getStock({ cycleId: C2 }, investor)).data).toEqual(
      [],
    );
  });

  it('GET /inventory/batches/:other/movements → 404 inventoryBatch', async () => {
    const { inventory } = services();
    const r = await refusal(inventory.getMovements(B2, investor));
    expect(r.body).toMatchObject({ params: { entity: 'inventoryBatch' } });
    expect((await inventory.getMovements(B1, investor)).data).toHaveLength(1);
  });
});

// ═══ Settlement ═════════════════════════════════════════════════════════

describe("An investor reads their settlement and payout; another participant's payout details on a shared cycle → only what their own line shows", () => {
  it('the settlement reads let an investor in; approving, paying and reversing still do not', () => {
    for (const m of ['findAll', 'findOne', 'preview']) {
      expect(canCall(SettlementsController, m, 'TEMP_INVESTOR')).toBe(true);
    }
    for (const m of ['calculate', 'approve', 'markPaid', 'reverse']) {
      expect(canCall(SettlementsController, m, 'TEMP_INVESTOR')).toEqual(
        refusedWithCode,
      );
    }
  });

  it("GET /settlements → their cycle's settlement, with their own line only", async () => {
    const { settlements } = services();
    const r = (await settlements.findAll({}, investor)).data as any[];
    expect(r.map((s) => s.id)).toEqual([ST1]);
    expect(r[0].lines.map((l: any) => l.participantId)).toEqual([P1]);
    // The cycle's totals are theirs to see.
    expect(r[0].grossProfitEgp).toBe('90000.00');
  });

  it('GET /settlements/:id of their cycle → their line only; of another cycle → 404', async () => {
    const { settlements } = services();
    const own = (await settlements.findOne(ST1, investor)).data as any;
    expect(own.lines.map((l: any) => l.participantId)).toEqual([P1]);
    const r = await refusal(settlements.findOne(ST2, investor));
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ params: { entity: 'settlement' } });
  });

  it('GET /settlements/preview/:cycleId → the totals and their own payout line; another cycle → 404', async () => {
    const { settlements } = services();
    const line = (participantId: string) => ({
      participantId,
      type: 'TEMP_INVESTOR',
      sharePct: { toFixed: () => '50.0000' },
      netProfit: { toFixed: () => '45000.00' },
      feeReceived: { toFixed: () => '0.00' },
      capitalReturn: { toFixed: () => '50000.00' },
      payout: { toFixed: () => '95000.00' },
    });
    const dec = (v: string) => ({ toFixed: () => v });
    jest.spyOn(settlements, 'project').mockResolvedValue({
      pnl: {
        revenue: dec('300000.00'),
        cogs: dec('210000.00'),
        expenses: dec('0.00'),
        grossProfit: dec('90000.00'),
        unsoldValue: dec('0.00'),
        fullySold: true,
      },
      distribution: { lines: [line(P4), line(P5)] },
      participants: [],
      lossesEgp: dec('0.00'),
      exchangeDifferenceEgp: dec('0.00'),
      hasAllocations: true,
    } as never);
    const r = (await settlements.preview(C3, investor)).data;
    expect(r.grossProfitEgp).toBe('90000.00');
    expect(r.lines.map((l) => l.participantId)).toEqual([P4]);
    expect((await refusal(settlements.preview(C2, investor))).status).toBe(404);
    // A core partner sees every line of the same preview.
    expect((await settlements.preview(C3, partner)).data.lines).toHaveLength(2);
  });
});

// ═══ Reference data ═════════════════════════════════════════════════════

describe('Reference data an investor needs for their cycle pages — the least that renders them', () => {
  it('GET /suppliers → only suppliers their cycles bought from, with only those orders counted', async () => {
    const { suppliers } = services();
    const r = (await suppliers.findAll({}, investor)).data as any[];
    expect(r.map((s) => s.id)).toEqual([S1]);
    expect(r[0]._count.purchaseOrders).toBe(2);
    expect((await refusal(suppliers.findById(S2, investor))).status).toBe(404);
    const one = (await suppliers.findById(S1, investor)).data as any;
    expect(one.purchaseOrders.map((p: any) => p.id).sort()).toEqual([PO1, PO3]);
  });

  it('GET /providers → only providers that carried their cycles', async () => {
    const { providers } = services();
    expect(ids(await providers.findAll(investor))).toEqual([V1]);
    expect((await refusal(providers.findById(V2, investor))).status).toBe(404);
  });

  it('GET /products → the catalogue, without who else the business buys each part from', async () => {
    const { products } = services();
    const forInvestor = (await products.findAll({}, investor)).data as any[];
    expect(forInvestor.map((p) => p.id)).toEqual([PROD]);
    expect(forInvestor[0].suppliers).toBeUndefined();
    // Nor how many are in stock (2026-10-17): the stock is the business's.
    expect(forInvestor[0].onHand).toBeUndefined();
    const forPartner = (await products.findAll({}, partner)).data as any[];
    expect(forPartner[0].suppliers).toHaveLength(1);
    expect(forPartner[0].onHand).toBe(24);
  });

  it("GET /files/download: a product photo → served; a shop's request photo → 404 for an investor", async () => {
    const { files } = services();
    await expect(
      files.serveFile('products/p/photo.webp', investor),
    ).resolves.toBeTruthy();
    expect(
      (await refusal(files.serveFile('product-requests/r/shop.webp', investor)))
        .status,
    ).toBe(404);
    await expect(
      files.serveFile('product-requests/r/shop.webp', partner),
    ).resolves.toBeTruthy();
  });

  it("adding or deleting a product photo is a core partner's, not any signed-in account's", () => {
    expect(
      canCall(FilesController, 'uploadProductImage', 'TEMP_INVESTOR'),
    ).toEqual(refusedWithCode);
    expect(canCall(FilesController, 'remove', 'TEMP_INVESTOR')).toEqual(
      refusedWithCode,
    );
    expect(canCall(FilesController, 'uploadProductImage', 'CORE_PARTNER')).toBe(
      true,
    );
  });
});

// ═══ The other direction ════════════════════════════════════════════════

describe('A core partner still sees everything (the other direction)', () => {
  it.each([
    ['core partner', partner],
    ['admin support', admin],
  ])(
    '%s: every cycle, order, leg, batch, settlement, supplier and provider',
    async (_n, who) => {
      const s = services();
      expect(ids(await s.cycles.findAll({}, who))).toEqual([C1, C2, C3]);
      expect(ids(await s.purchases.findAll({}, who))).toEqual([PO1, PO2, PO3]);
      expect(ids(await s.shipping.findAll({}, who))).toEqual([L1, L2]);
      const stock = (await s.inventory.getStock({}, who)).data;
      expect(
        stock.flatMap((p) => p.batches.map((b: any) => b.id)).sort(),
      ).toEqual([B1, B2]);
      expect(ids(await s.settlements.findAll({}, who))).toEqual([ST1, ST2]);
      expect(ids(await s.suppliers.findAll({}, who))).toEqual([S1, S2]);
      expect(ids(await s.providers.findAll(who))).toEqual([V1, V2]);
    },
  );

  it("a core partner: another person's cycle, every participant and every settlement line", async () => {
    const s = services();
    const c = (await s.cycles.findById(C3, partner)).data as any;
    expect(c.participants.map((p: any) => p.id).sort()).toEqual([P4, P5]);
    const st = (await s.settlements.findOne(ST1, partner)).data as any;
    expect(st.lines.map((l: any) => l.participantId).sort()).toEqual([P1, P2]);
    expect((await s.purchases.findById(PO2, partner)).data.id).toBe(PO2);
    expect((await s.inventory.getMovements(B2, partner)).data).toHaveLength(1);
  });
});

// ═══ Empty ══════════════════════════════════════════════════════════════

describe('An investor with no cycles → empty lists, not errors', () => {
  it('every scoped list answers [] for an investor on no cycle', async () => {
    const s = services();
    expect((await s.cycles.findAll({}, emptyInvestor)).data).toEqual([]);
    expect((await s.purchases.findAll({}, emptyInvestor)).data).toEqual([]);
    expect((await s.shipping.findAll({}, emptyInvestor)).data).toEqual([]);
    expect((await s.inventory.getStock({}, emptyInvestor)).data).toEqual([]);
    expect((await s.settlements.findAll({}, emptyInvestor)).data).toEqual([]);
    expect((await s.suppliers.findAll({}, emptyInvestor)).data).toEqual([]);
    expect((await s.providers.findAll(emptyInvestor)).data).toEqual([]);
    expect(
      (await s.analytics.getCycleProfitability(emptyInvestor)).data,
    ).toEqual([]);
  });

  it('and any one cycle is 404 for them', async () => {
    const s = services();
    expect((await refusal(s.cycles.findById(C1, emptyInvestor))).status).toBe(
      404,
    );
  });
});

// ═══ Controllers hand the signed-in user to the scope ═══════════════════
//
// A service defaults to 'internal' (unrestricted) for the assistant. So a
// controller that forgot to pass its user would quietly open the read again;
// each one is checked here.

describe('every scoped route passes the signed-in user to its service', () => {
  const user = investor;
  const spy = () => jest.fn().mockResolvedValue({ data: [] });
  const cases: [string, () => Promise<{ fn: jest.Mock }>][] = [
    [
      'GET /cycles',
      async () => {
        const fn = spy();
        await new CyclesController({ findAll: fn } as never).findAll({}, user);
        return { fn };
      },
    ],
    [
      'GET /cycles/:id',
      async () => {
        const fn = spy();
        await new CyclesController({ findById: fn } as never).findById(
          C1,
          user,
        );
        return { fn };
      },
    ],
    [
      'GET /cycles/:id/shipment',
      async () => {
        const fn = spy();
        await new CyclesController({ getShipment: fn } as never).getShipment(
          C1,
          user,
        );
        return { fn };
      },
    ],
    [
      'GET /cycles/:id/participants',
      async () => {
        const fn = spy();
        await new CyclesController({
          getParticipants: fn,
        } as never).getParticipants(C1, user);
        return { fn };
      },
    ],
    [
      'GET /purchases',
      async () => {
        const fn = spy();
        await new PurchasesController({ findAll: fn } as never).findAll(
          {},
          user,
        );
        return { fn };
      },
    ],
    [
      'GET /purchases/:id',
      async () => {
        const fn = spy();
        await new PurchasesController({ findById: fn } as never).findById(
          PO1,
          user,
        );
        return { fn };
      },
    ],
    [
      'GET /cycles/:id/purchases',
      async () => {
        const fn = spy();
        await new CyclePurchasesController({
          findByCycle: fn,
        } as never).findByCycle(C1, user);
        return { fn };
      },
    ],
    [
      'GET /shipping/legs',
      async () => {
        const fn = spy();
        await new ShippingController(
          { findAll: fn } as never,
          {} as never,
          {} as never,
        ).findAll({}, user);
        return { fn };
      },
    ],
    [
      'GET /cycles/:id/shipping-legs',
      async () => {
        const fn = spy();
        await new CycleShippingController({
          findByCycle: fn,
        } as never).findByCycle(C1, user);
        return { fn };
      },
    ],
    [
      'GET /inventory',
      async () => {
        const fn = spy();
        await new InventoryController({ getStock: fn } as never).getStock(
          {},
          user,
        );
        return { fn };
      },
    ],
    [
      'GET /inventory/batches/:id/movements',
      async () => {
        const fn = spy();
        await new InventoryController({
          getMovements: fn,
        } as never).getMovements(B1, user);
        return { fn };
      },
    ],
    [
      'GET /settlements',
      async () => {
        const fn = spy();
        await new SettlementsController({ findAll: fn } as never).findAll(
          {},
          user,
        );
        return { fn };
      },
    ],
    [
      'GET /settlements/:id',
      async () => {
        const fn = spy();
        await new SettlementsController({ findOne: fn } as never).findOne(
          ST1,
          user,
        );
        return { fn };
      },
    ],
    [
      'GET /settlements/preview/:cycleId',
      async () => {
        const fn = spy();
        await new SettlementsController({ preview: fn } as never).preview(
          C1,
          user,
        );
        return { fn };
      },
    ],
    [
      'GET /suppliers',
      async () => {
        const fn = spy();
        await new SuppliersController({ findAll: fn } as never).findAll(
          {},
          user,
        );
        return { fn };
      },
    ],
    [
      'GET /suppliers/:id',
      async () => {
        const fn = spy();
        await new SuppliersController({ findById: fn } as never).findById(
          S1,
          user,
        );
        return { fn };
      },
    ],
    [
      'GET /providers',
      async () => {
        const fn = spy();
        await new ProvidersController({ findAll: fn } as never).findAll(user);
        return { fn };
      },
    ],
    [
      'GET /providers/:id',
      async () => {
        const fn = spy();
        await new ProvidersController({ findById: fn } as never).findById(
          V1,
          user,
        );
        return { fn };
      },
    ],
    [
      'GET /products',
      async () => {
        const fn = spy();
        await new ProductsController({ findAll: fn } as never).findAll(
          {},
          user,
        );
        return { fn };
      },
    ],
    [
      'GET /analytics/cycle-profitability',
      async () => {
        const fn = spy();
        await new AnalyticsController({
          getCycleProfitability: fn,
        } as never).getCycleProfitability(user);
        return { fn };
      },
    ],
  ];
  it.each(cases)('%s', async (_n, run) => {
    const { fn } = await run();
    expect(fn.mock.calls[0].at(-1)).toBe(user);
  });

  it('GET /costing/cycles/:id/landed-cost', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('stop'));
    await expect(
      new CostingController({ landedCostFor: fn } as never).cycleLandedCost(
        C1,
        user,
      ),
    ).rejects.toThrow('stop');
    expect(fn).toHaveBeenCalledWith(C1, user);
  });
});
