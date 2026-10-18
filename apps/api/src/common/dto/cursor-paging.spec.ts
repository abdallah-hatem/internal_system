/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/require-await, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- an in-memory stand-in for Prisma answers loosely-shaped query objects */
import { CyclesService } from '../../modules/cycles/cycles.service';
import { ProductsService } from '../../modules/products/products.service';
import { PurchasesService } from '../../modules/purchases/purchases.service';
import { SuppliersService } from '../../modules/suppliers/suppliers.service';
import { cursorPage } from './pagination.dto';

/**
 * Following `nextCursor` must reach every row exactly once (L1).
 *
 * The web lists now walk the pages to fetch everything. Two things stood in
 * the way, and the fake below models both honestly:
 *
 * - Prisma's cursor is INCLUSIVE. Without `skip: 1` the next page starts on
 *   the last row of the one before, so that row came back twice.
 * - Postgres returns tied rows in no particular order, and differently from
 *   one query to the next. Rows written in one transaction share `createdAt`.
 *   With `createdAt` alone as the order, a page boundary inside a tie could
 *   skip one row and repeat another. The fake shuffles ties on every call.
 */

let seed = 7;
function random() {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
}

function compare(a: any, b: any, orderBy: any): number {
  const keys: Array<Record<string, 'asc' | 'desc'>> = Array.isArray(orderBy)
    ? orderBy
    : [orderBy];
  for (const k of keys) {
    const [field, dir] = Object.entries(k)[0];
    const x = a[field] instanceof Date ? a[field].getTime() : a[field];
    const y = b[field] instanceof Date ? b[field].getTime() : b[field];
    if (x < y) return dir === 'asc' ? -1 : 1;
    if (x > y) return dir === 'asc' ? 1 : -1;
  }
  return 0;
}

/** findMany with Prisma's cursor/skip/take semantics and Postgres's ties. */
function fakeFindMany(rows: any[]) {
  return async (args: any) => {
    const order = rows
      .map((r) => ({ r, tie: random() }))
      .sort((a, b) => compare(a.r, b.r, args.orderBy) || a.tie - b.tie)
      .map((x) => x.r);
    let start = 0;
    if (args.cursor) {
      start = order.findIndex((r) => r.id === args.cursor.id);
      if (start < 0) return [];
    }
    start += args.skip ?? 0;
    return order.slice(start, start + args.take);
  };
}

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// 45 rows; rows 10–29 were written in one transaction and share a timestamp.
function makeRows() {
  return Array.from({ length: 45 }, (_, i) => ({
    id: uuid(i + 1),
    name: `Row ${String(i % 7)}`, // names repeat, as supplier names can
    createdAt: new Date(
      Date.UTC(2026, 0, 1) + (i >= 10 && i < 30 ? 10 : i) * 60_000,
    ),
  }));
}

async function walk(findAll: (q: any) => Promise<any>) {
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 20; guard++) {
    const page = await findAll({ limit: 20, cursor });
    seen.push(...page.data.map((r: any) => r.id));
    cursor = page.meta.nextCursor ?? undefined;
    if (!cursor) break;
  }
  return seen;
}

const stub = {} as any;
const lists: Array<[string, string, (db: any) => (q: any) => Promise<any>]> = [
  [
    'purchases',
    'purchaseOrder',
    (db) => (q) => new PurchasesService(db, stub, stub).findAll(q),
  ],
  [
    'products',
    'product',
    (db) => (q) => new ProductsService(db, stub, stub).findAll(q),
  ],
  [
    'suppliers',
    'supplier',
    (db) => (q) => new SuppliersService(db, stub).findAll(q),
  ],
  [
    'cycles',
    'importCycle',
    (db) => (q) => new CyclesService(db, stub, stub).findAll(q),
  ],
];

describe.each(lists)('%s list — walking every page', (_name, model, make) => {
  it('returns each of 45 rows exactly once, across a 20-row tie', async () => {
    const rows = makeRows();
    const findAll = make({
      [model]: { findMany: fakeFindMany(rows) },
      // The products list reads each product's batches for its default price.
      inventoryBatch: { findMany: () => Promise.resolve([]) },
    });
    for (let run = 0; run < 5; run++) {
      const seen = await walk(findAll);
      expect(seen).toHaveLength(45);
      expect(new Set(seen).size).toBe(45);
    }
  });

  it('a second request for the same page gives the same rows', async () => {
    const rows = makeRows();
    const findAll = make({
      [model]: { findMany: fakeFindMany(rows) },
      // The products list reads each product's batches for its default price.
      inventoryBatch: { findMany: () => Promise.resolve([]) },
    });
    const a = await findAll({ limit: 20 });
    const b = await findAll({ limit: 20 });
    expect(b.data.map((r: any) => r.id)).toEqual(a.data.map((r: any) => r.id));
  });
});

describe('newest first', () => {
  it('purchases: the newest order is on the first page, not the 21st', async () => {
    const rows = makeRows();
    const service = new PurchasesService(
      { purchaseOrder: { findMany: fakeFindMany(rows) } } as any,
      stub,
      stub,
    );
    const { data } = await service.findAll({ limit: 20 });
    expect(data[0].id).toBe(uuid(45));
  });
});

describe('cursorPage', () => {
  it('no cursor: one extra row to tell whether there is more', () => {
    expect(cursorPage(undefined, 20)).toEqual({ take: 21 });
    expect(cursorPage('', 20)).toEqual({ take: 21 });
  });

  it('a cursor steps past itself — Prisma includes the cursor row', () => {
    expect(cursorPage(uuid(3), 20)).toEqual({
      take: 21,
      cursor: { id: uuid(3) },
      skip: 1,
    });
  });

  it('a cursor that cannot be an id is a 400, not a 500 from the uuid cast', () => {
    expect(() => cursorPage('not-an-id', 20)).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      }),
    );
    expect(() => cursorPage("1' OR '1'='1", 20)).toThrow();
  });
});
