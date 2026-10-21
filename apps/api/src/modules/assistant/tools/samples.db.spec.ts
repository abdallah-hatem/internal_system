/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- tool results are parsed JSON; each assertion names the field it checks */
import { randomUUID } from 'node:crypto';
import type { Type } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- this suite talks to a real, throwaway Postgres; that is its point
import { PrismaClient, type UserRole } from '@prisma/client';
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
 * The samples tools (BUSINESS_LOGIC §4 "Samples at shops", §16):
 * leave_samples, list_samples, complete_samples_sale, return_samples,
 * write_off_samples — driven through a real McpServer and the SDK's client,
 * the path Claude takes, against the real SalesService the office endpoints
 * call, on a real Postgres. A preview is the service's own write rolled back,
 * so "a preview writes nothing" is checked on the database itself.
 *
 * Beyond the happy path (CLAUDE.md §0): more than in stock, zero and negative
 * quantities, a walk-in and no shop, deciding twice, a token used twice,
 * returning more (or less) than was left, buying more than the shelf has, an
 * order that does not exist, an order that is not samples, and the roles the
 * office endpoints refuse.
 *
 * Runs only when INTEGRATION_DATABASE_URL points at a THROWAWAY database with
 * the migrations applied — an agent's own (`scripts/agent-env.sh <name>`),
 * never the developer's (CLAUDE.md rule 6):
 *
 *   INTEGRATION_DATABASE_URL=$DATABASE_URL npx jest tools/samples.db
 *
 * Each test builds its own products and shop, so it can run again on the same
 * database.
 */
// eslint-disable-next-line no-restricted-properties -- an opt-in switch for a suite that must never run by default
const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;
// Many tool calls a test, each a real transaction: more than jest's 5 s.
jest.setTimeout(60_000);

interface Structured {
  status?: string;
  confirmationToken?: string;
  data?: any;
  error?: { code: string; message: string; params?: any };
}
interface Result {
  isError?: boolean;
  s: Structured;
  text: string;
}

suite('assistant samples tools against Postgres', () => {
  let prisma: PrismaClient;
  let registry: Map<unknown, unknown>;
  const clients: Client[] = [];
  const users = new Map<UserRole, AssistantUser>();

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const db = prisma as unknown as PrismaService;
    const audit = { log: jest.fn() } as unknown as AuditService;
    const payments = new PaymentsService(db, audit);
    registry = new Map<unknown, unknown>([
      [PrismaService, db],
      [AuditService, audit],
      [PaymentsService, payments],
      [
        SalesService,
        new SalesService(db, audit, payments, {
          createForMultipleUsers: () => Promise.resolve({ count: 0 }),
        }),
      ],
    ]);
    for (const role of [
      'CORE_PARTNER',
      'ADMIN_SUPPORT',
      'TEMP_INVESTOR',
    ] as UserRole[]) {
      const u = await prisma.user.create({
        data: {
          email: `assistant-samples-${role}-${randomUUID()}@example.com`,
          passwordHash: 'x',
          role,
        },
      });
      users.set(role, { id: u.id, email: u.email, role, partner: null });
    }
  });
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close()));
    await prisma.$disconnect();
  });

  /** A tool caller signed in as `role`. */
  async function as(role: UserRole = 'CORE_PARTNER') {
    const assistant = new AssistantServer(
      new ConfirmationService(
        new JwtService({ secret: 'a-test-secret-that-is-long-enough' }),
        prisma as unknown as PrismaService,
      ),
      {
        get: (type: Type<unknown>) => registry.get(type),
      } as unknown as ModuleRef,
    );
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await assistant.create(users.get(role)!).connect(serverSide);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientSide);
    clients.push(client);
    return async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<Result> => {
      const r = (await client.callTool({
        name,
        arguments: args,
      })) as CallToolResult;
      return {
        isError: r.isError,
        s: r.structuredContent ?? {},
        text: (r.content[0] as { text: string }).text,
      };
    };
  }
  type Call = Awaited<ReturnType<typeof as>>;

  /** Preview, then commit with the token the preview gave. */
  async function previewAndCommit(
    call: Call,
    name: string,
    args: Record<string, unknown>,
  ) {
    const shown = await call(name, args);
    expect(shown.s.status).toBe('preview');
    const done = await call(name, {
      ...args,
      confirmationToken: shown.s.confirmationToken,
    });
    return { shown, done };
  }

  const codeOf = (r: Result) => r.s.error?.code;

  /** A product with one verified batch of `qty` on a selling cycle. */
  async function stocked(qty: number, cost = 100, name?: string) {
    const tag = randomUUID().slice(0, 8);
    const cycle = await prisma.importCycle.create({
      data: {
        code: `ASM-${tag}`,
        originType: 'UAE_DIRECT',
        currency: 'EGP',
        status: 'SELLING',
      },
    });
    const product = await prisma.product.create({
      data: {
        sku: `ASM-${tag}`,
        name: name ?? `Assistant sample part ${tag}`,
        status: 'ACTIVE',
      },
    });
    const batch = await prisma.inventoryBatch.create({
      data: {
        cycleId: cycle.id,
        productId: product.id,
        receivedQty: qty,
        remainingQty: qty,
        saleableQty: qty,
        landedUnitCostEgp: cost,
        verificationStatus: 'VERIFIED',
        createdAt: new Date(Date.now() - 86_400_000),
      },
    });
    return { product, batch };
  }

  async function shop() {
    return prisma.customer.create({
      data: {
        type: 'B2B',
        displayName: `Assistant Samples Shop ${randomUUID().slice(0, 8)}`,
        verificationStatus: 'VERIFIED',
      },
    });
  }

  const shelf = async (batchId: string) =>
    Number(
      (
        await prisma.inventoryBatch.findUniqueOrThrow({
          where: { id: batchId },
        })
      ).saleableQty,
    );
  const ordersOf = (customerId: string) =>
    prisma.saleOrder.findMany({ where: { customerId } });

  /** Samples of `qty` left with a new shop, through the tool. */
  async function leftWith(qty: number, stock = 10, unitPrice?: number) {
    const call = await as();
    const { product, batch } = await stocked(stock);
    const s = await shop();
    const { done } = await previewAndCommit(call, 'leave_samples', {
      customer: s.displayName,
      lines: [
        {
          product: product.name,
          qty,
          ...(unitPrice !== undefined ? { unitPrice } : {}),
        },
      ],
    });
    expect(done.s.status).toBe('committed');
    return { call, product, batch, shop: s, order: done.s.data };
  }

  // ── The happy path, once ─────────────────────────────────────────────

  it('leave 5 → listed → they buy 3 at the noted price: preview writes nothing, the sale is the office conversion', async () => {
    const call = await as();
    const { product, batch } = await stocked(10, 100);
    const s = await shop();
    const args = {
      customer: s.displayName,
      lines: [{ product: product.name, qty: 5, unitPrice: 300 }],
    };

    const shown = await call('leave_samples', args);
    expect(shown.s.status).toBe('preview');
    expect(shown.s.data).toMatchObject({
      customer: { id: s.id },
      total: '0.00',
      outstandingAfter: '0.00',
      statusAfter: 'SAMPLES',
      costAtShopEgp: '500.00',
    });
    expect(shown.s.data.lines[0]).toMatchObject({
      qty: '5',
      notedPrice: '300.00',
      available: '10',
    });
    // The preview left nothing behind.
    expect(await ordersOf(s.id)).toHaveLength(0);
    expect(await shelf(batch.id)).toBe(10);

    const done = await call('leave_samples', {
      ...args,
      confirmationToken: shown.s.confirmationToken,
    });
    expect(done.s.status).toBe('committed');
    const [order] = await ordersOf(s.id);
    expect(order.status).toBe('SAMPLES');
    expect(Number(order.total)).toBe(0);
    expect(await shelf(batch.id)).toBe(5);

    const listed = await call('list_samples', { customerId: s.id });
    expect(listed.s.data).toMatchObject({
      totalUnits: '5',
      byShop: [{ customerId: s.id, orders: 1, units: '5' }],
      byProduct: [{ productId: product.id, units: '5' }],
    });
    expect(listed.s.data.orders[0]).toMatchObject({
      orderNo: order.orderNo,
      lines: [{ productId: product.id, qty: '5' }],
    });
    const byProduct = await call('list_samples', { productId: product.id });
    expect(byProduct.s.data.byShop).toEqual([
      expect.objectContaining({ customerId: s.id, units: '5' }),
    ]);

    const buy = {
      order: order.orderNo,
      lines: [{ product: product.name, qty: 3 }],
    };
    const sale = await call('complete_samples_sale', buy);
    expect(sale.s.status).toBe('preview');
    expect(sale.s.data).toMatchObject({
      orderId: order.id,
      total: '900.00',
      statusAfter: 'CONFIRMED',
      outstandingAfter: '900.00',
    });
    expect(sale.s.data.lines[0]).toMatchObject({
      qty: '3',
      unitPrice: '300.00',
      priceSource: 'noted',
      lineTotal: '900.00',
    });
    expect(sale.s.data.products[0]).toMatchObject({
      out: '5',
      kept: '3',
      back: '2',
      fromShelf: '0',
    });
    // Still samples, still 5 out, until the partner says yes.
    expect(
      (await prisma.saleOrder.findUniqueOrThrow({ where: { id: order.id } }))
        .status,
    ).toBe('SAMPLES');
    expect(await shelf(batch.id)).toBe(5);

    const bought = await call('complete_samples_sale', {
      ...buy,
      confirmationToken: sale.s.confirmationToken,
    });
    expect(bought.s.status).toBe('committed');
    const after = await prisma.saleOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(after).toMatchObject({
      status: 'CONFIRMED',
      orderNo: order.orderNo,
    });
    expect(Number(after.total)).toBe(900);
    expect(Number(after.outstanding)).toBe(900);
    expect(await shelf(batch.id)).toBe(7);
    expect(
      (await call('list_samples', { customerId: s.id })).s.data.orders,
    ).toEqual([]);
    // Bought is decided: nothing else can be recorded on it.
    expect(codeOf(await call('return_samples', { order: order.orderNo }))).toBe(
      'SAMPLES_ALREADY_DECIDED',
    );
    expect(codeOf(await call('complete_samples_sale', buy))).toBe(
      'SAMPLES_ALREADY_DECIDED',
    );
  });

  it('write off: shows the cost, and the units never come back', async () => {
    const { call, batch, order } = await leftWith(4);
    const { shown, done } = await previewAndCommit(call, 'write_off_samples', {
      order: order.orderNo,
      reason: 'the shop kept them',
    });
    expect(shown.s.data).toMatchObject({ costEgp: '400.00' });
    expect(done.s.status).toBe('committed');
    expect(
      (
        await prisma.saleOrder.findUniqueOrThrow({
          where: { id: order.orderId },
        })
      ).status,
    ).toBe('SAMPLES_WRITTEN_OFF');
    expect(await shelf(batch.id)).toBe(6);
  });

  // ── Leaving: the limits and the wrong buyer ──────────────────────────

  it('more than is in stock → NOT_ENOUGH_STOCK, nothing written', async () => {
    const call = await as();
    const { product, batch } = await stocked(3);
    const s = await shop();
    const r = await call('leave_samples', {
      customer: s.displayName,
      lines: [{ product: product.name, qty: 4 }],
    });
    expect(codeOf(r)).toBe('NOT_ENOUGH_STOCK');
    expect(r.s.confirmationToken).toBeUndefined();
    expect(await ordersOf(s.id)).toHaveLength(0);
    expect(await shelf(batch.id)).toBe(3);
  });

  it('two lines of one product summed against the shelf → NOT_ENOUGH_STOCK', async () => {
    const call = await as();
    const { product } = await stocked(5);
    const s = await shop();
    const r = await call('leave_samples', {
      customer: s.displayName,
      lines: [
        { product: product.name, qty: 3 },
        { product: product.name, qty: 3 },
      ],
    });
    expect(codeOf(r)).toBe('NOT_ENOUGH_STOCK');
  });

  it.each([0, -2])('a quantity of %s → QTY_NOT_POSITIVE', async (qty) => {
    const call = await as();
    const { product } = await stocked(5);
    const s = await shop();
    const r = await call('leave_samples', {
      customer: s.displayName,
      lines: [{ product: product.name, qty }],
    });
    expect(codeOf(r)).toBe('QTY_NOT_POSITIVE');
    expect(await ordersOf(s.id)).toHaveLength(0);
  });

  it('a walk-in → SAMPLES_NEED_SHOP; no shop at all → CUSTOMER_REQUIRED', async () => {
    const call = await as();
    const { product } = await stocked(5);
    const line = [{ product: product.name, qty: 1 }];
    expect(
      codeOf(await call('leave_samples', { walkIn: true, lines: line })),
    ).toBe('SAMPLES_NEED_SHOP');
    const s = await shop();
    expect(
      codeOf(
        await call('leave_samples', {
          walkIn: true,
          customer: s.displayName,
          lines: line,
        }),
      ),
    ).toBe('SAMPLES_NEED_SHOP');
    expect(codeOf(await call('leave_samples', { lines: line }))).toBe(
      'CUSTOMER_REQUIRED',
    );
    expect(await ordersOf(s.id)).toHaveLength(0);
  });

  it('an unknown shop is a question with no token, never a new customer', async () => {
    const call = await as();
    const { product } = await stocked(5);
    const name = `Nobody Motors ${randomUUID().slice(0, 6)}`;
    const r = await call('leave_samples', {
      customer: name,
      lines: [{ product: product.name, qty: 1 }],
    });
    expect(r.s.status).toBe('needs_answers');
    expect(r.s.confirmationToken).toBeUndefined();
    expect(r.s.data.questions[0].kind).toBe('CUSTOMER_UNKNOWN');
    expect(await prisma.customer.count({ where: { displayName: name } })).toBe(
      0,
    );
  });

  it('stock sold elsewhere between preview and yes → PREVIEW_CHANGED, nothing written', async () => {
    const call = await as();
    const { product, batch } = await stocked(10);
    const s = await shop();
    const args = {
      customer: s.displayName,
      lines: [{ product: product.name, qty: 5 }],
    };
    const shown = await call('leave_samples', args);
    // The office leaves 1 elsewhere meanwhile.
    const other = await shop();
    await (registry.get(SalesService) as SalesService).create(
      {
        samples: true,
        customerId: other.id,
        channel: 'B2B',
        currency: 'EGP',
        items: [{ productId: product.id, quantity: 1, unitPrice: 0 }],
      },
      users.get('CORE_PARTNER')!.id,
    );
    const r = await call('leave_samples', {
      ...args,
      confirmationToken: shown.s.confirmationToken,
    });
    expect(codeOf(r)).toBe('PREVIEW_CHANGED');
    expect(await ordersOf(s.id)).toHaveLength(0);
    expect(await shelf(batch.id)).toBe(9);
  });

  // ── Deciding: the second time ────────────────────────────────────────

  it('the same token twice → CONFIRMATION_USED; one return', async () => {
    const { call, batch, order } = await leftWith(4);
    const args = { order: order.orderNo };
    const { shown, done } = await previewAndCommit(
      call,
      'return_samples',
      args,
    );
    expect(done.s.status).toBe('committed');
    expect(await shelf(batch.id)).toBe(10);
    const again = await call('return_samples', {
      ...args,
      confirmationToken: shown.s.confirmationToken,
    });
    expect(codeOf(again)).toBe('CONFIRMATION_USED');
    expect(await shelf(batch.id)).toBe(10);
  });

  it('deciding again after Returned → SAMPLES_ALREADY_DECIDED for every decision', async () => {
    const { call, batch, product, order } = await leftWith(4);
    await previewAndCommit(call, 'return_samples', { order: order.orderNo });

    for (const [tool, args] of [
      ['return_samples', { order: order.orderNo }],
      ['write_off_samples', { order: order.orderNo }],
      ['complete_samples_sale', { order: order.orderNo }],
      [
        'complete_samples_sale',
        {
          order: order.orderNo,
          lines: [{ product: product.name, qty: 1, unitPrice: 10 }],
        },
      ],
    ] as const) {
      expect(codeOf(await call(tool, args))).toBe('SAMPLES_ALREADY_DECIDED');
    }
    expect(await shelf(batch.id)).toBe(10);
  });

  it('a preview taken before the shop was decided elsewhere cannot be committed after', async () => {
    const { call, batch, order } = await leftWith(4);
    const shown = await call('write_off_samples', { order: order.orderNo });
    expect(shown.s.status).toBe('preview');
    // The office records "Returned" meanwhile.
    await (registry.get(SalesService) as SalesService).returnSamples(
      order.orderId as string,
      users.get('CORE_PARTNER')!.id,
    );
    const r = await call('write_off_samples', {
      order: order.orderNo,
      confirmationToken: shown.s.confirmationToken,
    });
    expect(codeOf(r)).toBe('SAMPLES_ALREADY_DECIDED');
    expect(
      (
        await prisma.saleOrder.findUniqueOrThrow({
          where: { id: order.orderId },
        })
      ).status,
    ).toBe('SAMPLES_RETURNED');
    expect(await shelf(batch.id)).toBe(10);
  });

  // ── Returning and buying: too much, too little ──────────────────────

  it('returning more than was left → SAMPLES_RETURN_MORE_THAN_OUT; still at the shop', async () => {
    const { call, batch, product, order } = await leftWith(4);
    const r = await call('return_samples', {
      order: order.orderNo,
      returned: [{ product: product.name, qty: 5 }],
    });
    expect(codeOf(r)).toBe('SAMPLES_RETURN_MORE_THAN_OUT');
    expect(r.s.error?.params).toMatchObject({ out: '4', returned: '5' });
    expect(await shelf(batch.id)).toBe(6);
  });

  it('two lines adding to more than was left → SAMPLES_RETURN_MORE_THAN_OUT', async () => {
    const { call, product, order } = await leftWith(4);
    const r = await call('return_samples', {
      order: order.orderNo,
      returned: [
        { product: product.name, qty: 3 },
        { product: product.sku, qty: 2 },
      ],
    });
    expect(codeOf(r)).toBe('SAMPLES_RETURN_MORE_THAN_OUT');
  });

  it('a product that never went out "came back" → SAMPLES_RETURN_MORE_THAN_OUT', async () => {
    const { call, order } = await leftWith(4);
    const { product: other } = await stocked(
      5,
      100,
      `Chain tensioner ${randomUUID().slice(0, 8)}`,
    );
    const r = await call('return_samples', {
      order: order.orderNo,
      returned: [{ product: other.name, qty: 1 }],
    });
    expect(codeOf(r)).toBe('SAMPLES_RETURN_MORE_THAN_OUT');
    expect(r.s.error?.params).toMatchObject({ out: '0', returned: '1' });
  });

  it('a close name for what came back is a question, never assumed', async () => {
    const { call, batch, product, order } = await leftWith(4);
    const r = await call('return_samples', {
      order: order.orderNo,
      returned: [{ product: `${product.name}s (front)`, qty: 4 }],
    });
    expect(r.s.status).toBe('needs_answers');
    expect(r.s.confirmationToken).toBeUndefined();
    expect(r.s.data.questions[0].options[0].value).toBe(product.id);
    expect(await shelf(batch.id)).toBe(6);
  });

  it('only part came back → SAMPLES_RETURN_NOT_ALL (that is a sale of the rest), nothing moved', async () => {
    const { call, batch, product, order } = await leftWith(4);
    const r = await call('return_samples', {
      order: order.orderNo,
      returned: [{ product: product.name, qty: 3 }],
    });
    expect(codeOf(r)).toBe('SAMPLES_RETURN_NOT_ALL');
    expect(await shelf(batch.id)).toBe(6);
  });

  it.each([0, -1])(
    'a returned quantity of %s → QTY_NOT_POSITIVE',
    async (qty) => {
      const { call, product, order } = await leftWith(2);
      const r = await call('return_samples', {
        order: order.orderNo,
        returned: [{ product: product.name, qty }],
      });
      expect(codeOf(r)).toBe('QTY_NOT_POSITIVE');
    },
  );

  it('exactly what was left, named → returned', async () => {
    const { call, batch, product, order } = await leftWith(4);
    const { done } = await previewAndCommit(call, 'return_samples', {
      order: order.orderNo,
      returned: [{ product: product.name, qty: 4 }],
    });
    expect(done.s.status).toBe('committed');
    expect(await shelf(batch.id)).toBe(10);
  });

  it('buying more than went out with nothing on the shelf → SAMPLES_EXTRA_NOT_IN_STOCK', async () => {
    const { call, batch, product, order } = await leftWith(4, 4);
    const r = await call('complete_samples_sale', {
      order: order.orderNo,
      lines: [{ product: product.name, qty: 6, unitPrice: 200 }],
    });
    expect(codeOf(r)).toBe('SAMPLES_EXTRA_NOT_IN_STOCK');
    expect(await shelf(batch.id)).toBe(0);
  });

  it('buying zero or a negative quantity → QTY_NOT_POSITIVE', async () => {
    const { call, product, order } = await leftWith(4);
    for (const qty of [0, -3]) {
      const r = await call('complete_samples_sale', {
        order: order.orderNo,
        lines: [{ product: product.name, qty, unitPrice: 200 }],
      });
      expect(codeOf(r)).toBe('QTY_NOT_POSITIVE');
    }
  });

  it('no price noted, none given and no list price set → the default price, marked', async () => {
    const { call, order } = await leftWith(2);
    const r = await call('complete_samples_sale', { order: order.orderNo });
    expect(r.s.status).toBe('preview');
    expect(r.s.data.lines[0]).toMatchObject({
      qty: '2',
      priceSource: 'default',
      unitPrice: '120.00',
    });
  });

  it('a sale dated before the samples were left → SAMPLES_SALE_BEFORE_LEFT; a future day → refused', async () => {
    const { call, product, order } = await leftWith(2);
    const r = await call('complete_samples_sale', {
      order: order.orderNo,
      lines: [{ product: product.name, qty: 1, unitPrice: 50 }],
      orderedOn: '2020-01-01',
    });
    expect(codeOf(r)).toBe('SAMPLES_SALE_BEFORE_LEFT');
    const future = await call('complete_samples_sale', {
      order: order.orderNo,
      lines: [{ product: product.name, qty: 1, unitPrice: 50 }],
      orderedOn: '2999-01-01',
    });
    expect(codeOf(future)).toBe('DATE_IN_FUTURE');
  });

  // ── The wrong order ──────────────────────────────────────────────────

  it('an order that does not exist → NOT_FOUND, never a 500', async () => {
    const call = await as();
    for (const ref of [randomUUID(), 'ORD-1999-99999', 'not an order']) {
      for (const tool of [
        'return_samples',
        'write_off_samples',
        'complete_samples_sale',
      ]) {
        const r = await call(tool, { order: ref });
        expect([tool, ref, codeOf(r)]).toEqual([tool, ref, 'NOT_FOUND']);
      }
    }
    expect(codeOf(await call('list_samples', { customerId: 'nope' }))).toBe(
      'NOT_FOUND',
    );
  });

  it('an ordinary sale, not samples → NOT_SAMPLES for every decision', async () => {
    const call = await as();
    const { product, batch } = await stocked(5);
    const s = await shop();
    const { data: sale } = (await (
      registry.get(SalesService) as SalesService
    ).create(
      {
        customerId: s.id,
        channel: 'B2B',
        currency: 'EGP',
        confirm: true,
        items: [{ productId: product.id, quantity: 2, unitPrice: 200 }],
      },
      users.get('CORE_PARTNER')!.id,
    )) as { data: { orderNo: string; id: string } };
    for (const [tool, args] of [
      ['return_samples', { order: sale.orderNo }],
      ['write_off_samples', { order: sale.id }],
      [
        'complete_samples_sale',
        {
          order: sale.orderNo,
          lines: [{ product: product.name, qty: 1, unitPrice: 1 }],
        },
      ],
    ] as const) {
      expect(codeOf(await call(tool, args))).toBe('NOT_SAMPLES');
    }
    const after = await prisma.saleOrder.findUniqueOrThrow({
      where: { id: sale.id },
    });
    expect(after.status).toBe('CONFIRMED');
    expect(await shelf(batch.id)).toBe(3);
  });

  // ── The roles the office endpoints carry (CLAUDE.md §12) ─────────────

  it('office support may leave and return samples but not write them off', async () => {
    const support = await as('ADMIN_SUPPORT');
    const { product, batch } = await stocked(5);
    const s = await shop();
    const { done } = await previewAndCommit(support, 'leave_samples', {
      customer: s.displayName,
      lines: [{ product: product.name, qty: 2 }],
    });
    expect(done.s.status).toBe('committed');
    const orderNo = done.s.data.orderNo;

    const off = await support('write_off_samples', { order: orderNo });
    expect(codeOf(off)).toBe('ROLE_NOT_ALLOWED');
    expect(off.s.confirmationToken).toBeUndefined();

    const back = await previewAndCommit(support, 'return_samples', {
      order: orderNo,
    });
    expect(back.done.s.status).toBe('committed');
    expect(await shelf(batch.id)).toBe(5);
  });

  it('a role the sales endpoints refuse gets nothing, not even a preview or the list', async () => {
    const investor = await as('TEMP_INVESTOR');
    const { call, product, order, batch } = await leftWith(2);
    void call;
    for (const [tool, args] of [
      [
        'leave_samples',
        { customer: order.orderNo, lines: [{ product: product.name, qty: 1 }] },
      ],
      ['list_samples', {}],
      ['complete_samples_sale', { order: order.orderNo }],
      ['return_samples', { order: order.orderNo }],
      ['write_off_samples', { order: order.orderNo }],
    ] as const) {
      const r = await investor(tool, args);
      expect([tool, codeOf(r)]).toEqual([tool, 'ROLE_NOT_ALLOWED']);
    }
    expect(await shelf(batch.id)).toBe(8);
  });
});
