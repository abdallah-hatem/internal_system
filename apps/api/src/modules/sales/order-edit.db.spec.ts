import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { HttpException } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- this suite talks to a real, throwaway Postgres; that is its point
import { PrismaClient, Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { PaymentsService } from '../payments/payments.service';
import { ReturnsService } from '../returns/returns.service';
import { SettlementsService } from '../settlements/settlements.service';
import { businessToday } from '../../common/dates';
import { owedBy } from '../../common/customer-balance';
import { heldUnits } from '../../common/held-price';
import {
  buildStatement,
  loadStatementSource,
} from '../../common/customer-statement';
import { OrderEditsService, type OrderEditInput } from './order-edits.service';
import { OrderHistoryService } from './order-history.service';
import { PriceAdjustmentsService } from './price-adjustments.service';
import { SalesService } from './sales.service';

/**
 * Editing a confirmed order (BUSINESS_LOGIC §4, owner 2026-10-25: "these need
 * a lot of testing scenarios and edge cases"). Every case the BUILD_LOG item
 * lists, each trying to make the system say something untrue (CLAUDE.md §0–§2),
 * and after each edit every reader asked the same question: the order, the
 * Sales list, the shop's balance and statement, the order's History, each
 * cycle's profit, the shelf, and the data check.
 *
 * Built as the business builds it: cycles with verified batches, a confirmed
 * sale drawn FIFO from them, a payment on it.
 *
 *   INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/motorcycle_parts_<name> \
 *     npx jest order-edit.db
 */
// eslint-disable-next-line no-restricted-properties -- an opt-in switch for a suite that must never run by default
const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;
// Each case builds its own cycles and sales and asks every reader after each
// step: far past jest's five seconds on a busy machine.
jest.setTimeout(120_000);

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const daysAgo = (n: number) => {
  const d = new Date(`${businessToday()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const tomorrow = () => {
  const d = new Date(`${businessToday()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof HttpException)) throw e;
    const body = e.getResponse() as {
      code?: string;
      params?: Record<string, unknown>;
    };
    return { status: e.getStatus(), code: body.code, params: body.params };
  }
  throw new Error('expected a refusal');
}

/**
 * The checks of scripts/check-data.sh that an edit can break: stock in a
 * batch, an order's worth, money allocated, price changes, edits, returned
 * orders, the walk-in. (The cycle-funding checks are left out: this suite's
 * cycles are funded by a participant row with no ledger arrival, as the
 * price-adjustment suite's are, and say nothing about an edit.)
 */
const EDIT_CHECKS = [
  '7',
  '7.1',
  '7.2',
  '8',
  '12',
  '12.1',
  '12.2',
  '13.1',
  '13.2',
  '13.3',
  '16',
  '18',
];

/** The data check's own queries (scripts/check-data.sh), the one definition. */
function checkDataSql() {
  const script = readFileSync(
    join(__dirname, '../../../../../scripts/check-data.sh'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const start = script.indexOf("CHECKS=$(cat <<'SQL'\n");
  const end = script.indexOf('\nSQL\n)', start);
  return script.slice(start + "CHECKS=$(cat <<'SQL'\n".length, end);
}

suite('editing a confirmed order (Postgres)', () => {
  let prisma: PrismaClient;
  let sales: SalesService;
  let payments: PaymentsService;
  let returns: ReturnsService;
  let adjust: PriceAdjustmentsService;
  let edits: OrderEditsService;
  let history: OrderHistoryService;
  let analytics: AnalyticsService;
  let settlements: SettlementsService;
  let partner: string;
  const checks = checkDataSql();

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const db = prisma as unknown as PrismaService;
    const audit = {
      log: (row: Record<string, unknown>) =>
        prisma.auditLog.create({ data: row as never }),
    } as unknown as AuditService;
    const notifier = {
      createForMultipleUsers: () => Promise.resolve({ count: 0 }),
    };
    payments = new PaymentsService(db, audit);
    sales = new SalesService(db, audit, payments, notifier);
    returns = new ReturnsService(db, audit);
    adjust = new PriceAdjustmentsService(db, audit);
    edits = new OrderEditsService(db, audit, sales, notifier);
    history = new OrderHistoryService(db);
    analytics = new AnalyticsService(db);
    settlements = new SettlementsService(db, audit);
    const user = await prisma.user.create({
      data: {
        email: `edit-${randomUUID()}@example.com`,
        passwordHash: 'x',
        role: 'CORE_PARTNER',
      },
    });
    partner = user.id;
  });
  afterAll(() => prisma.$disconnect());

  /** A selling cycle, funded by the partner, with one verified batch. */
  async function cycleWith(
    productId: string,
    qty: number,
    cost: number,
    ageDays: number,
  ) {
    const tag = randomUUID().slice(0, 8);
    const cycle = await prisma.importCycle.create({
      data: {
        code: `EDT-${tag}`,
        originType: 'UAE_DIRECT',
        currency: 'EGP',
        status: 'SELLING',
      },
    });
    await prisma.cycleParticipant.create({
      data: {
        cycleId: cycle.id,
        participantType: 'CORE_PARTNER',
        partnerUserId: partner,
        contributionAmount: 10_000,
      },
    });
    const batch = await prisma.inventoryBatch.create({
      data: {
        cycleId: cycle.id,
        productId,
        receivedQty: qty,
        remainingQty: qty,
        saleableQty: qty,
        landedUnitCostEgp: cost,
        verificationStatus: 'VERIFIED',
        createdAt: new Date(Date.now() - ageDays * 86_400_000),
      },
    });
    return { cycle, batch };
  }

  async function product(name: string, status = 'ACTIVE') {
    const tag = randomUUID().slice(0, 8);
    return prisma.product.create({
      data: { sku: `EDT-${tag}`, name: `${name} ${tag}`, status },
    });
  }

  async function shop(name = 'Koshary') {
    return prisma.customer.create({
      data: {
        type: 'B2B',
        displayName: `${name} ${randomUUID().slice(0, 8)}`,
        verificationStatus: 'VERIFIED',
      },
    });
  }

  /**
   * The world every case starts from. Helmet: 6 in an older cycle at 900,
   * 10 in a newer one at 950. Gloves: 5 at 500 in a third. The shop bought
   * 10 helmets at 1,250 three days ago (6 older + 4 newer; 6 newer left on
   * the shelf) — with `gloves`, 2 gloves at 1,000 too — and paid 5,000.
   */
  async function world(opts: { gloves?: boolean; paid?: number } = {}) {
    const helmet = await product('Helmet');
    const gloves = await product('Gloves');
    const older = await cycleWith(helmet.id, 6, 900, 6);
    const newer = await cycleWith(helmet.id, 10, 950, 5);
    const glovesCycle = await cycleWith(gloves.id, 5, 500, 5);
    const customer = await shop();
    const created = (await sales.create(
      {
        customerId: customer.id,
        channel: 'B2B',
        currency: 'EGP',
        orderedOn: daysAgo(3),
        items: [
          { productId: helmet.id, quantity: 10, unitPrice: 1250 },
          ...(opts.gloves
            ? [{ productId: gloves.id, quantity: 2, unitPrice: 1000 }]
            : []),
        ],
        confirm: true,
      },
      partner,
    )) as { data: { id: string } };
    const orderId = created.data.id;
    const paid = opts.paid ?? 5000;
    if (paid > 0) {
      await payments.create(
        {
          customerId: customer.id,
          amount: paid,
          currency: 'EGP',
          method: 'CASH',
          receivedOn: daysAgo(3),
          orderId,
        },
        partner,
      );
    }
    return {
      shop: customer,
      orderId,
      helmet,
      gloves,
      older,
      newer,
      glovesCycle,
      cycles: [older.cycle.id, newer.cycle.id, glovesCycle.cycle.id],
    };
  }
  type World = Awaited<ReturnType<typeof world>>;

  const order = (id: string) =>
    prisma.saleOrder.findUniqueOrThrow({
      where: { id },
      include: { items: true },
    });
  const outstanding = async (id: string) =>
    (await order(id)).outstanding.toFixed(2);
  const version = async (id: string) => (await order(id)).version;

  /** An edit as the office sends it: at the version it just read. */
  async function edit(
    orderId: string,
    lines: OrderEditInput['lines'],
    extra: Partial<OrderEditInput> = {},
  ) {
    return edits.create(
      orderId,
      { version: await version(orderId), lines, ...extra },
      partner,
    );
  }

  const remaining = async (batchId: string) =>
    (
      await prisma.inventoryBatch.findUniqueOrThrow({ where: { id: batchId } })
    ).remainingQty.toString();

  /** Analytics' P&L for one day: its figures are read row by row (itemised). */
  const revenueOn = async (day: string) =>
    new Prisma.Decimal(
      (await analytics.getProfitAndLoss(day, day)).data.salesEgp,
    );
  const cycleProfit = async (cycleId: string) => {
    const p = (await settlements.project(cycleId))!.pnl;
    return p.revenue.sub(p.cogs);
  };

  /**
   * Every reader asked what the order owes, is worth and holds — they must
   * all agree, after every case (BUILD_LOG: "Readers that must agree").
   */
  async function agree(w: World) {
    const o = await prisma.saleOrder.findUniqueOrThrow({
      where: { id: w.orderId },
      include: {
        items: { include: { returnItems: true } },
        paymentAllocations: { include: { payment: true } },
        returns: true,
      },
    });
    // The order popup and the Sales list say the same value now.
    const popup = (await sales.findById(w.orderId)).data;
    const list = (
      await sales.findAll({ customerId: w.shop.id, limit: 50 })
    ).data.find((r) => r.id === w.orderId)!;
    expect(list.valueNowEgp).toBe(popup.valueNowEgp);
    // value now − payments standing + cash refunded = outstanding (§4).
    const paid = o.paymentAllocations
      .filter((a) => a.payment.status !== 'REVERSED')
      .reduce((s, a) => s.add(a.amount), D(0));
    const cash = o.returns
      .filter((r) => r.refundMethod === 'CASH')
      .reduce((s, r) => s.add(r.refundEgp), D(0));
    expect(D(popup.valueNowEgp).sub(paid).add(cash).toFixed(2)).toBe(
      o.outstanding.toFixed(2),
    );
    // History replays to the order's own outstanding.
    const h = (await history.history(w.orderId)).data;
    expect(h.replayedOwes).toBe(h.owes);
    expect(h.owes).toBe(o.outstanding.toFixed(2));
    // The shop's balance and its statement's closing balance.
    const statement = buildStatement(
      { id: w.shop.id, displayName: w.shop.displayName, phone: null },
      await loadStatementSource(prisma, w.shop.id),
    );
    expect(statement.closingBalance).toBe(await owedBy(prisma, w.shop.id));
    // The statement's profit is the cycles' profit: the same units, the same
    // prices, the same costs (rule 11).
    let cycles = D(0);
    for (const c of w.cycles) cycles = cycles.add(await cycleProfit(c));
    expect(statement.profit).toBe(cycles.toFixed(2));
    // The shelf: what came in, less what the shop holds now.
    for (const [productId, received] of [
      [w.helmet.id, 16],
      [w.gloves.id, 5],
    ] as const) {
      const batches = await prisma.inventoryBatch.findMany({
        where: { productId },
      });
      const lines = await prisma.saleItem.findMany({
        where: {
          productId,
          saleOrder: { status: { notIn: ['DRAFT', 'CANCELLED'] } },
        },
        include: { returnItems: true },
      });
      const onShelf = batches.reduce((s, b) => s.add(b.remainingQty), D(0));
      const held = lines.reduce((s, l) => s.add(heldUnits(l)), D(0));
      expect(onShelf.add(held).toString()).toBe(String(received));
    }
    // The data check: every count zero.
    // The script's own text, no value of ours inside it.
    const bad = await prisma.$queryRaw<
      { ord: string; check_name: string; count: bigint }[]
    >(Prisma.sql`SELECT * FROM (${Prisma.raw(checks)}) c WHERE count > 0`);
    expect(
      bad
        .filter((b) => EDIT_CHECKS.includes(String(Number(b.ord))))
        .map((b) => b.check_name),
    ).toEqual([]);
    // The edit checks are really there to be asked.
    const asked = await prisma.$queryRaw<{ ord: string }[]>(
      Prisma.sql`SELECT ord FROM (${Prisma.raw(checks)}) c`,
    );
    expect(asked.map((a) => String(Number(a.ord)))).toEqual(
      expect.arrayContaining(EDIT_CHECKS),
    );
    return { popup, statement, history: h };
  }

  // ── The happy path, once ──────────────────────────────────────────────

  it('adds a product and two more units: one preview of the whole edit, then the shop owes it, revenue and cost on the edit’s day, drawn FIFO', async () => {
    const w = await world();
    const day = daysAgo(1);
    const [saleDay, editDay] = [
      await revenueOn(daysAgo(3)),
      await revenueOn(day),
    ];
    const newerBefore = await cycleProfit(w.newer.cycle.id);

    const body = {
      editedOn: day,
      lines: [
        { productId: w.helmet.id, quantity: 12 },
        { productId: w.gloves.id, quantity: 2, unitPrice: 1000 },
      ],
    };
    const preview = (await edits.preview(w.orderId, body)).data;
    expect(preview).toMatchObject({
      owedBefore: '7500.00',
      addedEgp: '4500.00',
      changeEgp: '4500.00',
      owedAfter: '12000.00',
      statusAfter: 'PARTIALLY_PAID',
      // 2 helmets from the newer batch at 950, 2 gloves at 500.
      cogsChangeEgp: '2900.00',
      profitChangeEgp: '1600.00',
    });
    expect(preview.stockTaken).toEqual(
      expect.arrayContaining([
        { product: w.helmet.name, qty: '2' },
        { product: w.gloves.name, qty: '2' },
      ]),
    );
    // The preview writes nothing.
    expect(await outstanding(w.orderId)).toBe('7500.00');
    expect(
      await prisma.saleOrderEdit.count({ where: { saleOrderId: w.orderId } }),
    ).toBe(0);

    const saved = await edit(w.orderId, body.lines, { editedOn: day });
    expect(saved.data.owedAfter).toBe('12000.00');
    const o = await order(w.orderId);
    expect(o.outstanding.toFixed(2)).toBe('12000.00');
    expect(o.status).toBe('PARTIALLY_PAID');
    // What was confirmed is never overwritten.
    expect(o.total.toFixed(2)).toBe('12500.00');
    const original = o.items.find((i) => !i.editId)!;
    expect(original.quantity.toString()).toBe('10');
    // The added units: their own dated lines, drawn FIFO.
    const added = await prisma.saleItem.findMany({
      where: { saleOrderId: w.orderId, editId: { not: null } },
      include: { allocations: { include: { inventoryBatch: true } } },
    });
    expect(added).toHaveLength(2);
    const helmets = added.find((i) => i.productId === w.helmet.id)!;
    expect(
      helmets.allocations.map((a) => [
        a.inventoryBatchId,
        a.qty.toString(),
        a.unitCostEgp.toFixed(2),
      ]),
    ).toEqual([[w.newer.batch.id, '2', '950.00']]);
    expect(await remaining(w.newer.batch.id)).toBe('4');
    expect(await remaining(w.glovesCycle.batch.id)).toBe('3');

    // Revenue on the edit's day, the sale's day untouched.
    expect((await revenueOn(daysAgo(3))).toFixed(2)).toBe(saleDay.toFixed(2));
    expect((await revenueOn(day)).sub(editDay).toFixed(2)).toBe('4500.00');
    // The newer cycle earns its 2 helmets: 2 × (1,250 − 950).
    expect(
      (await cycleProfit(w.newer.cycle.id)).sub(newerBefore).toFixed(2),
    ).toBe('600.00');

    const { statement, history: h, popup } = await agree(w);
    expect(popup.valueNowEgp).toBe('17000.00');
    const row = statement.rows.find((r) => r.kind === 'EDIT')!;
    expect(row).toMatchObject({
      date: day,
      amount: '4500.00',
      effect: '4500.00',
      profit: '1600.00',
    });
    const edited = h.events.find((e) => e.kind === 'EDITED')!;
    expect(edited).toMatchObject({
      date: day,
      amount: '4500.00',
      owes: '12000.00',
    });
    expect(edited.by).toBeTruthy();
    expect(edited.lines?.map((l) => [l.change, l.qty])).toEqual(
      expect.arrayContaining([
        ['ADDED', '2'],
        ['ADDED', '2'],
      ]),
    );
    // The invoice re-prints with the current lines: one per product and price.
    const invoice = (await sales.invoice(w.orderId)).data;
    expect(invoice).toMatchObject({
      edited: true,
      total: '17000.00',
      paid: '5000.00',
      owes: '12000.00',
      soldTotal: '12500.00',
    });
    expect(
      invoice.lines.map((l) => [
        l.productId,
        l.quantity,
        l.unitPrice,
        l.lineTotal,
      ]),
    ).toEqual([
      [w.helmet.id, '12', '1250.00', '15000.00'],
      [w.gloves.id, '2', '1000.00', '2000.00'],
    ]);
    // The balance after this sale on the invoice is the statement's.
    expect(invoice.account?.balanceNow).toBe(statement.closingBalance);
  });

  // ── Limits ────────────────────────────────────────────────────────────

  it('a quantity lowered: the units go back to the batch they came from (the last to leave) at their cost, and the shop owes their price less', async () => {
    const w = await world();
    const newerBefore = await cycleProfit(w.newer.cycle.id);
    await edit(w.orderId, [{ productId: w.helmet.id, quantity: 7 }]);
    expect(await outstanding(w.orderId)).toBe('3750.00');
    // 3 back to the newer batch (the last to leave), none to the older.
    expect(await remaining(w.newer.batch.id)).toBe('9');
    expect(await remaining(w.older.batch.id)).toBe('0');
    const back = await prisma.saleReturnItem.findMany({
      where: { saleReturn: { saleOrderId: w.orderId } },
      include: { saleReturn: true },
    });
    expect(
      back.map((b) => [
        b.inventoryBatchId,
        b.qty.toString(),
        b.unitCostEgp.toFixed(2),
        b.saleReturn.refundMethod,
      ]),
    ).toEqual([[w.newer.batch.id, '3', '950.00', 'CREDIT_NOTE']]);
    expect(back[0].saleReturn.editId).toBeTruthy();
    // The newer cycle gives back 3 × (1,250 − 950).
    expect(
      (await cycleProfit(w.newer.cycle.id)).sub(newerBefore).toFixed(2),
    ).toBe('-900.00');
    const { statement } = await agree(w);
    // One row for the edit; the return it wrote is not a second row.
    expect(statement.rows.map((r) => r.kind)).toEqual([
      'SALE',
      'PAYMENT',
      'EDIT',
    ]);
  });

  it('a quantity to 0 gives the whole line back, the rest of the order stands', async () => {
    const w = await world({ gloves: true });
    await edit(w.orderId, [{ productId: w.gloves.id, quantity: 0 }]);
    expect(await outstanding(w.orderId)).toBe('7500.00');
    expect(await remaining(w.glovesCycle.batch.id)).toBe('5');
    const o = await order(w.orderId);
    expect(o.status).toBe('PARTIALLY_PAID');
    await agree(w);
  });

  it('limits on the quantity: negative, not a number, more decimals than a quantity has — refused, nothing written; a fraction is a quantity as on any sale', async () => {
    const w = await world();
    for (const [quantity, code] of [
      [-1, 'EDIT_ORDER_BAD_QUANTITY'],
      ['abc', 'EDIT_ORDER_BAD_QUANTITY'],
      [undefined, 'EDIT_ORDER_BAD_QUANTITY'],
      [10.0005, 'EDIT_ORDER_BAD_QUANTITY'],
      [Number.POSITIVE_INFINITY, 'EDIT_ORDER_BAD_QUANTITY'],
    ] as const) {
      const r = await refusal(
        edit(w.orderId, [{ productId: w.helmet.id, quantity }]),
      );
      expect([String(quantity), r.code]).toEqual([String(quantity), code]);
    }
    expect(
      await prisma.saleOrderEdit.count({ where: { saleOrderId: w.orderId } }),
    ).toBe(0);
    expect(await outstanding(w.orderId)).toBe('7500.00');
    // Quantities are decimals everywhere (a sale takes 1.5): so does an edit.
    await edit(w.orderId, [{ productId: w.helmet.id, quantity: 10.5 }]);
    expect(await outstanding(w.orderId)).toBe('8125.00');
    await agree(w);
  });

  it('more than is on the shelf: NOT_ENOUGH_STOCK, naming what there is — and units out at shops as samples are never counted', async () => {
    const w = await world();
    // 6 helmets left: 17 would need 7.
    const over = await refusal(
      edit(w.orderId, [{ productId: w.helmet.id, quantity: 17 }]),
    );
    expect(over).toMatchObject({
      code: 'NOT_ENOUGH_STOCK',
      params: { available: '6.000', wanted: '7.000' },
    });
    // 3 of the 5 gloves left at another shop as samples: 2 can be sold, not 3.
    const other = await shop('Samples shop');
    await sales.create(
      {
        samples: true,
        customerId: other.id,
        channel: 'B2B',
        currency: 'EGP',
        items: [{ productId: w.gloves.id, quantity: 3, unitPrice: 1000 }],
      },
      partner,
    );
    const samples = await refusal(
      edit(w.orderId, [
        { productId: w.gloves.id, quantity: 3, unitPrice: 1000 },
      ]),
    );
    expect(samples).toMatchObject({
      code: 'NOT_ENOUGH_STOCK',
      params: { available: '2.000' },
    });
    expect(
      await prisma.saleOrderEdit.count({ where: { saleOrderId: w.orderId } }),
    ).toBe(0);
    expect(await outstanding(w.orderId)).toBe('7500.00');
  });

  it('limits on the price: negative, not a number, a fraction of a piastre, a huge one — refused; a price of 0 is a price', async () => {
    const w = await world();
    for (const unitPrice of [-1, 'abc', 12.345, 1e12, '99999999999']) {
      const r = await refusal(
        edit(w.orderId, [{ productId: w.gloves.id, quantity: 1, unitPrice }]),
      );
      expect([String(unitPrice), r.code]).toEqual([
        String(unitPrice),
        'EDIT_ORDER_BAD_PRICE',
      ]);
    }
    // A new line with no price at all is not guessed at.
    expect(
      (
        await refusal(
          edit(w.orderId, [{ productId: w.gloves.id, quantity: 1 }]),
        )
      ).code,
    ).toBe('EDIT_ORDER_PRICE_REQUIRED');
    // A glove given away at 0: owed unchanged, cost still lands.
    await edit(w.orderId, [
      { productId: w.gloves.id, quantity: 1, unitPrice: 0 },
    ]);
    expect(await outstanding(w.orderId)).toBe('7500.00');
    await agree(w);
  });

  it('a new line for a switched-off product sells what is still on the shelf (§3, decided 2026-10-14), and is refused once there is none', async () => {
    const w = await world();
    const off = await product('Old visor', 'INACTIVE');
    await cycleWith(off.id, 1, 200, 4);
    const none = await product('Gone visor', 'INACTIVE');
    await edit(w.orderId, [{ productId: off.id, quantity: 1, unitPrice: 300 }]);
    expect(await outstanding(w.orderId)).toBe('7800.00');
    expect(
      (
        await refusal(
          edit(w.orderId, [
            { productId: none.id, quantity: 1, unitPrice: 300 },
          ]),
        )
      ).code,
    ).toBe('NOT_ENOUGH_STOCK');
    expect(
      (
        await refusal(
          edit(w.orderId, [
            { productId: randomUUID(), quantity: 1, unitPrice: 300 },
          ]),
        )
      ).status,
    ).toBe(404);
  });

  it('GUESS — the same product is one line: listed twice in one edit is refused; adding a product the order has raises that line, at its price', async () => {
    const w = await world();
    expect(
      (
        await refusal(
          edit(w.orderId, [
            { productId: w.helmet.id, quantity: 11 },
            { productId: w.helmet.id, quantity: 12 },
          ]),
        )
      ).code,
    ).toBe('EDIT_ORDER_DUPLICATE_PRODUCT');
    // Asked as an "add" of 1 more helmet, it is the helmet line going to 11.
    const p = (
      await edits.preview(w.orderId, {
        lines: [{ productId: w.helmet.id, quantity: 11 }],
      })
    ).data;
    expect(p.lines).toEqual([
      expect.objectContaining({
        qtyBefore: '10',
        qtyAfter: '11',
        priceBefore: '1250.00',
        priceAfter: '1250.00',
        added: '1',
      }),
    ]);
    expect(p.changeEgp).toBe('1250.00');
  });

  it('nothing changes, or everything would go: refused — an edit is never a cancellation in disguise', async () => {
    const w = await world({ gloves: true });
    expect(
      (
        await refusal(
          edit(w.orderId, [{ productId: w.helmet.id, quantity: 10 }]),
        )
      ).code,
    ).toBe('EDIT_ORDER_NO_CHANGES');
    expect(
      (
        await refusal(
          edit(w.orderId, [
            { productId: w.helmet.id, quantity: 10, unitPrice: 1250 },
          ]),
        )
      ).code,
    ).toBe('EDIT_ORDER_NO_CHANGES');
    expect((await refusal(edit(w.orderId, []))).code).toBe(
      'EDIT_ORDER_NO_CHANGES',
    );
    // A new product at 0 units is no change either.
    expect(
      (
        await refusal(
          edit(w.orderId, [{ productId: w.gloves.id, quantity: 2 }]),
        )
      ).code,
    ).toBe('EDIT_ORDER_NO_CHANGES');
    const all = await refusal(
      edits.create(
        w.orderId,
        {
          version: await version(w.orderId),
          lines: [
            { productId: w.helmet.id, quantity: 0 },
            { productId: w.gloves.id, quantity: 0 },
          ],
        },
        partner,
      ),
    );
    expect(all.code).toBe('EDIT_ORDER_EMPTY');
  });

  // ── Money ─────────────────────────────────────────────────────────────

  it('GUESS — lowering below what was paid is refused (no negative owed, no credit nobody agreed to); down to exactly what was paid leaves it paid up', async () => {
    const w = await world();
    // Paid 5,000 of 12,500. 10 → 3 takes 8,750 off a 7,500 balance.
    const below = await refusal(
      edit(w.orderId, [{ productId: w.helmet.id, quantity: 3 }]),
    );
    expect(below).toMatchObject({
      code: 'EDIT_ORDER_BELOW_PAID',
      params: { amount: '8750.00', owed: '7500.00' },
    });
    // A price to 0 on all 10: 12,500 off — the same.
    expect(
      (
        await refusal(
          edit(w.orderId, [
            { productId: w.helmet.id, quantity: 10, unitPrice: 0 },
          ]),
        )
      ).code,
    ).toBe('EDIT_ORDER_BELOW_PAID');
    expect(
      await prisma.saleOrderEdit.count({ where: { saleOrderId: w.orderId } }),
    ).toBe(0);
    // 10 → 4 takes exactly 7,500: paid up.
    await edit(w.orderId, [{ productId: w.helmet.id, quantity: 4 }]);
    const o = await order(w.orderId);
    expect(o.outstanding.toFixed(2)).toBe('0.00');
    expect(o.status).toBe('PAID');
    await agree(w);
  });

  it('raising after it was paid in full: it owes again and is partly paid again', async () => {
    const w = await world({ paid: 12500 });
    expect((await order(w.orderId)).status).toBe('PAID');
    await edit(w.orderId, [
      { productId: w.helmet.id, quantity: 10, unitPrice: 1300 },
    ]);
    const o = await order(w.orderId);
    expect(o.outstanding.toFixed(2)).toBe('500.00');
    expect(o.status).toBe('PARTIALLY_PAID');
    // Never paid anything: a raise leaves it confirmed, not partly paid.
    const unpaid = await world({ paid: 0 });
    await edit(unpaid.orderId, [{ productId: unpaid.helmet.id, quantity: 11 }]);
    expect((await order(unpaid.orderId)).status).toBe('CONFIRMED');
    await agree(w);
    await agree(unpaid);
  });

  it('a payment spread over two orders keeps its allocations true after edits to both', async () => {
    const w = await world({ paid: 0 });
    const second = (await sales.create(
      {
        customerId: w.shop.id,
        channel: 'B2B',
        currency: 'EGP',
        items: [{ productId: w.gloves.id, quantity: 2, unitPrice: 1000 }],
        confirm: true,
      },
      partner,
    )) as { data: { id: string } };
    // 13,000 across 12,500 and 2,000: oldest first.
    const pay = await payments.create(
      {
        customerId: w.shop.id,
        amount: 13000,
        currency: 'EGP',
        method: 'CASH',
        receivedOn: businessToday(),
        applyOldestFirst: true,
      },
      partner,
    );
    const allocs = async () =>
      (
        await prisma.paymentAllocation.findMany({
          where: { paymentId: (pay as { data: { id: string } }).data.id },
          orderBy: { createdAt: 'asc' },
        })
      ).map((a) => [a.saleOrderId, a.amount.toFixed(2)]);
    const before = await allocs();
    expect(before).toEqual([
      [w.orderId, '12500.00'],
      [second.data.id, '500.00'],
    ]);
    await edit(w.orderId, [{ productId: w.helmet.id, quantity: 11 }]);
    await edit(second.data.id, [{ productId: w.gloves.id, quantity: 1 }]);
    expect(await allocs()).toEqual(before);
    expect(await outstanding(w.orderId)).toBe('1250.00');
    expect(await outstanding(second.data.id)).toBe('500.00');
    const { statement } = await agree(w);
    expect(statement.closingBalance).toBe('1750.00');
  });

  // ── Stock and cost ────────────────────────────────────────────────────

  it('units taken come from the oldest batches at their own cost, across batches', async () => {
    const w = await world();
    // An even older batch of helmets turns up: 2 at 800, received 10 days ago.
    const oldest = await cycleWith(w.helmet.id, 2, 800, 10);
    w.cycles.push(oldest.cycle.id);
    await edit(w.orderId, [{ productId: w.helmet.id, quantity: 13 }]);
    const added = await prisma.saleItem.findFirstOrThrow({
      where: { saleOrderId: w.orderId, editId: { not: null } },
      include: { allocations: true },
    });
    expect(
      added.allocations
        .map((a) => [
          a.inventoryBatchId,
          a.qty.toString(),
          a.cogsEgp.toFixed(2),
        ])
        .sort(),
    ).toEqual(
      [
        [oldest.batch.id, '2', '1600.00'],
        [w.newer.batch.id, '1', '950.00'],
      ].sort(),
    );
    // Agree, counting the 2 more helmets that came in.
    const lines = await prisma.saleItem.findMany({
      where: { productId: w.helmet.id },
      include: { returnItems: true },
    });
    const held = lines.reduce((s, l) => s.add(heldUnits(l)), D(0));
    const shelf = (
      await prisma.inventoryBatch.findMany({
        where: { productId: w.helmet.id },
      })
    ).reduce((s, b) => s.add(b.remainingQty), D(0));
    expect(shelf.add(held).toString()).toBe('18');
    // Back to 10: the units given back are the last to leave — the 3 just
    // added, to the batches they came from — not the first sale's.
    await edit(w.orderId, [{ productId: w.helmet.id, quantity: 10 }]);
    expect(await remaining(oldest.batch.id)).toBe('2');
    expect(await remaining(w.newer.batch.id)).toBe('6');
  });

  it('a batch emptied by another sale between preview and save: the save re-checks the shelf and refuses, nothing written', async () => {
    const w = await world();
    const preview = (
      await edits.preview(w.orderId, {
        lines: [{ productId: w.helmet.id, quantity: 14 }],
      })
    ).data;
    expect(preview.owedAfter).toBe('12500.00');
    // Another shop buys 5 of the 6 left.
    const other = await shop('Other');
    await sales.create(
      {
        customerId: other.id,
        channel: 'B2B',
        currency: 'EGP',
        items: [{ productId: w.helmet.id, quantity: 5, unitPrice: 1200 }],
        confirm: true,
      },
      partner,
    );
    const r = await refusal(
      edits.create(
        w.orderId,
        {
          version: preview.version,
          lines: [{ productId: w.helmet.id, quantity: 14 }],
        },
        partner,
      ),
    );
    expect(r).toMatchObject({
      code: 'NOT_ENOUGH_STOCK',
      params: { available: '1.000' },
    });
    expect(
      await prisma.saleOrderEdit.count({ where: { saleOrderId: w.orderId } }),
    ).toBe(0);
    expect(await outstanding(w.orderId)).toBe('7500.00');
    expect(await remaining(w.newer.batch.id)).toBe('1');
  });

  it('a cycle re-costed later: the units an edit added and gave back are re-priced with every other sale of the batch, and the readers follow', async () => {
    const w = await world();
    await edit(w.orderId, [{ productId: w.helmet.id, quantity: 12 }]);
    await edit(w.orderId, [{ productId: w.helmet.id, quantity: 11 }]);
    // What `recost` (modules/costing/leg-recost.ts) does to a batch: the
    // batch, every allocation drawn from it and every return to it.
    const unit = D(1000);
    await prisma.inventoryBatch.update({
      where: { id: w.newer.batch.id },
      data: { landedUnitCostEgp: unit },
    });
    for (const a of await prisma.saleItemAllocation.findMany({
      where: { inventoryBatchId: w.newer.batch.id },
    })) {
      await prisma.saleItemAllocation.update({
        where: { id: a.id },
        data: { unitCostEgp: unit, cogsEgp: a.qty.mul(unit) },
      });
    }
    for (const r of await prisma.saleReturnItem.findMany({
      where: { inventoryBatchId: w.newer.batch.id },
    })) {
      await prisma.saleReturnItem.update({
        where: { id: r.id },
        data: { unitCostEgp: unit, cogsReversedEgp: r.qty.mul(unit) },
      });
      await prisma.saleReturn.update({
        where: { id: r.saleReturnId },
        data: { cogsReversedEgp: r.qty.mul(unit) },
      });
    }
    // The edit stores no cost of its own: the statement's edit rows and the
    // cycle read the batch's, so they still agree.
    const { statement } = await agree(w);
    const editRows = statement.rows.filter((r) => r.kind === 'EDIT');
    // +2 at 1,250 that now cost 1,000; −1 at 1,250 that cost 1,000.
    expect(editRows.map((r) => r.profit)).toEqual(['500.00', '-250.00']);
  });

  it('cancelling an unpaid order after an edit gave units back puts each unit back once', async () => {
    const w = await world({ paid: 0 });
    await edit(w.orderId, [{ productId: w.helmet.id, quantity: 7 }]);
    expect(await remaining(w.newer.batch.id)).toBe('9');
    await sales.cancelOrder(w.orderId, partner);
    // Everything that came in is on the shelf again — never more.
    expect(await remaining(w.newer.batch.id)).toBe('10');
    expect(await remaining(w.older.batch.id)).toBe('6');
  });

  // ── Order history ─────────────────────────────────────────────────────

  it('an edit after a return of the same line, and a return after an edit — refunded at the price then in force', async () => {
    const w = await world();
    const line = (await order(w.orderId)).items[0];
    await returns.create(
      {
        saleOrderId: w.orderId,
        reason: 'One back',
        refundMethod: 'CREDIT_NOTE',
        items: [{ saleItemId: line.id, qty: 1 }],
      } as never,
      partner,
    );
    expect(await outstanding(w.orderId)).toBe('6250.00');
    // The shop holds 9: the edit sees 9, not 10.
    const p = (
      await edits.preview(w.orderId, {
        lines: [{ productId: w.helmet.id, quantity: 9, unitPrice: 1300 }],
      })
    ).data;
    expect(p.lines[0]).toMatchObject({ qtyBefore: '9', qtyAfter: '9' });
    await edit(w.orderId, [
      { productId: w.helmet.id, quantity: 9, unitPrice: 1300 },
    ]);
    expect(await outstanding(w.orderId)).toBe('6700.00');
    // A unit handed back now is refunded at 1,300, the price in force.
    const back = await returns.create(
      {
        saleOrderId: w.orderId,
        reason: 'Another',
        refundMethod: 'CREDIT_NOTE',
        items: [{ saleItemId: line.id, qty: 1 }],
      } as never,
      partner,
    );
    expect(back.data!.refundEgp.toFixed(2)).toBe('1300.00');
    expect(await outstanding(w.orderId)).toBe('5400.00');
    const { history: h } = await agree(w);
    expect(h.events.map((e) => [e.kind, e.owes])).toEqual([
      ['CREATED', '0.00'],
      ['CONFIRMED', '12500.00'],
      ['PAYMENT', '7500.00'],
      ['RETURN', '6250.00'],
      ['EDITED', '6700.00'],
      ['RETURN', '5400.00'],
    ]);
  });

  it('an edit after a price cut, and a price cut after an edit, each from the price the other left', async () => {
    const w = await world();
    const line = (await order(w.orderId)).items[0];
    await adjust.create(
      w.orderId,
      { saleItemId: line.id, newUnitPrice: 1200 },
      partner,
    );
    expect(await outstanding(w.orderId)).toBe('7000.00');
    const p = (
      await edits.preview(w.orderId, {
        lines: [{ productId: w.helmet.id, quantity: 11 }],
      })
    ).data;
    // The added unit comes at 1,200, the price the line is at now.
    expect(p.lines[0]).toMatchObject({
      priceBefore: '1200.00',
      priceAfter: '1200.00',
    });
    await edit(w.orderId, [{ productId: w.helmet.id, quantity: 11 }]);
    expect(await outstanding(w.orderId)).toBe('8200.00');
    // Raised back by an edit, then cut again from there.
    await edit(w.orderId, [
      { productId: w.helmet.id, quantity: 11, unitPrice: 1250 },
    ]);
    expect(await outstanding(w.orderId)).toBe('8750.00');
    const cut = await adjust.create(
      w.orderId,
      { saleItemId: line.id, newUnitPrice: 1240 },
      partner,
    );
    expect(cut.data).toMatchObject({
      previousUnitPrice: '1250.00',
      qty: '10',
      amountEgp: '100.00',
    });
    await agree(w);
  });

  it('two edits in a row, then editing back to the original: owed, value, stock and profit are back where they began', async () => {
    const w = await world({ gloves: true });
    const start = await agree(w);
    const profitBefore = start.statement.profit;
    await edit(w.orderId, [
      { productId: w.helmet.id, quantity: 12, unitPrice: 1300 },
    ]);
    // The second time, from the state the first left — a stale version is told so.
    const stale = await refusal(
      edits.create(
        w.orderId,
        { version: 1, lines: [{ productId: w.gloves.id, quantity: 1 }] },
        partner,
      ),
    );
    expect(stale.code).toBe('ORDER_VERSION_CONFLICT');
    await edit(w.orderId, [{ productId: w.gloves.id, quantity: 1 }]);
    await edit(w.orderId, [
      { productId: w.helmet.id, quantity: 10, unitPrice: 1250 },
      { productId: w.gloves.id, quantity: 2, unitPrice: 1000 },
    ]);
    expect(await outstanding(w.orderId)).toBe('9500.00');
    const end = await agree(w);
    expect(end.popup.valueNowEgp).toBe('14500.00');
    expect(end.statement.profit).toBe(profitBefore);
    expect(await remaining(w.newer.batch.id)).toBe('6');
    expect(await remaining(w.glovesCycle.batch.id)).toBe('3');
    expect(end.history.events.filter((e) => e.kind === 'EDITED')).toHaveLength(
      3,
    );
  });

  // ── Dates ─────────────────────────────────────────────────────────────

  it('dates: not before the sale, not in the future, not a date — and a back-dated edit draws only what had arrived by its day', async () => {
    const w = await world();
    const body = (editedOn: string) =>
      edit(w.orderId, [{ productId: w.helmet.id, quantity: 11 }], { editedOn });
    expect((await refusal(body(daysAgo(4)))).code).toBe(
      'EDIT_ORDER_BEFORE_SALE',
    );
    expect((await refusal(body(tomorrow()))).code).toBe('DATE_IN_FUTURE');
    expect((await refusal(body('2026-02-30'))).code).toBe('BAD_DATE');
    // Gloves arrive today; an edit dated two days ago cannot have sold them.
    const late = await product('Late gloves');
    await cycleWith(late.id, 5, 500, 0);
    const r = await refusal(
      edit(w.orderId, [{ productId: late.id, quantity: 1, unitPrice: 700 }], {
        editedOn: daysAgo(2),
      }),
    );
    expect(r.code).toBe('NOT_ENOUGH_STOCK_ON_DATE');
  });

  it('a back-dated sale edited today: revenue and cost land today, in the dashboard’s This month as in P&L', async () => {
    const w = await world();
    const today = businessToday();
    // The dashboard sums (profitFigures); P&L reads row by row (revenueOn).
    const [todayBefore, saleDayBefore, saleDayCostBefore, monthBefore] = [
      await analytics.profitFigures({ from: today, to: today }),
      await revenueOn(daysAgo(3)),
      (await analytics.profitFigures({ from: daysAgo(3), to: daysAgo(3) })).cogs,
      (await analytics.getDashboardKPIs()).data.month.revenue,
    ];
    await edit(w.orderId, [{ productId: w.helmet.id, quantity: 12 }]);
    const after = await analytics.profitFigures({ from: today, to: today });
    expect(after.revenue.sub(todayBefore.revenue).toFixed(2)).toBe('2500.00');
    expect(after.cogs.sub(todayBefore.cogs).toFixed(2)).toBe('1900.00');
    expect((await revenueOn(daysAgo(3))).toFixed(2)).toBe(
      saleDayBefore.toFixed(2),
    );
    // The added units' cost is today's, not the sale's day.
    expect(
      (
        await analytics.profitFigures({ from: daysAgo(3), to: daysAgo(3) })
      ).cogs.toFixed(2),
    ).toBe(saleDayCostBefore.toFixed(2));
    expect((await revenueOn(today)).toFixed(2)).toBe(after.revenue.toFixed(2));
    const monthAfter = (await analytics.getDashboardKPIs()).data.month.revenue;
    expect((monthAfter - monthBefore).toFixed(2)).toBe('2500.00');
  });

  // ── The wrong context ─────────────────────────────────────────────────

  it('only the order named is touched: another shop’s product on another order is a new line here, and that order does not move', async () => {
    const a = await world();
    const b = await world();
    const vb = await version(b.orderId);
    await edit(a.orderId, [
      { productId: b.helmet.id, quantity: 1, unitPrice: 1000 },
    ]);
    expect(await outstanding(b.orderId)).toBe('7500.00');
    expect(await version(b.orderId)).toBe(vb);
    expect(await outstanding(a.orderId)).toBe('8500.00');
    expect(
      (
        await refusal(
          edits.create(
            randomUUID(),
            { version: 1, lines: [{ productId: a.helmet.id, quantity: 1 }] },
            partner,
          ),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await refusal(
          edits.create('not-a-uuid', { version: 1, lines: [] }, partner),
        )
      ).status,
    ).toBe(404);
  });

  it('not on a draft, a cancelled, a fully returned, a samples or a walk-in order, nor under an instalment contract', async () => {
    const w = await world();
    const draft = (await sales.create(
      {
        customerId: w.shop.id,
        channel: 'B2B',
        currency: 'EGP',
        items: [{ productId: w.helmet.id, quantity: 1, unitPrice: 1 }],
      },
      partner,
    )) as { data: { id: string } };
    expect(
      (
        await refusal(
          edit(draft.data.id, [{ productId: w.helmet.id, quantity: 2 }]),
        )
      ).code,
    ).toBe('EDIT_ORDER_NOT_EDITABLE');

    const cancelled = (await sales.create(
      {
        customerId: w.shop.id,
        channel: 'B2B',
        currency: 'EGP',
        items: [{ productId: w.helmet.id, quantity: 1, unitPrice: 1 }],
        confirm: true,
      },
      partner,
    )) as { data: { id: string } };
    await sales.cancelOrder(cancelled.data.id, partner);
    expect(
      (
        await refusal(
          edit(cancelled.data.id, [{ productId: w.helmet.id, quantity: 2 }]),
        )
      ).code,
    ).toBe('EDIT_ORDER_NOT_EDITABLE');

    const returnedOrder = (await sales.create(
      {
        customerId: w.shop.id,
        channel: 'B2B',
        currency: 'EGP',
        items: [{ productId: w.gloves.id, quantity: 1, unitPrice: 1 }],
        confirm: true,
      },
      partner,
    )) as { data: { id: string } };
    const rl = (await order(returnedOrder.data.id)).items[0];
    await returns.create(
      {
        saleOrderId: returnedOrder.data.id,
        reason: 'All',
        refundMethod: 'CREDIT_NOTE',
        items: [{ saleItemId: rl.id, qty: 1 }],
      } as never,
      partner,
    );
    expect(
      (
        await refusal(
          edit(returnedOrder.data.id, [
            { productId: w.gloves.id, quantity: 1 },
          ]),
        )
      ).code,
    ).toBe('EDIT_ORDER_NOT_EDITABLE');

    const samples = (await sales.create(
      {
        samples: true,
        customerId: w.shop.id,
        channel: 'B2B',
        currency: 'EGP',
        items: [{ productId: w.gloves.id, quantity: 1, unitPrice: 1 }],
      },
      partner,
    )) as { data: { id: string } };
    expect(
      (
        await refusal(
          edit(samples.data.id, [{ productId: w.gloves.id, quantity: 2 }]),
        )
      ).code,
    ).toBe('EDIT_ORDER_SAMPLES');

    const walkIn = (await sales.create(
      {
        walkIn: true,
        channel: 'B2C',
        currency: 'EGP',
        payment: { method: 'CASH' },
        items: [{ productId: w.gloves.id, quantity: 1, unitPrice: 100 }],
      },
      partner,
    )) as { data: { id: string } };
    expect(
      (
        await refusal(
          edit(walkIn.data.id, [{ productId: w.gloves.id, quantity: 2 }]),
        )
      ).code,
    ).toBe('EDIT_ORDER_WALK_IN');

    const plan = await prisma.paymentPlan.create({
      data: {
        customerId: w.shop.id,
        reference: `PLAN-${randomUUID().slice(0, 8)}`,
        totalEgp: 7500,
        agreedOn: new Date(),
        saleOrderId: w.orderId,
      },
    });
    expect(
      (
        await refusal(
          edit(w.orderId, [{ productId: w.helmet.id, quantity: 11 }]),
        )
      ).code,
    ).toBe('EDIT_ORDER_UNDER_CONTRACT');
    await prisma.paymentPlan.update({
      where: { id: plan.id },
      data: { status: 'CANCELLED' },
    });
    await edit(w.orderId, [{ productId: w.helmet.id, quantity: 11 }]);
    expect(await outstanding(w.orderId)).toBe('8750.00');
  });

  it('an order on a cycle being settled, or with its settlement approved, is refused; so are added units that would come from one', async () => {
    const w = await world();
    await prisma.importCycle.update({
      where: { id: w.newer.cycle.id },
      data: { status: 'SETTLEMENT' },
    });
    expect(
      (
        await refusal(
          edit(w.orderId, [{ productId: w.helmet.id, quantity: 9 }]),
        )
      ).code,
    ).toBe('EDIT_ORDER_CYCLE_SETTLED');
    await prisma.importCycle.update({
      where: { id: w.newer.cycle.id },
      data: { status: 'SELLING' },
    });
    const s = await prisma.settlement.create({
      data: { cycleId: w.older.cycle.id, status: 'APPROVED' },
    });
    expect(
      (
        await refusal(
          edit(w.orderId, [{ productId: w.helmet.id, quantity: 9 }]),
        )
      ).code,
    ).toBe('EDIT_ORDER_CYCLE_SETTLED');
    await prisma.settlement.delete({ where: { id: s.id } });
    // The gloves' cycle is being settled: none of its units can be added.
    await prisma.importCycle.update({
      where: { id: w.glovesCycle.cycle.id },
      data: { status: 'SETTLEMENT' },
    });
    expect(
      (
        await refusal(
          edit(w.orderId, [
            { productId: w.gloves.id, quantity: 1, unitPrice: 900 },
          ]),
        )
      ).code,
    ).toBe('EDIT_ORDER_CYCLE_SETTLED');
    expect(
      await prisma.saleOrderEdit.count({ where: { saleOrderId: w.orderId } }),
    ).toBe(0);
  });

  it('two partners editing at once: one wins, the others are told the order changed, nothing applied twice', async () => {
    const w = await world();
    const v = await version(w.orderId);
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        edits.create(
          w.orderId,
          { version: v, lines: [{ productId: w.helmet.id, quantity: 11 }] },
          partner,
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected')) {
      const e = r.reason as HttpException;
      expect((e.getResponse() as { code: string }).code).toBe(
        'ORDER_VERSION_CONFLICT',
      );
    }
    expect(
      await prisma.saleOrderEdit.count({ where: { saleOrderId: w.orderId } }),
    ).toBe(1);
    expect(await outstanding(w.orderId)).toBe('8750.00');
    expect(await remaining(w.newer.batch.id)).toBe('5');
    // Saving needs the version it was read at.
    expect(
      (
        await refusal(
          edits.create(
            w.orderId,
            { lines: [{ productId: w.helmet.id, quantity: 12 }] },
            partner,
          ),
        )
      ).code,
    ).toBe('VERSION_REQUIRED');
    await agree(w);
  });
});
