/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/require-await, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- an in-memory stand-in for Prisma answers loosely-shaped query objects */
// The fake store holds real Decimals, as the services expect.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { Prisma } from '@prisma/client';
import type { HttpException } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import { PaymentsService } from './payments.service';

/**
 * Reversing a payment puts what it paid back on the orders it was allocated
 * to. It used to do that every time it was asked — a second reversal of the
 * same payment put the money back twice, so a shop owed more than it had ever
 * been charged. A payment is reversed once; the second asks are refused with
 * PAYMENT_ALREADY_REVERSED and change nothing. e2e: spec 34 TC-INV-PAY-REV.
 */

const D = (v: number | string) => new Prisma.Decimal(v);

function fake() {
  const store = {
    orders: [
      { id: 'order-1', status: 'PAID', outstanding: D(0), version: 1 },
      {
        id: 'order-2',
        status: 'PARTIALLY_PAID',
        outstanding: D(100),
        version: 1,
      },
    ],
    payments: [
      {
        id: 'pay-1',
        status: 'RECORDED',
        amount: D(500),
        version: 1,
        allocations: [
          { saleOrderId: 'order-1', amount: D(300) },
          { saleOrderId: 'order-2', amount: D(200) },
        ],
      },
    ],
  };
  const client: any = {
    payment: {
      findUnique: async ({ where }: any) => {
        const p = store.payments.find((x) => x.id === where.id);
        return p
          ? { ...p, allocations: p.allocations.map((a) => ({ ...a })) }
          : null;
      },
      update: async ({ where, data }: any) => {
        const p = store.payments.find((x) => x.id === where.id)!;
        p.status = data.status;
        p.version += data.version?.increment ?? 0;
        return { ...p };
      },
      updateMany: async ({ where, data }: any) => {
        const rows = store.payments.filter(
          (x) =>
            x.id === where.id && (!where.status || x.status === where.status),
        );
        for (const p of rows) {
          p.status = data.status;
          p.version += data.version?.increment ?? 0;
        }
        return { count: rows.length };
      },
    },
    saleOrder: {
      findUnique: async ({ where }: any) => {
        const o = store.orders.find((x) => x.id === where.id);
        return o ? { ...o } : null;
      },
      update: async ({ where, data }: any) => {
        const o = store.orders.find((x) => x.id === where.id)!;
        if (data.outstanding?.increment !== undefined) {
          o.outstanding = o.outstanding.add(data.outstanding.increment);
        }
        if (data.status) o.status = data.status;
        return { ...o };
      },
    },
    // No rollback here: a snapshot restore would also undo the other,
    // interleaved reversal's writes, which Postgres would not. The code under
    // test writes nothing before its claim, so a refused one has nothing to undo.
    $transaction: async (fn: (tx: any) => Promise<unknown>) => fn(client),
  };
  const audit = { log: jest.fn(async () => undefined) };
  const service = new PaymentsService(
    client as PrismaService,
    audit as unknown as AuditService,
  );
  return { service, store, audit };
}

async function refused(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    const err = e as HttpException;
    return {
      status: err.getStatus(),
      code: (err.getResponse() as { code: string }).code,
    };
  }
  throw new Error('expected a refusal, and the request went through');
}

const owed = (store: ReturnType<typeof fake>['store']) =>
  store.orders.map((o) => o.outstanding.toNumber());

describe('PaymentsService.reverse', () => {
  it('the first reversal puts the money back on each order and marks the payment reversed', async () => {
    const { service, store } = fake();
    await service.reverse('pay-1', 'entered twice', 'actor');
    expect(owed(store)).toEqual([300, 300]);
    expect(store.payments[0].status).toBe('REVERSED');
  });

  it('a second reversal is refused with PAYMENT_ALREADY_REVERSED and puts nothing back again', async () => {
    const { service, store, audit } = fake();
    await service.reverse('pay-1', 'entered twice', 'actor');
    const r = await refused(service.reverse('pay-1', 'again', 'actor'));
    expect(r).toEqual({ status: 400, code: 'PAYMENT_ALREADY_REVERSED' });
    expect(owed(store)).toEqual([300, 300]);
    expect(audit.log).toHaveBeenCalledTimes(1);
  });

  it('two reversals sent at once: one wins, the money goes back once', async () => {
    const { service, store } = fake();
    const results = await Promise.allSettled([
      service.reverse('pay-1', 'a', 'actor'),
      service.reverse('pay-1', 'b', 'actor'),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(owed(store)).toEqual([300, 300]);
  });

  it('a payment that does not exist is a 404, not a 500', async () => {
    const { service } = fake();
    expect((await refused(service.reverse('nope', 'x', 'actor'))).status).toBe(
      404,
    );
  });
});
