import { randomUUID } from 'crypto';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- this suite talks to a real, throwaway Postgres; that is its point
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { PaymentsService } from '../payments/payments.service';
import { SalesService } from '../sales/sales.service';
import { businessToday } from '../../common/dates';
import { ProductsService } from './products.service';
import type { ProductListFilters } from './product-list-where';

/**
 * The Products tab's cards follow its filters (owner 2026-10-28: "when filter
 * by category, it shows number of products in that category, and total number
 * of units as well"). `GET /products/summary` takes the table's search,
 * category and status and answers how many products match and how many units
 * they hold on the shelf — for the whole filtered set, never one page of it.
 *
 * Every case is checked against the table itself: the cards' product count
 * must be the table's `meta.total` for the same filters, and its units the
 * table's own per-row `onHand` added up over every page. A card and a table
 * that disagree is the bug this guards against.
 *
 * Each test scopes itself by a category or a search of its own, so whatever
 * else is in the database cannot move its figures.
 *
 * Runs only against a THROWAWAY database (CLAUDE.md rule 6):
 *
 *   INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/motorcycle_parts_<name> \
 *     npx jest products-summary.db
 */
// eslint-disable-next-line no-restricted-properties -- an opt-in switch for a suite that must never run by default
const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;

const daysAgo = (n: number) => {
  const d = new Date(`${businessToday()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

suite('the Products tab’s cards follow its filters (Postgres)', () => {
  let prisma: PrismaClient;
  let products: ProductsService;
  let analytics: AnalyticsService;
  let sales: SalesService;
  let partner: string;

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const db = prisma as unknown as PrismaService;
    const audit = {
      log: (row: Record<string, unknown>) =>
        prisma.auditLog.create({ data: row as never }),
    } as unknown as AuditService;
    products = new ProductsService(db, audit, {} as never);
    analytics = new AnalyticsService(db);
    const payments = new PaymentsService(db, audit);
    sales = new SalesService(db, audit, payments, {
      createForMultipleUsers: () => Promise.resolve({ count: 0 }),
    });
    const user = await prisma.user.create({
      data: {
        email: `products-summary-${randomUUID()}@example.com`,
        passwordHash: 'x',
        role: 'CORE_PARTNER',
      },
    });
    partner = user.id;
  });
  afterAll(() => prisma.$disconnect());

  const tagOf = () => randomUUID().slice(0, 8);

  const category = async (name: string, parentId?: string) =>
    prisma.category.create({
      data: { name: `${name} ${tagOf()}`, parentId: parentId ?? null },
    });

  /** A cycle selling its goods, as the office builds one. */
  async function cycle() {
    const tag = tagOf();
    const made = await prisma.importCycle.create({
      data: {
        code: `PSU-${tag}`,
        originType: 'UAE_DIRECT',
        currency: 'EGP',
        status: 'SELLING',
      },
    });
    await prisma.cycleParticipant.create({
      data: {
        cycleId: made.id,
        participantType: 'CORE_PARTNER',
        partnerUserId: partner,
        contributionAmount: 10_000,
      },
    });
    return made.id;
  }

  /** A verified batch of `qty` of a product on a cycle. */
  const receive = (cycleId: string, productId: string, qty: number) =>
    prisma.inventoryBatch.create({
      data: {
        cycleId,
        productId,
        receivedQty: qty,
        remainingQty: qty,
        saleableQty: qty,
        landedUnitCostEgp: 50,
        verificationStatus: 'VERIFIED',
        createdAt: new Date(Date.now() - 10 * 86_400_000),
      },
    });

  /**
   * A product made through the office's own service (its Arabic search key is
   * written there), with `stock` units received on `cycleId` when given.
   */
  async function product(opts: {
    name?: string;
    nameAr?: string;
    categoryId?: string;
    status?: 'ACTIVE' | 'INACTIVE';
    stock?: number;
    cycleId?: string;
  }) {
    const { data } = await products.create(
      {
        name: opts.name ?? `Part ${tagOf()}`,
        nameAr: opts.nameAr,
        categoryId: opts.categoryId,
        status: opts.status,
      },
      partner,
    );
    if (opts.stock)
      await receive(opts.cycleId ?? (await cycle()), data.id, opts.stock);
    return data;
  }

  /** What the cards show for these filters. */
  const cards = async (filters: ProductListFilters) =>
    (await products.summary(filters)).data;

  /**
   * What the table shows for the same filters, every page walked: its total,
   * and its rows' in-stock column added up — the cards' two figures, the long
   * way round.
   */
  async function table(filters: ProductListFilters, pageSize = 5) {
    let total = 0;
    let units = 0;
    let rows = 0;
    for (let page = 1; ; page++) {
      const { data, meta } = await products.findAll({
        ...filters,
        page: String(page),
        pageSize: String(pageSize),
      });
      total = meta.total ?? 0;
      rows += data.length;
      for (const row of data) units += Number(row.onHand ?? 0);
      if (page >= (meta.totalPages ?? 0)) break;
    }
    expect(rows).toBe(total);
    return { products: total, unitsInStock: Math.round(units * 100) / 100 };
  }

  it('a category: its products and their units — not another category’s, and not its subcategories’ (the table does not include them either)', async () => {
    const brakes = await category('Brakes');
    const pads = await category('Brake pads', brakes.id);
    const helmets = await category('Helmets');
    await product({ categoryId: brakes.id, stock: 4 });
    await product({ categoryId: brakes.id, stock: 6 });
    await product({ categoryId: brakes.id }); // never received: counted, 0 units
    await product({ categoryId: pads.id, stock: 100 });
    await product({ categoryId: helmets.id, stock: 50 });

    const filters = { categoryId: brakes.id };
    expect(await cards(filters)).toEqual({ products: 3, unitsInStock: 10 });
    expect(await cards(filters)).toEqual(await table(filters));
    // The subcategory and the other category have their own figures.
    expect(await cards({ categoryId: pads.id })).toEqual({
      products: 1,
      unitsInStock: 100,
    });
    expect(await cards({ categoryId: helmets.id })).toEqual({
      products: 1,
      unitsInStock: 50,
    });
  });

  it('search in English, in Arabic (either spelling), and by SKU — the same products the table finds', async () => {
    const cat = await category('Search');
    const helmet = await product({
      name: 'Open-face Helmet',
      nameAr: 'خوذة مفتوحة',
      categoryId: cat.id,
      stock: 4,
    });
    await product({
      name: 'Brake pad',
      nameAr: 'تيل فرامل',
      categoryId: cat.id,
      stock: 6,
    });

    for (const search of ['helmet', 'HELMET', 'خوذة', 'خوذه', helmet.sku]) {
      const filters = { categoryId: cat.id, search };
      expect({ search, ...(await cards(filters)) }).toEqual({
        search,
        products: 1,
        unitsInStock: 4,
      });
      expect(await cards(filters)).toEqual(await table(filters));
    }
    // Arabic for the other one.
    expect(await cards({ categoryId: cat.id, search: 'تيل' })).toEqual({
      products: 1,
      unitsInStock: 6,
    });
    // Nothing typed is everything in the category.
    expect(await cards({ categoryId: cat.id, search: '  ' })).toEqual({
      products: 2,
      unitsInStock: 10,
    });
  });

  it('status: Active, Inactive, or all — an inactive product’s units count only when the filter takes it in', async () => {
    const cat = await category('Status');
    await product({ categoryId: cat.id, stock: 3 });
    const off = await product({ categoryId: cat.id, stock: 8 });
    await products.setStatus(off.id, 'INACTIVE', partner);

    for (const [status, expected] of [
      ['ACTIVE', { products: 1, unitsInStock: 3 }],
      ['INACTIVE', { products: 1, unitsInStock: 8 }],
      [undefined, { products: 2, unitsInStock: 11 }],
      ['', { products: 2, unitsInStock: 11 }],
    ] as const) {
      const filters = { categoryId: cat.id, status };
      expect({ status, ...(await cards(filters)) }).toEqual({
        status,
        ...expected,
      });
      expect(await cards(filters)).toEqual(await table(filters));
    }
  });

  it('nothing matches: 0 products and 0 units — not every product’s figures, not an error', async () => {
    const empty = await category('Empty');
    expect(await cards({ categoryId: empty.id })).toEqual({
      products: 0,
      unitsInStock: 0,
    });
    expect(await cards({ search: `no such part ${randomUUID()}` })).toEqual({
      products: 0,
      unitsInStock: 0,
    });
    expect(await cards({ categoryId: empty.id })).toEqual(
      await table({ categoryId: empty.id }),
    );
    // A category that does not exist matches nothing, as in the table.
    expect(await cards({ categoryId: randomUUID() })).toEqual({
      products: 0,
      unitsInStock: 0,
    });
  });

  it('paging never changes the totals: 12 products over pages of 5 — the cards count all 12, whatever page is asked', async () => {
    const cat = await category('Paged');
    const shared = await cycle();
    // 1 + 2 + … + 12 = 78 units, so a figure from one page cannot pass.
    for (let i = 1; i <= 12; i++) {
      await product({ categoryId: cat.id, stock: i, cycleId: shared });
    }
    const expected = { products: 12, unitsInStock: 78 };
    expect(await cards({ categoryId: cat.id })).toEqual(expected);
    // The summary takes no page: one sent along changes nothing.
    for (const page of ['1', '2', '3', '9']) {
      expect(await cards({ categoryId: cat.id, page, pageSize: '5' })).toEqual(
        expected,
      );
    }
    // And the table, walked page by page, agrees.
    expect(await table({ categoryId: cat.id }, 5)).toEqual(expected);
    // Its first page alone would have said 5 products.
    const first = await products.findAll({
      categoryId: cat.id,
      page: '1',
      pageSize: '5',
    });
    expect(first.data).toHaveLength(5);
    expect(first.meta.total).toBe(12);
  });

  it('a product with stock in two cycles: both batches count; a batch sold out adds 0; fractions are kept', async () => {
    const cat = await category('Two cycles');
    const p = await product({ categoryId: cat.id, stock: 3 });
    await receive(await cycle(), p.id, 7);
    await prisma.inventoryBatch.create({
      data: {
        cycleId: await cycle(),
        productId: p.id,
        receivedQty: 5,
        remainingQty: 0,
        saleableQty: 0,
        landedUnitCostEgp: 40,
        verificationStatus: 'VERIFIED',
      },
    });
    const q = await product({ categoryId: cat.id, stock: 2.5 });
    await receive(await cycle(), q.id, 0.25);

    expect(await cards({ categoryId: cat.id })).toEqual({
      products: 2,
      unitsInStock: 12.75,
    });
    expect(await cards({ categoryId: cat.id })).toEqual(
      await table({ categoryId: cat.id }),
    );
  });

  it('units sold or out at a shop as samples have left the shelf (GUESS: as the existing card and Inventory’s on-shelf figure)', async () => {
    const cat = await category('Samples');
    const p = await product({ categoryId: cat.id, stock: 10 });
    const shop = await prisma.customer.create({
      data: {
        type: 'B2B',
        displayName: `Shop ${tagOf()}`,
        verificationStatus: 'VERIFIED',
      },
    });
    const order = (quantity: number, samples: boolean) =>
      sales.create(
        {
          customerId: shop.id,
          channel: 'B2B',
          currency: 'EGP',
          orderedOn: daysAgo(2),
          items: [{ productId: p.id, quantity, unitPrice: 100 }],
          ...(samples ? { samples: true } : { confirm: true }),
        },
        partner,
      );
    await order(3, true);
    expect(await cards({ categoryId: cat.id })).toEqual({
      products: 1,
      unitsInStock: 7,
    });
    await order(2, false);
    expect(await cards({ categoryId: cat.id })).toEqual({
      products: 1,
      unitsInStock: 5,
    });
    expect(await cards({ categoryId: cat.id })).toEqual(
      await table({ categoryId: cat.id }),
    );
  });

  it('with only the default filter, the cards are the dashboard’s figures: Active is its product count, all products its units in stock', async () => {
    const [active, all, stock] = await Promise.all([
      cards({ status: 'ACTIVE' }),
      cards({}),
      analytics.getStockSummary(),
    ]);
    expect(active.products).toBe(stock.data.totalProducts);
    expect(all.unitsInStock).toBe(stock.data.unitsInStock);
  });

  it('the second time: a product added, received, sold or switched off after a first look changes the next answer', async () => {
    const cat = await category('Again');
    const first = await product({ categoryId: cat.id, stock: 5 });
    expect(await cards({ categoryId: cat.id })).toEqual({
      products: 1,
      unitsInStock: 5,
    });
    await product({ categoryId: cat.id, stock: 4 });
    expect(await cards({ categoryId: cat.id })).toEqual({
      products: 2,
      unitsInStock: 9,
    });
    await products.setStatus(first.id, 'INACTIVE', partner);
    expect(await cards({ categoryId: cat.id, status: 'ACTIVE' })).toEqual({
      products: 1,
      unitsInStock: 4,
    });
    // Moved to another category: it leaves this one's cards.
    const other = await category('Elsewhere');
    await products.update(first.id, { categoryId: other.id }, partner);
    expect(await cards({ categoryId: cat.id })).toEqual({
      products: 1,
      unitsInStock: 4,
    });
    expect(await cards({ categoryId: other.id })).toEqual({
      products: 1,
      unitsInStock: 5,
    });
  });

  it('a filter the table refuses, the cards refuse with the same code', async () => {
    const codeOf = async (filters: ProductListFilters) => {
      const both = await Promise.allSettled([
        products.summary(filters),
        products.findAll({ ...filters, page: '1' }),
      ]);
      return both.map((r) =>
        r.status === 'rejected'
          ? (r.reason as { getResponse(): { code: string } }).getResponse().code
          : 'accepted',
      );
    };
    expect(await codeOf({ status: 'DELETED' })).toEqual([
      'LIST_FILTER_INVALID',
      'LIST_FILTER_INVALID',
    ]);
    expect(await codeOf({ categoryId: 'not-a-uuid' })).toEqual([
      'VALIDATION_FAILED',
      'VALIDATION_FAILED',
    ]);
    expect(await codeOf({ search: 'x'.repeat(101) })).toEqual([
      'LIST_SEARCH_TOO_LONG',
      'LIST_SEARCH_TOO_LONG',
    ]);
    expect(await codeOf({ search: ['a', 'b'] })).toEqual([
      'VALIDATION_FAILED',
      'VALIDATION_FAILED',
    ]);
  });
});
