import { HttpException } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import { ReturnsService } from './returns.service';

/**
 * A credit note can only lower what is still owed (BUSINESS_LOGIC §5,
 * DECIDED 2026-11-06).
 *
 * Found in production: ORD-2026-00016, a shop order for 2,000, paid in full in
 * cash and then returned whole. The form defaulted to a credit note, and a
 * credit note only lowered `outstanding` — floored at 0 — so the 2,000
 * vanished: nothing owed went down, no credit was kept anywhere, and no
 * REFUND_PAID left the books although the partner had handed the cash back.
 *
 * The order and every write are held in memory: the rule is decided before
 * and inside the return's transaction, and this proves what each case writes.
 * The batch arithmetic itself is covered against Postgres in the db specs.
 */

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

interface Line {
  id: string;
  quantity: number;
  lineTotal: number;
  returned?: number;
}

interface Order {
  id: string;
  orderNo: string;
  status: string;
  outstanding: Prisma.Decimal;
  isWalkIn: boolean;
  lines: Line[];
}

interface Fin {
  type: string;
  amount: Prisma.Decimal;
}

/** One order in memory, and everything the service wrote. */
function world(order: Order) {
  const returns: {
    id: string;
    refundMethod: string;
    refundEgp: Prisma.Decimal;
  }[] = [];
  const returnItems: {
    saleItemId: string;
    qty: Prisma.Decimal;
    inventoryBatchId: string;
  }[] = [];
  const fin: Fin[] = [];
  let n = 0;

  const items = () =>
    order.lines.map((l) => ({
      id: l.id,
      quantity: D(l.quantity),
      lineTotal: D(l.lineTotal),
      product: { name: `Part ${l.id}` },
      priceAdjustments: [],
      allocations: [
        {
          inventoryBatchId: `batch-${l.id}`,
          qty: D(l.quantity),
          unitCostEgp: D(100),
          createdAt: new Date('2026-11-01'),
        },
      ],
      returnItems: returnItems.filter((r) => r.saleItemId === l.id),
    }));

  const tx = {
    $executeRaw: () => Promise.resolve(0),
    saleReturn: {
      findFirst: () => Promise.resolve(null),
      create: ({
        data,
      }: {
        data: { refundMethod: string; refundEgp: Prisma.Decimal };
      }) => {
        const r = { id: `ret-${++n}`, ...data };
        returns.push(r);
        return Promise.resolve(r);
      },
      findUnique: ({ where }: { where: { id: string } }) => {
        const r = returns.find((x) => x.id === where.id)!;
        return Promise.resolve({
          ...r,
          reference: `RET-2026-0000${n}`,
          saleOrder: { customer: { displayName: 'Shop' } },
          items: [],
        });
      },
    },
    saleReturnItem: {
      create: ({
        data,
      }: {
        data: {
          saleItemId: string;
          qty: Prisma.Decimal;
          inventoryBatchId: string;
        };
      }) => {
        returnItems.push(data);
        return Promise.resolve(data);
      },
    },
    inventoryBatch: { update: () => Promise.resolve({}) },
    inventoryMovement: { create: () => Promise.resolve({}) },
    saleItem: { findMany: () => Promise.resolve(items()) },
    saleOrder: {
      findUniqueOrThrow: () =>
        Promise.resolve({ outstanding: order.outstanding }),
      update: ({
        data,
      }: {
        data: { outstanding: Prisma.Decimal; status: string };
      }) => {
        order.outstanding = D(data.outstanding);
        order.status = data.status;
        return Promise.resolve({});
      },
    },
    financialTransaction: {
      create: ({ data }: { data: Fin }) => {
        fin.push({ type: data.type, amount: D(data.amount) });
        return Promise.resolve({});
      },
    },
  };

  const prisma = {
    saleOrder: {
      findUnique: () =>
        Promise.resolve({
          id: order.id,
          orderNo: order.orderNo,
          status: order.status,
          outstanding: order.outstanding,
          currency: 'EGP',
          customer: { isWalkIn: order.isWalkIn },
          items: items(),
        }),
    },
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaService;

  const audit = {
    log: jest.fn(() => Promise.resolve()),
  } as unknown as AuditService;
  return { service: new ReturnsService(prisma, audit), returns, fin, order };
}

/** ORD-2026-00016 as it stood: one line of 2,000, paid in full. */
const shopOrder = (over: Partial<Order> = {}): Order => ({
  id: '11111111-1111-4111-8111-111111111111',
  orderNo: 'ORD-2026-00016',
  status: 'PAID',
  outstanding: D(0),
  isWalkIn: false,
  lines: [{ id: 'line-1', quantity: 4, lineTotal: 2000 }],
  ...over,
});

const back = (
  order: Order,
  qty: number,
  refundMethod?: 'CASH' | 'CREDIT_NOTE',
) => ({
  saleOrderId: order.id,
  reason: 'came back',
  ...(refundMethod ? { refundMethod } : {}),
  items: [{ saleItemId: 'line-1', qty }],
});

async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (!(e instanceof HttpException)) throw e;
    const body = e.getResponse() as {
      code: string;
      params?: Record<string, string>;
    };
    return { code: body.code, params: body.params };
  }
  throw new Error('expected a refusal, got success');
}

const refundsPaid = (fin: Fin[]) =>
  fin.filter((f) => f.type === 'REFUND_PAID').map((f) => f.amount.toFixed(2));

describe('a return on a credit note cannot credit more than is owed', () => {
  it('paid in full, credit note → RETURN_CREDIT_OVER_OWED, nothing written', async () => {
    const w = world(shopOrder());
    expect(
      await refusal(w.service.create(back(w.order, 4, 'CREDIT_NOTE'), 'actor')),
    ).toEqual({
      code: 'RETURN_CREDIT_OVER_OWED',
      params: {
        order: 'ORD-2026-00016',
        refund: '2000.00',
        outstanding: '0.00',
      },
    });
    expect(w.returns).toHaveLength(0);
    expect(w.fin).toHaveLength(0);
    expect(w.order.status).toBe('PAID');
  });

  it('paid in full, cash → REFUND_PAID of 2,000, outstanding stays 0, RETURNED', async () => {
    const w = world(shopOrder());
    const r = await w.service.create(back(w.order, 4, 'CASH'), 'actor');
    expect(r.data!.refundMethod).toBe('CASH');
    expect(refundsPaid(w.fin)).toEqual(['2000.00']);
    expect(w.order.outstanding.toFixed(2)).toBe('0.00');
    expect(w.order.status).toBe('RETURNED');
  });

  it('paid in full, no method named → defaults to CASH, never into the refusal', async () => {
    const w = world(shopOrder());
    const r = await w.service.create(back(w.order, 4), 'actor');
    expect(r.data!.refundMethod).toBe('CASH');
    expect(refundsPaid(w.fin)).toEqual(['2000.00']);
  });

  it('unpaid shop order, no method named → still CREDIT_NOTE, owed lowered, no cash out', async () => {
    const w = world(shopOrder({ status: 'CONFIRMED', outstanding: D(2000) }));
    const r = await w.service.create(back(w.order, 1), 'actor');
    expect(r.data!.refundMethod).toBe('CREDIT_NOTE');
    expect(w.order.outstanding.toFixed(2)).toBe('1500.00');
    expect(refundsPaid(w.fin)).toEqual([]);
  });

  it('partly paid, credit within what is owed → allowed, owed lowered', async () => {
    // 2,000 sold, 1,500 paid: 500 owed; one unit back is 500.
    const w = world(
      shopOrder({ status: 'PARTIALLY_PAID', outstanding: D(500) }),
    );
    const r = await w.service.create(back(w.order, 1, 'CREDIT_NOTE'), 'actor');
    expect(r.data!.refundMethod).toBe('CREDIT_NOTE');
    expect(w.order.outstanding.toFixed(2)).toBe('0.00');
    expect(w.order.status).toBe('PAID');
    expect(refundsPaid(w.fin)).toEqual([]);
  });

  it('partly paid, credit beyond what is owed → refused (500 owed, 1,000 back)', async () => {
    const w = world(
      shopOrder({ status: 'PARTIALLY_PAID', outstanding: D(500) }),
    );
    expect(
      await refusal(w.service.create(back(w.order, 2, 'CREDIT_NOTE'), 'actor')),
    ).toEqual({
      code: 'RETURN_CREDIT_OVER_OWED',
      params: {
        order: 'ORD-2026-00016',
        refund: '1000.00',
        outstanding: '500.00',
      },
    });
    expect(w.order.outstanding.toFixed(2)).toBe('500.00');
    expect(w.returns).toHaveLength(0);
  });

  it('partly paid, credit a cent over what is owed → refused', async () => {
    const w = world(
      shopOrder({ status: 'PARTIALLY_PAID', outstanding: D('499.99') }),
    );
    expect(
      (
        await refusal(
          w.service.create(back(w.order, 1, 'CREDIT_NOTE'), 'actor'),
        )
      ).code,
    ).toBe('RETURN_CREDIT_OVER_OWED');
  });

  it('a second credit note is checked against what the first one left', async () => {
    // 2,000 owed. First: 3 units = 1,500 on credit → 500 owed. Second: the
    // last unit, 500, fits exactly; a third unit's worth would not have.
    const w = world(shopOrder({ status: 'CONFIRMED', outstanding: D(2000) }));
    await w.service.create(back(w.order, 3, 'CREDIT_NOTE'), 'actor');
    expect(w.order.outstanding.toFixed(2)).toBe('500.00');

    w.order.outstanding = D(300); // a payment of 200 landed in between
    expect(
      await refusal(w.service.create(back(w.order, 1, 'CREDIT_NOTE'), 'actor')),
    ).toEqual({
      code: 'RETURN_CREDIT_OVER_OWED',
      params: {
        order: 'ORD-2026-00016',
        refund: '500.00',
        outstanding: '300.00',
      },
    });
    // Named nothing: the default follows the new outstanding and is cash.
    const r = await w.service.create(back(w.order, 1), 'actor');
    expect(r.data!.refundMethod).toBe('CASH');
    expect(w.order.outstanding.toFixed(2)).toBe('300.00');
  });

  it('owed went down between the read and the lock → refused inside the transaction', async () => {
    const w = world(shopOrder({ status: 'CONFIRMED', outstanding: D(2000) }));
    // Another return took 1,800 off after this one read 2,000.
    const service = w.service as unknown as {
      prisma: {
        $transaction: (
          fn: (tx: unknown) => Promise<unknown>,
        ) => Promise<unknown>;
      };
    };
    const run = service.prisma.$transaction;
    service.prisma.$transaction = (fn) => {
      w.order.outstanding = D(200);
      return run(fn);
    };
    expect(
      (
        await refusal(
          w.service.create(back(w.order, 1, 'CREDIT_NOTE'), 'actor'),
        )
      ).code,
    ).toBe('RETURN_CREDIT_OVER_OWED');
    expect(w.order.outstanding.toFixed(2)).toBe('200.00');
  });

  it('walk-in: no method named → CASH; credit note → WALK_IN_REFUND_IN_MONEY (unchanged)', async () => {
    const w = world(shopOrder({ isWalkIn: true }));
    expect(
      (
        await refusal(
          w.service.create(back(w.order, 1, 'CREDIT_NOTE'), 'actor'),
        )
      ).code,
    ).toBe('WALK_IN_REFUND_IN_MONEY');
    const r = await w.service.create(back(w.order, 1), 'actor');
    expect(r.data!.refundMethod).toBe('CASH');
    expect(refundsPaid(w.fin)).toEqual(['500.00']);
  });
});
