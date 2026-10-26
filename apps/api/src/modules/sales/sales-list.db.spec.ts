import { randomUUID } from 'crypto';
import { HttpException } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- this suite talks to a real, throwaway Postgres; that is its point
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import { PaymentsService } from '../payments/payments.service';
import { CustomersService } from '../customers/customers.service';
import { SalesService } from './sales.service';

/**
 * The Sales list on the server (owner 2026-10-25, "server-side search,
 * filters, sorting and pagination everywhere"; and "the Sales list filters by
 * customer", with a branch filter for a customer with branches) — against a
 * real Postgres, through `SalesService.findAll`, the endpoint's own code.
 *
 * The fixture is a shop with more orders than one page (23, at 10 a page), so
 * a list that paged, counted or filtered only the rows it had loaded would
 * give a different answer. Each assertion is narrowed to this run's own shops,
 * so the suite runs again on the same database and beside other suites.
 *
 * Opt-in, a THROWAWAY database only (CLAUDE.md rule 6):
 *
 *   INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/motorcycle_parts_<name> \
 *     npx jest sales-list.db
 */
// eslint-disable-next-line no-restricted-properties -- an opt-in switch for a suite that must never run by default
const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;

type Row = {
  id: string;
  orderNo: string;
  status: string;
  customerId: string;
  branchId: string | null;
  createdAt: Date;
};
type Meta = {
  page?: number;
  pageSize?: number;
  total?: number;
  totalPages?: number;
  nextCursor: string | null;
};

suite('the Sales list, searched, filtered and paged by Postgres', () => {
  let prisma: PrismaClient;
  let sales: SalesService;
  let customers: CustomersService;
  let actor: string;
  const tag = randomUUID().slice(0, 6);
  // An Arabic shop, written with hamza and taa marbuta and a vowel mark, so
  // the forgiving search has something to forgive.
  const arabicName = `مَحَلّ أحمد للخوذة ${tag}`;
  let shopA: { id: string };
  let productId: string;
  let shopB: { id: string };
  let mokattam: { id: string };
  let master: { id: string };
  let otherBranch: { id: string };
  /** Shop A's orders by where they went. */
  const onOwner: string[] = [];
  const onMokattam: string[] = [];
  const onMaster: string[] = [];
  const drafts: string[] = [];

  const list = (q: Record<string, unknown>) =>
    sales.findAll(q) as Promise<{ data: Row[]; meta: Meta }>;

  async function refusal(p: Promise<unknown>) {
    try {
      await p;
    } catch (e) {
      if (!(e instanceof HttpException)) throw e;
      return (e.getResponse() as { code: string }).code;
    }
    throw new Error('expected a refusal, got success');
  }

  /** Every page of a query, walked as the list's pager would. */
  async function everyPage(q: Record<string, unknown>, pageSize: number) {
    const first = await list({ ...q, page: '1', pageSize: String(pageSize) });
    const rows = [...first.data];
    for (let p = 2; p <= (first.meta.totalPages ?? 0); p++) {
      rows.push(
        ...(await list({ ...q, page: String(p), pageSize: String(pageSize) }))
          .data,
      );
    }
    return { rows, total: first.meta.total, totalPages: first.meta.totalPages };
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const db = prisma as unknown as PrismaService;
    const audit = { log: jest.fn() } as unknown as AuditService;
    const payments = new PaymentsService(db, audit);
    sales = new SalesService(db, audit, payments, {
      createForMultipleUsers: () => Promise.resolve({ count: 0 }),
    });
    customers = new CustomersService(db, audit, {} as never);
    const user = await prisma.user.create({
      data: {
        email: `sales-list-${randomUUID()}@example.com`,
        passwordHash: 'x',
        role: 'CORE_PARTNER',
      },
    });
    actor = user.id;

    // Stock, as the business makes it: a selling cycle's verified batch.
    const cycle = await prisma.importCycle.create({
      data: {
        code: `LST-${tag}`,
        originType: 'UAE_DIRECT',
        currency: 'EGP',
        status: 'SELLING',
      },
    });
    const product = await prisma.product.create({
      data: { sku: `LST-${tag}`, name: `List part ${tag}`, status: 'ACTIVE' },
    });
    productId = product.id;
    await prisma.inventoryBatch.create({
      data: {
        cycleId: cycle.id,
        productId: product.id,
        receivedQty: 1000,
        remainingQty: 1000,
        saleableQty: 1000,
        landedUnitCostEgp: 10,
        verificationStatus: 'VERIFIED',
      },
    });

    shopA = await prisma.customer.create({
      data: {
        type: 'B2B',
        displayName: arabicName,
        verificationStatus: 'VERIFIED',
      },
    });
    shopB = await prisma.customer.create({
      data: {
        type: 'B2B',
        displayName: `Shop B ${tag}`,
        verificationStatus: 'VERIFIED',
      },
    });

    const sell = async (
      customerId: string,
      extra: { branchId?: string; confirm?: boolean } = {},
    ) => {
      const made = (await sales.create(
        {
          customerId,
          channel: 'B2B',
          currency: 'EGP',
          items: [{ productId: product.id, quantity: 1, unitPrice: 50 }],
          confirm: extra.confirm ?? true,
          ...(extra.branchId ? { branchId: extra.branchId } : {}),
        },
        actor,
      )) as { data?: { id: string }; id?: string };
      return made.data?.id ?? (made as { id: string }).id;
    };

    // Before shop A had branches: its orders are on the owner.
    for (let i = 0; i < 5; i++) onOwner.push(await sell(shopA.id));
    for (let i = 0; i < 3; i++) {
      drafts.push(await sell(shopA.id, { confirm: false }));
    }
    mokattam = await prisma.customerBranch.create({
      data: { customerId: shopA.id, name: `Mokattam ${tag}` },
    });
    master = await prisma.customerBranch.create({
      data: { customerId: shopA.id, name: `Master ${tag}` },
    });
    otherBranch = await prisma.customerBranch.create({
      data: { customerId: shopB.id, name: `Elsewhere ${tag}` },
    });
    for (let i = 0; i < 8; i++) {
      onMokattam.push(await sell(shopA.id, { branchId: mokattam.id }));
    }
    for (let i = 0; i < 7; i++) {
      onMaster.push(await sell(shopA.id, { branchId: master.id }));
    }
    for (let i = 0; i < 3; i++) await sell(shopB.id);
  }, 300_000);
  afterAll(() => prisma.$disconnect());

  // 5 on the owner + 3 drafts + 8 + 7 on branches = 23: more than a page.
  const SHOP_A_ORDERS = 23;

  describe('pages', () => {
    it('page 1 is 10 of 23, newest first, and the count is every match', async () => {
      const { data, meta } = await list({ customerId: shopA.id, page: '1' });
      expect(meta).toMatchObject({
        page: 1,
        pageSize: 10,
        total: SHOP_A_ORDERS,
        totalPages: 3,
      });
      expect(data).toHaveLength(10);
      // The newest order of all is the last one Master was sold.
      expect(data[0].id).toBe(onMaster[onMaster.length - 1]);
      expect(data.every((o) => o.customerId === shopA.id)).toBe(true);
    });

    it('walking every page gives each order once — the count matches the rows', async () => {
      const { rows, total, totalPages } = await everyPage(
        { customerId: shopA.id },
        7,
      );
      expect(totalPages).toBe(4);
      expect(rows).toHaveLength(total!);
      expect(new Set(rows.map((r) => r.id)).size).toBe(SHOP_A_ORDERS);
      const all = [...onOwner, ...drafts, ...onMokattam, ...onMaster];
      expect(new Set(rows.map((r) => r.id))).toEqual(new Set(all));
      // Newest first across the pages, not only within one.
      const times = rows.map((r) => new Date(r.createdAt).getTime());
      expect([...times].sort((a, b) => b - a)).toEqual(times);
    });

    it('the last page holds the remainder', async () => {
      const { data, meta } = await list({ customerId: shopA.id, page: '3' });
      expect(data).toHaveLength(3);
      expect(meta.totalPages).toBe(3);
    });

    it('a page past the end is empty and still says how many there are', async () => {
      const { data, meta } = await list({ customerId: shopA.id, page: '4' });
      expect(data).toEqual([]);
      expect(meta).toMatchObject({ total: SHOP_A_ORDERS, totalPages: 3 });
      const far = await list({ customerId: shopA.id, page: '100000' });
      expect(far.data).toEqual([]);
      expect(far.meta.total).toBe(SHOP_A_ORDERS);
    });

    it.each(['0', '-1', '-100', '1.5', 'abc', '2;DROP TABLE sale_orders'])(
      'page "%s" is refused, not read as page 1',
      async (page) => {
        expect(await refusal(list({ customerId: shopA.id, page }))).toBe(
          'LIST_PAGE_INVALID',
        );
      },
    );

    it('a page too large to skip to is refused, never a database error', async () => {
      for (const page of ['99999999999999999999', '2147483648', '1000001']) {
        expect(await refusal(list({ customerId: shopA.id, page }))).toBe(
          'LIST_PAGE_INVALID',
        );
      }
    });

    it.each(['0', '-5', '201', '1000000', '99999999999999999999', '1e3'])(
      'page size "%s" is refused (1 to 200)',
      async (pageSize) => {
        expect(
          await refusal(list({ customerId: shopA.id, page: '1', pageSize })),
        ).toBe('LIST_PAGE_SIZE_INVALID');
      },
    );

    it('the largest page, 200, holds all 23 on one page', async () => {
      const { data, meta } = await list({
        customerId: shopA.id,
        page: '1',
        pageSize: '200',
      });
      expect(data).toHaveLength(SHOP_A_ORDERS);
      expect(meta.totalPages).toBe(1);
    });
  });

  describe('sort', () => {
    it('the one order it offers, by name, is the default order', async () => {
      const named = await list({
        customerId: shopA.id,
        page: '1',
        sort: 'newest',
      });
      const unnamed = await list({ customerId: shopA.id, page: '1' });
      expect(named.data.map((o) => o.id)).toEqual(
        unnamed.data.map((o) => o.id),
      );
    });

    it.each(['oldest', 'createdAt', 'id; DROP TABLE sale_orders', 'NEWEST'])(
      'an order it does not offer (%s) is refused, not quietly ignored',
      async (sort) => {
        expect(
          await refusal(list({ customerId: shopA.id, page: '1', sort })),
        ).toBe('LIST_SORT_UNKNOWN');
      },
    );
  });

  describe('search', () => {
    it.each([
      ['plain alef for hamza', 'احمد'],
      ['the hamza as typed', 'أحمد'],
      ['alef madda', 'آحمد'],
      ['taa marbuta as haa', 'للخوذه'],
      ['vowel marks typed', 'مَحَلّ'],
      ['no vowel marks', 'محل'],
    ])('Arabic, %s, finds the shop (%s)', async (_how, term) => {
      const { meta } = await list({
        customerId: shopA.id,
        page: '1',
        search: term,
      });
      expect(meta.total).toBe(SHOP_A_ORDERS);
    });

    it('the Arabic search finds the shop without the customer filter too, and only shops that match', async () => {
      const { rows } = await everyPage({ search: `احمد للخوذه ${tag}` }, 200);
      expect(rows).toHaveLength(SHOP_A_ORDERS);
      expect(rows.every((r) => r.customerId === shopA.id)).toBe(true);
    });

    it('an order number finds that order alone', async () => {
      const order = await prisma.saleOrder.findUniqueOrThrow({
        where: { id: onMokattam[2] },
      });
      const { data, meta } = await list({
        customerId: shopA.id,
        page: '1',
        search: ` ${order.orderNo.toLowerCase()} `,
      });
      expect(meta.total).toBe(1);
      expect(data[0].id).toBe(order.id);
    });

    it.each([
      ["'; DROP TABLE sale_orders; --"],
      ["' OR '1'='1"],
      ['%'],
      ['_'],
      ['\\'],
      ['") OR 1=1 --'],
    ])('SQL-ish input %s matches nothing and breaks nothing', async (term) => {
      const { data, meta } = await list({
        customerId: shopA.id,
        page: '1',
        search: term,
      });
      // `%` and `_` are LIKE wildcards: a search built on LIKE would match all.
      expect(meta.total).toBe(0);
      expect(data).toEqual([]);
      // The table is still there, every order in it.
      expect(
        await prisma.saleOrder.count({ where: { customerId: shopA.id } }),
      ).toBe(SHOP_A_ORDERS);
    });

    it('a search longer than 100 characters is refused; one sent twice is refused', async () => {
      expect(
        await refusal(
          list({ customerId: shopA.id, page: '1', search: 'x'.repeat(101) }),
        ),
      ).toBe('LIST_SEARCH_TOO_LONG');
      expect(
        await refusal(
          list({ customerId: shopA.id, page: '1', search: ['a', 'b'] }),
        ),
      ).toBe('VALIDATION_FAILED');
    });
  });

  describe('filters', () => {
    it("one shop's orders: the other shop's never show", async () => {
      const { rows, total } = await everyPage({ customerId: shopB.id }, 2);
      expect(total).toBe(3);
      expect(rows.every((r) => r.customerId === shopB.id)).toBe(true);
    });

    it('a customer that does not exist, or an id that cannot be one, is refused — not an empty list', async () => {
      expect(await refusal(list({ customerId: randomUUID(), page: '1' }))).toBe(
        'NOT_FOUND',
      );
      expect(await refusal(list({ customerId: "x' OR 1=1", page: '1' }))).toBe(
        'VALIDATION_FAILED',
      );
    });

    it('walk-in is its own choice: only walk-in orders', async () => {
      const { data } = await list({ customerId: 'walk-in', page: '1' });
      const walkIn = await prisma.customer.findFirst({
        where: { isWalkIn: true },
      });
      expect(data.every((o) => o.customerId === walkIn?.id)).toBe(true);
    });

    it('a status the list does not offer is refused before Postgres sees it', async () => {
      expect(
        await refusal(
          list({ customerId: shopA.id, page: '1', status: 'paid' }),
        ),
      ).toBe('LIST_FILTER_INVALID');
    });

    it("one branch's orders, and the orders on the owner", async () => {
      const m = await everyPage(
        { customerId: shopA.id, branchId: mokattam.id },
        3,
      );
      expect(m.total).toBe(8);
      expect(new Set(m.rows.map((r) => r.id))).toEqual(new Set(onMokattam));
      const owner = await everyPage(
        { customerId: shopA.id, branchId: 'none' },
        3,
      );
      // The drafts were made before the branches too: on the owner.
      expect(new Set(owner.rows.map((r) => r.id))).toEqual(
        new Set([...onOwner, ...drafts]),
      );
      expect(owner.total).toBe(8);
    });

    it('an archived branch still lists its orders', async () => {
      await prisma.customerBranch.update({
        where: { id: master.id },
        data: { archivedAt: new Date() },
      });
      try {
        const { meta } = await list({
          customerId: shopA.id,
          branchId: master.id,
          page: '1',
        });
        expect(meta.total).toBe(7);
      } finally {
        await prisma.customerBranch.update({
          where: { id: master.id },
          data: { archivedAt: null },
        });
      }
    });

    it('another customer\'s branch is refused, not answered with "no orders"', async () => {
      expect(
        await refusal(
          list({ customerId: shopA.id, branchId: otherBranch.id, page: '1' }),
        ),
      ).toBe('BRANCH_NOT_THIS_CUSTOMER');
    });

    it('a branch that does not exist, or cannot be an id, is refused', async () => {
      for (const branchId of [randomUUID(), 'mokattam', "' OR 1=1 --"]) {
        expect(
          await refusal(list({ customerId: shopA.id, branchId, page: '1' })),
        ).toBe('NOT_FOUND');
      }
    });

    it('a branch with no customer, or with the walk-in buyer, is refused', async () => {
      expect(await refusal(list({ branchId: mokattam.id, page: '1' }))).toBe(
        'LIST_FILTER_INVALID',
      );
      expect(await refusal(list({ branchId: 'none', page: '1' }))).toBe(
        'LIST_FILTER_INVALID',
      );
      expect(
        await refusal(
          list({ customerId: 'walk-in', branchId: 'none', page: '1' }),
        ),
      ).toBe('LIST_FILTER_INVALID');
    });

    it('a filter, a search and a sort together: each narrows, the count matches the rows', async () => {
      const q = {
        customerId: shopA.id,
        branchId: 'none',
        status: 'CONFIRMED',
        search: 'أحمد',
        sort: 'newest',
      };
      const { rows, total } = await everyPage(q, 2);
      expect(total).toBe(onOwner.length);
      expect(new Set(rows.map((r) => r.id))).toEqual(new Set(onOwner));
      expect(rows.every((r) => r.status === 'CONFIRMED')).toBe(true);
      // The drafts on the owner are left out by the status, not by the page.
      const draftsOnly = await list({ ...q, status: 'DRAFT', page: '1' });
      expect(new Set(draftsOnly.data.map((r) => r.id))).toEqual(
        new Set(drafts),
      );
      // And the search still narrows: shop A's name does not hold shop B's.
      const none = await list({ ...q, search: `Shop B ${tag}`, page: '1' });
      expect(none.meta.total).toBe(0);
    });
  });

  describe('the second visit', () => {
    it('an order added after the first look is counted and shown on the next', async () => {
      const before = await list({ customerId: shopB.id, page: '1' });
      const added = await prisma.saleOrder.findFirstOrThrow({
        where: { customerId: shopB.id },
      });
      await prisma.saleOrder.update({
        where: { id: added.id },
        data: { status: 'CANCELLED' },
      });
      try {
        const after = await list({
          customerId: shopB.id,
          status: 'CANCELLED',
          page: '1',
        });
        expect(after.meta.total).toBe(1);
        expect(after.data[0].id).toBe(added.id);
        const again = await list({ customerId: shopB.id, page: '1' });
        expect(again.meta.total).toBe(before.meta.total);
      } finally {
        await prisma.saleOrder.update({
          where: { id: added.id },
          data: { status: added.status },
        });
      }
    });

    it('without a page the picker and the export still walk cursors, with the same filters', async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const answer: { data: Row[]; meta: Meta } = await list({
          customerId: shopA.id,
          branchId: mokattam.id,
          limit: '3',
          ...(cursor ? { cursor } : {}),
        });
        expect(answer.meta.total).toBeUndefined();
        seen.push(...answer.data.map((r) => r.id));
        cursor = answer.meta.nextCursor;
      } while (cursor);
      expect(seen).toHaveLength(8);
      expect(new Set(seen)).toEqual(new Set(onMokattam));
    });
  });

  it('the customers list never offers the walk-in record, searched for by name or not (§4)', async () => {
    // A walk-in sale, so the record exists in this database.
    await sales.create(
      {
        walkIn: true,
        channel: 'B2C',
        currency: 'EGP',
        items: [{ productId, quantity: 1, unitPrice: 50 }],
      },
      actor,
    );
    for (const search of ['Walk', 'walk-in', '']) {
      const answer = (await customers.findAll({
        page: '1',
        pageSize: '200',
        search,
      })) as { data: { isWalkIn: boolean }[] };
      expect(answer.data.some((c) => c.isWalkIn)).toBe(false);
    }
  });

  it('the customers list pages and searches the same way (the Arabic shop by plain letters)', async () => {
    const answer = (await customers.findAll({
      page: '1',
      pageSize: '1',
      search: `احمد للخوذه ${tag}`,
    })) as { data: { id: string }[]; meta: Meta };
    expect(answer.meta.total).toBe(1);
    expect(answer.data[0].id).toBe(shopA.id);
  });
});
