/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument -- a hand-made Prisma whose rows are untyped records */
import { randomUUID } from 'crypto';
import { InventoryService } from './inventory.service';

/**
 * GET /inventory/batches/:id/movements names the record each movement came
 * from by its own number (2026-10-22). The product page printed
 * "Sale order (4d2d3158-…)" — a database id nobody can look up.
 */

const BATCH = randomUUID();
const CYCLE = randomUUID();
const ORDER = randomUUID();
const CANCELLED = randomUUID();
const SAMPLES = randomUUID();
const RETURN = randomUUID();
const RETURN_ORDER = randomUUID();
const PO_ITEM = randomUUID();
const PO = randomUUID();
const TRANSFER = randomUUID();

function service(movements: any[]) {
  const calls: Record<string, any[]> = {
    saleOrder: [],
    saleReturn: [],
    purchaseOrderItem: [],
  };
  const prisma: any = {
    inventoryBatch: {
      findUnique: () => Promise.resolve({ id: BATCH, cycleId: CYCLE }),
    },
    inventoryMovement: { findMany: () => Promise.resolve(movements) },
    saleOrder: {
      findMany: (args: any) => {
        calls.saleOrder.push(args);
        const rows = [
          { id: ORDER, orderNo: 'ORD-2026-0007' },
          { id: CANCELLED, orderNo: 'ORD-2026-0008' },
          { id: SAMPLES, orderNo: 'ORD-2026-0009' },
        ];
        return Promise.resolve(
          rows.filter((r) => args.where.id.in.includes(r.id)),
        );
      },
    },
    saleReturn: {
      findMany: (args: any) => {
        calls.saleReturn.push(args);
        return Promise.resolve(
          [
            {
              id: RETURN,
              reference: 'RET-2026-0002',
              saleOrderId: RETURN_ORDER,
            },
          ].filter((r) => args.where.id.in.includes(r.id)),
        );
      },
    },
    purchaseOrderItem: {
      findMany: (args: any) => {
        calls.purchaseOrderItem.push(args);
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

const mov = (referenceType: string | null, referenceId: string | null) => ({
  id: randomUUID(),
  batchId: BATCH,
  movementType: 'SALE',
  qtyDelta: '-1',
  occurredAt: new Date('2026-10-20T10:00:00Z'),
  referenceType,
  referenceId,
});

describe('batch movements carry the record number', () => {
  it('names each kind of record by its own number, with the id to open it', async () => {
    const { inventory } = service([
      mov('SALE_ORDER', ORDER),
      mov('SALE_ORDER_CANCEL', CANCELLED),
      mov('SAMPLES_ORDER', SAMPLES),
      mov('SALE_RETURN', RETURN),
      mov('PURCHASE_ORDER_ITEM', PO_ITEM),
    ]);
    const { data } = await inventory.getMovements(BATCH);
    expect(data.map((m: any) => m.reference)).toEqual([
      { number: 'ORD-2026-0007', saleOrderId: ORDER },
      { number: 'ORD-2026-0008', saleOrderId: CANCELLED },
      { number: 'ORD-2026-0009', saleOrderId: SAMPLES },
      // A return opens the order it was made on.
      { number: 'RET-2026-0002', saleOrderId: RETURN_ORDER },
      { number: 'PO-2026-0003', purchaseOrderId: PO },
    ]);
  });

  it('keeps every field it returned before (backward compatible)', async () => {
    const m = mov('SALE_ORDER', ORDER);
    const { inventory } = service([m]);
    const { data } = await inventory.getMovements(BATCH);
    expect(data[0]).toMatchObject(m);
    expect(data[0].referenceId).toBe(ORDER);
  });

  it('asks once per kind of record, however many rows there are', async () => {
    const rows = [
      ...Array.from({ length: 40 }, () => mov('SALE_ORDER', ORDER)),
      ...Array.from({ length: 40 }, () => mov('SALE_RETURN', RETURN)),
      ...Array.from({ length: 40 }, () => mov('PURCHASE_ORDER_ITEM', PO_ITEM)),
    ];
    const { inventory, calls } = service(rows);
    const { data } = await inventory.getMovements(BATCH);
    expect(calls.saleOrder).toHaveLength(1);
    expect(calls.saleReturn).toHaveLength(1);
    expect(calls.purchaseOrderItem).toHaveLength(1);
    // The same id asked for once, not forty times.
    expect(calls.saleOrder[0].where.id.in).toEqual([ORDER]);
    expect(data.every((m: any) => m.reference)).toBe(true);
  });

  it('asks nothing when no movement names a record', async () => {
    const { inventory, calls } = service([
      mov(null, null),
      mov('STOCK_TRANSFER', TRANSFER),
    ]);
    const { data } = await inventory.getMovements(BATCH);
    expect(calls.saleOrder).toHaveLength(0);
    expect(calls.saleReturn).toHaveLength(0);
    expect(calls.purchaseOrderItem).toHaveLength(0);
    // A transfer has no number of its own; it says so rather than inventing one.
    expect(data.map((m: any) => m.reference)).toEqual([null, null]);
  });

  it('a reference whose record is gone is null, not an error', async () => {
    const { inventory } = service([
      mov('SALE_ORDER', randomUUID()),
      mov('SALE_RETURN', ORDER),
    ]);
    const { data } = await inventory.getMovements(BATCH);
    expect(data.map((m: any) => m.reference)).toEqual([null, null]);
  });

  it('a type mismatch never borrows another record’s number', async () => {
    // A return's id given as a sale order's must not find the return.
    const { inventory } = service([mov('SALE_ORDER', RETURN)]);
    const { data } = await inventory.getMovements(BATCH);
    expect(data[0].reference).toBeNull();
  });

  it('a batch that is not one is still a 404', async () => {
    const { inventory } = service([]);
    await expect(inventory.getMovements('not-a-uuid')).rejects.toMatchObject({
      status: 404,
    });
  });
});
