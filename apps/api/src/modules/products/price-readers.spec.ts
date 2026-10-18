/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- the fake database's rows are untyped records, as Prisma's argument objects are */
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- the fake carries Prisma's own decimals
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { ProductsService } from './products.service';
import { PortalCatalogueService } from '../portal/portal-catalogue.service';

/**
 * Every reader of a product's price gives the same figure (BUSINESS_LOGIC §3,
 * 2026-10-18; CLAUDE.md rule 11): the products list — which is also what the
 * New Order popup prefills its lines from — the product page, and the
 * storefront's catalogue and product page. The assistant's find_products reads
 * the products list itself (read-tools.spec), and record_sale the same
 * function (tools/sales.spec).
 */

const D = (v: number | string) => new Prisma.Decimal(v);

interface World {
  products: any[];
  prices: any[];
  batches: any[];
}

function world(): World {
  return {
    products: [
      // Two batches on the shelf: 30 at 100 and 10 at 140 → 110 → 132.
      { id: 'mix', sku: 'MIX', name: 'Mixed batches', status: 'ACTIVE' },
      // B2B set at 150; B2C left to the default of landed 100 → 120.
      { id: 'b2b', sku: 'B2B', name: 'B2B set', status: 'ACTIVE' },
      // Switched off, still on the shelf: priced as before it was switched off.
      { id: 'off', sku: 'OFF', name: 'Switched off', status: 'INACTIVE' },
      // Never received, no price: nothing to show.
      { id: 'new', sku: 'NEW', name: 'Never received', status: 'ACTIVE' },
    ].map((p) => ({
      nameAr: null,
      description: null,
      descriptionAr: null,
      categoryId: null,
      createdAt: new Date('2026-09-01T00:00:00Z'),
      ...p,
    })),
    prices: [
      {
        productId: 'b2b',
        channel: 'B2B',
        currency: 'EGP',
        amount: D(150),
        effectiveTo: null,
      },
    ],
    batches: [
      batchRow('mix', 30, 100, '2026-08-01'),
      batchRow('mix', 10, 140, '2026-09-01'),
      batchRow('b2b', 5, 100, '2026-09-01'),
      batchRow('off', 3, 200, '2026-09-01'),
    ],
  };
}

function batchRow(productId: string, qty: number, cost: number, day: string) {
  return {
    id: `${productId}-${day}`,
    productId,
    remainingQty: D(qty),
    saleableQty: D(qty),
    landedUnitCostEgp: D(cost),
    verificationStatus: 'VERIFIED',
    createdAt: new Date(`${day}T00:00:00Z`),
  };
}

function fakePrisma(w: World) {
  const shape = (p: any, include: any = {}) => ({
    ...p,
    category: null,
    prices: w.prices.filter((r) => r.productId === p.id),
    suppliers: [],
    compatibilities: [],
    fileAssets: [],
    ...(include.inventoryBatches
      ? {
          inventoryBatches: w.batches
            .filter((b) => b.productId === p.id)
            .map((b) => ({ remainingQty: b.remainingQty })),
        }
      : {}),
  });
  return {
    product: {
      findMany: ({ include }: any = {}) =>
        Promise.resolve(w.products.map((p) => shape(p, include))),
      findUnique: ({ where, include }: any) => {
        const p = w.products.find((x) =>
          where.id ? x.id === where.id : x.sku === where.sku,
        );
        return Promise.resolve(p ? shape(p, include) : null);
      },
      count: () => Promise.resolve(w.products.length),
    },
    inventoryBatch: {
      findMany: ({ where }: any) =>
        Promise.resolve(
          w.batches.filter((b) => where.productId.in.includes(b.productId)),
        ),
      groupBy: ({ where }: any) => {
        const sums = new Map<string, Prisma.Decimal>();
        for (const b of w.batches.filter((x) =>
          where.productId.in.includes(x.productId),
        ))
          sums.set(
            b.productId,
            (sums.get(b.productId) ?? D(0)).add(b.saleableQty),
          );
        return Promise.resolve(
          [...sums].map(([productId, s]) => ({
            productId,
            _sum: { saleableQty: s },
          })),
        );
      },
      count: ({ where }: any) =>
        Promise.resolve(
          w.batches.filter(
            (b) => b.productId === where.productId && b.saleableQty.gt(0),
          ).length,
        ),
    },
    inventoryReservation: { findMany: () => Promise.resolve([]) },
  } as unknown as PrismaService;
}

function services(w = world()) {
  const prisma = fakePrisma(w);
  return {
    products: new ProductsService(
      prisma,
      { log: jest.fn() } as unknown as AuditService,
      {} as NotificationsService,
    ),
    portal: new PortalCatalogueService(prisma),
  };
}

const VERIFIED_B2B = 'shop-b2b';

/** Every reader's answer for one product on one channel, as amount + source. */
async function readers(id: string, sku: string, channel: 'B2B' | 'B2C') {
  const { products, portal } = services();
  const list = (await products.findAll({})).data.find((p) => p.id === id)!;
  const detail = (await products.findById(id)).data;
  // The storefront resolves the channel from who is asking (§12): anonymous
  // reads B2C; a verified B2B shop, B2B.
  (portal as any).viewerOf = (customerId?: string) =>
    Promise.resolve(
      customerId === VERIFIED_B2B
        ? { id: customerId, type: 'B2B', verificationStatus: 'VERIFIED' }
        : null,
    );
  const who = channel === 'B2B' ? VERIFIED_B2B : undefined;
  const shopList = (await portal.list({}, who)).data.items.find(
    (p) => p.id === id,
  )!;
  const shopPage = (await portal.bySku(sku, who)).data;
  return {
    list: list.listPrices[channel],
    detail: detail.listPrices[channel],
    storefrontList: shopList.price,
    storefrontPage: shopPage.price,
  };
}

describe('one price, whoever reads it', () => {
  it('two batches, no price set: every reader says the weighted default, 132', async () => {
    for (const channel of ['B2B', 'B2C'] as const) {
      const r = await readers('mix', 'MIX', channel);
      expect(r.list).toEqual({
        amount: '132.00',
        currency: 'EGP',
        source: 'DEFAULT',
        markupPct: 20,
      });
      expect(r.detail).toEqual(r.list);
      expect(r.storefrontList).toBe('132.00');
      expect(r.storefrontPage).toBe('132.00');
    }
  });

  it('B2B set at 150 wins on B2B; B2C, unset, is landed 100 + 20% = 120 — on every reader', async () => {
    const b2b = await readers('b2b', 'B2B', 'B2B');
    expect(b2b.list).toEqual({
      amount: '150.00',
      currency: 'EGP',
      source: 'SET',
    });
    expect(b2b.detail).toEqual(b2b.list);
    expect(b2b.storefrontList).toBe('150.00');
    expect(b2b.storefrontPage).toBe('150.00');

    const b2c = await readers('b2b', 'B2B', 'B2C');
    expect(b2c.list).toMatchObject({ amount: '120.00', source: 'DEFAULT' });
    expect(b2c.detail).toEqual(b2c.list);
    expect(b2c.storefrontList).toBe('120.00');
    expect(b2c.storefrontPage).toBe('120.00');
  });

  it('a switched-off product still on the shelf is priced as any other (status changes nothing)', async () => {
    const r = await readers('off', 'OFF', 'B2C');
    expect(r.list).toMatchObject({ amount: '240.00', source: 'DEFAULT' });
    expect(r.detail).toEqual(r.list);
    expect(r.storefrontPage).toBe('240.00');
  });

  it('a switched-off product that sold out is still gone from the storefront', async () => {
    const w = world();
    w.batches = w.batches.map((b) =>
      b.productId === 'off'
        ? { ...b, saleableQty: D(0), remainingQty: D(0) }
        : b,
    );
    const { portal, products } = services(w);
    await expect(portal.bySku('OFF')).rejects.toMatchObject({
      response: { code: 'NOT_FOUND' },
    });
    // The office still reads its default, from the last batch received.
    const detail = (await products.findById('off')).data;
    expect(detail.listPrices.B2C).toMatchObject({
      amount: '240.00',
      source: 'DEFAULT',
    });
  });

  it('never received and never priced: null everywhere, never 0', async () => {
    const r = await readers('new', 'NEW', 'B2C');
    expect(r.list).toBeNull();
    expect(r.detail).toBeNull();
    expect(r.storefrontList).toBeNull();
    expect(r.storefrontPage).toBeNull();
  });

  it('the raw price rows are still sent beside it, unchanged, for the history', async () => {
    const { products } = services();
    const detail = (await products.findById('b2b')).data;
    expect(detail.prices).toHaveLength(1);
    expect(detail.prices[0]).toMatchObject({ channel: 'B2B' });
  });
});
