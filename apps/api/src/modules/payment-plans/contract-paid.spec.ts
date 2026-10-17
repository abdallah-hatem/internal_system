/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- the fake database's rows are untyped records, as Prisma's argument objects are */
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- Decimal is a value type, not data access; plan amounts are Decimals
import { Prisma } from '@prisma/client';

import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { NotificationsService } from '../notifications/notifications.service';
import { PaymentPlansService } from './payment-plans.service';

/**
 * What has been paid toward a contract (§7, owner 2026-10-17): its total less
 * what its sale still owes — never the shop's payments since the agreed day,
 * which counted a same-day down payment as paying the contract and gave each
 * of a shop's contracts every one of the shop's payments.
 */

const D = (v: number) => new Prisma.Decimal(v);

/** A calendar day `n` days from today, as the plan service stores due dates. */
function day(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const iso = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
  return new Date(`${iso}T00:00:00Z`);
}

function plan(
  id: string,
  opts: {
    customerId?: string;
    outstanding: number | null;
    amounts: number[];
    firstDue?: number;
  },
) {
  return {
    id,
    customerId: opts.customerId ?? 'shop-1',
    agreedOn: day(0),
    status: 'ACTIVE',
    customer: {
      id: opts.customerId ?? 'shop-1',
      displayName: 'Shop',
      phone: null,
    },
    saleOrder:
      opts.outstanding === null
        ? null
        : {
            id: `sale-${id}`,
            orderNo: `ORD-${id}`,
            outstanding: D(opts.outstanding),
          },
    instalments: opts.amounts.map((a, i) => ({
      id: `${id}-i${i}`,
      sequence: i + 1,
      dueOn: day((opts.firstDue ?? 7) + i * 7),
      amount: D(a),
      note: null,
    })),
  };
}

function service(plans: any[], paidByShop: number) {
  const prisma = {
    paymentPlan: {
      findMany: jest.fn(() => Promise.resolve(plans)),
      findUnique: jest.fn(({ where }: any) =>
        Promise.resolve(plans.find((p) => p.id === where.id) ?? null),
      ),
    },
    payment: {
      aggregate: jest.fn(() =>
        Promise.resolve({ _sum: { amount: D(paidByShop) } }),
      ),
    },
  };
  const svc = new PaymentPlansService(
    prisma as unknown as PrismaService,
    {} as AuditService,
    {} as NotificationsService,
  );
  return { svc, prisma };
}

const figures = (p: any) => ({
  paid: Number(p.paidEgp),
  remaining: Number(p.remainingEgp),
});

describe('what has been paid toward a contract', () => {
  it('a down payment made before the contract, the same day, pays none of it', async () => {
    // Sale 7,200; 5,000 paid at signing; the contract covers the 2,200 still owed.
    const { svc } = service(
      [plan('a', { outstanding: 2200, amounts: [1100, 1100] })],
      5000,
    );
    const [p] = (await svc.findAll({})).data;
    expect(figures(p)).toEqual({ paid: 0, remaining: 2200 });
  });

  it('a payment on the sale after signing is paid toward it, and only that much', async () => {
    const { svc } = service(
      [plan('a', { outstanding: 1200, amounts: [1100, 1100] })],
      5000 + 1000,
    );
    const [p] = (await svc.findAll({})).data;
    expect(figures(p)).toEqual({ paid: 1000, remaining: 1200 });
  });

  it('two contracts at one shop never share a payment', async () => {
    // 3,000 paid on sale A's contract, nothing on B's; the shop has paid 3,000 in all.
    const { svc } = service(
      [
        plan('a', { outstanding: 0, amounts: [1500, 1500] }),
        plan('b', { outstanding: 4000, amounts: [2000, 2000] }),
      ],
      3000,
    );
    const [a, b] = (await svc.findAll({})).data;
    expect(figures(a)).toEqual({ paid: 3000, remaining: 0 });
    expect(figures(b)).toEqual({ paid: 0, remaining: 4000 });
  });

  it('a sale paid beyond its contract still reads the contract as paid in full, never more', async () => {
    const { svc } = service(
      [plan('a', { outstanding: 0, amounts: [1100, 1100] })],
      99999,
    );
    const [p] = (await svc.findAll({})).data;
    expect(figures(p)).toEqual({ paid: 2200, remaining: 0 });
  });

  it('a sale owing more than its contract (a later change) is never read as negative', async () => {
    const { svc } = service(
      [plan('a', { outstanding: 3000, amounts: [1100, 1100] })],
      0,
    );
    const [p] = (await svc.findAll({})).data;
    expect(figures(p).paid).toBe(0);
  });

  it('an older plan with no sale keeps reading the shop’s payments since it was agreed', async () => {
    const { svc, prisma } = service(
      [plan('old', { outstanding: null, amounts: [500, 500] })],
      600,
    );
    const [p] = (await svc.findAll({})).data;
    expect(figures(p)).toEqual({ paid: 600, remaining: 400 });
    expect(prisma.payment.aggregate).toHaveBeenCalled();
  });

  it('one plan opened on its own reads the same as in the list', async () => {
    const { svc } = service(
      [plan('a', { outstanding: 2200, amounts: [1100, 1100] })],
      5000,
    );
    expect(figures((await svc.findOne('a')).data)).toEqual({
      paid: 0,
      remaining: 2200,
    });
  });
});
