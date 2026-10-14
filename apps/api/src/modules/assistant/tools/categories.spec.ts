import { randomUUID } from 'node:crypto';
import { Logger, type HttpException, type Type } from '@nestjs/common';
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
import { AssistantServer } from '../assistant-server';
import { ConfirmationService } from '../confirmation.service';
import type { AssistantUser } from '../tool-kit';

/**
 * create_category and list_categories (BUSINESS_LOGIC §16, owner 2026-10-15),
 * driven through a real McpServer and the SDK's client — the path Claude
 * takes — against the real ProductsService the office's New Category form
 * calls. Only the database is fake: in memory, keeping the two unique indexes
 * (the English name; the Arabic name ignoring case) and rolling a transaction
 * back when it throws, because "a preview writes nothing" is under test.
 *
 * Beyond the happy path (CLAUDE.md §0): a blank name, a name already taken in
 * either language, an Arabic name too long or not text, a parent that is not
 * there, that is only close, or that could be two; the same token twice; a
 * parent that changed between the preview and the yes; and the roles the
 * office endpoint refuses.
 */

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

const TABLES = ['category', 'product', 'auditLog', 'usedNonce'] as const;
type Table = (typeof TABLES)[number];

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

  counts(): Record<string, number> {
    const { usedNonce: _spent, ...rest } = Object.fromEntries(
      TABLES.map((t) => [t, this.tables[t].length]),
    );
    return rest;
  }

  insert(table: Table, row: Row): Row {
    const full: Row = { id: randomUUID(), createdAt: new Date(), ...row };
    const rows = this.tables[table];
    if (table === 'category') {
      if (rows.some((r) => r.name === full.name)) throw p2002(['name']);
      // categories_name_ar_key: unique on lower(name_ar), NULLs never collide.
      const ar = typeof full.nameAr === 'string' ? full.nameAr : null;
      if (
        ar &&
        rows.some(
          (r) =>
            typeof r.nameAr === 'string' &&
            r.nameAr.toLowerCase() === ar.toLowerCase(),
        )
      )
        throw p2002(['name_ar']);
      full.nameAr ??= null;
      full.parentId ??= null;
    }
    if (table === 'usedNonce' && rows.some((r) => r.jti === full.jti))
      throw p2002(['jti']);
    rows.push(full);
    return full;
  }

  async $transaction<T>(
    work: (tx: FakeDb) => Promise<T>,
    _options?: unknown,
  ): Promise<T> {
    const before = Object.fromEntries(
      Object.entries(this.tables).map(([t, rows]) => [
        t,
        rows.map((r) => ({ ...r })),
      ]),
    ) as Record<Table, Row[]>;
    try {
      return await work(this);
    } catch (err) {
      this.tables = before;
      throw err;
    }
  }

  private matches(row: Row, where: Where = {}): boolean {
    return Object.entries(where).every(([key, cond]) => {
      if (key === 'NOT') return !this.matches(row, cond as Where);
      const value = row[key];
      if (
        cond !== null &&
        typeof cond === 'object' &&
        !(cond instanceof Date)
      ) {
        const c = cond as Row;
        if ('equals' in c)
          return c.mode === 'insensitive'
            ? typeof value === 'string' &&
                value.toLowerCase() === String(c.equals).toLowerCase()
            : value === c.equals;
        throw new Error(`fake db: unsupported filter ${JSON.stringify(cond)}`);
      }
      return value === cond;
    });
  }

  private shape(table: Table, row: Row, args: Row): Row {
    const out: Row = { ...row };
    if (args.select) {
      const picked: Row = {};
      for (const k of Object.keys(args.select)) picked[k] = row[k];
      return picked;
    }
    const include = args.include as Row | undefined;
    if (table === 'category' && include) {
      if (include.children)
        out.children = this.tables.category.filter(
          (c) => c.parentId === row.id,
        );
      if (include._count)
        out._count = {
          products: this.tables.product.filter((p) => p.categoryId === row.id)
            .length,
          children: this.tables.category.filter((c) => c.parentId === row.id)
            .length,
        };
    }
    return out;
  }

  private model(table: Table) {
    const all = (args: Row = {}) => {
      let rows = this.tables[table].filter((r) =>
        this.matches(r, args.where as Where),
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
      create: (args: Row) => {
        try {
          return Promise.resolve({ ...this.insert(table, args.data as Row) });
        } catch (err) {
          return Promise.reject(err as Error);
        }
      },
      update: (args: Row) => {
        const rows = this.tables[table];
        const i = rows.findIndex((r) => this.matches(r, args.where as Where));
        if (i < 0) return Promise.reject(new Error('fake db: no row'));
        rows[i] = { ...rows[i], ...(args.data as Row) };
        return Promise.resolve({ ...rows[i] });
      },
    };
  }
}

// ── The world ────────────────────────────────────────────────────────────

const partner: AssistantUser = {
  id: randomUUID(),
  email: 'omar@motoparts.test',
  role: 'CORE_PARTNER',
  partner: null,
};

let db: FakeDb;
let assistant: AssistantServer;
let products: ProductsService;
let client: Client;
let ids: { brakes: string; lighting: string; tyres: string };

function seed() {
  const brakes = db.insert('category', { name: 'Brakes', nameAr: 'فرامل' });
  const lighting = db.insert('category', { name: 'Lighting', nameAr: 'إضاءة' });
  const tyres = db.insert('category', { name: 'Tyres' });
  db.insert('product', { name: 'Brake pad', categoryId: brakes.id });
  db.insert('product', { name: 'Brake lever', categoryId: brakes.id });
  ids = {
    brakes: brakes.id as string,
    lighting: lighting.id as string,
    tyres: tyres.id as string,
  };
}

async function connectAs(user: AssistantUser): Promise<Client> {
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
  products = new ProductsService(prisma, audit, {} as NotificationsService);
  const registry = new Map<unknown, unknown>([
    [PrismaService, prisma],
    [AuditService, audit],
    [ProductsService, products],
  ]);
  const moduleRef = {
    get: (type: Type<unknown>) => registry.get(type),
  } as unknown as ModuleRef;
  assistant = new AssistantServer(
    new ConfirmationService(
      new JwtService({ secret: 'a-test-secret-that-is-long-enough' }),
      prisma,
    ),
    moduleRef,
  );
  client = await connectAs(partner);
});

afterEach(async () => {
  await client.close();
  jest.restoreAllMocks();
});

// ── Calling the tools ─────────────────────────────────────────────────────

interface Structured {
  status?: string;
  confirmationToken?: string;
  data?: unknown;
  error?: { code: string; message: string; params?: Record<string, unknown> };
}

async function call(
  name: string,
  args: Record<string, unknown>,
  as: Client = client,
): Promise<CallToolResult & { s: Structured; text: string }> {
  const r = (await as.callTool({ name, arguments: args })) as CallToolResult;
  return {
    ...r,
    s: r.structuredContent ?? {},
    text: (r.content[0] as { text: string }).text,
  };
}

/** Preview, then commit the same arguments with the token it gave. */
async function confirmed(args: Record<string, unknown>) {
  const preview = await call('create_category', args);
  expect(preview.s.error).toBeUndefined();
  expect(preview.s.status).toBe('preview');
  return call('create_category', {
    ...args,
    confirmationToken: preview.s.confirmationToken,
  });
}

const codeOf = (r: { s: Structured }) => r.s.error?.code;
const stored = (name: string) =>
  db.tables.category.find((c) => c.name === name);

// ── create_category ──────────────────────────────────────────────────────

describe('create_category', () => {
  it('a top-level category: the preview writes nothing, the yes creates it, with no Arabic name made up', async () => {
    const before = db.counts();

    const preview = await call('create_category', { name: 'Mirrors' });

    expect(preview.s.status).toBe('preview');
    expect(preview.text).toContain('Mirrors, at the top level');
    expect(preview.s.data).toEqual({
      id: null,
      name: 'Mirrors',
      nameAr: null,
      parent: null,
    });
    expect(db.counts()).toEqual(before);

    const r = await call('create_category', {
      name: 'Mirrors',
      confirmationToken: preview.s.confirmationToken,
    });

    expect(r.s.status).toBe('committed');
    const row = stored('Mirrors')!;
    expect(row).toMatchObject({ nameAr: null, parentId: null });
    expect(r.s.data).toMatchObject({ id: row.id, parent: null });
  });

  it('the audit row names the signed-in partner (§16: attribution)', async () => {
    await confirmed({ name: 'Mirrors' });
    expect(db.tables.auditLog).toEqual([
      expect.objectContaining({
        action: 'CREATE',
        entityType: 'Category',
        entityId: stored('Mirrors')!.id,
        actorUserId: partner.id,
      }),
    ]);
  });

  it('an Arabic name the partner gave is stored, trimmed', async () => {
    const r = await confirmed({ name: 'Mirrors', nameAr: '  مرايات ' });
    expect(r.s.error).toBeUndefined();
    expect(stored('Mirrors')!.nameAr).toBe('مرايات');
  });

  it('a parent by its English name, in any case — the preview names it', async () => {
    const preview = await call('create_category', {
      name: 'Brake pads',
      parent: 'brakes',
    });
    expect(preview.text).toContain('under Brakes (فرامل)');

    await confirmed({ name: 'Brake pads', parent: 'brakes' });
    expect(stored('Brake pads')!.parentId).toBe(ids.brakes);
  });

  it('a parent by its Arabic name, spelled with vowel marks', async () => {
    const r = await confirmed({ name: 'Brake pads', parent: 'فَرامِل' });
    expect(r.s.error).toBeUndefined();
    expect(stored('Brake pads')!.parentId).toBe(ids.brakes);
  });

  it('a parent by its Arabic name, spelled ه for ة and ا for إ', async () => {
    const r = await confirmed({ name: 'Headlights', parent: 'اضاءه' });
    expect(r.s.error).toBeUndefined();
    expect(stored('Headlights')!.parentId).toBe(ids.lighting);
  });

  it('a parent by its id', async () => {
    const r = await confirmed({ name: 'Tubes', parent: ids.tyres });
    expect(r.s.error).toBeUndefined();
    expect(r.s.data).toMatchObject({
      parent: { id: ids.tyres, name: 'Tyres', nameAr: null },
    });
    expect(stored('Tubes')!.parentId).toBe(ids.tyres);
  });

  it('an English name already taken → CATEGORY_NAME_TAKEN, also with space around it; nothing written', async () => {
    const before = db.counts();
    for (const name of ['Brakes', '  Brakes ']) {
      const r = await call('create_category', { name });
      expect(codeOf(r)).toBe('CATEGORY_NAME_TAKEN');
    }
    expect(db.counts()).toEqual(before);
  });

  it('an Arabic name already taken → CATEGORY_NAME_AR_TAKEN, naming the category that has it', async () => {
    const r = await call('create_category', {
      name: 'Brake parts',
      nameAr: 'فرامل',
    });
    expect(codeOf(r)).toBe('CATEGORY_NAME_AR_TAKEN');
    expect(r.s.error?.params).toEqual({ nameAr: 'فرامل', category: 'Brakes' });
    expect(stored('Brake parts')).toBeUndefined();
  });

  it('a blank or whitespace name → VALIDATION_FAILED, nothing written', async () => {
    const before = db.counts();
    for (const name of ['', '   ']) {
      const r = await call('create_category', { name });
      expect(codeOf(r)).toBe('VALIDATION_FAILED');
      expect(r.s.error?.params).toEqual({ fields: 'name' });
    }
    expect(db.counts()).toEqual(before);
  });

  it('an Arabic name past 200 characters → NAME_AR_TOO_LONG, nothing written', async () => {
    const r = await call('create_category', {
      name: 'Pads',
      nameAr: 'ب'.repeat(201),
    });
    expect(codeOf(r)).toBe('NAME_AR_TOO_LONG');
    expect(stored('Pads')).toBeUndefined();
  });

  it('an Arabic name that is not text is refused, nothing written', async () => {
    const r = await call('create_category', { name: 'Pads', nameAr: 42 });
    expect(r.isError).toBe(true);
    // Refused for the Arabic name — not because there is no such tool.
    expect(r.text).toMatch(/nameAr/);
    expect(r.s.status).not.toBe('preview');
    expect(stored('Pads')).toBeUndefined();
  });

  it('a parent nobody has → CATEGORY_PARENT_NOT_FOUND naming it; an id that is no category too', async () => {
    for (const parent of ['Exhausts', randomUUID(), 'not-an-id']) {
      const r = await call('create_category', { name: 'Silencers', parent });
      expect(codeOf(r)).toBe('CATEGORY_PARENT_NOT_FOUND');
      expect(r.s.error?.params).toMatchObject({ parent });
    }
    expect(stored('Silencers')).toBeUndefined();
  });

  it('a parent that is only close is refused, offering the close one — never taken', async () => {
    const r = await call('create_category', { name: 'Pads', parent: 'Brake' });
    expect(codeOf(r)).toBe('CATEGORY_PARENT_NOT_FOUND');
    expect(r.s.error?.params).toEqual({
      parent: 'Brake',
      closest: 'Brakes (فرامل)',
    });
    expect(stored('Pads')).toBeUndefined();
  });

  it('a parent name two categories answer to → CATEGORY_PARENT_AMBIGUOUS listing both, never a guess', async () => {
    db.insert('category', { name: 'Body kit', nameAr: 'شنطة' });
    db.insert('category', { name: 'Bags', nameAr: 'شنطه' });
    db.insert('category', { name: 'Brake pads' });
    db.insert('category', { name: 'Brake-pads' });

    const ar = await call('create_category', { name: 'Side', parent: 'شنطة' });
    const en = await call('create_category', {
      name: 'Rear',
      parent: 'brake pads',
    });

    expect(codeOf(ar)).toBe('CATEGORY_PARENT_AMBIGUOUS');
    expect(String(ar.s.error?.params?.candidates)).toContain('Body kit (شنطة)');
    expect(String(ar.s.error?.params?.candidates)).toContain('Bags (شنطه)');
    expect(codeOf(en)).toBe('CATEGORY_PARENT_AMBIGUOUS');
    expect(en.s.error?.params?.candidates).toBe('Brake pads, Brake-pads');
    expect(stored('Side')).toBeUndefined();
    expect(stored('Rear')).toBeUndefined();
  });

  it('one confirmation used twice → CONFIRMATION_USED, one category', async () => {
    const args = { name: 'Mirrors' };
    const preview = await call('create_category', args);
    const token = preview.s.confirmationToken;

    const first = await call('create_category', {
      ...args,
      confirmationToken: token,
    });
    const second = await call('create_category', {
      ...args,
      confirmationToken: token,
    });

    expect(first.s.status).toBe('committed');
    expect(codeOf(second)).toBe('CONFIRMATION_USED');
    expect(db.tables.category.filter((c) => c.name === 'Mirrors')).toHaveLength(
      1,
    );
  });

  it('confirming different arguments than were previewed → CONFIRMATION_MISMATCH, nothing written', async () => {
    const preview = await call('create_category', { name: 'Mirrors' });
    const r = await call('create_category', {
      name: 'Mirrors',
      parent: 'Brakes',
      confirmationToken: preview.s.confirmationToken,
    });
    expect(codeOf(r)).toBe('CONFIRMATION_MISMATCH');
    expect(stored('Mirrors')).toBeUndefined();
  });

  it('the parent a name meant changed between the preview and the yes → PREVIEW_CHANGED, nothing written', async () => {
    const args = { name: 'Tubes', parent: 'Tyres' };
    const preview = await call('create_category', args);
    // Someone renames Tyres and makes a new "Tyres" in the office meanwhile.
    const i = db.tables.category.findIndex((c) => c.id === ids.tyres);
    db.tables.category[i] = { ...db.tables.category[i], name: 'Tyres (old)' };
    db.insert('category', { name: 'Tyres' });

    const r = await call('create_category', {
      ...args,
      confirmationToken: preview.s.confirmationToken,
    });

    expect(codeOf(r)).toBe('PREVIEW_CHANGED');
    expect(stored('Tubes')).toBeUndefined();
  });

  it('the tool tells the model not to translate', async () => {
    const { tools } = await client.listTools();
    const create = tools.find((t) => t.name === 'create_category')!;
    const nameAr = (
      create.inputSchema.properties as Record<string, { description?: string }>
    ).nameAr;
    expect(create.description).toMatch(/never a translation/i);
    expect(nameAr.description).toMatch(/never translate/i);
  });
});

// ── Roles (CLAUDE.md §12) ────────────────────────────────────────────────

describe("create_category — roles are the office endpoint's", () => {
  it.each(['TEMP_INVESTOR', 'ADMIN_SUPPORT'] as const)(
    'a role POST /categories refuses (%s) is refused here too, nothing written',
    async (role) => {
      const other = await connectAs({ ...partner, role });
      const before = db.counts();
      const r = await call('create_category', { name: 'Mirrors' }, other);
      await other.close();
      expect(codeOf(r)).toBe('ROLE_NOT_ALLOWED');
      expect(db.counts()).toEqual(before);
    },
  );

  it('a core partner, whom POST /categories allows, is allowed', async () => {
    const r = await confirmed({ name: 'Mirrors' });
    expect(r.s.status).toBe('committed');
  });
});

// ── list_categories ──────────────────────────────────────────────────────

describe('list_categories', () => {
  it('returns both names, the parent and the product count; no Arabic name is null', async () => {
    db.insert('category', { name: 'Brake pads', parentId: ids.brakes });

    const r = await call('list_categories', {});

    expect(r.isError).toBeFalsy();
    const rows = r.s.data as Array<Record<string, unknown>>;
    expect(rows.map((c) => c.name)).toEqual([
      'Brake pads',
      'Brakes',
      'Lighting',
      'Tyres',
    ]);
    expect(rows[0]).toEqual({
      id: stored('Brake pads')!.id,
      name: 'Brake pads',
      nameAr: null,
      parentId: ids.brakes,
      parent: 'Brakes',
      parentAr: 'فرامل',
      products: 0,
    });
    expect(rows[1]).toMatchObject({
      name: 'Brakes',
      nameAr: 'فرامل',
      parentId: null,
      parent: null,
      products: 2,
    });
    expect(rows[3]).toMatchObject({ name: 'Tyres', nameAr: null });
    // A client that ignores structuredContent still gets the facts.
    expect(r.text).toContain('Brake pads');
  });

  it('the id it gives is the one create_product takes', async () => {
    const r = await call('list_categories', {});
    const brakes = (r.s.data as Array<{ id: string; name: string }>).find(
      (c) => c.name === 'Brakes',
    )!;
    expect(brakes.id).toBe(ids.brakes);
  });
});

// ── The office form gets the same rules (one definition) ─────────────────

describe('ProductsService.createCategory — the office path', () => {
  const refusal = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (err) {
      return (err as HttpException).getResponse() as { code: string };
    }
    throw new Error('expected a refusal');
  };

  it('a blank name is refused, not stored as a category called nothing', async () => {
    expect(
      await refusal(products.createCategory({ name: '  ' }, partner.id)),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(db.tables.category).toHaveLength(3);
  });

  it('a parent id that is no category → NOT_FOUND, never a 500 from the foreign key', async () => {
    for (const parentId of [randomUUID(), 'abc']) {
      expect(
        await refusal(
          products.createCategory({ name: 'Orphan', parentId }, partner.id),
        ),
      ).toMatchObject({ code: 'NOT_FOUND' });
    }
    expect(stored('Orphan')).toBeUndefined();
  });
});
