/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- tool results are parsed JSON; each assertion names the field it checks */
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
import { LendersService } from '../../lenders/lenders.service';
import type { NotificationsService } from '../../notifications/notifications.service';
import { AssistantServer } from '../assistant-server';
import { ConfirmationService } from '../confirmation.service';
import type { AssistantUser } from '../tool-kit';

/**
 * The lender tools (BUSINESS_LOGIC §16, §18, 2026-10-11): list_lenders,
 * get_lender, record_lender_financing, record_lender_repayment — driven through
 * a real McpServer and the SDK's client, the path Claude takes, against the
 * real LendersService and CostingService the office app calls. Only the
 * database is fake: in memory, rolling a transaction back when it throws,
 * because "a preview writes nothing" is under test.
 *
 * Beyond the happy path (CLAUDE.md §0): too much, a future day, zero, the
 * wrong currency, a name that is close or unknown, a new friend, an order or
 * an account that is not said, the same token twice, altered arguments, a
 * repayment arriving between the preview and the yes, and roles the office
 * endpoints refuse.
 */

type Row = Record<string, unknown>;
const D = (v: unknown) => new Prisma.Decimal(v as Prisma.Decimal.Value);

const TABLES = [
  'lender',
  'lenderFinancing',
  'lenderRepayment',
  'lenderPlan',
  'lenderPlanInstalment',
  'purchaseOrder',
  'purchaseOrderItem',
  'importCycle',
  'shippingLeg',
  'product',
  'moneyAccount',
  'currencyRate',
  'financialTransaction',
  'auditLog',
  'usedNonce',
] as const;
type Table = (typeof TABLES)[number];

const RELATIONS: Partial<
  Record<Table, Record<string, [Table, string, 'many' | 'one']>>
> = {
  lender: { financings: ['lenderFinancing', 'lenderId', 'many'] },
  lenderFinancing: {
    lender: ['lender', 'lenderId', 'one'],
    purchaseOrder: ['purchaseOrder', 'purchaseOrderId', 'one'],
    cycle: ['importCycle', 'cycleId', 'one'],
    repayments: ['lenderRepayment', 'financingId', 'many'],
    plans: ['lenderPlan', 'financingId', 'many'],
  },
  lenderRepayment: {
    account: ['moneyAccount', 'accountId', 'one'],
    financing: ['lenderFinancing', 'financingId', 'one'],
  },
  lenderPlan: { instalments: ['lenderPlanInstalment', 'planId', 'many'] },
  purchaseOrder: {
    cycle: ['importCycle', 'cycleId', 'one'],
    items: ['purchaseOrderItem', 'purchaseOrderId', 'many'],
    lenderFinancings: ['lenderFinancing', 'purchaseOrderId', 'many'],
  },
  importCycle: {
    shippingLegs: ['shippingLeg', 'cycleId', 'many'],
    purchaseOrders: ['purchaseOrder', 'cycleId', 'many'],
  },
  purchaseOrderItem: { product: ['product', 'productId', 'one'] },
};

/** Columns Prisma returns as null when a create leaves them out. */
const NULLABLE: Partial<Record<Table, Row>> = {
  lender: { phone: null, notes: null },
  lenderFinancing: { note: null, removedAt: null, removalReason: null },
  lenderRepayment: { note: null, reversedAt: null, reversalReason: null },
};

const sortable = (v: unknown) =>
  v instanceof Date
    ? v.getTime()
    : typeof v === 'string'
      ? v
      : v instanceof Prisma.Decimal
        ? v.toNumber()
        : Number(v);

class FakeDb {
  tables = Object.fromEntries(TABLES.map((t) => [t, [] as Row[]])) as Record<
    Table,
    Row[]
  >;
  /** Every interactive transaction opened, rolled back or not. */
  transactions = 0;

  constructor() {
    for (const t of TABLES) {
      (this as unknown as Record<string, unknown>)[t] = this.model(t);
    }
  }

  insert(table: Table, row: Row): Row {
    const full: Row = {
      id: randomUUID(),
      createdAt: new Date(Date.now() + this.tables[table].length),
      ...NULLABLE[table],
      ...row,
    };
    this.tables[table].push(full);
    return full;
  }

  counts() {
    return Object.fromEntries(
      (
        [
          'lender',
          'lenderFinancing',
          'lenderRepayment',
          'financialTransaction',
        ] as const
      ).map((t) => [t, this.tables[t].length]),
    );
  }

  $queryRaw() {
    return Promise.resolve([]);
  }

  async $transaction<T>(
    work: (tx: FakeDb) => Promise<T>,
    _options?: unknown,
  ): Promise<T> {
    this.transactions++;
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
      if (key === 'OR') {
        return (cond as Row[]).some((c) => this.matches(row, c));
      }
      const value = row[key];
      if (cond === null || typeof cond !== 'object' || cond instanceof Date)
        return value === cond || (cond === null && value === undefined);
      const c = cond as Row;
      if ('in' in c) return (c.in as unknown[]).includes(value);
      if ('gt' in c) return D(value ?? 0).gt(D(c.gt));
      if ('not' in c) return value !== c.not;
      if ('equals' in c) {
        return c.mode === 'insensitive'
          ? String(value).toLowerCase() === String(c.equals).toLowerCase()
          : value === c.equals;
      }
      throw new Error(`fake db: unsupported filter ${JSON.stringify(cond)}`);
    });
  }

  private ordered(rows: Row[], orderBy: unknown): Row[] {
    const keys = (
      Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []
    ).map((o) => Object.entries(o as Row)[0]);
    return rows.slice().sort((a, b) => {
      for (const [field, dir] of keys) {
        const x = sortable(a[field]);
        const y = sortable(b[field]);
        if (x !== y) return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1);
      }
      return 0;
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
        const rows = this.tables[rel[0]].filter(
          (r) => r[rel[1]] === row.id && this.matches(r, sub.where as Row),
        );
        out[key] = this.ordered(rows, sub.orderBy).map((r) =>
          this.shape(rel[0], r, sub),
        );
      } else {
        const other = this.tables[rel[0]].find((r) => r.id === row[rel[1]]);
        out[key] = other ? this.shape(rel[0], other, sub) : null;
      }
    }
    return out;
  }

  private model(table: Table) {
    const all = (args: Row = {}) =>
      this.ordered(
        this.tables[table].filter((r) => this.matches(r, args.where as Row)),
        args.orderBy,
      );
    const one = (args: Row) => {
      const row = all(args)[0];
      return Promise.resolve(row ? this.shape(table, row, args) : null);
    };
    const orThrow = async (args: Row) => {
      const row = await one(args);
      if (!row) throw new Error(`fake db: no ${table}`);
      return row;
    };
    return {
      findUnique: one,
      findFirst: one,
      findUniqueOrThrow: orThrow,
      findFirstOrThrow: orThrow,
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
        rows[i] = { ...rows[i], ...(args.data as Row) };
        return Promise.resolve(this.shape(table, rows[i], args));
      },
      delete: (args: Row) => {
        const rows = this.tables[table];
        const i = rows.findIndex((r) => this.matches(r, args.where as Row));
        if (i < 0) return Promise.reject(new Error(`fake db: no ${table}`));
        const [row] = rows.splice(i, 1);
        return Promise.resolve(row);
      },
      updateMany: (args: Row) => {
        const rows = this.tables[table];
        let count = 0;
        rows.forEach((r, i) => {
          if (!this.matches(r, args.where as Row)) return;
          rows[i] = { ...r, ...(args.data as Row) };
          count++;
        });
        return Promise.resolve({ count });
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

// ── The world ─────────────────────────────────────────────────────────────

const partner: AssistantUser = {
  id: randomUUID(),
  email: 'omar@motoparts.test',
  role: 'CORE_PARTNER',
  partner: null,
};

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);
const daysAgo = (n: number) => {
  const d = new Date(`${businessToday()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

let db: FakeDb;
let client: Client;
let assistant: AssistantServer;
let ids: {
  mahmoud: string;
  mahmoudHassan: string;
  sami: string;
  po4: string;
  po5: string;
  po6: string;
  cycle: string;
  cash: string;
  bank: string;
  samiFinancing: string;
};

/**
 * PO-2026-0004: 100 parts at 300 AED at 13.00 — 30,000 AED, 390,000 EGP —
 * on a cycle with 13,000 EGP of freight: 403,000 to fund. PO-2026-0005 is a
 * second dirham order on the same cycle; PO-2026-0006 is in yuan, which has
 * no rate on the exchange-rate page. Sami paid 10,000 AED of PO-0005 a month
 * ago on a plan whose first instalment is past due.
 */
function seed() {
  const cycle = db.insert('importCycle', {
    code: 'CYC-2026-0007',
    status: 'PURCHASING',
  }).id as string;
  db.insert('shippingLeg', {
    cycleId: cycle,
    sequence: 1,
    origin: 'Dubai, UAE',
    destination: 'Cairo, Egypt',
    costBasis: 'FLAT',
    amount: D(13000),
    fxRateToEgp: D(1),
    ratePerUnit: null,
    chargeablePieces: null,
    chargeableWeightKg: null,
  });
  const product = db.insert('product', {
    name: 'Exhaust',
    unitWeightKg: null,
  }).id as string;
  const order = (
    reference: string,
    currency: string,
    rate: number,
    total: number,
  ) => {
    const po = db.insert('purchaseOrder', {
      cycleId: cycle,
      reference,
      currency,
      fxRateToEgp: D(rate),
      orderedOn: day(daysAgo(40)),
    }).id as string;
    db.insert('purchaseOrderItem', {
      purchaseOrderId: po,
      productId: product,
      orderedQty: D(100),
      lineTotal: D(total),
    });
    return po;
  };
  const po4 = order('PO-2026-0004', 'AED', 13, 30000);
  const po5 = order('PO-2026-0005', 'AED', 13, 20000);
  const po6 = order('PO-2026-0006', 'CNY', 2, 5000);

  const lender = (name: string) =>
    db.insert('lender', { name, phone: null, notes: null }).id as string;
  const mahmoud = lender('Mahmoud');
  const mahmoudHassan = lender('Mahmoud Hassan');
  const sami = lender('Sami');

  const samiFinancing = db.insert('lenderFinancing', {
    lenderId: sami,
    purchaseOrderId: po5,
    cycleId: cycle,
    currency: 'AED',
    amount: D(10000),
    fxRateToEgp: D(13),
    amountEgp: D(130000),
    paidOn: day(daysAgo(30)),
    note: null,
    removedAt: null,
    removalReason: null,
  }).id as string;
  const plan = db.insert('lenderPlan', {
    financingId: samiFinancing,
    agreedOn: day(daysAgo(30)),
    status: 'ACTIVE',
    note: null,
  }).id as string;
  db.insert('lenderPlanInstalment', {
    planId: plan,
    sequence: 1,
    dueOn: day(daysAgo(5)),
    amount: D(4000),
  });
  db.insert('lenderPlanInstalment', {
    planId: plan,
    sequence: 2,
    dueOn: day(daysAgo(-25)),
    amount: D(6000),
  });

  const account = (name: string, currency = 'EGP', active = true) =>
    db.insert('moneyAccount', { name, currency, active, accountType: 'CASH' })
      .id as string;
  const cash = account('Cash Box');
  const bank = account('Bank Misr');
  account('Dirham Wallet', 'AED');
  account('Old Safe', 'EGP', false);

  db.insert('currencyRate', { code: 'AED', rateToEgp: D(13.85) });
  db.insert('currencyRate', { code: 'CNY', rateToEgp: null });

  ids = {
    mahmoud,
    mahmoudHassan,
    sami,
    po4,
    po5,
    po6,
    cycle,
    cash,
    bank,
    samiFinancing,
  };
}

let lendersService: LendersService;

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
  lendersService = new LendersService(
    prisma,
    audit,
    {} as unknown as NotificationsService,
  );
  const registry = new Map<unknown, unknown>([
    [PrismaService, prisma],
    [AuditService, audit],
    [LendersService, lendersService],
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
  data?: Record<string, any>;
  error?: { code: string; message: string; params?: Record<string, unknown> };
}

async function call(name: string, args: Record<string, unknown>, on = client) {
  const r = (await on.callTool({ name, arguments: args })) as CallToolResult;
  return {
    ...r,
    s: (r.structuredContent ?? {}) as Structured,
    text: (r.content[0] as { text: string }).text,
  };
}
const codeOf = (r: { s: Structured }) => r.s.error?.code;
const finance = (args: Record<string, unknown>, on = client) =>
  call('record_lender_financing', args, on);
const repay = (args: Record<string, unknown>, on = client) =>
  call('record_lender_repayment', args, on);

const paid30k = {
  lender: 'Mahmoud',
  order: 'PO-2026-0004',
  amount: 30000,
  currency: 'AED',
};

/** Mahmoud paid all of PO-0004, through the office's own method. */
async function mahmoudPaid(amount = 30000) {
  const { data } = await lendersService.finance(
    ids.po4,
    { lenderId: ids.mahmoud, amount, paidOn: daysAgo(20) },
    partner.id,
  );
  return data.id;
}

// ── list_lenders / get_lender ─────────────────────────────────────────────

describe('list_lenders — who we owe, in his currency and in pounds today', () => {
  it("lists each friend still owed, with pounds at today's rate and his overdue instalment", async () => {
    await mahmoudPaid();
    const r = await call('list_lenders', {});
    expect(r.isError).toBeFalsy();
    const rows = r.s.data as any[];
    expect(rows.map((x) => x.name)).toEqual(['Mahmoud', 'Sami']);
    expect(rows[0].owed).toEqual([
      {
        currency: 'AED',
        owed: '30000.00',
        rateToEgp: '13.8500',
        owedEgp: '415500.00',
      },
    ]);
    expect(rows[0].owedEgpToday).toBe('415500.00');
    expect(rows[0].overdueInstalments).toEqual([]);
    expect(rows[1].overdueInstalments).toEqual([
      expect.objectContaining({
        order: 'PO-2026-0005',
        amount: '4000.00',
        outstanding: '4000.00',
      }),
    ]);
    expect(r.text).toContain(
      '2 friend(s) are owed money; 1 with an overdue instalment',
    );
  });

  it('overdueOnly leaves out a friend with nothing late, and a friend owed nothing is never listed', async () => {
    await mahmoudPaid();
    const r = await call('list_lenders', { overdueOnly: true });
    expect((r.s.data as any[]).map((x) => x.name)).toEqual(['Sami']);
    const all = await call('list_lenders', {});
    expect((all.s.data as any[]).map((x) => x.name)).not.toContain(
      'Mahmoud Hassan',
    );
  });

  it('a temporary investor is refused, as on GET /lenders; admin support may read', async () => {
    const investor = await connectAs({
      ...partner,
      id: randomUUID(),
      role: 'TEMP_INVESTOR',
    });
    expect(codeOf(await call('list_lenders', {}, investor))).toBe(
      'ROLE_NOT_ALLOWED',
    );
    expect(codeOf(await call('get_lender', { lender: 'Sami' }, investor))).toBe(
      'ROLE_NOT_ALLOWED',
    );
    await investor.close();
    const office = await connectAs({
      ...partner,
      id: randomUUID(),
      role: 'ADMIN_SUPPORT',
    });
    expect((await call('list_lenders', {}, office)).isError).toBeFalsy();
    await office.close();
  });
});

describe('get_lender — one friend', () => {
  it('by exact name: what he paid for, each repayment with its rate and exchange difference, his plan, still owed', async () => {
    await lendersService.repay(
      ids.samiFinancing,
      {
        amountEgp: 54800,
        rateToEgp: 13.7,
        accountId: ids.cash,
        paidOn: daysAgo(2),
      },
      partner.id,
    );
    const r = await call('get_lender', { lender: 'sami' });
    const d = r.s.data as any;
    expect(d.name).toBe('Sami');
    expect(d.owed).toEqual([
      {
        currency: 'AED',
        owed: '6000.00',
        rateToEgp: '13.8500',
        owedEgp: '83100.00',
      },
    ]);
    const [f] = d.financings;
    expect(f).toMatchObject({
      order: 'PO-2026-0005',
      cycle: 'CYC-2026-0007',
      paid: '10000.00',
      owed: '6000.00',
    });
    expect(f.repayments).toEqual([
      expect.objectContaining({
        poundsPaid: '54800.00',
        rateToEgp: '13.7000',
        cleared: '4000.00',
        exchangeDifferenceEgp: '2800.00',
        account: 'Cash Box',
        reversed: false,
      }),
    ]);
    expect(f.plan.instalments.map((i: any) => i.state)).toEqual([
      'PAID',
      'UPCOMING',
    ]);
    expect(r.text).toContain('We owe Sami 6,000.00 AED (83,100.00 EGP today).');
  });

  it('a name close to two friends returns the candidates and no figures; an unknown name is not found', async () => {
    const r = await call('get_lender', { lender: 'Mahmod' });
    expect(r.isError).toBeFalsy();
    expect((r.s.data as any).candidates.map((c: any) => c.name).sort()).toEqual(
      ['Mahmoud', 'Mahmoud Hassan'],
    );
    expect((r.s.data as any).financings).toBeUndefined();
    expect(codeOf(await call('get_lender', { lender: 'Zakaria' }))).toBe(
      'NOT_FOUND',
    );
  });
});

// ── record_lender_financing ───────────────────────────────────────────────

describe('record_lender_financing — "Mahmoud paid 30,000 AED for PO-2026-0004"', () => {
  it('previews what the partners fund before and after, writes nothing, then records exactly that on yes', async () => {
    const before = db.counts();
    const preview = await finance(paid30k);
    expect(preview.s.status).toBe('preview');
    expect(preview.s.data).toMatchObject({
      lender: { id: ids.mahmoud, name: 'Mahmoud', isNew: false },
      order: 'PO-2026-0004',
      amount: '30000.00',
      currency: 'AED',
      amountEgp: '390000.00',
      partnersFundBeforeEgp: '543000.00',
      partnersFundAfterEgp: '153000.00',
    });
    expect(preview.text).toContain(
      'Partners fund 543,000.00 EGP of the cycle before this, 153,000.00 EGP after.',
    );
    expect(db.counts()).toEqual(before);

    const done = await finance({
      ...paid30k,
      confirmationToken: preview.s.confirmationToken,
    });
    expect(done.s.status).toBe('committed');
    const rows = db.tables.lenderFinancing.filter(
      (f) => f.lenderId === ids.mahmoud,
    );
    expect(rows).toHaveLength(1);
    expect([
      rows[0].purchaseOrderId,
      D(rows[0].amount).toFixed(2),
      D(rows[0].amountEgp).toFixed(2),
    ]).toEqual([ids.po4, '30000.00', '390000.00']);
    expect(
      db.tables.auditLog.some((a) => a.entityType === 'LenderFinancing'),
    ).toBe(true);
  });

  it('a confirmation with a changed amount is refused, and nothing is recorded', async () => {
    const preview = await finance(paid30k);
    const r = await finance({
      ...paid30k,
      amount: 29000,
      confirmationToken: preview.s.confirmationToken,
    });
    expect(codeOf(r)).toBe('CONFIRMATION_MISMATCH');
    expect(db.tables.lenderFinancing).toHaveLength(1);
  });

  it('the same token twice records it once', async () => {
    const preview = await finance(paid30k);
    await finance({
      ...paid30k,
      confirmationToken: preview.s.confirmationToken,
    });
    const again = await finance({
      ...paid30k,
      confirmationToken: preview.s.confirmationToken,
    });
    expect(again.isError).toBe(true);
    expect(db.tables.lenderFinancing).toHaveLength(2);
  });

  it('an unknown friend is a question with nothing to confirm; with newLender he is added only on yes', async () => {
    const asked = await finance({ ...paid30k, lender: 'Khaled' });
    expect(asked.s.status).toBe('needs_answers');
    expect(asked.s.confirmationToken).toBeUndefined();
    expect(asked.s.data!.questions[0].id).toBe('LENDER_NEW');

    const args = {
      ...paid30k,
      lender: 'Khaled',
      newLender: true,
      phone: '0100 000 0000',
    };
    const before = db.counts();
    const preview = await finance(args);
    expect(preview.s.status).toBe('preview');
    expect(preview.s.data!.lender).toEqual({
      id: null,
      name: 'Khaled',
      isNew: true,
    });
    expect(preview.text).toContain(
      'Khaled is not on file yet: he will be added as a new lender.',
    );
    expect(db.counts()).toEqual(before);

    const done = await finance({
      ...args,
      confirmationToken: preview.s.confirmationToken,
    });
    expect(done.s.status).toBe('committed');
    const khaled = db.tables.lender.find((l) => l.name === 'Khaled')!;
    expect(khaled.phone).toBe('0100 000 0000');
    expect(
      db.tables.lenderFinancing.filter((f) => f.lenderId === khaled.id),
    ).toHaveLength(1);
  });

  it('a close name asks which friend — the candidates and "a new lender" — and never takes one', async () => {
    const r = await finance({ ...paid30k, lender: 'Mahmod' });
    expect(r.s.status).toBe('needs_answers');
    const q = r.s.data!.questions[0];
    expect(q.id).toBe('LENDER_WHICH');
    expect(q.options.map((o: any) => o.value)).toEqual(
      expect.arrayContaining([ids.mahmoud, ids.mahmoudHassan, 'new']),
    );
    expect(db.tables.lenderFinancing).toHaveLength(1);
  });

  it('too much, the wrong currency, zero, more decimals than money has, a future day and an unknown order are each refused with a code, nothing written', async () => {
    const before = db.counts();
    expect(codeOf(await finance({ ...paid30k, amount: 30000.01 }))).toBe(
      'FINANCING_EXCEEDS_ORDER',
    );
    expect(codeOf(await finance({ ...paid30k, currency: 'CNY' }))).toBe(
      'LENDER_CURRENCY_MISMATCH',
    );
    expect(codeOf(await finance({ ...paid30k, amount: 0 }))).toBe(
      'AMOUNT_NOT_POSITIVE',
    );
    expect(codeOf(await finance({ ...paid30k, amount: -5 }))).toBe(
      'AMOUNT_NOT_POSITIVE',
    );
    expect(codeOf(await finance({ ...paid30k, amount: 10.005 }))).toBe(
      'VALIDATION_FAILED',
    );
    const tomorrow = daysAgo(-2);
    expect(codeOf(await finance({ ...paid30k, paidOn: tomorrow }))).toBe(
      'DATE_IN_FUTURE',
    );
    expect(codeOf(await finance({ ...paid30k, order: 'PO-2099-9999' }))).toBe(
      'NOT_FOUND',
    );
    expect(db.counts()).toEqual(before);
  });

  it('he already paid for that order: refused the second time, as in the office', async () => {
    await mahmoudPaid(100);
    expect(codeOf(await finance({ ...paid30k, amount: 50 }))).toBe(
      'LENDER_ALREADY_FINANCES_ORDER',
    );
  });

  it("another friend's payment between the preview and the yes changes what partners fund: PREVIEW_CHANGED, nothing recorded", async () => {
    const args = { ...paid30k, amount: 10000 };
    const preview = await finance(args);
    await lendersService.finance(
      ids.po4,
      { lenderId: ids.mahmoudHassan, amount: 5000 },
      partner.id,
    );
    const r = await finance({
      ...args,
      confirmationToken: preview.s.confirmationToken,
    });
    expect(codeOf(r)).toBe('PREVIEW_CHANGED');
    expect(
      db.tables.lenderFinancing.filter((f) => f.lenderId === ids.mahmoud),
    ).toHaveLength(0);
  });

  it("roles are the office endpoint's: admin support and an investor are refused, the preview included", async () => {
    for (const role of ['ADMIN_SUPPORT', 'TEMP_INVESTOR'] as const) {
      const other = await connectAs({ ...partner, id: randomUUID(), role });
      expect([role, codeOf(await finance(paid30k, other))]).toEqual([
        role,
        'ROLE_NOT_ALLOWED',
      ]);
      await other.close();
    }
    expect(db.tables.lenderFinancing).toHaveLength(1);
  });
});

// ── record_lender_repayment ───────────────────────────────────────────────

describe('record_lender_repayment — "paid Mahmoud 50,000 pounds today"', () => {
  it("previews at today's rate, says so, shows what it clears, what is still owed and the exchange difference; writes nothing; records exactly that on yes", async () => {
    await mahmoudPaid();
    const args = { lender: 'Mahmoud', amountEgp: 50000, account: 'Cash Box' };
    const before = db.counts();
    const preview = await repay(args);
    expect(preview.s.status).toBe('preview');
    expect(preview.s.data).toMatchObject({
      order: 'PO-2026-0004',
      amountEgp: '50000.00',
      rateToEgp: '13.8500',
      rateFrom: 'today',
      account: { id: ids.cash, name: 'Cash Box' },
      paidOn: businessToday(),
      cleared: '3610.10',
      owedBefore: '30000.00',
      owedAfter: '26389.90',
      exchangeDiffEgp: '3068.70',
    });
    expect(preview.text).toContain("today's rate on the exchange-rate page");
    expect(preview.text).toContain(
      'Still owed: 30,000.00 AED before, 26,389.90 AED after.',
    );
    expect(preview.text).toContain(
      'Exchange difference: 3,068.70 EGP — a cost to the cycle',
    );
    expect(db.counts()).toEqual(before);

    const done = await repay({
      ...args,
      confirmationToken: preview.s.confirmationToken,
    });
    expect(done.s.status).toBe('committed');
    expect(done.s.data).toMatchObject({
      cleared: '3610.10',
      owedAfter: '26389.90',
    });
    const [r] = db.tables.lenderRepayment;
    expect([
      D(r.amountEgp).toFixed(2),
      D(r.rateToEgp).toFixed(4),
      r.accountId,
    ]).toEqual(['50000.00', '13.8500', ids.cash]);
  });

  it("a rate the partner gives is used instead of today's", async () => {
    await mahmoudPaid();
    const r = await repay({
      lender: 'Mahmoud',
      amountEgp: 13000,
      rateToEgp: 13,
      account: 'Cash Box',
    });
    expect(r.s.data).toMatchObject({
      rateToEgp: '13.0000',
      rateFrom: 'given',
      cleared: '1000.00',
      exchangeDiffEgp: '0.00',
    });
  });

  it('"pay him off" uses the exact settling figure and ends the debt at zero', async () => {
    await mahmoudPaid();
    const args = { lender: 'Mahmoud', payOff: true, account: 'Bank Misr' };
    const preview = await repay(args);
    expect(preview.s.data).toMatchObject({
      amountEgp: '415500.00',
      payOff: true,
      owedAfter: '0.00',
    });
    await repay({ ...args, confirmationToken: preview.s.confirmationToken });
    expect(
      (await lendersService.findOne(ids.mahmoud)).data.financings[0].owed,
    ).toBe('0.00');
  });

  it("several accounts in pounds and none said: asks which, naming the office form's default; one account is taken as it", async () => {
    await mahmoudPaid();
    const asked = await repay({ lender: 'Mahmoud', amountEgp: 1000 });
    expect(asked.s.status).toBe('needs_answers');
    const q = asked.s.data!.questions[0];
    expect(q.id).toBe('ACCOUNT_WHICH');
    // Active, in pounds, by name — the dialog's list; its default first.
    expect(q.options.map((o: any) => o.label)).toEqual([
      'Bank Misr',
      'Cash Box',
    ]);
    expect(q.text).toContain('The office form starts on Bank Misr.');

    db.tables.moneyAccount.find((a) => a.id === ids.bank)!.active = false;
    const one = await repay({ lender: 'Mahmoud', amountEgp: 1000 });
    expect(one.s.status).toBe('preview');
    expect(one.s.data!.account.name).toBe('Cash Box');
  });

  it('more than is owed is refused with the settling figure; nothing written', async () => {
    await mahmoudPaid();
    const before = db.counts();
    const r = await repay({
      lender: 'Mahmoud',
      amountEgp: 415500.01,
      account: 'Cash Box',
    });
    expect(codeOf(r)).toBe('LENDER_REPAYMENT_EXCEEDS_OWED');
    expect(r.s.error!.params).toMatchObject({ settling: '415,500.00' });
    expect(r.s.confirmationToken).toBeUndefined();
    expect(db.counts()).toEqual(before);
  });

  it('a confirmation with a changed amount is refused', async () => {
    await mahmoudPaid();
    const args = { lender: 'Mahmoud', amountEgp: 50000, account: 'Cash Box' };
    const preview = await repay(args);
    const r = await repay({
      ...args,
      amountEgp: 60000,
      confirmationToken: preview.s.confirmationToken,
    });
    expect(codeOf(r)).toBe('CONFIRMATION_MISMATCH');
    expect(db.tables.lenderRepayment).toHaveLength(0);
  });

  it('another repayment between the preview and the yes: PREVIEW_CHANGED, and only that one stands', async () => {
    await mahmoudPaid();
    const args = { lender: 'Mahmoud', amountEgp: 50000, account: 'Cash Box' };
    const preview = await repay(args);
    const f = db.tables.lenderFinancing.find(
      (x) => x.lenderId === ids.mahmoud,
    )!;
    await lendersService.repay(
      f.id as string,
      { amountEgp: 13000, rateToEgp: 13, accountId: ids.cash },
      partner.id,
    );
    const r = await repay({
      ...args,
      confirmationToken: preview.s.confirmationToken,
    });
    expect(codeOf(r)).toBe('PREVIEW_CHANGED');
    expect(db.tables.lenderRepayment).toHaveLength(1);
  });

  it('a close name asks which friend; an unknown one is asked and never offered as new', async () => {
    const close = await repay({
      lender: 'Mahmod',
      amountEgp: 1000,
      account: 'Cash Box',
    });
    expect(close.s.data!.questions[0].id).toBe('LENDER_WHICH');
    expect(
      close.s.data!.questions[0].options.map((o: any) => o.value),
    ).not.toContain('new');
    const unknown = await repay({
      lender: 'Zakaria',
      amountEgp: 1000,
      account: 'Cash Box',
    });
    expect(unknown.s.data!.questions[0].id).toBe('LENDER_UNKNOWN');
    expect(unknown.s.confirmationToken).toBeUndefined();
  });

  it('owed on two orders: asks which; naming one goes ahead on that order', async () => {
    await mahmoudPaid();
    await lendersService.finance(
      ids.po5,
      { lenderId: ids.mahmoud, amount: 1000 },
      partner.id,
    );
    const asked = await repay({
      lender: 'Mahmoud',
      amountEgp: 1000,
      account: 'Cash Box',
    });
    expect(asked.s.data!.questions[0].id).toBe('FINANCING_WHICH');
    expect(asked.s.data!.questions[0].options.map((o: any) => o.value)).toEqual(
      ['PO-2026-0004', 'PO-2026-0005'],
    );
    const named = await repay({
      lender: 'Mahmoud',
      amountEgp: 1000,
      account: 'Cash Box',
      order: 'po-2026-0005',
    });
    expect(named.s.data).toMatchObject({
      order: 'PO-2026-0005',
      owedBefore: '1000.00',
    });
  });

  it('nothing owed: LENDER_NOT_OWED; a currency with no rate and none given: asks for the rate', async () => {
    expect(
      codeOf(
        await repay({
          lender: 'Mahmoud Hassan',
          amountEgp: 1000,
          account: 'Cash Box',
        }),
      ),
    ).toBe('LENDER_NOT_OWED');
    await lendersService.finance(
      ids.po6,
      { lenderId: ids.mahmoudHassan, amount: 500 },
      partner.id,
    );
    const r = await repay({
      lender: 'Mahmoud Hassan',
      amountEgp: 1000,
      account: 'Cash Box',
    });
    expect(r.s.data!.questions.map((q: any) => q.id)).toEqual(['RATE_NEEDED']);
  });

  it('neither or both of amountEgp and payOff, a future day, and a zero amount are refused with a code', async () => {
    await mahmoudPaid();
    const base = { lender: 'Mahmoud', account: 'Cash Box' };
    expect(codeOf(await repay(base))).toBe('VALIDATION_FAILED');
    expect(codeOf(await repay({ ...base, amountEgp: 10, payOff: true }))).toBe(
      'VALIDATION_FAILED',
    );
    expect(
      codeOf(await repay({ ...base, amountEgp: 10, paidOn: daysAgo(-2) })),
    ).toBe('DATE_IN_FUTURE');
    expect(codeOf(await repay({ ...base, amountEgp: 0 }))).toBe(
      'AMOUNT_NOT_POSITIVE',
    );
    expect(db.tables.lenderRepayment).toHaveLength(0);
  });

  it("roles are the office endpoint's: admin support and an investor are refused", async () => {
    await mahmoudPaid();
    for (const role of ['ADMIN_SUPPORT', 'TEMP_INVESTOR'] as const) {
      const other = await connectAs({ ...partner, id: randomUUID(), role });
      expect([
        role,
        codeOf(
          await repay(
            { lender: 'Mahmoud', amountEgp: 1000, account: 'Cash Box' },
            other,
          ),
        ),
      ]).toEqual([role, 'ROLE_NOT_ALLOWED']);
      await other.close();
    }
    expect(db.tables.lenderRepayment).toHaveLength(0);
  });
});

describe('LendersService.finance — the guard lives in the service, not only the DTO', () => {
  it('a zero or negative amount is refused even when the DTO is bypassed', async () => {
    for (const amount of [0, -1]) {
      await expect(
        lendersService.finance(
          ids.po4,
          { lenderId: ids.mahmoud, amount },
          partner.id,
        ),
      ).rejects.toMatchObject({ response: { code: 'AMOUNT_NOT_POSITIVE' } });
    }
    expect(db.tables.lenderFinancing).toHaveLength(1);
  });
});

// ── The cases the L2 alignment review asked to see (§16, §18) ─────────────

describe('lender tools — the documented cases, each named (L2 review)', () => {
  const cycleRow = () => db.tables.importCycle.find((c) => c.id === ids.cycle)!;

  it('newLender sent for a friend who already exists by exact name uses that friend and creates no duplicate', async () => {
    const args = { ...paid30k, newLender: true };
    const preview = await finance(args);
    expect(preview.s.status).toBe('preview');
    expect(preview.s.data!.lender).toEqual({
      id: ids.mahmoud,
      name: 'Mahmoud',
      isNew: false,
    });
    expect(preview.text).not.toContain('added as a new lender');

    const done = await finance({
      ...args,
      confirmationToken: preview.s.confirmationToken,
    });
    expect(done.s.status).toBe('committed');
    expect(db.tables.lender.filter((l) => l.name === 'Mahmoud')).toHaveLength(
      1,
    );
    expect(
      db.tables.lenderFinancing.filter((f) => f.lenderId === ids.mahmoud),
    ).toHaveLength(1);
  });

  it('a repayment dated before the friend paid the supplier is refused, nothing written', async () => {
    await mahmoudPaid(); // paid 20 days ago
    const before = db.counts();
    const r = await repay({
      lender: 'Mahmoud',
      amountEgp: 1000,
      account: 'Cash Box',
      paidOn: daysAgo(25),
    });
    expect(codeOf(r)).toBe('LENDER_REPAYMENT_BEFORE_FINANCING');
    expect(r.s.confirmationToken).toBeUndefined();
    expect(db.counts()).toEqual(before);
  });

  it("a friend's payment on a cycle in settlement, closed or cancelled is refused, nothing written", async () => {
    for (const status of ['SETTLEMENT', 'CLOSED', 'CANCELLED']) {
      cycleRow().status = status;
      const before = db.counts();
      const r = await finance(paid30k);
      expect([status, codeOf(r)]).toEqual([
        status,
        'CYCLE_CLOSED_FOR_FINANCING',
      ]);
      expect(r.s.confirmationToken).toBeUndefined();
      expect(db.counts()).toEqual(before);
    }
  });

  /**
   * A cycle reaches SETTLEMENT or CLOSED only once every friend on it is
   * repaid (§18 settlement gate), and CANCELLED only once his payment was
   * removed. Those are the states built here (CLAUDE.md §4): a repayment on
   * such a cycle has nothing to clear, and is refused both ways it can be
   * asked — with the order named and without.
   */
  it('a repayment on a cycle in settlement, closed or cancelled is refused, nothing written', async () => {
    const f = await mahmoudPaid();
    await lendersService.repay(
      f,
      { amountEgp: 390000, rateToEgp: 13, accountId: ids.cash },
      partner.id,
    );
    for (const status of ['SETTLEMENT', 'CLOSED']) {
      cycleRow().status = status;
      const before = db.counts();
      const unnamed = await repay({
        lender: 'Mahmoud',
        amountEgp: 1000,
        account: 'Cash Box',
      });
      expect([status, codeOf(unnamed)]).toEqual([status, 'LENDER_NOT_OWED']);
      const named = await repay({
        lender: 'Mahmoud',
        amountEgp: 1000,
        account: 'Cash Box',
        order: 'PO-2026-0004',
      });
      expect([status, codeOf(named)]).toEqual([
        status,
        'LENDER_REPAYMENT_EXCEEDS_OWED',
      ]);
      expect(db.counts()).toEqual(before);
    }

    // Cancelled: his payment on it was removed first (§18 "Which cycles").
    cycleRow().status = 'PURCHASING';
    const { data: hassan } = await lendersService.finance(
      ids.po5,
      { lenderId: ids.mahmoudHassan, amount: 1000 },
      partner.id,
    );
    await lendersService.removeFinancing(
      hassan.id,
      'cycle cancelled',
      partner.id,
    );
    cycleRow().status = 'CANCELLED';
    const before = db.counts();
    const unnamed = await repay({
      lender: 'Mahmoud Hassan',
      amountEgp: 100,
      account: 'Cash Box',
    });
    expect(codeOf(unnamed)).toBe('LENDER_NOT_OWED');
    const named = await repay({
      lender: 'Mahmoud Hassan',
      amountEgp: 100,
      account: 'Cash Box',
      order: 'PO-2026-0005',
    });
    expect(codeOf(named)).toBe('NOT_FOUND');
    expect(db.counts()).toEqual(before);
  });

  it('a new friend stays on file, owing nothing, when his payment is refused after he was added (the two-step path)', async () => {
    // The race the two steps leave open: the cycle is cancelled after the
    // bound preview was re-checked and after he was added, before his
    // payment is written. Simulated at exactly that point.
    const create = lendersService.create.bind(lendersService);
    jest
      .spyOn(lendersService, 'create')
      .mockImplementation(async (...a: Parameters<typeof create>) => {
        const made = await create(...a);
        cycleRow().status = 'CANCELLED';
        return made;
      });
    const args = { ...paid30k, lender: 'Khaled', newLender: true };
    const preview = await finance(args);
    expect(preview.s.status).toBe('preview');

    const r = await finance({
      ...args,
      confirmationToken: preview.s.confirmationToken,
    });
    expect(codeOf(r)).toBe('CYCLE_CLOSED_FOR_FINANCING');

    const khaled = db.tables.lender.filter((l) => l.name === 'Khaled');
    expect(khaled).toHaveLength(1);
    expect(
      db.tables.lenderFinancing.filter((f) => f.lenderId === khaled[0].id),
    ).toHaveLength(0);
    const shown = await call('get_lender', { lender: 'Khaled' });
    expect(shown.s.data!.owed).toEqual([]);
    expect(shown.s.data!.financings).toEqual([]);
  });
});
