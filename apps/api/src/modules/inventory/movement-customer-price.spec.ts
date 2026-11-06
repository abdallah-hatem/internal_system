/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment -- a hand-made Prisma whose rows are untyped records */
import { randomUUID } from 'crypto';
import { InventoryService } from './inventory.service';

/**
 * A product page's movements say who each one went to and at what price
 * (owner 2026-11-06: "in movement I want to see the customer name and the
 * price"). Resolved by the movements endpoint, so the screen asks nothing.
 *
 * - SALE: the order's customer, and the line's price as charged — its total
 *   over its quantity, so a line discount is in it (the return's rule).
 * - RETURN: the order's customer, and what was refunded per unit.
 * - RECEIVE: the batch's landed cost, marked as cost.
 * - Samples: the shop, and no price — nothing was charged.
 */

const BATCH = randomUUID();
const OTHER_BATCH = randomUUID();
const CYCLE = randomUUID();
const PRODUCT = randomUUID();
const OTHER_PRODUCT = randomUUID();
const SALE = randomUUID();
const WALK_IN = randomUUID();
const SAMPLES = randomUUID();
const TWO_PRICES = randomUUID();
const RETURN = randomUUID();
const RETURN_ORDER = randomUUID();
const PO_ITEM = randomUUID();
const PO = randomUUID();
const CANCELLED = randomUUID();

const koshary = { displayName: 'Koshary Motors', isWalkIn: false };

const ORDERS = [
  {
    id: SALE,
    orderNo: 'ORD-2026-0101',
    currency: 'EGP',
    customer: koshary,
    branch: { name: 'Shubra' },
    items: [
      // 3 at 1,000 less a 100 line discount: 2,900, so 966.67 each.
      {
        productId: PRODUCT,
        quantity: '3',
        unitPrice: '1000',
        discount: '100',
        lineTotal: '2900',
        allocations: [{ id: randomUUID(), inventoryBatchId: BATCH }],
      },
      // Another product on the same order, cheaper: must never lend its price.
      {
        productId: OTHER_PRODUCT,
        quantity: '1',
        unitPrice: '50',
        discount: '0',
        lineTotal: '50',
        allocations: [{ id: randomUUID(), inventoryBatchId: OTHER_BATCH }],
      },
    ],
  },
  {
    id: WALK_IN,
    orderNo: 'ORD-2026-0102',
    currency: 'EGP',
    customer: { displayName: 'Walk-in customer', isWalkIn: true },
    branch: null,
    items: [
      {
        productId: PRODUCT,
        quantity: '2',
        unitPrice: '750',
        discount: '0',
        lineTotal: '1500',
        allocations: [{ id: randomUUID(), inventoryBatchId: BATCH }],
      },
    ],
  },
  {
    id: SAMPLES,
    orderNo: 'ORD-2026-0103',
    currency: 'EGP',
    customer: { displayName: 'Ali Shop', isWalkIn: false },
    branch: null,
    items: [
      {
        productId: PRODUCT,
        quantity: '5',
        unitPrice: '1000',
        discount: '0',
        lineTotal: '5000',
        allocations: [],
      },
    ],
  },
  {
    id: TWO_PRICES,
    orderNo: 'ORD-2026-0104',
    currency: 'EGP',
    customer: koshary,
    branch: null,
    items: [
      {
        productId: PRODUCT,
        quantity: '1',
        unitPrice: '900',
        discount: '0',
        lineTotal: '900',
        allocations: [{ id: randomUUID(), inventoryBatchId: BATCH }],
      },
      {
        productId: PRODUCT,
        quantity: '1',
        unitPrice: '800',
        discount: '0',
        lineTotal: '800',
        allocations: [{ id: randomUUID(), inventoryBatchId: BATCH }],
      },
    ],
  },
  {
    id: CANCELLED,
    orderNo: 'ORD-2026-0105',
    currency: 'EGP',
    customer: koshary,
    branch: null,
    items: [
      {
        productId: PRODUCT,
        quantity: '1',
        unitPrice: '900',
        discount: '0',
        lineTotal: '900',
        allocations: [{ id: randomUUID(), inventoryBatchId: BATCH }],
      },
    ],
  },
];

const RETURNS = [
  {
    id: RETURN,
    reference: 'RET-2026-0009',
    saleOrderId: RETURN_ORDER,
    // The order it was made on is in dollars: the refund is said in them.
    saleOrder: {
      currency: 'USD',
      customer: koshary,
      branch: { name: 'Shubra' },
    },
    items: [
      { inventoryBatchId: BATCH, unitPrice: '20.50' },
      // A line that went back to another batch: not this row's price.
      { inventoryBatchId: OTHER_BATCH, unitPrice: '3.00' },
    ],
  },
];

/** Applies the nested `where`s the service asks with, as Postgres would. */
function selectOrder(o: any, args: any) {
  const itemWhere = args.select?.items?.where ?? {};
  const allocWhere = args.select?.items?.select?.allocations?.where ?? {};
  return {
    ...o,
    items: o.items
      .filter(
        (i: any) => !itemWhere.productId || i.productId === itemWhere.productId,
      )
      .map((i: any) => ({
        ...i,
        allocations: i.allocations.filter(
          (a: any) =>
            !allocWhere.inventoryBatchId ||
            a.inventoryBatchId === allocWhere.inventoryBatchId,
        ),
      })),
  };
}
function selectReturn(r: any, args: any) {
  const where = args.select?.items?.where ?? {};
  return {
    ...r,
    items: r.items.filter(
      (i: any) =>
        !where.inventoryBatchId ||
        i.inventoryBatchId === where.inventoryBatchId,
    ),
  };
}

function service(movements: any[]) {
  const calls: Record<string, number> = {
    saleOrder: 0,
    saleReturn: 0,
    purchaseOrderItem: 0,
  };
  const prisma: any = {
    inventoryBatch: {
      findUnique: () =>
        Promise.resolve({
          id: BATCH,
          cycleId: CYCLE,
          productId: PRODUCT,
          landedUnitCostEgp: '412.5000',
        }),
    },
    inventoryMovement: { findMany: () => Promise.resolve(movements) },
    // A temporary investor in this batch's cycle.
    cycleParticipant: {
      findMany: () => Promise.resolve([{ cycleId: CYCLE, id: randomUUID() }]),
    },
    saleOrder: {
      findMany: (args: any) => {
        calls.saleOrder++;
        return Promise.resolve(
          ORDERS.filter((o) => args.where.id.in.includes(o.id)).map((o) =>
            selectOrder(o, args),
          ),
        );
      },
    },
    saleReturn: {
      findMany: (args: any) => {
        calls.saleReturn++;
        return Promise.resolve(
          RETURNS.filter((r) => args.where.id.in.includes(r.id)).map((r) =>
            selectReturn(r, args),
          ),
        );
      },
    },
    purchaseOrderItem: {
      findMany: (args: any) => {
        calls.purchaseOrderItem++;
        return Promise.resolve(
          [
            {
              id: PO_ITEM,
              purchaseOrder: { id: PO, reference: 'PO-2026-0003' },
            },
          ].filter((r) => args.where.id.in.includes(r.id)),
        );
      },
    },
  };
  const inventory = new InventoryService(
    prisma,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { inventory, calls };
}

const mov = (
  movementType: string,
  referenceType: string | null,
  referenceId: string | null,
) => ({
  id: randomUUID(),
  batchId: BATCH,
  movementType,
  qtyDelta: '-1',
  occurredAt: new Date('2026-11-01T10:00:00Z'),
  referenceType,
  referenceId,
});

const party = (m: any) => ({
  customerName: m.customerName,
  walkIn: m.walkIn,
  branchName: m.branchName,
  unitPrice: m.unitPrice,
  priceKind: m.priceKind,
  currency: m.currency,
});

const NOTHING = {
  customerName: null,
  walkIn: false,
  branchName: null,
  unitPrice: null,
  priceKind: null,
  currency: null,
};

describe('movements say the customer and the price (2026-11-06)', () => {
  it('a sale: the order’s customer and branch, at the price charged after the line discount', async () => {
    const { inventory } = service([mov('SALE', 'SALE_ORDER', SALE)]);
    const data: any[] = (await inventory.getMovements(BATCH)).data;
    expect(party(data[0])).toEqual({
      customerName: 'Koshary Motors',
      walkIn: false,
      branchName: 'Shubra',
      // 2,900 / 3 — not the 1,000 list price, not the other product's 50.
      unitPrice: '966.67',
      priceKind: 'sale',
      currency: 'EGP',
    });
  });

  it('a return: the customer of the order it was made on, at what was refunded, in that order’s currency', async () => {
    const { inventory } = service([mov('RETURN', 'SALE_RETURN', RETURN)]);
    const data: any[] = (await inventory.getMovements(BATCH)).data;
    expect(party(data[0])).toEqual({
      customerName: 'Koshary Motors',
      walkIn: false,
      branchName: 'Shubra',
      unitPrice: '20.50',
      priceKind: 'refund',
      currency: 'USD',
    });
  });

  it('a receipt: the batch’s landed cost, marked as cost, and no customer', async () => {
    const { inventory } = service([
      mov('RECEIVE', 'PURCHASE_ORDER_ITEM', PO_ITEM),
    ]);
    const data: any[] = (await inventory.getMovements(BATCH)).data;
    expect(party(data[0])).toEqual({
      ...NOTHING,
      unitPrice: '412.50',
      priceKind: 'cost',
      currency: 'EGP',
    });
  });

  it('samples out and back: the shop, and no price — nothing was charged', async () => {
    const { inventory } = service([
      mov('SAMPLE_OUT', 'SAMPLES_ORDER', SAMPLES),
      mov('SAMPLE_BACK', 'SAMPLES_ORDER', SAMPLES),
    ]);
    const data: any[] = (await inventory.getMovements(BATCH)).data;
    for (const row of data)
      expect(party(row)).toEqual({ ...NOTHING, customerName: 'Ali Shop' });
  });

  it('a walk-in sale says walk-in, never the name the shared record is stored under', async () => {
    const { inventory } = service([mov('SALE', 'SALE_ORDER', WALK_IN)]);
    const data: any[] = (await inventory.getMovements(BATCH)).data;
    expect(party(data[0])).toEqual({
      ...NOTHING,
      walkIn: true,
      unitPrice: '750.00',
      priceKind: 'sale',
      currency: 'EGP',
    });
  });

  it('a cancelled order’s release names the customer but carries no price', async () => {
    const { inventory } = service([
      mov('RELEASE', 'SALE_ORDER_CANCEL', CANCELLED),
    ]);
    const data: any[] = (await inventory.getMovements(BATCH)).data;
    expect(party(data[0])).toEqual({
      ...NOTHING,
      customerName: 'Koshary Motors',
    });
  });

  it('two lines of the product at different prices: no price, not an average nobody charged', async () => {
    const { inventory } = service([mov('SALE', 'SALE_ORDER', TWO_PRICES)]);
    const data: any[] = (await inventory.getMovements(BATCH)).data;
    expect(data[0].customerName).toBe('Koshary Motors');
    expect(data[0].unitPrice).toBeNull();
    expect(data[0].priceKind).toBeNull();
  });

  it('a record that is gone, or of the wrong kind, gives nulls rather than an error', async () => {
    const { inventory } = service([
      mov('SALE', 'SALE_ORDER', randomUUID()),
      mov('RETURN', 'SALE_RETURN', randomUUID()),
      // A return's id given as a sale order's must not find the return.
      mov('SALE', 'SALE_ORDER', RETURN),
      // A sale movement pointing at a return: never priced as a sale.
      mov('SALE', 'SALE_RETURN', RETURN),
      mov('ADJUSTMENT', null, null),
      mov('TRANSFER_OUT', 'STOCK_TRANSFER', randomUUID()),
    ]);
    const data: any[] = (await inventory.getMovements(BATCH)).data;
    expect(party(data[0])).toEqual(NOTHING);
    expect(party(data[1])).toEqual(NOTHING);
    expect(party(data[2])).toEqual(NOTHING);
    expect(party(data[3])).toEqual({
      ...NOTHING,
      customerName: 'Koshary Motors',
      branchName: 'Shubra',
    });
    expect(party(data[4])).toEqual(NOTHING);
    expect(party(data[5])).toEqual(NOTHING);
  });

  it('asks once per kind of record however many rows there are', async () => {
    const rows = [
      ...Array.from({ length: 50 }, () => mov('SALE', 'SALE_ORDER', SALE)),
      ...Array.from({ length: 50 }, () =>
        mov('SAMPLE_OUT', 'SAMPLES_ORDER', SAMPLES),
      ),
      ...Array.from({ length: 50 }, () => mov('RETURN', 'SALE_RETURN', RETURN)),
      ...Array.from({ length: 50 }, () =>
        mov('RECEIVE', 'PURCHASE_ORDER_ITEM', PO_ITEM),
      ),
    ];
    const { inventory, calls } = service(rows);
    const data: any[] = (await inventory.getMovements(BATCH)).data;
    expect(calls).toEqual({
      saleOrder: 1,
      saleReturn: 1,
      purchaseOrderItem: 1,
    });
    expect(data.filter((m: any) => m.priceKind === 'sale')).toHaveLength(50);
    expect(data.filter((m: any) => m.priceKind === 'refund')).toHaveLength(50);
    expect(data.filter((m: any) => m.priceKind === 'cost')).toHaveLength(50);
  });

  it('a temporary investor sees the stock moving, never who bought it or for how much', async () => {
    const rows = [
      mov('SALE', 'SALE_ORDER', SALE),
      mov('RETURN', 'SALE_RETURN', RETURN),
      mov('SAMPLE_OUT', 'SAMPLES_ORDER', SAMPLES),
      mov('RECEIVE', 'PURCHASE_ORDER_ITEM', PO_ITEM),
    ];
    const { inventory } = service(rows);
    const investor = { id: randomUUID(), role: 'TEMP_INVESTOR' };
    const data: any[] = (await inventory.getMovements(BATCH, investor)).data;
    expect(data.slice(0, 3).map(party)).toEqual([NOTHING, NOTHING, NOTHING]);
    // The landed cost is the batch's own figure, which the investor reads already.
    expect(data[3].priceKind).toBe('cost');
    // The record numbers stay, as before.
    expect(data[0].reference).toEqual({
      number: 'ORD-2026-0101',
      saleOrderId: SALE,
    });
  });

  it('the partners and the office see both', async () => {
    for (const role of ['CORE_PARTNER', 'ADMIN_SUPPORT']) {
      const { inventory } = service([mov('SALE', 'SALE_ORDER', SALE)]);
      const data: any[] = (
        await inventory.getMovements(BATCH, { id: randomUUID(), role })
      ).data;
      expect(data[0].customerName).toBe('Koshary Motors');
      expect(data[0].unitPrice).toBe('966.67');
    }
  });
});
