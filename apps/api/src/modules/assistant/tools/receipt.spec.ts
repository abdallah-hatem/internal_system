import { randomUUID } from 'node:crypto';
import { Logger, type Type } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
// The fake database fails a unique index with Prisma's own error class.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- the test fakes a P2002 from the database
import { Prisma } from '@prisma/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import type { NotificationsService } from '../../notifications/notifications.service';
import { ProductsService } from '../../products/products.service';
import { PurchasesService } from '../../purchases/purchases.service';
import { SuppliersService } from '../../suppliers/suppliers.service';
import { AssistantServer } from '../assistant-server';
import { ConfirmationService } from '../confirmation.service';
import type { AssistantUser } from '../tool-kit';

/**
 * The receipt tools, driven through a real McpServer and the SDK's client —
 * the path Claude takes — against the real purchases, suppliers and products
 * services. Only the database is fake: an in-memory one that keeps unique
 * indexes and rolls a transaction back when it throws, because atomicity and
 * "a preview writes nothing" are exactly what is under test, and a mock that
 * only records calls could not show either.
 */

// ── An in-memory database with transactions ──────────────────────────────

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

const TABLES = [
  'importCycle',
  'supplier',
  'product',
  'category',
  'purchaseOrder',
  'purchaseOrderItem',
  'auditLog',
  'cycleParticipant',
  'currencyRate',
  'usedNonce',
] as const;

/** relation name → [table, foreign key on this row] */
const RELATIONS: Record<string, Record<string, [string, string]>> = {
  purchaseOrder: {
    cycle: ['importCycle', 'cycleId'],
    supplier: ['supplier', 'supplierId'],
  },
  product: { category: ['category', 'categoryId'] },
};

/** Unique indexes, as the schema declares them. NULLs never collide. */
const UNIQUE: Record<string, string[][]> = {
  product: [['sku']],
  category: [['name']],
  importCycle: [['code']],
  purchaseOrder: [['supplierId', 'supplierInvoiceRef']],
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
  tables: Tables = Object.fromEntries(TABLES.map((t) => [t, []]));

  constructor() {
    for (const t of TABLES) {
      (this as unknown as Record<string, unknown>)[t] = this.model(t);
    }
  }

  counts(): Record<string, number> {
    return Object.fromEntries(TABLES.map((t) => [t, this.tables[t].length]));
  }

  insert(table: string, row: Row): Row {
    const full: Row = { id: randomUUID(), createdAt: new Date(), ...row };
    for (const cols of UNIQUE[table] ?? []) {
      if (cols.some((c) => full[c] === null || full[c] === undefined)) continue;
      if (this.tables[table].some((r) => cols.every((c) => r[c] === full[c])))
        throw p2002(cols);
    }
    this.tables[table].push(full);
    return full;
  }

  async $transaction<T>(
    work: (tx: FakeDb) => Promise<T>,
    _options?: unknown,
  ): Promise<T> {
    // Rows are replaced, never mutated, so copying the arrays is a snapshot.
    const before = Object.fromEntries(
      Object.entries(this.tables).map(([t, rows]) => [t, rows.slice()]),
    );
    try {
      return await work(this);
    } catch (err) {
      this.tables = before;
      throw err;
    }
  }

  private matches(table: string, row: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([key, cond]) => {
      const rel = RELATIONS[table]?.[key];
      if (rel) {
        const other = this.tables[rel[0]].find((r) => r.id === row[rel[1]]);
        return !!other && this.matches(rel[0], other, cond as Row);
      }
      const value = row[key];
      if (cond === null || typeof cond !== 'object' || cond instanceof Date)
        return value === cond;
      const c = cond as Row;
      if ('in' in c) return (c.in as unknown[]).includes(value);
      if ('startsWith' in c)
        return (
          typeof value === 'string' && value.startsWith(String(c.startsWith))
        );
      if ('not' in c) return value !== c.not && value !== undefined;
      if ('equals' in c)
        return c.mode === 'insensitive'
          ? String(value).toLowerCase() === String(c.equals).toLowerCase()
          : value === c.equals;
      throw new Error(`fake db: unsupported filter ${JSON.stringify(cond)}`);
    });
  }

  private shape(table: string, row: Row, args: Row): Row {
    const pick = (args.select ?? args.include) as Row | undefined;
    if (!pick) return { ...row };
    const out: Row = args.include ? { ...row } : {};
    for (const [key, spec] of Object.entries(pick)) {
      const rel = RELATIONS[table]?.[key];
      if (rel) {
        const other = this.tables[rel[0]].find((r) => r.id === row[rel[1]]);
        out[key] = other
          ? spec === true
            ? { ...other }
            : this.shape(rel[0], other, spec as Row)
          : null;
      } else if (spec) {
        out[key] = row[key];
      }
    }
    return out;
  }

  private model(table: string) {
    const all = (args: Row = {}) => {
      let rows = this.tables[table].filter((r) =>
        this.matches(table, r, args.where as Row),
      );
      const order = args.orderBy as Record<string, 'asc' | 'desc'> | undefined;
      if (order) {
        const [[field, dir]] = Object.entries(order);
        rows = rows.slice().sort((a, b) => {
          const x = String(a[field]);
          const y = String(b[field]);
          return (x < y ? -1 : x > y ? 1 : 0) * (dir === 'desc' ? -1 : 1);
        });
      }
      return rows;
    };
    return {
      findUnique: (args: Row) => {
        const row = all(args)[0];
        return Promise.resolve(row ? this.shape(table, row, args) : null);
      },
      findFirst: (args: Row = {}) => {
        const row = all(args)[0];
        return Promise.resolve(row ? this.shape(table, row, args) : null);
      },
      findMany: (args: Row = {}) =>
        Promise.resolve(all(args).map((r) => this.shape(table, r, args))),
      count: (args: Row = {}) => Promise.resolve(all(args).length),
      create: (args: Row) => {
        try {
          const row = this.insert(table, args.data as Row);
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
        if (i < 0) return Promise.reject(new Error('fake db: no row'));
        rows[i] = { ...rows[i], ...(args.data as Row) };
        return Promise.resolve({ ...rows[i] });
      },
    };
  }
}

// ── The world a receipt arrives in ────────────────────────────────────────

const partner: AssistantUser = {
  id: randomUUID(),
  email: 'omar@motoparts.test',
  role: 'CORE_PARTNER',
  partner: null,
};

const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Africa/Cairo',
}).format(new Date());
const nextWeek = new Date(Date.now() + 7 * 86_400_000)
  .toISOString()
  .slice(0, 10);

let db: FakeDb;
let notify: jest.Mock;
let client: Client;
let ids: {
  cycle: string;
  shippedCycle: string;
  supplier: string;
  otherSupplier: string;
  brakePad: string;
  chain: string;
  category: string;
  draft: string;
  confirmed: string;
};

function seed() {
  const cycle = db.insert('importCycle', {
    code: 'C-2026-01',
    status: 'PURCHASING',
    originType: 'CHINA',
    currency: 'CNY',
  });
  const shipped = db.insert('importCycle', {
    code: 'C-2025-09',
    status: 'IN_TRANSIT',
    originType: 'CHINA',
    currency: 'CNY',
  });
  const supplier = db.insert('supplier', {
    name: 'Yiwu Parts',
    country: 'China',
  });
  const other = db.insert('supplier', {
    name: 'Dubai Moto Trading',
    country: 'UAE',
  });
  const category = db.insert('category', { name: 'Brakes' });
  const brakePad = db.insert('product', {
    sku: 'BP-100',
    name: 'Brake pad',
    status: 'ACTIVE',
  });
  const chain = db.insert('product', {
    sku: 'PRD-000007',
    name: 'Drive chain',
    status: 'ACTIVE',
  });
  const draft = db.insert('purchaseOrder', {
    cycleId: cycle.id,
    supplierId: supplier.id,
    reference: 'PO-2026-0001',
    currency: 'CNY',
    fxRateToEgp: 7,
    orderedOn: new Date('2026-09-01'),
    status: 'DRAFT',
    supplierInvoiceRef: null,
  });
  db.insert('purchaseOrderItem', {
    purchaseOrderId: draft.id,
    productId: brakePad.id,
    orderedQty: 10,
    unitPrice: 5,
    discount: 0,
    lineTotal: new Prisma.Decimal(50),
  });
  const confirmed = db.insert('purchaseOrder', {
    cycleId: shipped.id,
    supplierId: supplier.id,
    reference: 'PO-2025-0044',
    currency: 'CNY',
    fxRateToEgp: 7,
    orderedOn: new Date('2025-09-01'),
    status: 'CONFIRMED',
    supplierInvoiceRef: 'INV-OLD',
  });
  db.insert('cycleParticipant', {
    cycleId: cycle.id,
    partnerUserId: partner.id,
    investorUserId: null,
  });
  db.insert('currencyRate', { code: 'CNY', rateToEgp: 7.1 });
  ids = {
    cycle: cycle.id as string,
    shippedCycle: shipped.id as string,
    supplier: supplier.id as string,
    otherSupplier: other.id as string,
    brakePad: brakePad.id as string,
    chain: chain.id as string,
    category: category.id as string,
    draft: draft.id as string,
    confirmed: confirmed.id as string,
  };
}

beforeEach(async () => {
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  db = new FakeDb();
  seed();
  const prisma = db as unknown as PrismaService;
  const audit = new AuditService(prisma);
  notify = jest.fn().mockResolvedValue(undefined);
  const notifications = {
    createForMultipleUsers: notify,
  } as unknown as NotificationsService;
  const registry = new Map<unknown, unknown>([
    [PrismaService, prisma],
    [AuditService, audit],
    [PurchasesService, new PurchasesService(prisma, audit, notifications)],
    [SuppliersService, new SuppliersService(prisma, audit)],
    [ProductsService, new ProductsService(prisma, audit, notifications)],
  ]);
  const moduleRef = {
    get: (type: Type<unknown>) => registry.get(type),
  } as unknown as ModuleRef;
  const assistant = new AssistantServer(
    new ConfirmationService(
      new JwtService({ secret: 'a-test-secret-that-is-long-enough' }),
      prisma,
    ),
    moduleRef,
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

// ── Calling the tools ─────────────────────────────────────────────────────

interface Structured {
  status?: string;
  confirmationToken?: string;
  data?: Record<string, unknown> & {
    lines?: Array<Record<string, unknown>>;
    questions?: Array<{ kind: string }>;
    findings?: { cycles: { open: Array<{ code: string }> } };
  };
  error?: { code: string; message: string; params?: Record<string, unknown> };
}

async function call(
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult & { s: Structured; text: string }> {
  const r = (await client.callTool({
    name,
    arguments: args,
  })) as CallToolResult;
  return {
    ...r,
    s: r.structuredContent ?? {},
    text: (r.content[0] as { text: string }).text,
  };
}

/** Preview, then commit the same arguments with the token it gave. */
async function confirmed(name: string, args: Record<string, unknown>) {
  const preview = await call(name, args);
  expect(preview.s.error).toBeUndefined();
  expect(preview.s.status).toBe('preview');
  return call(name, {
    ...args,
    confirmationToken: preview.s.confirmationToken,
  });
}

const codeOf = (r: { s: Structured }) => r.s.error?.code;

/** Row counts without the confirmation nonces, which a commit spends by design. */
function businessCounts() {
  const { usedNonce: _spent, ...rest } = db.counts();
  return rest;
}

function order(overrides: Record<string, unknown> = {}) {
  return {
    cycleId: ids.cycle,
    supplier: { new: { name: 'Guangzhou Brake Co.', country: 'China' } },
    currency: 'CNY',
    fxRateToEgp: 7,
    orderedOn: today,
    supplierInvoiceRef: 'gz-001',
    lines: [
      {
        product: { new: { name: 'Disc rotor 220mm', sku: 'DR-220' } },
        quantity: 20,
        unitPrice: 30,
        discountPercent: 5,
      },
      {
        product: { new: { name: 'Caliper front' } },
        quantity: 4,
        unitPrice: 55.5,
      },
    ],
    ...overrides,
  };
}

const existingLine = (over: Record<string, unknown> = {}) => ({
  product: { id: ids.brakePad },
  quantity: 10,
  unitPrice: 5,
  ...over,
});

// ── create_purchase_order ────────────────────────────────────────────────

describe('create_purchase_order', () => {
  it('preview → row counts unchanged (invariant §16)', async () => {
    const before = db.counts();

    const r = await call('create_purchase_order', order());

    expect(r.s.error).toBeUndefined();
    expect(r.s.status).toBe('preview');
    expect(r.text).toContain('NEW supplier');
    expect(r.text).toContain('Disc rotor 220mm (NEW product, SKU DR-220)');
    expect(r.text).toContain(
      'Caliper front (NEW product, SKU generated when saved)',
    );
    // 20 × 30 less 5% = 570, plus 4 × 55.50 = 222 → 792 CNY = 5,544 EGP
    expect(r.text).toContain('Total: 792.00 CNY = 5,544.00 EGP');
    expect(r.s.data).toMatchObject({
      reference: null,
      supplier: { id: null, name: 'Guangzhou Brake Co.', created: true },
    });
    expect(db.counts()).toEqual(before);
    expect(notify).not.toHaveBeenCalled();
  });

  it('commit with a new supplier and two new products → all created together', async () => {
    const before = businessCounts();

    const r = await confirmed('create_purchase_order', order());

    expect(r.s.error).toBeUndefined();
    expect(r.s.status).toBe('committed');
    expect(businessCounts()).toEqual({
      ...before,
      supplier: before.supplier + 1,
      product: before.product + 2,
      purchaseOrder: before.purchaseOrder + 1,
      purchaseOrderItem: before.purchaseOrderItem + 2,
      auditLog: before.auditLog + 4,
    });
    const supplier = db.tables.supplier.find(
      (s) => s.name === 'Guangzhou Brake Co.',
    )!;
    const po = db.tables.purchaseOrder.find(
      (p) => p.supplierId === supplier.id,
    )!;
    expect(po).toMatchObject({
      cycleId: ids.cycle,
      status: 'DRAFT',
      supplierInvoiceRef: 'GZ-001',
      currency: 'CNY',
    });
    const items = db.tables.purchaseOrderItem.filter(
      (i) => i.purchaseOrderId === po.id,
    );
    const names = items.map(
      (i) => db.tables.product.find((p) => p.id === i.productId)!.name,
    );
    expect(names).toEqual(['Disc rotor 220mm', 'Caliper front']);
    expect(items.map((i) => String(i.lineTotal))).toEqual(['570', '222']);
    expect(
      db.tables.product.find((p) => p.name === 'Disc rotor 220mm')!.sku,
    ).toBe('DR-220');
    expect(r.text).toContain(`Created purchase order ${String(po.reference)}`);
    // Told only once it was real.
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('a line fails at commit → no supplier or product left behind (atomic)', async () => {
    const preview = await call('create_purchase_order', order());
    expect(preview.s.status).toBe('preview');

    // Between the preview and the "yes", the office app records a product
    // under the first line's SKU. At commit the new supplier is created first,
    // then that line fails — mid-transaction.
    db.insert('product', {
      sku: 'dr 220',
      name: 'Rotor (office)',
      status: 'ACTIVE',
    });
    const before = businessCounts();

    const r = await call('create_purchase_order', {
      ...order(),
      confirmationToken: preview.s.confirmationToken,
    });

    expect(codeOf(r)).toBe('PRODUCT_SKU_TAKEN');
    expect(businessCounts()).toEqual(before);
    expect(
      db.tables.supplier.some((s) => s.name === 'Guangzhou Brake Co.'),
    ).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it('a later line the service refuses → refused at preview, nothing written', async () => {
    const args = order({
      lines: [
        ...order().lines,
        existingLine({ quantity: 0 }), // refused only once the order is checked
      ],
    });
    const before = businessCounts();

    const r = await call('create_purchase_order', args);

    expect(codeOf(r)).toBe('QTY_NOT_POSITIVE');
    expect(businessCounts()).toEqual(before);
  });

  it('the invoice recorded by someone else between preview and commit → refused, nothing written (§15)', async () => {
    const args = order({
      supplier: { id: ids.supplier },
      supplierInvoiceRef: 'INV-778',
    });
    const preview = await call('create_purchase_order', args);
    expect(preview.s.status).toBe('preview');

    // A second partner records the same receipt from the office app.
    db.insert('purchaseOrder', {
      cycleId: ids.cycle,
      supplierId: ids.supplier,
      reference: 'PO-2026-0099',
      currency: 'CNY',
      fxRateToEgp: 7,
      orderedOn: new Date(),
      status: 'DRAFT',
      supplierInvoiceRef: 'INV-778',
    });
    const before = businessCounts();

    const r = await call('create_purchase_order', {
      ...args,
      confirmationToken: preview.s.confirmationToken,
    });

    expect(codeOf(r)).toBe('DUPLICATE_SUPPLIER_INVOICE');
    expect(r.s.error?.params).toMatchObject({
      ref: 'INV-778',
      supplier: 'Yiwu Parts',
      purchaseOrder: 'PO-2026-0099',
    });
    expect(businessCounts()).toEqual(before);
  });

  it('two sends racing past the invoice check → the index stops the second, as the same refusal', async () => {
    const args = order({
      supplier: { id: ids.supplier },
      supplierInvoiceRef: 'INV-RACE',
    });
    const preview = await call('create_purchase_order', args);
    // The other send is recorded in the gap between this one's check and its
    // write: the check saw nothing, and only the unique index sees both.
    db.insert('purchaseOrder', {
      cycleId: ids.cycle,
      supplierId: ids.supplier,
      reference: 'PO-2026-0100',
      currency: 'CNY',
      fxRateToEgp: 7,
      orderedOn: new Date(),
      status: 'DRAFT',
      supplierInvoiceRef: 'INV-RACE',
    });
    const checkSawNothing = jest
      .spyOn(PurchasesService.prototype, 'assertInvoiceNotRecorded')
      .mockResolvedValueOnce('INV-RACE');
    const before = businessCounts();

    const r = await call('create_purchase_order', {
      ...args,
      confirmationToken: preview.s.confirmationToken,
    });

    expect(checkSawNothing).toHaveBeenCalled();
    expect(codeOf(r)).toBe('DUPLICATE_SUPPLIER_INVOICE');
    expect(r.s.error?.params).toMatchObject({ purchaseOrder: 'PO-2026-0100' });
    expect(businessCounts()).toEqual(before);
  });

  it("cycle past PURCHASING → the service's refusal, surfaced", async () => {
    const r = await call(
      'create_purchase_order',
      order({ cycleId: ids.shippedCycle }),
    );

    expect(codeOf(r)).toBe('CYCLE_STATUS_BLOCKS_PO');
    expect(r.s.error?.params).toEqual({ status: 'IN_TRANSIT' });
    expect(r.isError).toBe(true);
  });

  it('add to an existing draft order → lines appended', async () => {
    const before = businessCounts();

    const r = await confirmed('create_purchase_order', {
      addToOrderId: ids.draft,
      supplier: { id: ids.supplier },
      currency: 'cny',
      supplierInvoiceRef: 'INV-555',
      lines: [
        { product: { id: ids.chain }, quantity: 2, unitPrice: 40 },
        {
          product: { new: { name: 'Clutch lever' } },
          quantity: 5,
          unitPrice: 3,
        },
      ],
    });

    expect(r.s.error).toBeUndefined();
    expect(businessCounts()).toMatchObject({
      purchaseOrder: before.purchaseOrder,
      purchaseOrderItem: before.purchaseOrderItem + 2,
      product: before.product + 1,
    });
    const items = db.tables.purchaseOrderItem.filter(
      (i) => i.purchaseOrderId === ids.draft,
    );
    expect(items).toHaveLength(3);
    // The draft now carries this receipt's number, so it cannot be added again.
    expect(
      db.tables.purchaseOrder.find((p) => p.id === ids.draft)!
        .supplierInvoiceRef,
    ).toBe('INV-555');
    // 50 already on it + 80 + 15
    expect(r.text).toContain('Order total after: 145.00 CNY = 1,015.00 EGP');
  });

  it('add to a confirmed order → PO_NOT_DRAFT (§15)', async () => {
    const before = businessCounts();

    const r = await call('create_purchase_order', {
      addToOrderId: ids.confirmed,
      supplier: { id: ids.supplier },
      currency: 'CNY',
      lines: [existingLine()],
    });

    expect(codeOf(r)).toBe('PO_NOT_DRAFT');
    expect(businessCounts()).toEqual(before);
  });

  it('the same receipt added to a draft twice → the second is DUPLICATE_SUPPLIER_INVOICE', async () => {
    const args = {
      addToOrderId: ids.draft,
      supplier: { id: ids.supplier },
      currency: 'CNY',
      supplierInvoiceRef: 'INV-555',
      lines: [existingLine()],
    };
    expect(
      (await confirmed('create_purchase_order', args)).s.error,
    ).toBeUndefined();

    const again = await call('create_purchase_order', args);

    expect(codeOf(again)).toBe('DUPLICATE_SUPPLIER_INVOICE');
  });

  it("add to another supplier's draft → PO_SUPPLIER_MISMATCH", async () => {
    const r = await call('create_purchase_order', {
      addToOrderId: ids.draft,
      supplier: { id: ids.otherSupplier },
      currency: 'CNY',
      lines: [existingLine()],
    });

    expect(codeOf(r)).toBe('PO_SUPPLIER_MISMATCH');
  });

  it('add to a draft in another currency or at another rate → PO_TERMS_MISMATCH', async () => {
    const base = {
      addToOrderId: ids.draft,
      supplier: { id: ids.supplier },
      lines: [existingLine()],
    };

    const currency = await call('create_purchase_order', {
      ...base,
      currency: 'AED',
    });
    const rate = await call('create_purchase_order', {
      ...base,
      currency: 'CNY',
      fxRateToEgp: 7.5,
    });

    expect(codeOf(currency)).toBe('PO_TERMS_MISMATCH');
    expect(codeOf(rate)).toBe('PO_TERMS_MISMATCH');
  });

  it('add a second invoice to a draft that already records one → PO_HAS_OTHER_INVOICE', async () => {
    db.tables.purchaseOrder = db.tables.purchaseOrder.map((p) =>
      p.id === ids.draft ? { ...p, supplierInvoiceRef: 'INV-FIRST' } : p,
    );

    const r = await call('create_purchase_order', {
      addToOrderId: ids.draft,
      supplier: { id: ids.supplier },
      currency: 'CNY',
      supplierInvoiceRef: 'INV-SECOND',
      lines: [existingLine()],
    });

    expect(codeOf(r)).toBe('PO_HAS_OTHER_INVOICE');
  });

  it('a draft stranded on a cycle past PURCHASING takes no lines', async () => {
    db.tables.purchaseOrder = db.tables.purchaseOrder.map((p) =>
      p.id === ids.draft ? { ...p, cycleId: ids.shippedCycle } : p,
    );

    const r = await call('create_purchase_order', {
      addToOrderId: ids.draft,
      supplier: { id: ids.supplier },
      currency: 'CNY',
      lines: [existingLine()],
    });

    expect(codeOf(r)).toBe('CYCLE_STATUS_BLOCKS_PO');
  });

  it('both a cycle and a draft, or neither → VALIDATION_FAILED', async () => {
    const both = await call(
      'create_purchase_order',
      order({ addToOrderId: ids.draft }),
    );
    const neither = await call(
      'create_purchase_order',
      order({ cycleId: undefined }),
    );

    expect(codeOf(both)).toBe('VALIDATION_FAILED');
    expect(codeOf(neither)).toBe('VALIDATION_FAILED');
  });

  it('orderedOn in the future → refused', async () => {
    const before = businessCounts();

    const r = await call(
      'create_purchase_order',
      order({ orderedOn: nextWeek }),
    );

    expect(codeOf(r)).toBe('DATE_IN_FUTURE');
    expect(businessCounts()).toEqual(before);
  });

  it('FX rate zero or negative → refused (money)', async () => {
    const zero = await call('create_purchase_order', order({ fxRateToEgp: 0 }));
    const negative = await call(
      'create_purchase_order',
      order({ fxRateToEgp: -7 }),
    );

    expect(codeOf(zero)).toBe('RATE_NOT_POSITIVE');
    expect(codeOf(negative)).toBe('RATE_NOT_POSITIVE');
  });

  it('a line discount making the line negative → refused (money)', async () => {
    const over = await call(
      'create_purchase_order',
      order({ lines: [existingLine({ discountPercent: 150 })] }),
    );
    const negative = await call(
      'create_purchase_order',
      order({ lines: [existingLine({ discountPercent: -10 })] }),
    );
    const whole = await call(
      'create_purchase_order',
      order({ lines: [existingLine({ discountPercent: 100 })] }),
    );

    expect(codeOf(over)).toBe('DISCOUNT_PERCENT_INVALID');
    expect(codeOf(negative)).toBe('DISCOUNT_PERCENT_INVALID');
    expect(whole.s.error).toBeUndefined();
  });

  it('unit price zero → accepted (free goods); negative → refused (money)', async () => {
    const free = await confirmed(
      'create_purchase_order',
      order({ lines: [existingLine({ unitPrice: 0 })] }),
    );
    const negative = await call(
      'create_purchase_order',
      order({
        supplierInvoiceRef: 'gz-002',
        supplier: { id: ids.supplier },
        lines: [existingLine({ unitPrice: -1 })],
      }),
    );

    expect(free.s.error).toBeUndefined();
    expect(free.s.status).toBe('committed');
    expect(codeOf(negative)).toBe('PRICE_NEGATIVE');
  });

  it('the audit log names the signed-in partner (§16: attribution)', async () => {
    await confirmed('create_purchase_order', order());

    const entries = db.tables.auditLog;
    expect(entries.map((e) => e.entityType).sort()).toEqual([
      'Product',
      'Product',
      'PurchaseOrder',
      'Supplier',
    ]);
    expect(entries.every((e) => e.actorUserId === partner.id)).toBe(true);
  });

  it('quantity 0 or negative → QTY_NOT_POSITIVE', async () => {
    const zero = await call(
      'create_purchase_order',
      order({ lines: [existingLine({ quantity: 0 })] }),
    );
    const negative = await call(
      'create_purchase_order',
      order({ lines: [existingLine({ quantity: -3 })] }),
    );

    expect(codeOf(zero)).toBe('QTY_NOT_POSITIVE');
    expect(codeOf(negative)).toBe('QTY_NOT_POSITIVE');
  });

  it('a product, supplier or cycle id that belongs to nothing → a coded 404, never a 500', async () => {
    const product = await call(
      'create_purchase_order',
      order({ lines: [existingLine({ product: { id: randomUUID() } })] }),
    );
    const supplier = await call(
      'create_purchase_order',
      order({ supplier: { id: randomUUID() } }),
    );
    const cycle = await call(
      'create_purchase_order',
      order({ cycleId: randomUUID() }),
    );
    const draft = await call('create_purchase_order', {
      addToOrderId: randomUUID(),
      supplier: { id: ids.supplier },
      currency: 'CNY',
      lines: [existingLine()],
    });

    expect(product.s.error).toMatchObject({
      code: 'NOT_FOUND',
      params: { entity: 'product' },
    });
    expect(supplier.s.error).toMatchObject({
      code: 'NOT_FOUND',
      params: { entity: 'supplier' },
    });
    expect(cycle.s.error).toMatchObject({
      code: 'NOT_FOUND',
      params: { entity: 'cycle' },
    });
    expect(draft.s.error).toMatchObject({
      code: 'NOT_FOUND',
      params: { entity: 'purchaseOrder' },
    });
  });

  it('the same new product named twice in one order → NEW_PRODUCT_REPEATED', async () => {
    const byName = await call(
      'create_purchase_order',
      order({
        lines: [
          {
            product: { new: { name: 'Brake lever' } },
            quantity: 1,
            unitPrice: 2,
          },
          {
            product: { new: { name: 'BRAKE  lever' } },
            quantity: 1,
            unitPrice: 3,
          },
        ],
      }),
    );
    const bySku = await call(
      'create_purchase_order',
      order({
        lines: [
          {
            product: { new: { name: 'Lever L', sku: 'LV-1' } },
            quantity: 1,
            unitPrice: 2,
          },
          {
            product: { new: { name: 'Lever R', sku: 'lv 1' } },
            quantity: 1,
            unitPrice: 2,
          },
        ],
      }),
    );

    expect(codeOf(byName)).toBe('NEW_PRODUCT_REPEATED');
    expect(codeOf(bySku)).toBe('NEW_PRODUCT_REPEATED');
  });

  it('a preview then a commit with a changed line → CONFIRMATION_MISMATCH, nothing written', async () => {
    const preview = await call('create_purchase_order', order());
    const before = businessCounts();
    const changed = order();
    changed.lines[1] = { ...changed.lines[1], quantity: 40 };

    const r = await call('create_purchase_order', {
      ...changed,
      confirmationToken: preview.s.confirmationToken,
    });

    expect(codeOf(r)).toBe('CONFIRMATION_MISMATCH');
    expect(businessCounts()).toEqual(before);
  });

  it('one confirmation used twice → CONFIRMATION_USED, one order', async () => {
    const preview = await call('create_purchase_order', order());
    const args = { ...order(), confirmationToken: preview.s.confirmationToken };

    const first = await call('create_purchase_order', args);
    const before = businessCounts();
    const second = await call('create_purchase_order', args);

    expect(first.s.status).toBe('committed');
    expect(codeOf(second)).toBe('CONFIRMATION_USED');
    expect(businessCounts()).toEqual(before);
  });
});

// ── create_supplier, create_product ───────────────────────────────────────

describe('create_supplier', () => {
  it('with an existing name, any case → refused, naming the existing one', async () => {
    const before = businessCounts();

    const r = await call('create_supplier', {
      name: 'YIWU parts Co., Ltd.',
      country: 'China',
    });

    expect(codeOf(r)).toBe('SUPPLIER_NAME_TAKEN');
    expect(r.s.error?.params).toEqual({ name: 'Yiwu Parts' });
    expect(businessCounts()).toEqual(before);
  });

  it('a new name → previewed, then created under the signed-in partner', async () => {
    const before = businessCounts();
    const preview = await call('create_supplier', {
      name: 'Ningbo Moto',
      country: 'China',
    });
    expect(businessCounts()).toEqual(before);

    const r = await call('create_supplier', {
      name: 'Ningbo Moto',
      country: 'China',
      confirmationToken: preview.s.confirmationToken,
    });

    expect(r.s.status).toBe('committed');
    const created = db.tables.supplier.find((s) => s.name === 'Ningbo Moto')!;
    expect(r.s.data).toMatchObject({ id: created.id });
    expect(db.tables.auditLog).toEqual([
      expect.objectContaining({
        entityId: created.id,
        actorUserId: partner.id,
      }),
    ]);
  });

  it('a name with no letter or digit is not a name', async () => {
    const r = await call('create_supplier', { name: ' — ', country: 'China' });
    expect(r.isError).toBe(true);
    expect(db.tables.supplier).toHaveLength(2);
  });
});

describe('create_product', () => {
  it('with an existing SKU → refused', async () => {
    const r = await call('create_product', {
      name: 'Brake pad (copy)',
      sku: 'bp 100',
    });

    expect(codeOf(r)).toBe('PRODUCT_SKU_TAKEN');
    expect(r.s.error?.params).toMatchObject({ product: 'Brake pad' });
  });

  it('a printed SKU is kept; none given → one is generated at commit', async () => {
    const printed = await confirmed('create_product', {
      name: 'Mirror',
      sku: 'MR-9',
    });
    const generated = await confirmed('create_product', { name: 'Grip' });

    expect(printed.s.data).toMatchObject({ sku: 'MR-9' });
    expect(generated.s.data).toMatchObject({ sku: 'PRD-000008' });
  });

  it('a category id that is no category → NOT_FOUND, not a 500', async () => {
    const r = await call('create_product', {
      name: 'Pad',
      categoryId: randomUUID(),
    });
    const ok = await call('create_product', {
      name: 'Pad',
      categoryId: ids.category,
    });

    expect(r.s.error).toMatchObject({
      code: 'NOT_FOUND',
      params: { entity: 'category' },
    });
    expect(ok.s.error).toBeUndefined();
  });
});

// ── match_receipt ─────────────────────────────────────────────────────────

describe('match_receipt', () => {
  const receipt = {
    supplierName: 'Yiwu Parts Co., Ltd.',
    invoiceNumber: 'inv-old',
    date: today,
    currency: 'CNY',
    lines: [
      { description: 'Brake pad', sku: 'BP-100', quantity: 10, unitPrice: 5 },
    ],
  };

  it('offers only the cycles the purchases service would accept, from one definition', async () => {
    const r = await call('match_receipt', receipt);

    expect(r.s.error).toBeUndefined();
    expect(r.s.data?.findings?.cycles.open.map((c) => c.code)).toEqual([
      'C-2026-01',
    ]);
  });

  it('flags an invoice already recorded, and writes nothing', async () => {
    const before = db.counts();

    const r = await call('match_receipt', receipt);

    expect(r.s.data?.questions?.map((q) => q.kind)).toContain(
      'DUPLICATE_INVOICE',
    );
    expect(r.s.data).toMatchObject({
      supplier: { status: 'matched', match: { id: ids.supplier } },
      findings: { fx: { rate: '7.1', source: 'stored' } },
    });
    expect(db.counts()).toEqual(before);
  });
});
