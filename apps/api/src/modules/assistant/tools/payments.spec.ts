import { randomUUID } from 'node:crypto';
import { Logger, type Type } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
// The fake database keeps money as Prisma decimals, as the real one does.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- the test fakes Prisma's own value types
import { Prisma } from '@prisma/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { businessToday } from '../../../common/dates';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { PaymentsService } from '../../payments/payments.service';
import { AssistantServer } from '../assistant-server';
import { ConfirmationService } from '../confirmation.service';
import type { AssistantUser } from '../tool-kit';

/**
 * record_payment (BUSINESS_LOGIC §16, owner 2026-10-11), driven through a real
 * McpServer and the SDK's client — the path Claude takes — against the real
 * PaymentsService the office app's Record payment calls. Only the database is
 * fake: in memory, rolling a transaction back when it throws, because "a
 * preview writes nothing" is under test.
 *
 * Beyond the happy path (CLAUDE.md §0): too much, a future day, zero and
 * negative, a name that is close or unknown, another shop's order, an
 * unverified shop, the same token twice, a payment that arrives between the
 * preview and the yes, and a role the office endpoint refuses.
 */

type Row = Record<string, unknown>;
const D = (v: unknown) => new Prisma.Decimal(v as Prisma.Decimal.Value);

const TABLES = [
  'customer',
  'saleOrder',
  'payment',
  'paymentAllocation',
  'financialTransaction',
  'auditLog',
  'usedNonce',
] as const;
type Table = (typeof TABLES)[number];

const RELATIONS: Record<
  string,
  Record<string, [Table, string, 'many' | 'one']>
> = {
  payment: { allocations: ['paymentAllocation', 'paymentId', 'many'] },
  paymentAllocation: { saleOrder: ['saleOrder', 'saleOrderId', 'one'] },
};

const sortable = (v: unknown) =>
  v instanceof Date ? v.getTime() : typeof v === 'string' ? v : Number(v);

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
    this.tables[table].push(full);
    return full;
  }

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

  private matches(row: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([key, cond]) => {
      const value = row[key];
      if (cond === null || typeof cond !== 'object' || cond instanceof Date)
        return value === cond;
      const c = cond as Row;
      if ('in' in c) return (c.in as unknown[]).includes(value);
      if ('gt' in c) return D(value ?? 0).gt(D(c.gt));
      if ('not' in c) return value !== c.not;
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
      if (v && typeof v === 'object' && 'increment' in v) {
        next[k] = D(row[k]).add(D((v as Row).increment));
      } else {
        next[k] = v;
      }
    }
    return next;
  }

  private model(table: Table) {
    const all = (args: Row = {}) => {
      const rows = this.tables[table].filter((r) =>
        this.matches(r, args.where as Row),
      );
      const orderBy = args.orderBy as Row | Row[] | undefined;
      const keys = (
        Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []
      ).map((o) => Object.entries(o)[0]);
      return rows.slice().sort((a, b) => {
        for (const [field, dir] of keys) {
          const x = sortable(a[field]);
          const y = sortable(b[field]);
          if (x !== y) return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1);
        }
        return 0;
      });
    };
    const one = (args: Row) => {
      const row = all(args)[0];
      return Promise.resolve(row ? this.shape(table, row, args) : null);
    };
    return {
      findUnique: one,
      findFirst: one,
      findFirstOrThrow: async (args: Row) => {
        const row = await one(args);
        if (!row) throw new Error(`fake db: no ${table}`);
        return row;
      },
      findMany: (args: Row = {}) =>
        Promise.resolve(all(args).map((r) => this.shape(table, r, args))),
      create: (args: Row) =>
        Promise.resolve(
          this.shape(table, this.insert(table, args.data as Row), args),
        ),
      update: (args: Row) => {
        const rows = this.tables[table];
        const i = rows.findIndex((r) => this.matches(r, args.where as Row));
        if (i < 0) return Promise.reject(new Error(`fake db: no ${table}`));
        rows[i] = this.apply(rows[i], args.data as Row);
        return Promise.resolve(this.shape(table, rows[i], args));
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

// ── The shops ─────────────────────────────────────────────────────────────

const partner: AssistantUser = {
  id: randomUUID(),
  email: 'omar@motoparts.test',
  role: 'CORE_PARTNER',
  partner: null,
};

let db: FakeDb;
let client: Client;
let assistant: AssistantServer;
let ids: {
  sayed: string;
  sayedOld: string;
  sayedNew: string;
  sayedDraft: string;
  other: string;
  otherOrder: string;
  unverified: string;
};

function seed() {
  const customer = (displayName: string, extra: Row = {}) =>
    db.insert('customer', {
      displayName,
      type: 'B2B',
      verificationStatus: 'VERIFIED',
      isWalkIn: false,
      ...extra,
    }).id as string;
  const order = (
    customerId: string,
    orderNo: string,
    total: number,
    createdAt: string,
    status = 'CONFIRMED',
  ) =>
    db.insert('saleOrder', {
      customerId,
      orderNo,
      status,
      currency: 'EGP',
      total: D(total),
      outstanding: D(total),
      createdAt: new Date(createdAt),
      // The day it was sold defaults to when it was written (§4, 2026-10-16).
      orderedAt: new Date(createdAt),
    }).id as string;

  const sayed = customer('El-Sayed Motors');
  customer('El-Sayed Spare Parts');
  const other = customer('Nasr City Motors');
  const unverified = customer('Heliopolis Bikes', {
    verificationStatus: 'UNVERIFIED',
  });
  customer('Walk-in', { type: 'B2C', isWalkIn: true });

  // Created out of order on purpose: oldest first means by date, not by row.
  const sayedNew = order(sayed, 'SO-2026-0003', 4000, '2026-09-20T10:00:00Z');
  const sayedOld = order(sayed, 'SO-2026-0001', 3000, '2026-09-01T10:00:00Z');
  // A draft owes nothing (§4, §7a): never paid against.
  const sayedDraft = order(
    sayed,
    'SO-2026-0004',
    9000,
    '2026-08-01T10:00:00Z',
    'DRAFT',
  );
  const otherOrder = order(other, 'SO-2026-0002', 2500, '2026-09-05T10:00:00Z');
  order(unverified, 'SO-2026-0005', 1000, '2026-09-05T10:00:00Z');
  ids = {
    sayed,
    sayedOld,
    sayedNew,
    sayedDraft,
    other,
    otherOrder,
    unverified,
  };
}

async function connectAs(user: AssistantUser) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await assistant.create(user).connect(serverSide);
  const c = new Client({ name: 'test', version: '1.0.0' });
  await c.connect(clientSide);
  return c;
}

beforeEach(async () => {
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  db = new FakeDb();
  seed();
  const prisma = db as unknown as PrismaService;
  const audit = new AuditService(prisma);
  const registry = new Map<unknown, unknown>([
    [PrismaService, prisma],
    [AuditService, audit],
    [PaymentsService, new PaymentsService(prisma, audit)],
  ]);
  assistant = new AssistantServer(
    new ConfirmationService(
      new JwtService({ secret: 'a-test-secret-that-is-long-enough' }),
      prisma,
    ),
    {
      get: (type: Type<unknown>) => registry.get(type),
    } as unknown as ModuleRef,
  );
  client = await connectAs(partner);
});

afterEach(async () => {
  await client.close();
  jest.restoreAllMocks();
});

interface Structured {
  status?: string;
  confirmationToken?: string;
  data?: Record<string, unknown> & {
    allocations?: { orderNo: string; amount: string; owesAfter: string }[];
    questions?: { id: string; options: { value: string; label: string }[] }[];
  };
  error?: { code: string; message: string; params?: Record<string, unknown> };
}

async function call(args: Record<string, unknown>, on = client) {
  const r = (await on.callTool({
    name: 'record_payment',
    arguments: args,
  })) as CallToolResult;
  return {
    ...r,
    s: (r.structuredContent ?? {}) as Structured,
    text: (r.content[0] as { text: string }).text,
  };
}
const codeOf = (r: { s: Structured }) => r.s.error?.code;
const owes = (id: string) =>
  Number(db.tables.saleOrder.find((o) => o.id === id)!.outstanding);

const paid = { customer: 'El-Sayed Motors', amount: 5000, method: 'CASH' };

// ── The happy path, once ──────────────────────────────────────────────────

describe('record_payment — "El-Sayed paid 5,000 cash"', () => {
  it('previews oldest first with the balance before and after, writes nothing, then records exactly that on yes', async () => {
    const before = db.counts();
    const preview = await call(paid);

    expect(preview.s.status).toBe('preview');
    expect(preview.s.data).toMatchObject({
      customer: { id: ids.sayed, name: 'El-Sayed Motors' },
      amount: '5000.00',
      method: 'CASH',
      receivedOn: businessToday(),
      balanceBefore: '7000.00',
      balanceAfter: '2000.00',
      unapplied: '0.00',
    });
    // The September 1st order is cleared before the September 20th one.
    expect(preview.s.data?.allocations).toEqual([
      { orderNo: 'SO-2026-0001', amount: '3000.00', owesAfter: '0.00' },
      { orderNo: 'SO-2026-0003', amount: '2000.00', owesAfter: '2000.00' },
    ]);
    expect(preview.text).toContain(
      'Balance: 7,000.00 EGP before, 2,000.00 EGP after.',
    );
    expect(db.counts()).toEqual(before);
    expect(owes(ids.sayedOld)).toBe(3000);

    const done = await call({
      ...paid,
      confirmationToken: preview.s.confirmationToken,
    });

    expect(done.s.status).toBe('committed');
    expect(db.tables.payment).toHaveLength(1);
    expect(db.tables.payment[0]).toMatchObject({
      customerId: ids.sayed,
      amount: 5000,
      method: 'CASH',
      createdBy: partner.id,
      status: 'RECORDED',
    });
    expect(owes(ids.sayedOld)).toBe(0);
    expect(owes(ids.sayedNew)).toBe(2000);
    expect(owes(ids.sayedDraft)).toBe(9000);
    // Money received reaches the ledger as the office app's payment does (§9).
    expect(db.tables.financialTransaction).toHaveLength(1);
    expect(done.s.data).toMatchObject({ balanceAfter: '2000.00' });
    // Attributed to the partner, as if done in the office app.
    expect(
      db.tables.auditLog.filter((a) => a.entityType === 'Payment'),
    ).toHaveLength(3);
  });
});

// ── Too much, zero, negative, the future ──────────────────────────────────

describe('record_payment — what cannot be recorded (§7a)', () => {
  it('more than the shop owes → PAYMENT_EXCEEDS_OWED in the preview, nothing written', async () => {
    const before = db.counts();
    const r = await call({ ...paid, amount: 7000.01 });
    expect(r.isError).toBe(true);
    expect(codeOf(r)).toBe('PAYMENT_EXCEEDS_OWED');
    expect(r.s.error?.params).toMatchObject({ owed: '7000.00' });
    expect(r.s.confirmationToken).toBeUndefined();
    expect(db.counts()).toEqual(before);
  });

  it('exactly what is owed clears every confirmed order and leaves the draft alone', async () => {
    const preview = await call({ ...paid, amount: 7000 });
    expect(preview.s.data).toMatchObject({ balanceAfter: '0.00' });
    await call({
      ...paid,
      amount: 7000,
      confirmationToken: preview.s.confirmationToken,
    });
    expect(owes(ids.sayedOld)).toBe(0);
    expect(owes(ids.sayedNew)).toBe(0);
    expect(owes(ids.sayedDraft)).toBe(9000);
  });

  it('more than a named order owes → PAYMENT_EXCEEDS_ORDER, even though the shop owes enough', async () => {
    const r = await call({ ...paid, amount: 3500, order: 'SO-2026-0001' });
    expect(codeOf(r)).toBe('PAYMENT_EXCEEDS_ORDER');
    expect(db.tables.payment).toHaveLength(0);
  });

  it.each([0, -50])('an amount of %d → AMOUNT_NOT_POSITIVE', async (amount) => {
    const r = await call({ ...paid, amount });
    expect(codeOf(r)).toBe('AMOUNT_NOT_POSITIVE');
    expect(db.tables.payment).toHaveLength(0);
  });

  it('a fraction of a piastre → VALIDATION_FAILED', async () => {
    const r = await call({ ...paid, amount: 100.005 });
    expect(codeOf(r)).toBe('VALIDATION_FAILED');
  });

  it('a day that has not come yet → DATE_IN_FUTURE; a day that does not exist → BAD_DATE', async () => {
    const tomorrow = new Date(
      Date.parse(`${businessToday()}T00:00:00Z`) + 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    expect(codeOf(await call({ ...paid, receivedOn: tomorrow }))).toBe(
      'DATE_IN_FUTURE',
    );
    expect(codeOf(await call({ ...paid, receivedOn: '2026-02-30' }))).toBe(
      'BAD_DATE',
    );
    expect(db.tables.payment).toHaveLength(0);
  });

  it('a day in the past is kept as given', async () => {
    const args = { ...paid, amount: 100, receivedOn: '2026-10-01' };
    const preview = await call(args);
    expect(preview.s.data).toMatchObject({ receivedOn: '2026-10-01' });
    await call({ ...args, confirmationToken: preview.s.confirmationToken });
    expect(
      (db.tables.payment[0].receivedOn as Date).toISOString().slice(0, 10),
    ).toBe('2026-10-01');
  });

  it('a shop that owes nothing → CUSTOMER_OWES_NOTHING', async () => {
    db.tables.saleOrder = db.tables.saleOrder.map((o) =>
      o.customerId === ids.sayed
        ? { ...o, status: 'PAID', outstanding: D(0) }
        : o,
    );
    expect(codeOf(await call(paid))).toBe('CUSTOMER_OWES_NOTHING');
  });
});

// ── The wrong context ─────────────────────────────────────────────────────

describe('record_payment — the wrong customer or order', () => {
  it('a close name ("El-Sayed") is a question with both candidates and no token', async () => {
    const r = await call({ ...paid, customer: 'El-Sayed' });
    expect(r.s.status).toBe('needs_answers');
    expect(r.s.confirmationToken).toBeUndefined();
    const labels = r.s.data?.questions?.[0].options.map((o) => o.label);
    expect(labels).toEqual(
      expect.arrayContaining(['El-Sayed Motors', 'El-Sayed Spare Parts']),
    );
    expect(db.tables.payment).toHaveLength(0);
  });

  it('an unknown name is a question, never a new customer', async () => {
    const r = await call({ ...paid, customer: 'Zamalek Scooters' });
    expect(r.s.status).toBe('needs_answers');
    expect(r.s.data?.questions?.[0].id).toBe('CUSTOMER_UNKNOWN');
    expect(db.tables.customer).toHaveLength(5);
  });

  it('the walk-in record is not a payer', async () => {
    const r = await call({ ...paid, customer: 'Walk-in' });
    expect(r.s.status).toBe('needs_answers');
  });

  it("another shop's order → NOT_FOUND, and its debt is untouched", async () => {
    const r = await call({ ...paid, amount: 100, order: 'SO-2026-0002' });
    expect(codeOf(r)).toBe('NOT_FOUND');
    expect(owes(ids.otherOrder)).toBe(2500);
  });

  it('a draft named as the order → ORDER_NOT_CONFIRMED', async () => {
    const r = await call({ ...paid, amount: 100, order: 'so-2026-0004' });
    expect(codeOf(r)).toBe('ORDER_NOT_CONFIRMED');
  });

  it('a named order takes all of it, even when an older one owes', async () => {
    const args = { ...paid, amount: 1000, order: 'SO-2026-0003' };
    const preview = await call(args);
    expect(preview.s.data?.allocations).toEqual([
      { orderNo: 'SO-2026-0003', amount: '1000.00', owesAfter: '3000.00' },
    ]);
    await call({ ...args, confirmationToken: preview.s.confirmationToken });
    expect(owes(ids.sayedOld)).toBe(3000);
    expect(owes(ids.sayedNew)).toBe(3000);
  });

  it('an unverified shop → CUSTOMER_NOT_VERIFIED', async () => {
    const r = await call({
      ...paid,
      customer: 'Heliopolis Bikes',
      amount: 100,
    });
    expect(codeOf(r)).toBe('CUSTOMER_NOT_VERIFIED');
  });
});

// ── The second time ───────────────────────────────────────────────────────

describe('record_payment — the second time', () => {
  it('a token spent once is refused the second time; the money is taken once', async () => {
    const preview = await call({ ...paid, amount: 1000 });
    const args = {
      ...paid,
      amount: 1000,
      confirmationToken: preview.s.confirmationToken,
    };
    expect((await call(args)).s.status).toBe('committed');
    const again = await call(args);
    expect(again.isError).toBe(true);
    expect(codeOf(again)).toBe('CONFIRMATION_USED');
    expect(db.tables.payment).toHaveLength(1);
  });

  it('a token for 1,000 cannot record 2,000', async () => {
    const preview = await call({ ...paid, amount: 1000 });
    const r = await call({
      ...paid,
      amount: 2000,
      confirmationToken: preview.s.confirmationToken,
    });
    expect(codeOf(r)).toBe('CONFIRMATION_MISMATCH');
    expect(db.tables.payment).toHaveLength(0);
  });

  it('a payment recorded in the office app between preview and yes → PREVIEW_CHANGED, nothing written', async () => {
    const preview = await call({ ...paid, amount: 1000 });
    // Someone at the office takes 3,000 against the same shop meanwhile.
    await new PaymentsService(
      db as unknown as PrismaService,
      new AuditService(db as unknown as PrismaService),
    ).create(
      {
        customerId: ids.sayed,
        amount: 3000,
        currency: 'EGP',
        applyOldestFirst: true,
      },
      randomUUID(),
    );
    const r = await call({
      ...paid,
      amount: 1000,
      confirmationToken: preview.s.confirmationToken,
    });
    expect(codeOf(r)).toBe('PREVIEW_CHANGED');
    expect(db.tables.payment).toHaveLength(1);
  });
});

// ── The wrong role (CLAUDE.md §12) ────────────────────────────────────────

describe("record_payment — roles are the office endpoint's", () => {
  it('a role POST /payments refuses is refused here too, before anything is read or written', async () => {
    const investor = await connectAs({ ...partner, role: 'TEMP_INVESTOR' });
    const r = await call(paid, investor);
    await investor.close();
    expect(codeOf(r)).toBe('ROLE_NOT_ALLOWED');
    expect(db.tables.payment).toHaveLength(0);
  });

  it('admin support, whom POST /payments allows, is allowed', async () => {
    const office = await connectAs({ ...partner, role: 'ADMIN_SUPPORT' });
    const r = await call({ ...paid, amount: 10 }, office);
    await office.close();
    expect(r.s.status).toBe('preview');
  });
});
