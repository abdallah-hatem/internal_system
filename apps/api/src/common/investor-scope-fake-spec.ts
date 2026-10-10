/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/require-await, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- an in-memory stand-in for Prisma answers loosely-shaped query objects */
/**
 * A small in-memory stand-in for the Prisma client, enough for the R1 scope
 * tests to run the real service reads against rows and see what comes back —
 * rather than asserting on the `where` a service built, which would pass for a
 * filter that was written and then never applied.
 *
 * It understands what those reads use: equality, `in`, `contains`, `AND`/`OR`,
 * relation `some`, nested `include`/`select` with their own `where`, and
 * `_count` (filtered or not). Anything else is not supported and throws, so a
 * read the fake cannot answer fails loudly instead of matching by accident.
 *
 * Named `-spec.ts` so the build leaves it out while jest does not run it as a
 * suite (as `shipping/shipment-fake-spec.ts`).
 */

type Row = Record<string, any>;
type Rel = { model: string; fk: string; kind: 'many' | 'one' };

const many = (model: string, fk: string): Rel => ({ model, fk, kind: 'many' });
const one = (model: string, fk: string): Rel => ({ model, fk, kind: 'one' });

const REL: Record<string, Record<string, Rel>> = {
  importCycle: {
    participants: many('cycleParticipant', 'cycleId'),
    purchaseOrders: many('purchaseOrder', 'cycleId'),
    shippingLegs: many('shippingLeg', 'cycleId'),
    inventoryBatches: many('inventoryBatch', 'cycleId'),
    settlements: many('settlement', 'cycleId'),
    financialTransactions: many('financialTransaction', 'cycleId'),
  },
  cycleParticipant: {
    cycle: one('importCycle', 'cycleId'),
    partner: one('user', 'partnerUserId'),
    investor: one('user', 'investorUserId'),
  },
  user: { partner: one('partner', 'partnerId') },
  purchaseOrder: {
    cycle: one('importCycle', 'cycleId'),
    supplier: one('supplier', 'supplierId'),
    items: many('purchaseOrderItem', 'purchaseOrderId'),
    supplierRefunds: many('supplierRefund', 'purchaseOrderId'),
  },
  purchaseOrderItem: { product: one('product', 'productId') },
  shippingLeg: { cycle: one('importCycle', 'cycleId') },
  inventoryBatch: {
    cycle: one('importCycle', 'cycleId'),
    product: one('product', 'productId'),
    saleItemAllocations: many('saleItemAllocation', 'inventoryBatchId'),
    returnItems: many('returnItem', 'batchId'),
  },
  settlement: {
    cycle: one('importCycle', 'cycleId'),
    lines: many('settlementLine', 'settlementId'),
  },
  settlementLine: { participant: one('cycleParticipant', 'participantId') },
  supplier: {
    purchaseOrders: many('purchaseOrder', 'supplierId'),
    products: many('supplierProduct', 'supplierId'),
  },
  supplierProduct: {
    supplier: one('supplier', 'supplierId'),
    product: one('product', 'productId'),
  },
  provider: { shippingLegs: many('shippingLeg', 'providerId') },
  product: {
    category: one('category', 'categoryId'),
    suppliers: many('supplierProduct', 'productId'),
    prices: many('productPrice', 'productId'),
    compatibilities: many('compatibility', 'productId'),
  },
};

export type Tables = Record<string, Row[]>;

export function fakeDb(tables: Tables) {
  const rows = (model: string) => tables[model] ?? [];

  const related = (model: string, row: Row, rel: Rel): Row[] =>
    rel.kind === 'many'
      ? rows(rel.model).filter((r) => r[rel.fk] === row.id)
      : rows(rel.model).filter((r) => r.id === row[rel.fk]);

  function matches(model: string, row: Row, where: any): boolean {
    if (!where) return true;
    return Object.entries(where).every(([k, v]: [string, any]) => {
      if (v === undefined) return true;
      if (k === 'AND') return (v as any[]).every((w) => matches(model, row, w));
      if (k === 'OR') return (v as any[]).some((w) => matches(model, row, w));
      const rel = REL[model]?.[k];
      if (rel) {
        const rs = related(model, row, rel);
        if (rel.kind === 'many') {
          if (!v.some)
            throw new Error(`fake: ${model}.${k} supports only "some"`);
          return rs.some((r) => matches(rel.model, r, v.some));
        }
        return rs.some((r) => matches(rel.model, r, v));
      }
      if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
        if ('in' in v) return (v.in as unknown[]).includes(row[k]);
        if ('contains' in v) {
          return String(row[k] ?? '')
            .toLowerCase()
            .includes(String(v.contains).toLowerCase());
        }
        if ('equals' in v) return row[k] === v.equals;
        throw new Error(
          `fake: unsupported filter on ${model}.${k}: ${JSON.stringify(v)}`,
        );
      }
      return row[k] === v;
    });
  }

  function count(model: string, row: Row, spec: Record<string, any>) {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(spec)) {
      const rel = REL[model]?.[k];
      if (!rel) throw new Error(`fake: no relation ${model}.${k} to count`);
      const rs = related(model, row, rel);
      out[k] =
        v === true
          ? rs.length
          : rs.filter((r) => matches(rel.model, r, v.where)).length;
    }
    return out;
  }

  function relation(model: string, row: Row, key: string, v: any) {
    const rel = REL[model]?.[key];
    if (!rel) throw new Error(`fake: no relation ${model}.${key}`);
    const opts = v === true ? {} : v;
    const rs = related(model, row, rel).filter((r) =>
      matches(rel.model, r, opts.where),
    );
    const shaped = rs.map((r) => project(rel.model, r, opts));
    return rel.kind === 'many' ? shaped : (shaped[0] ?? null);
  }

  function project(
    model: string,
    row: Row,
    args: { include?: any; select?: any } = {},
  ): Row {
    if (args.select) {
      const out: Row = {};
      for (const [k, v] of Object.entries<any>(args.select)) {
        if (!v) continue;
        if (k === '_count') out._count = count(model, row, v.select);
        else if (REL[model]?.[k]) out[k] = relation(model, row, k, v);
        else out[k] = row[k];
      }
      return out;
    }
    const out: Row = { ...row };
    for (const [k, v] of Object.entries<any>(args.include ?? {})) {
      if (!v) continue;
      if (k === '_count') out._count = count(model, row, v.select);
      else out[k] = relation(model, row, k, v);
    }
    return out;
  }

  const model = (name: string) => ({
    findMany: jest.fn(async (args: any = {}) => {
      const found = rows(name).filter((r) => matches(name, r, args.where));
      const taken = args.take ? found.slice(0, args.take) : found;
      return taken.map((r) => project(name, r, args));
    }),
    findUnique: jest.fn(async (args: any) => {
      const r = rows(name).find((x) => matches(name, x, args.where));
      return r ? project(name, r, args) : null;
    }),
    findFirst: jest.fn(async (args: any = {}) => {
      const r = rows(name).find((x) => matches(name, x, args.where));
      return r ? project(name, r, args) : null;
    }),
    aggregate: jest.fn(async () => ({ _sum: {} })),
  });

  const cache = new Map<string, ReturnType<typeof model>>();
  return new Proxy(
    {},
    {
      get: (_t, name: string) => {
        if (!cache.has(name)) cache.set(name, model(name));
        return cache.get(name);
      },
    },
  );
}
