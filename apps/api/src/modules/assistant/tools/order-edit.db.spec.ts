/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- tool results are parsed JSON; each assertion names the field it checks */
import { randomUUID } from 'node:crypto';
import type { Type } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- this suite talks to a real, throwaway Postgres; that is its point
import { PrismaClient, type UserRole } from '@prisma/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { businessToday } from '../../../common/dates';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { PaymentsService } from '../../payments/payments.service';
import { OrderEditsService } from '../../sales/order-edits.service';
import { receivedStock } from '../../sales/received-stock-fixture-spec';
import { SalesService } from '../../sales/sales.service';
import { AssistantServer } from '../assistant-server';
import { ConfirmationService } from '../confirmation.service';
import type { AssistantUser } from '../tool-kit';

/**
 * edit_order — editing a confirmed sale through the assistant and the office
 * chat (BUSINESS_LOGIC §4 "Editing a confirmed order"; BUILD_LOG: "through the
 * assistant/office chat too … same service, preview/confirm"). Driven through
 * a real McpServer and the SDK's client against the real OrderEditsService on
 * a real Postgres, with stock that came in through a purchase order, a leg, a
 * delivery and a verified receipt.
 *
 * Beyond the happy path (CLAUDE.md §0): a preview writes nothing; a token
 * spent twice or on other arguments saves nothing; the order moving between
 * preview and yes is refused, not applied to a state nobody saw; the
 * service's refusals keep their codes; a close product name is a question;
 * the roles the office endpoint refuses are refused here.
 *
 *   INTEGRATION_DATABASE_URL=$DATABASE_URL npx jest tools/order-edit.db
 */
// eslint-disable-next-line no-restricted-properties -- an opt-in switch for a suite that must never run by default
const url = process.env.INTEGRATION_DATABASE_URL;
const suite = url ? describe : describe.skip;
jest.setTimeout(120_000);

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

const daysAgo = (n: number) => {
  const d = new Date(`${businessToday()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

suite('assistant edit_order against Postgres', () => {
  let prisma: PrismaClient;
  let registry: Map<unknown, unknown>;
  let stock: ReturnType<typeof receivedStock>;
  let sales: SalesService;
  let payments: PaymentsService;
  const clients: Client[] = [];
  const users = new Map<UserRole, AssistantUser>();

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const db = prisma as unknown as PrismaService;
    const audit = { log: jest.fn() } as unknown as AuditService;
    const notifier = {
      createForMultipleUsers: () => Promise.resolve({ count: 0 }),
    };
    payments = new PaymentsService(db, audit);
    sales = new SalesService(db, audit, payments, notifier);
    registry = new Map<unknown, unknown>([
      [PrismaService, db],
      [AuditService, audit],
      [PaymentsService, payments],
      [SalesService, sales],
      [OrderEditsService, new OrderEditsService(db, audit, sales, notifier)],
    ]);
    stock = receivedStock(prisma, audit, notifier);
    for (const role of [
      'CORE_PARTNER',
      'ADMIN_SUPPORT',
      'TEMP_INVESTOR',
    ] as UserRole[]) {
      const u = await prisma.user.create({
        data: {
          email: `assistant-edit-${role}-${randomUUID()}@example.com`,
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

  /**
   * A tool caller signed in as `role` — one MCP server per call, as on the
   * real surface, where each HTTP request builds its own.
   */
  function as(role: UserRole = 'CORE_PARTNER') {
    return async (
      name: string,
      args: Record<string, unknown>,
    ): Promise<Result> => {
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
  const codeOf = (r: Result) => r.s.error?.code;

  /**
   * Helmets: 16 bought at 900, received 5 days ago. Gloves: 5 at 500. The
   * shop bought 10 helmets at 1,250 three days ago and paid 5,000.
   */
  async function world() {
    const partner = users.get('CORE_PARTNER')!.id;
    const tag = randomUUID().slice(0, 8);
    const helmet = await prisma.product.create({
      data: { sku: `AED-H-${tag}`, name: `Edit helmet ${tag}` },
    });
    const gloves = await prisma.product.create({
      data: { sku: `AED-G-${tag}`, name: `Edit gloves ${tag}` },
    });
    const helmets = await stock.cycleWith({
      productId: helmet.id,
      qty: 16,
      cost: 900,
      receivedOn: daysAgo(5),
      actor: partner,
    });
    await stock.cycleWith({
      productId: gloves.id,
      qty: 5,
      cost: 500,
      receivedOn: daysAgo(5),
      actor: partner,
    });
    const shop = await prisma.customer.create({
      data: {
        type: 'B2B',
        displayName: `Edit shop ${tag}`,
        verificationStatus: 'VERIFIED',
      },
    });
    const made = (await sales.create(
      {
        customerId: shop.id,
        channel: 'B2B',
        currency: 'EGP',
        orderedOn: daysAgo(3),
        items: [{ productId: helmet.id, quantity: 10, unitPrice: 1250 }],
        confirm: true,
      },
      partner,
    )) as { data: { id: string; orderNo: string } };
    await payments.create(
      {
        customerId: shop.id,
        amount: 5000,
        currency: 'EGP',
        method: 'CASH',
        receivedOn: daysAgo(3),
        orderId: made.data.id,
      },
      partner,
    );
    return { helmet, gloves, shop, helmets, order: made.data };
  }
  type World = Awaited<ReturnType<typeof world>>;

  const read = (w: World) =>
    prisma.saleOrder.findUniqueOrThrow({ where: { id: w.order.id } });
  const edits = (w: World) =>
    prisma.saleOrderEdit.count({ where: { saleOrderId: w.order.id } });
  const shelf = async (batchId: string) =>
    (
      await prisma.inventoryBatch.findUniqueOrThrow({ where: { id: batchId } })
    ).remainingQty.toString();

  it('previews the whole edit by names and writes nothing; yes saves exactly that, once, and the assistant’s own reads agree', async () => {
    const w = await world();
    const call = as();
    const args = {
      order: w.order.orderNo,
      lines: [
        { product: w.helmet.name, quantity: 12 },
        { product: w.gloves.sku, quantity: 2, unitPrice: 1000 },
      ],
      reason: 'They took more',
    };
    const shown = await call('edit_order', args);
    expect(shown.isError).toBeFalsy();
    expect(shown.s.status).toBe('preview');
    expect(shown.s.data).toMatchObject({
      orderNo: w.order.orderNo,
      owedBefore: '7500.00',
      owedAfter: '12000.00',
      changeEgp: '4500.00',
    });
    expect(shown.text).toContain('7,500.00 EGP before, 12,000.00 EGP after');
    expect(shown.text).toContain(`${w.helmet.name}: 10 → 12`);
    // The preview wrote nothing.
    expect(await edits(w)).toBe(0);
    expect((await read(w)).outstanding.toFixed(2)).toBe('7500.00');
    expect(await shelf(w.helmets.batch.id)).toBe('6');

    const done = await call('edit_order', {
      ...args,
      confirmationToken: shown.s.confirmationToken,
    });
    expect(done.isError).toBeFalsy();
    expect(done.s.status).toBe('committed');
    expect(done.s.data.owedAfter).toBe('12000.00');
    expect(await edits(w)).toBe(1);
    const o = await read(w);
    expect(o.outstanding.toFixed(2)).toBe('12000.00');
    expect(await shelf(w.helmets.batch.id)).toBe('4');
    const edit = await prisma.saleOrderEdit.findFirstOrThrow({
      where: { saleOrderId: w.order.id },
    });
    expect(edit.reason).toBe('They took more');
    expect(edit.createdBy).toBe(users.get('CORE_PARTNER')!.id);

    // The same yes again saves nothing more.
    const again = await call('edit_order', {
      ...args,
      confirmationToken: shown.s.confirmationToken,
    });
    expect(again.isError).toBe(true);
    expect(await edits(w)).toBe(1);

    // The assistant's sales read shows the value now: 12 × 1,250 + 2 × 1,000.
    const list = await call('list_sales', { customerId: w.shop.id });
    const row = list.s.data.find((r: any) => r.id === w.order.id);
    expect([row.valueNow, Number(row.outstanding)]).toEqual([
      '17000.00',
      12000,
    ]);
  });

  it('a token spent on other arguments saves nothing', async () => {
    const w = await world();
    const call = as();
    const args = {
      order: w.order.orderNo,
      lines: [{ product: w.helmet.name, quantity: 11 }],
    };
    const shown = await call('edit_order', args);
    const other = await call('edit_order', {
      ...args,
      lines: [{ product: w.helmet.name, quantity: 16 }],
      confirmationToken: shown.s.confirmationToken,
    });
    expect(other.isError).toBe(true);
    expect(codeOf(other)).toBe('CONFIRMATION_MISMATCH');
    expect(await edits(w)).toBe(0);
    expect((await read(w)).outstanding.toFixed(2)).toBe('7500.00');
  });

  it('the order moving between the preview and the yes is refused — a payment, or another partner’s edit — and nothing is applied to a state nobody saw', async () => {
    const w = await world();
    const call = as();
    const args = {
      order: w.order.id,
      lines: [{ product: w.helmet.name, quantity: 11 }],
    };
    const shown = await call('edit_order', args);
    expect(shown.s.status).toBe('preview');
    // The shop pays 1,000 in the office meanwhile.
    await payments.create(
      {
        customerId: w.shop.id,
        amount: 1000,
        currency: 'EGP',
        method: 'CASH',
        orderId: w.order.id,
      },
      users.get('CORE_PARTNER')!.id,
    );
    const done = await call('edit_order', {
      ...args,
      confirmationToken: shown.s.confirmationToken,
    });
    expect(done.isError).toBe(true);
    expect(codeOf(done)).toBe('PREVIEW_CHANGED');
    expect(await edits(w)).toBe(0);
    expect((await read(w)).outstanding.toFixed(2)).toBe('6500.00');
    expect(await shelf(w.helmets.batch.id)).toBe('6');

    // Previewed again; another partner edits the order in the office first.
    const again = await call('edit_order', args);
    expect(again.s.status).toBe('preview');
    const office = registry.get(OrderEditsService) as OrderEditsService;
    await office.create(
      w.order.id,
      {
        version: (await read(w)).version,
        lines: [{ productId: w.helmet.id, quantity: 12 }],
      },
      users.get('CORE_PARTNER')!.id,
    );
    const late = await call('edit_order', {
      ...args,
      confirmationToken: again.s.confirmationToken,
    });
    expect(codeOf(late)).toBe('PREVIEW_CHANGED');
    // Only the office's edit stands: 12 helmets, never 11.
    expect(await edits(w)).toBe(1);
    expect((await read(w)).outstanding.toFixed(2)).toBe('9000.00');
    expect(await shelf(w.helmets.batch.id)).toBe('4');
  });

  it('the service’s refusals reach the partner with their codes, and no token is issued: below what was paid, beyond the shelf, a future day, a walk-in, an order that does not exist', async () => {
    const w = await world();
    const call = as();
    const cases: [Record<string, unknown>, string][] = [
      [
        {
          order: w.order.orderNo,
          lines: [{ product: w.helmet.name, quantity: 3 }],
        },
        'EDIT_ORDER_BELOW_PAID',
      ],
      [
        {
          order: w.order.orderNo,
          lines: [{ product: w.helmet.name, quantity: 17 }],
        },
        'NOT_ENOUGH_STOCK',
      ],
      [
        {
          order: w.order.orderNo,
          lines: [{ product: w.helmet.name, quantity: 11 }],
          editedOn: '2999-01-01',
        },
        'DATE_IN_FUTURE',
      ],
      [
        {
          order: 'ORD-0000-99999',
          lines: [{ product: w.helmet.name, quantity: 11 }],
        },
        'NOT_FOUND',
      ],
      [
        {
          order: w.order.orderNo,
          lines: [{ product: w.gloves.name, quantity: 1, unitPrice: -5 }],
        },
        'EDIT_ORDER_BAD_PRICE',
      ],
    ];
    for (const [args, code] of cases) {
      const r = await call('edit_order', args);
      expect([code, r.isError, codeOf(r)]).toEqual([code, true, code]);
      expect(r.s.confirmationToken).toBeUndefined();
    }
    const walkIn = (await sales.create(
      {
        walkIn: true,
        channel: 'B2C',
        currency: 'EGP',
        payment: { method: 'CASH' },
        items: [{ productId: w.gloves.id, quantity: 1, unitPrice: 800 }],
      },
      users.get('CORE_PARTNER')!.id,
    )) as { data: { orderNo: string } };
    const r = await call('edit_order', {
      order: walkIn.data.orderNo,
      lines: [{ product: w.gloves.name, quantity: 2 }],
    });
    expect(codeOf(r)).toBe('EDIT_ORDER_WALK_IN');
    expect(await edits(w)).toBe(0);
  });

  it('a close product name is a question, never the product: no token, nothing saved', async () => {
    const w = await world();
    const call = as();
    const r = await call('edit_order', {
      order: w.order.orderNo,
      lines: [
        { product: w.helmet.name.replace('helmet', 'helmets'), quantity: 11 },
      ],
    });
    expect(r.s.status).toBe('needs_answers');
    expect(r.s.confirmationToken).toBeUndefined();
    expect(r.s.data.questions[0].options.map((o: any) => o.value)).toContain(
      w.helmet.id,
    );
    expect(await edits(w)).toBe(0);
  });

  it.each(['ADMIN_SUPPORT', 'TEMP_INVESTOR'] as UserRole[])(
    'a %s is refused as the office endpoint refuses them, before any preview',
    async (role) => {
      const w = await world();
      const r = await as(role)('edit_order', {
        order: w.order.orderNo,
        lines: [{ product: w.helmet.name, quantity: 11 }],
      });
      expect(r.isError).toBe(true);
      expect(codeOf(r)).toBe('ROLE_NOT_ALLOWED');
      expect(r.s.confirmationToken).toBeUndefined();
      expect(await edits(w)).toBe(0);
    },
  );
});
