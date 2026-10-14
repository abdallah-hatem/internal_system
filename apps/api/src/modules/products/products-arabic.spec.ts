/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment -- a hand-written Prisma fake: `where` clauses are evaluated generically */
import type { HttpException } from '@nestjs/common';
import { randomUUID } from 'crypto';

import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { ProductsService } from './products.service';

/**
 * Arabic names through the service the office and the assistant both call
 * (BUSINESS_LOGIC §3, owner 2026-10-14), over a small fake that evaluates the
 * `where` clauses honestly — a search that forgot `nameAr` finds nothing here,
 * exactly as it would in Postgres.
 */

type Row = Record<string, any>;

function fieldMatches(value: unknown, cond: any): boolean {
  if (cond && typeof cond === 'object') {
    const fold = (v: unknown) =>
      cond.mode === 'insensitive' ? String(v).toLowerCase() : String(v);
    if ('contains' in cond)
      return (
        typeof value === 'string' && fold(value).includes(fold(cond.contains))
      );
    if ('equals' in cond)
      return typeof value === 'string' && fold(value) === fold(cond.equals);
    if ('startsWith' in cond)
      return typeof value === 'string' && value.startsWith(cond.startsWith);
  }
  return value === cond;
}

function matches(row: Row, where: any): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    if (k === 'OR') return (cond as any[]).some((w) => matches(row, w));
    if (k === 'AND') return (cond as any[]).every((w) => matches(row, w));
    if (k === 'NOT') return !matches(row, cond);
    return fieldMatches(row[k], cond);
  });
}

function table(rows: Row[]) {
  return {
    rows,
    findUnique: ({ where }: any) =>
      Promise.resolve(rows.find((r) => matches(r, where)) ?? null),
    findFirst: ({ where }: any = {}) =>
      Promise.resolve(rows.find((r) => matches(r, where)) ?? null),
    findMany: ({ where }: any = {}) =>
      Promise.resolve(rows.filter((r) => matches(r, where))),
    create: ({ data }: any) => {
      const row = { id: randomUUID(), ...data };
      rows.push(row);
      return Promise.resolve(row);
    },
    update: ({ where, data }: any) => {
      const row = rows.find((r) => matches(r, where))!;
      for (const [k, v] of Object.entries(data))
        if (v !== undefined) row[k] = v;
      return Promise.resolve(row);
    },
  };
}

function setup() {
  const category = table([]);
  const product = table([]);
  const prisma = { category, product } as unknown as PrismaService;
  const audit = { log: jest.fn() } as unknown as AuditService;
  const service = new ProductsService(
    prisma,
    audit,
    {} as NotificationsService,
  );
  return { service, category, product };
}

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return ((e as HttpException).getResponse() as { code: string }).code;
  }
}

const ACTOR = 'partner-a';

describe("a product's Arabic name and description", () => {
  it('are stored trimmed', async () => {
    const { service } = setup();
    const { data } = await service.create(
      {
        name: 'Brake pads',
        nameAr: '  تيل فرامل ',
        descriptionAr: ' تيل أمامي ',
      },
      ACTOR,
    );
    expect(data.nameAr).toBe('تيل فرامل');
    expect(data.descriptionAr).toBe('تيل أمامي');
  });

  it('sent empty or blank are stored as null, not as ""', async () => {
    const { service } = setup();
    const { data } = await service.create(
      { name: 'Chain kit', nameAr: '   ', descriptionAr: '' },
      ACTOR,
    );
    expect(data.nameAr).toBeNull();
    expect(data.descriptionAr).toBeNull();
  });

  it('too long is refused with a code, and nothing is created', async () => {
    const { service, product } = setup();
    expect(
      await codeOf(
        service.create({ name: 'X', nameAr: 'ب'.repeat(201) }, ACTOR),
      ),
    ).toBe('NAME_AR_TOO_LONG');
    expect(
      await codeOf(
        service.create({ name: 'X', descriptionAr: 'ب'.repeat(1001) }, ACTOR),
      ),
    ).toBe('DESCRIPTION_AR_TOO_LONG');
    expect(product.rows).toHaveLength(0);
  });

  it('an update that does not mention them leaves them alone (the second visit)', async () => {
    const { service } = setup();
    const { data } = await service.create(
      { name: 'Brake pads', nameAr: 'تيل فرامل', descriptionAr: 'تيل أمامي' },
      ACTOR,
    );
    const first = await service.update(
      data.id,
      { name: 'Brake pads, front' },
      ACTOR,
    );
    const second = await service.update(data.id, { minStock: 4 }, ACTOR);
    expect(first.data.nameAr).toBe('تيل فرامل');
    expect(second.data.nameAr).toBe('تيل فرامل');
    expect(second.data.descriptionAr).toBe('تيل أمامي');
  });

  it('an update that sends them empty clears them', async () => {
    const { service } = setup();
    const { data } = await service.create(
      { name: 'Brake pads', nameAr: 'تيل فرامل' },
      ACTOR,
    );
    const { data: cleared } = await service.update(
      data.id,
      { nameAr: '' },
      ACTOR,
    );
    expect(cleared.nameAr).toBeNull();
  });

  it('too long on an update is refused before the product is looked up', async () => {
    const { service } = setup();
    expect(
      await codeOf(
        service.update(randomUUID(), { nameAr: 'ب'.repeat(201) }, ACTOR),
      ),
    ).toBe('NAME_AR_TOO_LONG');
  });
});

describe('searching products finds either language and the SKU', () => {
  async function seeded() {
    const s = setup();
    await s.service.create({ name: 'Brake pads', nameAr: 'تيل فرامل' }, ACTOR);
    await s.service.create({ name: 'Chain kit' }, ACTOR);
    return s;
  }
  const names = (r: { data: { name: string }[] }) => r.data.map((p) => p.name);

  it('"تيل" finds the brake pads by their Arabic name', async () => {
    const { service } = await seeded();
    expect(names(await service.findAll({ search: 'تيل' }))).toEqual([
      'Brake pads',
    ]);
  });

  it('the English name and the SKU still match', async () => {
    const { service } = await seeded();
    expect(names(await service.findAll({ search: 'chain' }))).toEqual([
      'Chain kit',
    ]);
    expect(names(await service.findAll({ search: 'prd-000002' }))).toEqual([
      'Chain kit',
    ]);
  });

  it('a word in neither language finds nothing', async () => {
    const { service } = await seeded();
    expect(names(await service.findAll({ search: 'خوذ' }))).toEqual([]);
  });
});

describe('an Arabic search forgives spelling (§3, owner 2026-10-15)', () => {
  async function seeded() {
    const s = setup();
    await s.service.create({ name: 'Helmet', nameAr: 'خوذة هوندى' }, ACTOR);
    await s.service.create({ name: 'Tyre', nameAr: 'إطار أمامي' }, ACTOR);
    await s.service.create({ name: 'Mirror', nameAr: 'مِرْآةٌ جانبية' }, ACTOR);
    await s.service.create({ name: 'Brake pads', nameAr: 'تيل فـرامل' }, ACTOR);
    await s.service.create({ name: 'Chain kit' }, ACTOR);
    return s;
  }
  const names = (r: { data: { name: string }[] }) => r.data.map((p) => p.name);
  const find = async (search: string) =>
    names(await (await seeded()).service.findAll({ search }));

  it.each([
    ['خوذه', 'Helmet'],
    ['هوندي', 'Helmet'],
    ['اطار', 'Tyre'],
    ['أطار', 'Tyre'],
    ['امامي', 'Tyre'],
    ['مراة', 'Mirror'],
    ['مرآه', 'Mirror'],
    ['فرامل', 'Brake pads'],
    ['تَيْل', 'Brake pads'],
  ])('"%s" finds the %s', async (search, name) => {
    expect(await find(search)).toEqual([name]);
  });

  it('a different word finds nothing — ه is not ح, ة is not ت', async () => {
    expect(await find('حوندا')).toEqual([]);
    expect(await find('خوذت')).toEqual([]);
    expect(await find('زيت')).toEqual([]);
  });

  it('a search of nothing but marks finds nothing, not every Arabic name', async () => {
    expect(await find('ـــ')).toEqual([]);
  });

  it('English is unchanged: case is ignored, nothing else', async () => {
    expect(await find('HELMET')).toEqual(['Helmet']);
    expect(await find('helmét')).toEqual([]);
  });

  it('the key is written with the name on create', async () => {
    const { service, product } = setup();
    const { data } = await service.create(
      { name: 'Helmet', nameAr: ' خوذة ' },
      ACTOR,
    );
    expect(product.rows.find((r) => r.id === data.id)!.nameArSearch).toBe(
      'خوذه',
    );
    const { data: none } = await service.create({ name: 'Chain' }, ACTOR);
    expect(product.rows.find((r) => r.id === none.id)!.nameArSearch).toBeNull();
  });

  it('editing the Arabic name moves the key; an edit that leaves it alone keeps it', async () => {
    const { service, product } = setup();
    const { data } = await service.create(
      { name: 'Helmet', nameAr: 'خوذة' },
      ACTOR,
    );
    const row = () => product.rows.find((r) => r.id === data.id)!;
    await service.update(data.id, { nameAr: 'إطار' }, ACTOR);
    expect(row().nameArSearch).toBe('اطار');
    expect(names(await service.findAll({ search: 'اطار' }))).toEqual([
      'Helmet',
    ]);
    expect(names(await service.findAll({ search: 'خوذه' }))).toEqual([]);
    await service.update(data.id, { minStock: 3 }, ACTOR);
    expect(row().nameArSearch).toBe('اطار');
  });

  it('clearing the Arabic name clears the key, and the old word stops finding it', async () => {
    const { service, product } = setup();
    const { data } = await service.create(
      { name: 'Helmet', nameAr: 'خوذة' },
      ACTOR,
    );
    await service.update(data.id, { nameAr: '' }, ACTOR);
    expect(product.rows.find((r) => r.id === data.id)!.nameArSearch).toBeNull();
    expect(names(await service.findAll({ search: 'خوذه' }))).toEqual([]);
  });
});

describe("a category's Arabic name", () => {
  it('is stored trimmed; empty becomes null', async () => {
    const { service } = setup();
    const a = await service.createCategory(
      { name: 'Helmets', nameAr: ' خوذ ' },
      ACTOR,
    );
    const b = await service.createCategory(
      { name: 'Chains', nameAr: '' },
      ACTOR,
    );
    expect(a.data.nameAr).toBe('خوذ');
    expect(b.data.nameAr).toBeNull();
  });

  it('is unique when present — ignoring case and surrounding space', async () => {
    const { service, category } = setup();
    await service.createCategory({ name: 'Helmets', nameAr: 'خوذ' }, ACTOR);
    expect(
      await codeOf(
        service.createCategory({ name: 'Helmets 2', nameAr: '  خوذ ' }, ACTOR),
      ),
    ).toBe('CATEGORY_NAME_AR_TAKEN');
    // Case, for a name written in Latin letters in the Arabic field.
    await service.createCategory({ name: 'Tyres', nameAr: 'Kawetsh' }, ACTOR);
    expect(
      await codeOf(
        service.createCategory({ name: 'Tyres 2', nameAr: 'KAWETSH' }, ACTOR),
      ),
    ).toBe('CATEGORY_NAME_AR_TAKEN');
    expect(category.rows).toHaveLength(2);
  });

  it('many categories may have no Arabic name at all', async () => {
    const { service, category } = setup();
    await service.createCategory({ name: 'A' }, ACTOR);
    await service.createCategory({ name: 'B', nameAr: '' }, ACTOR);
    await service.createCategory({ name: 'C', nameAr: null }, ACTOR);
    expect(category.rows).toHaveLength(3);
  });

  it("renaming to another category's Arabic name is refused; keeping your own is not", async () => {
    const { service } = setup();
    await service.createCategory({ name: 'Helmets', nameAr: 'خوذ' }, ACTOR);
    const { data: brakes } = await service.createCategory(
      { name: 'Brakes', nameAr: 'فرامل' },
      ACTOR,
    );
    expect(
      await codeOf(service.updateCategory(brakes.id, { nameAr: 'خوذ' }, ACTOR)),
    ).toBe('CATEGORY_NAME_AR_TAKEN');
    const same = await service.updateCategory(
      brakes.id,
      { nameAr: ' فرامل ' },
      ACTOR,
    );
    expect(same.data.nameAr).toBe('فرامل');
  });

  it('an update that does not mention it keeps it', async () => {
    const { service } = setup();
    const { data } = await service.createCategory(
      { name: 'Helmets', nameAr: 'خوذ' },
      ACTOR,
    );
    const { data: renamed } = await service.updateCategory(
      data.id,
      { name: 'Helmets & visors' },
      ACTOR,
    );
    expect(renamed.nameAr).toBe('خوذ');
  });

  it('too long is refused with a code', async () => {
    const { service } = setup();
    expect(
      await codeOf(
        service.createCategory({ name: 'X', nameAr: 'ب'.repeat(201) }, ACTOR),
      ),
    ).toBe('NAME_AR_TOO_LONG');
  });
});
