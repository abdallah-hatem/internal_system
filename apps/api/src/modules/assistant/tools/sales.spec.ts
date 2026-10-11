import { randomUUID } from 'node:crypto';
import { Logger, type Type } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
// The fake database keeps quantities as Prisma decimals, as the real one does.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- the test fakes Prisma's own value types
import { Prisma } from '@prisma/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { PaymentsService } from '../../payments/payments.service';
import { SalesService } from '../../sales/sales.service';
import { AssistantServer } from '../assistant-server';
import { ConfirmationService } from '../confirmation.service';
import type { AssistantUser } from '../tool-kit';

/**
 * record_sale (plan W3, BUSINESS_LOGIC §16 2026-10-11), driven through a real
 * McpServer and the SDK's client — the path Claude takes — against the real
 * SalesService and PaymentsService. Only the database is fake: an in-memory
 * one that rolls a transaction back when it throws, because "a preview writes
 * nothing" and "one paid order or nothing" are what is under test. Each test
 * is named after the plan's edge case it covers.
 */

// ── An in-memory database with transactions ──────────────────────────────

type Row = Record<string, unknown>;
const D = (v: unknown) => new Prisma.Decimal(v as Prisma.Decimal.Value);

const TABLES = [
  'product',
  'productPrice',
  'customer',
  'inventoryBatch',
  'inventoryReservation',
  'saleOrder',
  'saleItem',
  'inventoryMovement',
  'saleItemAllocation',
  'payment',
  'financialTransaction',
  'paymentAllocation',
  'auditLog',
  'usedNonce',
  'user',
] as const;
type Table = (typeof TABLES)[number];

/** relation → [table, key on the other row or on this row, kind] */
const RELATIONS: Record<
  string,
  Record<string, [Table, string, 'many' | 'one']>
> = {
  product: {
    prices: ['productPrice', 'productId', 'many'],
    inventoryBatches: ['inventoryBatch', 'productId', 'many'],
  },
  saleOrder: {
    items: ['saleItem', 'saleOrderId', 'many'],
    customer: ['customer', 'customerId', 'one'],
  },
  saleItem: { product: ['product', 'productId', 'one'] },
};

const UNIQUE: Partial<Record<Table, string[][]>> = {
  saleOrder: [['orderNo'], ['createdBy', 'idempotencyKey']],
  usedNonce: [['jti']],
};

function p2002(target: string[]) {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target },
  });
}

class FakeDb {
  tables = Object.fromEntries(TABLES.map((t) => [t, [] as Row[]])) as Record<
    Table,
    Row[]
  >;

  constructor() {
    for (const t of TABLES) {
      (this as unknown as Record<string, unknown>)[t] = this.model(t);
    }
  }

  insert(table: Table, row: Row): Row {
    const full: Row = {
      id: randomUUID(),
      createdAt: new Date(),
      version: 1,
      ...row,
    };
    for (const cols of UNIQUE[table] ?? []) {
      if (cols.some((c) => full[c] === null || full[c] === undefined)) continue;
      if (this.tables[table].some((r) => cols.every((c) => r[c] === full[c])))
        throw p2002(cols);
    }
    this.tables[table].push(full);
    return full;
  }

  /** Every table except the nonces and the audit trail, by row count. */
  counts() {
    return Object.fromEntries(
      TABLES.filter((t) => t !== 'usedNonce' && t !== 'auditLog').map((t) => [
        t,
        this.tables[t].length,
      ]),
    );
  }

  async $transaction<T>(
    work: (tx: FakeDb) => Promise<T>,
    _options?: unknown,
  ): Promise<T> {
    // Rows are replaced, never mutated, so copying the arrays is a snapshot.
    const before = Object.fromEntries(
      Object.entries(this.tables).map(([t, rows]) => [t, rows.slice()]),
    ) as Record<Table, Row[]>;
    try {
      return await work(this);
    } catch (err) {
      this.tables = before;
      throw err;
    }
  }

  $executeRaw(): Promise<number> {
    return Promise.reject(new Error('fake db: seed the walk-in record'));
  }

  private matches(table: Table, row: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([key, cond]) => {
      if (key === 'createdBy_idempotencyKey') {
        const c = cond as Row;
        return (
          row.createdBy === c.createdBy &&
          row.idempotencyKey === c.idempotencyKey
        );
      }
      if (key === 'OR')
        return (cond as Row[]).some((c) => this.matches(table, row, c));
      const rel = RELATIONS[table]?.[key];
      if (rel && rel[2] === 'one') {
        const other = this.tables[rel[0]].find((r) => r.id === row[rel[1]]);
        return !!other && this.matches(rel[0], other, cond as Row);
      }
      const value = row[key];
      if (cond === null || typeof cond !== 'object' || cond instanceof Date)
        return value === cond;
      const c = cond as Row;
      if ('in' in c) return (c.in as unknown[]).includes(value);
      if ('gt' in c) return D(value ?? 0).gt(D(c.gt));
      if ('startsWith' in c)
        return (
          typeof value === 'string' && value.startsWith(String(c.startsWith))
        );
      if ('not' in c) return value !== c.not && value !== undefined;
      throw new Error(`fake db: unsupported filter ${JSON.stringify(cond)}`);
    });
  }

  private shape(table: Table, row: Row, args: Row = {}): Row {
    const pick = (args.select ?? args.include) as Row | undefined;
    if (!pick) return { ...row };
    const out: Row = args.include ? { ...row } : {};
    for (const [key, spec] of Object.entries(pick)) {
      const rel = RELATIONS[table]?.[key];
      if (!rel) {
        if (spec) out[key] = row[key];
        continue;
      }
      const sub = spec === true ? {} : (spec as Row);
      if (rel[2] === 'many') {
        out[key] = this.tables[rel[0]]
          .filter((r) => r[rel[1]] === row.id)
          .filter((r) => this.matches(rel[0], r, sub.where as Row))
          .map((r) => this.shape(rel[0], r, sub));
      } else {
        const other = this.tables[rel[0]].find((r) => r.id === row[rel[1]]);
        out[key] = other ? this.shape(rel[0], other, sub) : null;
      }
    }
    return out;
  }

  private apply(row: Row, data: Row): Row {
    const next = { ...row };
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && 'decrement' in v) {
        next[k] = D(row[k]).sub(D((v as Row).decrement));
      } else if (v && typeof v === 'object' && 'increment' in v) {
        next[k] = D(row[k])
          .add(D((v as Row).increment))
          .toNumber();
      } else {
        next[k] = v;
      }
    }
    return next;
  }

  private model(table: Table) {
    const all = (args: Row = {}) => {
      const rows = this.tables[table].filter((r) =>
        this.matches(table, r, args.where as Row),
      );
      const orderBy = args.orderBy as Row | Row[] | undefined;
      const first = Array.isArray(orderBy) ? orderBy[0] : orderBy;
      if (!first) return rows;
      const [[field, dir]] = Object.entries(first);
      return rows.slice().sort((a, b) => {
        const x = String(a[field]);
        const y = String(b[field]);
        return (x < y ? -1 : x > y ? 1 : 0) * (dir === 'desc' ? -1 : 1);
      });
    };
    const one = (args: Row) => {
      const row = all(args)[0];
      return Promise.resolve(row ? this.shape(table, row, args) : null);
    };
    return {
      findUnique: one,
      findFirst: one,
      findUniqueOrThrow: async (args: Row) => {
        const row = await one(args);
        if (!row) throw new Error(`fake db: no ${table}`);
        return row;
      },
      findMany: (args: Row = {}) =>
        Promise.resolve(all(args).map((r) => this.shape(table, r, args))),
      create: (args: Row) => {
        try {
          const { items, ...data } = args.data as Row;
          const row = this.insert(table, data);
          const nested = (items as { create?: Row[] } | undefined)?.create;
          for (const item of nested ?? [])
            this.insert('saleItem', { ...item, saleOrderId: row.id });
          return Promise.resolve(this.shape(table, row, args));
        } catch (err) {
          return Promise.reject(err as Error);
        }
      },
      update: (args: Row) => {
        const rows = this.tables[table];
        const i = rows.findIndex((r) =>
          this.matches(table, r, args.where as Row),
        );
        if (i < 0) return Promise.reject(new Error(`fake db: no ${table}`));
        rows[i] = this.apply(rows[i], args.data as Row);
        return Promise.resolve(this.shape(table, rows[i], args));
      },
      groupBy: (args: Row) => {
        const by = (args.by as string[])[0];
        const sumOf = Object.keys((args._sum as Row) ?? {})[0];
        const groups = new Map<unknown, Prisma.Decimal>();
        for (const r of all(args))
          groups.set(r[by], (groups.get(r[by]) ?? D(0)).add(D(r[sumOf])));
        return Promise.resolve(
          [...groups].map(([k, sum]) => ({ [by]: k, _sum: { [sumOf]: sum } })),
        );
      },
      aggregate: (args: Row) => {
        const sumOf = Object.keys((args._sum as Row) ?? {})[0];
        const rows = all(args);
        return Promise.resolve({
          _sum: {
            [sumOf]: rows.length
              ? rows.reduce((s, r) => s.add(D(r[sumOf])), D(0))
              : null,
          },
        });
      },
    };
  }
}

// ── The shop ──────────────────────────────────────────────────────────────

const partner: AssistantUser = {
  id: randomUUID(),
  email: 'omar@motoparts.test',
  role: 'CORE_PARTNER',
  partner: null,
};

let db: FakeDb;
let client: Client;
/** The low-stock alerts the sales service raised (BUSINESS_LOGIC §3, 2026-10-11). */
const lowStockAlerts = jest.fn((_userIds: string[], _data: unknown) =>
  Promise.resolve({ count: 0 }),
);
let ids: {
  pad: string;
  helmet: string;
  chain: string;
  padBatch: string;
  padB2c: string;
  shop: string;
  unverified: string;
  walkIn: string;
};

function seed() {
  const product = (name: string, sku: string) =>
    db.insert('product', { name, sku, status: 'ACTIVE' }).id as string;
  const pad = product('Honda CBR Brake Pad', 'HCB-BP');
  const helmet = product('Full Face Helmet', 'FFH-01');
  const chain = product('Drive chain 428', 'DC-428');
  const batch = (productId: string, qty: number) =>
    db.insert('inventoryBatch', {
      productId,
      cycleId: randomUUID(),
      verificationStatus: 'VERIFIED',
      receivedQty: D(qty),
      remainingQty: D(qty),
      saleableQty: D(qty),
      landedUnitCostEgp: D(120),
    }).id as string;
  const padBatch = batch(pad, 40);
  batch(helmet, 10);
  // The chain has a price but no stock.
  const price = (productId: string, channel: string, amount: number) =>
    db.insert('productPrice', {
      productId,
      channel,
      currency: 'EGP',
      amount: D(amount),
      effectiveFrom: new Date('2026-01-01'),
      effectiveTo: null,
    }).id as string;
  const padB2c = price(pad, 'B2C', 350);
  price(pad, 'B2B', 280);
  price(chain, 'B2C', 900);

  const customer = (displayName: string, extra: Row = {}) =>
    db.insert('customer', {
      displayName,
      type: 'B2B',
      verificationStatus: 'VERIFIED',
      isWalkIn: false,
      ...extra,
    }).id as string;
  const shop = customer('Nasr City Motors');
  const unverified = customer('Heliopolis Bikes', {
    verificationStatus: 'UNVERIFIED',
  });
  const walkIn = customer('Walk-in', { type: 'B2C', isWalkIn: true });
  ids = { pad, helmet, chain, padBatch, padB2c, shop, unverified, walkIn };
}

beforeEach(async () => {
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  lowStockAlerts.mockClear();
  db = new FakeDb();
  seed();
  const prisma = db as unknown as PrismaService;
  const audit = new AuditService(prisma);
  const payments = new PaymentsService(prisma, audit);
  const registry = new Map<unknown, unknown>([
    [PrismaService, prisma],
    [AuditService, audit],
    [PaymentsService, payments],
    [
      SalesService,
      new SalesService(prisma, audit, payments, {
        createForMultipleUsers: lowStockAlerts,
      }),
    ],
  ]);
  const assistant = new AssistantServer(
    new ConfirmationService(
      new JwtService({ secret: 'a-test-secret-that-is-long-enough' }),
      prisma,
    ),
    {
      get: (type: Type<unknown>) => registry.get(type),
    } as unknown as ModuleRef,
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await assistant.create(partner).connect(serverSide);
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
});

afterEach(async () => {
  await client.close();
  jest.restoreAllMocks();
});

// ── Calling the tool ──────────────────────────────────────────────────────

interface Line {
  product: string;
  qty: string;
  unitPrice: string;
  priceSource: 'given' | 'list';
  note?: string;
  lineTotal: string;
  available: string;
}
interface Structured {
  status?: string;
  confirmationToken?: string;
  data?: Record<string, unknown> & {
    lines?: Line[];
    questions?: {
      id: string;
      kind: string;
      options: { value: string; label: string }[];
    }[];
  };
  error?: { code: string; message: string };
}

async function call(args: Record<string, unknown>) {
  const r = (await client.callTool({
    name: 'record_sale',
    arguments: args,
  })) as CallToolResult;
  return {
    ...r,
    s: (r.structuredContent ?? {}) as Structured,
    text: (r.content[0] as { text: string }).text,
  };
}

const confirm = (args: Record<string, unknown>, token?: string) =>
  call({ ...args, confirmationToken: token });

const codeOf = (r: { s: Structured }) => r.s.error?.code;
const batchQty = () =>
  String(
    db.tables.inventoryBatch.find((b) => b.id === ids.padBatch)!.saleableQty,
  );

const walkInSale = {
  walkIn: true,
  lines: [{ product: 'Honda CBR Brake Pad', qty: 25, unitPrice: 300 }],
};

// ── The edge cases (plan W3, sales) ───────────────────────────────────────

describe('record_sale — a walk-in sale', () => {
  it('"Sold 25 of <product> at 300 to anyone" → a walk-in preview with 25 × 300 and stock shown; confirm writes one paid order', async () => {
    const before = db.counts();
    const preview = await call(walkInSale);

    expect(preview.s.status).toBe('preview');
    expect(preview.s.data).toMatchObject({
      walkIn: true,
      channel: 'B2C',
      total: '7500.00',
      statusAfter: 'PAID',
      outstandingAfter: '0.00',
      payment: { method: 'CASH', amount: '7500.00' },
    });
    expect(preview.s.data?.lines).toEqual([
      expect.objectContaining({
        product: 'Honda CBR Brake Pad',
        qty: '25',
        unitPrice: '300.00',
        priceSource: 'given',
        lineTotal: '7500.00',
        available: '40',
      }),
    ]);
    expect(preview.text).toContain('Paid on the spot by CASH');
    expect(preview.text).toContain('40 in stock');
    // The preview wrote nothing — not even the order it rolled back.
    expect(db.counts()).toEqual(before);
    expect(batchQty()).toBe('40');

    const done = await confirm(walkInSale, preview.s.confirmationToken);

    expect(done.s.status).toBe('committed');
    expect(db.tables.saleOrder).toHaveLength(1);
    expect(db.tables.saleOrder[0]).toMatchObject({
      customerId: ids.walkIn,
      status: 'PAID',
      channel: 'B2C',
    });
    expect(Number(db.tables.saleOrder[0].outstanding)).toBe(0);
    expect(db.tables.payment).toHaveLength(1);
    expect(db.tables.payment[0]).toMatchObject({
      method: 'CASH',
      amount: 7500,
    });
    expect(db.tables.paymentAllocation).toHaveLength(1);
    expect(batchQty()).toBe('15');
  });

  it('a walk-in paid another way says so in the preview and records that method', async () => {
    const args = { ...walkInSale, paymentMethod: 'MOBILE_WALLET' };
    const preview = await call(args);
    expect(preview.text).toContain('Paid on the spot by MOBILE_WALLET');
    await confirm(args, preview.s.confirmationToken);
    expect(db.tables.payment[0].method).toBe('MOBILE_WALLET');
  });

  it('walkIn together with a customer → VALIDATION_FAILED, nothing written', async () => {
    const before = db.counts();
    const r = await call({ ...walkInSale, customer: 'Nasr City Motors' });
    expect(codeOf(r)).toBe('VALIDATION_FAILED');
    expect(db.counts()).toEqual(before);
  });

  it('neither a customer nor walkIn → VALIDATION_FAILED', async () => {
    const r = await call({ lines: walkInSale.lines });
    expect(codeOf(r)).toBe('VALIDATION_FAILED');
  });
});

describe('record_sale — a named customer', () => {
  const shopSale = {
    customer: 'nasr city  MOTORS',
    lines: [{ product: 'HCB-BP', qty: 10, unitPrice: 290 }],
  };

  it('A named customer → a CONFIRMED order that is owed, no payment', async () => {
    const preview = await call(shopSale);
    expect(preview.s.data).toMatchObject({
      walkIn: false,
      channel: 'B2B',
      customer: { id: ids.shop, name: 'Nasr City Motors' },
      statusAfter: 'CONFIRMED',
      outstandingAfter: '2900.00',
      payment: null,
    });
    expect(preview.text).toContain('will owe 2,900.00 EGP');

    const done = await confirm(shopSale, preview.s.confirmationToken);

    expect(done.s.status).toBe('committed');
    expect(db.tables.saleOrder).toHaveLength(1);
    expect(db.tables.saleOrder[0]).toMatchObject({
      customerId: ids.shop,
      status: 'CONFIRMED',
      outstanding: '2900.00',
    });
    expect(db.tables.payment).toHaveLength(0);
    expect(db.tables.customer).toHaveLength(3);
  });

  it('a payment method on a named customer → refused (VALIDATION_FAILED), not dropped', async () => {
    const before = db.counts();
    const r = await call({ ...shopSale, paymentMethod: 'CASH' });
    expect(codeOf(r)).toBe('VALIDATION_FAILED');
    expect(db.counts()).toEqual(before);
  });

  it('an unverified customer is refused as the office app refuses it', async () => {
    const r = await call({ ...shopSale, customer: 'Heliopolis Bikes' });
    expect(r.isError).toBe(true);
    expect(db.tables.saleOrder).toHaveLength(0);
  });
});

describe('record_sale — matching (the shared matcher)', () => {
  it('A close product name → candidates, nothing written', async () => {
    const before = db.counts();
    const r = await call({
      walkIn: true,
      lines: [
        { product: 'Honda CBR brake pads (front)', qty: 2, unitPrice: 300 },
      ],
    });

    expect(r.isError).toBeFalsy();
    expect(r.s.status).toBe('needs_answers');
    expect(r.s.confirmationToken).toBeUndefined();
    expect(r.s.data?.questions).toEqual([
      expect.objectContaining({
        id: 'LINE_WHICH:1',
        options: [
          expect.objectContaining({
            value: ids.pad,
            label: 'Honda CBR Brake Pad (HCB-BP)',
          }),
        ],
      }),
    ]);
    expect(r.text).toContain('nothing to confirm');
    expect(db.counts()).toEqual(before);
  });

  it('a name with extra descriptors ("Full face helmet, matt black, size L") is asked, never auto-matched', async () => {
    const r = await call({
      walkIn: true,
      lines: [
        {
          product: 'Full face helmet, matt black, size L',
          qty: 1,
          unitPrice: 1,
        },
      ],
    });
    expect(r.s.status).toBe('needs_answers');
    expect(r.s.data?.questions?.[0].options.map((o) => o.value)).toEqual([
      ids.helmet,
    ]);
  });

  it('a product nobody has → LINE_UNKNOWN, a question with no candidates', async () => {
    const r = await call({
      walkIn: true,
      lines: [{ product: 'Handlebar grips', qty: 1, unitPrice: 1 }],
    });
    expect(r.s.data?.questions).toEqual([
      expect.objectContaining({ kind: 'LINE_UNKNOWN', options: [] }),
    ]);
  });

  it('An unknown customer name → a question, not a new customer', async () => {
    const before = db.counts();
    const r = await call({
      customer: 'Zamalek Scooters',
      lines: [{ product: 'Honda CBR Brake Pad', qty: 1, unitPrice: 300 }],
    });
    expect(r.s.status).toBe('needs_answers');
    expect(r.s.data?.questions).toEqual([
      expect.objectContaining({
        kind: 'CUSTOMER_UNKNOWN',
        options: [{ value: 'walk_in', label: 'A walk-in sale' }],
      }),
    ]);
    expect(db.counts()).toEqual(before);
    expect(db.tables.customer).toHaveLength(3);
  });

  it('a close customer name → CUSTOMER_WHICH with the candidate', async () => {
    const r = await call({
      customer: 'Nasr City Motor',
      lines: [{ product: 'Honda CBR Brake Pad', qty: 1, unitPrice: 300 }],
    });
    expect(r.s.data?.questions).toEqual([
      expect.objectContaining({
        kind: 'CUSTOMER_WHICH',
        options: [expect.objectContaining({ value: ids.shop })],
      }),
    ]);
  });

  it('the walk-in record cannot be named as a customer — it is not offered', async () => {
    const r = await call({
      customer: 'Walk-in',
      lines: [{ product: 'Honda CBR Brake Pad', qty: 1, unitPrice: 300 }],
    });
    expect(r.s.data?.questions?.[0].kind).toBe('CUSTOMER_UNKNOWN');
  });

  it('a product by id, and a customer by id, are matched', async () => {
    const r = await call({
      customer: ids.shop,
      lines: [{ product: ids.pad, qty: 1, unitPrice: 300 }],
    });
    expect(r.s.status).toBe('preview');
  });
});

describe('record_sale — prices', () => {
  it('No price → the preview offers the list price and asks (B2C for a walk-in)', async () => {
    const r = await call({
      walkIn: true,
      lines: [{ product: 'Honda CBR Brake Pad', qty: 2 }],
    });
    expect(r.s.status).toBe('preview');
    expect(r.s.data?.lines?.[0]).toMatchObject({
      unitPrice: '350.00',
      priceSource: 'list',
      note: 'list price — confirm or give the price',
    });
    expect(r.text).toContain('list price — confirm or give the price');
  });

  it('No price for a B2B shop → the B2B list price', async () => {
    const r = await call({
      customer: 'Nasr City Motors',
      lines: [{ product: 'Honda CBR Brake Pad', qty: 2 }],
    });
    expect(r.s.data?.lines?.[0]).toMatchObject({
      unitPrice: '280.00',
      priceSource: 'list',
    });
  });

  it('No price and no list price on that channel → PRICE_NEEDED, nothing to confirm', async () => {
    const r = await call({
      walkIn: true,
      lines: [{ product: 'Full Face Helmet', qty: 1 }],
    });
    expect(r.s.status).toBe('needs_answers');
    expect(r.s.data?.questions?.[0].kind).toBe('PRICE_NEEDED');
  });

  it('A discount larger than the line → DISCOUNT_EXCEEDS_LINE in the preview', async () => {
    const r = await call({
      walkIn: true,
      lines: [
        {
          product: 'Honda CBR Brake Pad',
          qty: 1,
          unitPrice: 100,
          discount: 9999,
        },
      ],
    });
    expect(codeOf(r)).toBe('DISCOUNT_EXCEEDS_LINE');
    expect(db.tables.saleOrder).toHaveLength(0);
  });

  it('a zero quantity → QTY_NOT_POSITIVE', async () => {
    const r = await call({
      walkIn: true,
      lines: [{ product: 'Honda CBR Brake Pad', qty: 0, unitPrice: 100 }],
    });
    expect(codeOf(r)).toBe('QTY_NOT_POSITIVE');
  });
});

describe('record_sale — stock and the binding', () => {
  it('More than in stock → NOT_ENOUGH_STOCK in the preview', async () => {
    const before = db.counts();
    const r = await call({
      walkIn: true,
      lines: [{ product: 'Honda CBR Brake Pad', qty: 41, unitPrice: 300 }],
    });
    expect(codeOf(r)).toBe('NOT_ENOUGH_STOCK');
    expect(r.s.confirmationToken).toBeUndefined();
    expect(db.counts()).toEqual(before);
  });

  it('two lines of the same product are summed against stock (25 + 25 > 40)', async () => {
    const r = await call({
      walkIn: true,
      lines: [
        { product: 'Honda CBR Brake Pad', qty: 25, unitPrice: 300 },
        { product: 'HCB-BP', qty: 25, unitPrice: 300 },
      ],
    });
    expect(codeOf(r)).toBe('NOT_ENOUGH_STOCK');
  });

  it('Stock sold elsewhere between preview and confirm → PREVIEW_CHANGED; nothing written', async () => {
    const preview = await call(walkInSale);
    // Another sale takes 5 of the 40: still enough for 25, but not what was shown.
    const b = db.tables.inventoryBatch.findIndex((x) => x.id === ids.padBatch);
    db.tables.inventoryBatch[b] = {
      ...db.tables.inventoryBatch[b],
      saleableQty: D(35),
    };
    const before = db.counts();

    const r = await confirm(walkInSale, preview.s.confirmationToken);

    expect(codeOf(r)).toBe('PREVIEW_CHANGED');
    expect(db.counts()).toEqual(before);
    // The token is not spent: the partner can look again.
    expect(db.tables.usedNonce).toHaveLength(0);
  });

  it('Stock sold elsewhere so that too little is left → NOT_ENOUGH_STOCK; nothing written', async () => {
    const preview = await call(walkInSale);
    const b = db.tables.inventoryBatch.findIndex((x) => x.id === ids.padBatch);
    db.tables.inventoryBatch[b] = {
      ...db.tables.inventoryBatch[b],
      saleableQty: D(20),
    };

    const r = await confirm(walkInSale, preview.s.confirmationToken);

    expect(codeOf(r)).toBe('NOT_ENOUGH_STOCK');
    expect(db.tables.saleOrder).toHaveLength(0);
    expect(db.tables.payment).toHaveLength(0);
  });

  it('The list price changed between preview and confirm → PREVIEW_CHANGED', async () => {
    const args = {
      walkIn: true,
      lines: [{ product: 'Honda CBR Brake Pad', qty: 2 }],
    };
    const preview = await call(args);
    const p = db.tables.productPrice.findIndex((x) => x.id === ids.padB2c);
    db.tables.productPrice[p] = {
      ...db.tables.productPrice[p],
      amount: D(400),
    };

    const r = await confirm(args, preview.s.confirmationToken);

    expect(codeOf(r)).toBe('PREVIEW_CHANGED');
    expect(db.tables.saleOrder).toHaveLength(0);
  });

  it('Replay → CONFIRMATION_USED; one order, one payment', async () => {
    const preview = await call(walkInSale);
    await confirm(walkInSale, preview.s.confirmationToken);

    const again = await confirm(walkInSale, preview.s.confirmationToken);

    expect(codeOf(again)).toBe('CONFIRMATION_USED');
    expect(db.tables.saleOrder).toHaveLength(1);
    expect(db.tables.payment).toHaveLength(1);
  });

  it('a different quantity on the commit than on the preview → CONFIRMATION_MISMATCH', async () => {
    const preview = await call(walkInSale);
    const r = await confirm(
      { walkIn: true, lines: [{ ...walkInSale.lines[0], qty: 30 }] },
      preview.s.confirmationToken,
    );
    expect(codeOf(r)).toBe('CONFIRMATION_MISMATCH');
    expect(db.tables.saleOrder).toHaveLength(0);
  });
});

describe('record_sale — what the assistant offers', () => {
  it('tools/list has record_sale and record_payment, and still no return, settlement or reversal tool', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    expect(names).toContain('record_sale');
    // Reading payments is allowed (list_payments); recording one a shop made
    // is too since 2026-10-11 (record_payment, §16); nothing else writes them.
    const writes = tools
      .filter((t) => t.annotations?.readOnlyHint !== true)
      .map((t) => t.name);
    expect(
      writes
        .filter((n) =>
          /sale|payment|instal|settle|return|refund|ledger|allocat/i.test(n),
        )
        .sort(),
    ).toEqual(['record_payment', 'record_sale']);
    const sale = tools.find((t) => t.name === 'record_sale')!;
    expect(sale.annotations?.readOnlyHint).toBe(false);
    expect(Object.keys(sale.inputSchema.properties ?? {}).sort()).toEqual([
      'confirmationToken',
      'customer',
      'lines',
      'paymentMethod',
      'walkIn',
    ]);
  });
});

describe('record_sale — low stock after the sale (§3, 2026-10-11)', () => {
  function minimum(productId: string, min: number) {
    const row = db.tables.product.find((p) => p.id === productId)!;
    row.minStock = D(min);
    db.insert('user', { role: 'CORE_PARTNER', status: 'ACTIVE' });
  }

  it('a confirmed walk-in sale taking the pads under their minimum alerts every partner once; the preview alerts nobody', async () => {
    minimum(ids.pad, 20); // 40 on the shelf, 25 sold → 15
    const preview = await call(walkInSale);
    expect(lowStockAlerts).not.toHaveBeenCalled();

    await confirm(walkInSale, preview.s.confirmationToken);

    expect(lowStockAlerts).toHaveBeenCalledTimes(1);
    const [userIds, data] = lowStockAlerts.mock.calls[0] as [
      string[],
      { code: string; payload: { products: { productId: string }[] } },
    ];
    expect(userIds).toHaveLength(1);
    expect(data.code).toBe('LOW_STOCK_DETECTED');
    expect(data.payload.products.map((p) => p.productId)).toEqual([ids.pad]);
  });

  it('a sale that leaves the pads above their minimum alerts nobody', async () => {
    minimum(ids.pad, 10); // 40 → 15, still above 10
    const preview = await call(walkInSale);
    await confirm(walkInSale, preview.s.confirmationToken);
    expect(lowStockAlerts).not.toHaveBeenCalled();
  });
});
