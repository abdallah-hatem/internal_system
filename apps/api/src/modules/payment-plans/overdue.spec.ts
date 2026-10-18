/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment -- the fake database's rows are untyped records, as Prisma's argument objects are */
/* eslint-disable no-restricted-properties -- the cron door reads CRON_SECRET from process.env, so its test sets it there */
import { HttpException } from '@nestjs/common';

import type { PrismaService } from '../../prisma/prisma.service';
import type { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { JobsController } from '../portal/jobs.controller';
import type { HoldsScheduler } from '../portal/holds.scheduler';
import { PaymentPlansService } from './payment-plans.service';
import type { LendersService } from '../lenders/lenders.service';
import type { SalesService } from '../sales/sales.service';
import type { PushService } from '../notifications/push.service';

/** No phones in this suite: what is written is what is checked. */
const NO_PUSH = {
  sendToUsers: () => Promise.resolve({ sent: 0, removed: 0 }),
} as unknown as PushService;

/**
 * The daily overdue check (BUSINESS_LOGIC §7, DECIDED 2026-10-11): every
 * active core partner hears about each overdue instalment, once, however often
 * the check runs — and the door it runs through is shut without the secret.
 */

/** A calendar day `n` days from today, local, as the plan service reads it. */
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

interface World {
  plans: any[];
  paid: Record<string, number>;
  users: any[];
  notifications: any[];
}

function inList(value: unknown, cond: any) {
  return cond && typeof cond === 'object' && 'in' in cond
    ? cond.in.includes(value)
    : value === cond;
}

function fakePrisma(w: World) {
  return {
    paymentPlan: {
      findMany: jest.fn(({ where }: any) =>
        Promise.resolve(
          w.plans.filter((p) => !where?.status || p.status === where.status),
        ),
      ),
    },
    payment: {
      aggregate: jest.fn(({ where }: any) =>
        Promise.resolve({
          _sum: { amount: w.paid[where.customerId] ?? 0 },
        }),
      ),
    },
    user: {
      findMany: jest.fn(({ where }: any) =>
        Promise.resolve(
          w.users.filter(
            (u) => inList(u.role, where.role) && inList(u.status, where.status),
          ),
        ),
      ),
    },
    notification: {
      findMany: jest.fn(({ where }: any) =>
        Promise.resolve(
          w.notifications.filter(
            (n) =>
              n.eventType === where.eventType &&
              inList(n.userId, where.userId) &&
              (!where.createdAt?.gte || n.createdAt >= where.createdAt.gte),
          ),
        ),
      ),
      createMany: jest.fn(({ data }: any) => {
        for (const row of data)
          w.notifications.push({ ...row, createdAt: new Date() });
        return Promise.resolve({ count: data.length });
      }),
    },
  };
}

function plan(
  id: string,
  instalments: { dueIn: number; amount: number }[],
  extra: any = {},
) {
  return {
    id,
    reference: `PLAN-2026-${id}`,
    customerId: `cust-${id}`,
    agreedOn: day(-30),
    status: 'ACTIVE',
    customer: { id: `cust-${id}`, displayName: `Shop ${id}`, phone: null },
    instalments: instalments.map((i, idx) => ({
      id: `${id}-i${idx + 1}`,
      sequence: idx + 1,
      dueOn: day(i.dueIn),
      amount: i.amount,
      note: null,
    })),
    ...extra,
  };
}

const partners = () => [
  { id: 'p1', role: 'CORE_PARTNER', status: 'ACTIVE' },
  { id: 'p2', role: 'CORE_PARTNER', status: 'ACTIVE' },
  { id: 'gone', role: 'CORE_PARTNER', status: 'INACTIVE' },
  { id: 'inv', role: 'TEMP_INVESTOR', status: 'ACTIVE' },
  { id: 'adm', role: 'ADMIN_SUPPORT', status: 'ACTIVE' },
  { id: 'shop', role: 'SHOP_OWNER_PORTAL', status: 'ACTIVE' },
];

function service(w: World) {
  const prisma = fakePrisma(w) as unknown as PrismaService;
  return new PaymentPlansService(
    prisma,
    { log: jest.fn() } as unknown as AuditService,
    new NotificationsService(prisma, NO_PUSH),
  );
}

const sentTo = (w: World) =>
  w.notifications
    .map((n) => `${n.userId}:${n.payloadJson.instalmentId}`)
    .sort();

describe('notifyOverdue — the daily check', () => {
  it('tells every active core partner, and nobody else, about each overdue instalment', async () => {
    const w: World = {
      plans: [
        plan('A', [
          { dueIn: -7, amount: 1000 },
          { dueIn: -3, amount: 500 },
        ]),
      ],
      paid: {},
      users: partners(),
      notifications: [],
    };

    const result = await service(w).notifyOverdue();

    expect(result).toEqual({ overdueInstalments: 2, notifications: 4 });
    expect(sentTo(w)).toEqual(['p1:A-i1', 'p1:A-i2', 'p2:A-i1', 'p2:A-i2']);
    const first = w.notifications.find(
      (n) => n.payloadJson.instalmentId === 'A-i1',
    );
    expect(first.code).toBe('INSTALMENT_OVERDUE');
    expect(first.eventType).toBe('PAYMENT_OVERDUE');
    expect(first.params).toMatchObject({
      customer: 'Shop A',
      amount: '1,000.00',
      reference: 'PLAN-2026-A',
    });
    expect(first.title).toContain('1,000.00 EGP outstanding');
  });

  it('the second run, and the tenth, send nothing new', async () => {
    const w: World = {
      plans: [plan('A', [{ dueIn: -7, amount: 1000 }])],
      paid: {},
      users: partners(),
      notifications: [],
    };
    const s = service(w);

    await s.notifyOverdue();
    const after1 = w.notifications.length;
    for (let i = 0; i < 9; i++) {
      expect((await s.notifyOverdue()).notifications).toBe(0);
    }

    expect(after1).toBe(2);
    expect(w.notifications).toHaveLength(2);
  });

  it('a later instalment of the same plan falling behind is told, the earlier one is not repeated', async () => {
    const w: World = {
      plans: [
        plan('A', [
          { dueIn: -7, amount: 1000 },
          { dueIn: 0, amount: 500 },
        ]),
      ],
      paid: {},
      users: partners(),
      notifications: [],
    };
    await service(w).notifyOverdue();
    expect(sentTo(w)).toEqual(['p1:A-i1', 'p2:A-i1']);

    // A day later the second instalment's due day is over.
    w.plans[0].instalments[1].dueOn = day(-1);
    await service(w).notifyOverdue();

    expect(sentTo(w)).toEqual(['p1:A-i1', 'p1:A-i2', 'p2:A-i1', 'p2:A-i2']);
  });

  it('due today is not overdue until tomorrow; upcoming is not either', async () => {
    const w: World = {
      plans: [
        plan('A', [
          { dueIn: 0, amount: 1000 },
          { dueIn: 7, amount: 1000 },
        ]),
      ],
      paid: {},
      users: partners(),
      notifications: [],
    };
    expect(await service(w).notifyOverdue()).toEqual({
      overdueInstalments: 0,
      notifications: 0,
    });
    expect(w.notifications).toEqual([]);
  });

  it('paid instalments are not overdue: money covers the earliest promise first', async () => {
    // 1,500 promised by now, 1,200 paid: the first is covered, 300 of the second is behind.
    const w: World = {
      plans: [
        plan('A', [
          { dueIn: -7, amount: 1000 },
          { dueIn: -2, amount: 500 },
        ]),
      ],
      paid: { 'cust-A': 1200 },
      users: partners(),
      notifications: [],
    };
    await service(w).notifyOverdue();

    expect(sentTo(w)).toEqual(['p1:A-i2', 'p2:A-i2']);
    expect(w.notifications[0].params.amount).toBe('300.00');
  });

  it('a cancelled plan is not checked', async () => {
    const w: World = {
      plans: [
        plan('A', [{ dueIn: -7, amount: 1000 }], { status: 'CANCELLED' }),
      ],
      paid: {},
      users: partners(),
      notifications: [],
    };
    expect((await service(w).notifyOverdue()).notifications).toBe(0);
  });

  it('a partner added after the first run hears about what is still overdue; the others are not told again', async () => {
    const w: World = {
      plans: [plan('A', [{ dueIn: -7, amount: 1000 }])],
      paid: {},
      users: partners(),
      notifications: [],
    };
    await service(w).notifyOverdue();
    w.users.push({ id: 'p3', role: 'CORE_PARTNER', status: 'ACTIVE' });

    expect((await service(w).notifyOverdue()).notifications).toBe(1);
    expect(sentTo(w)).toEqual(['p1:A-i1', 'p2:A-i1', 'p3:A-i1']);
  });

  it('an older PAYMENT_OVERDUE row with no instalment id does not silence the new check', async () => {
    const w: World = {
      plans: [plan('A', [{ dueIn: -7, amount: 1000 }])],
      paid: {},
      users: partners(),
      notifications: [
        {
          userId: 'p1',
          eventType: 'PAYMENT_OVERDUE',
          payloadJson: { planId: 'A' },
          createdAt: new Date(),
        },
      ],
    };
    expect((await service(w).notifyOverdue()).notifications).toBe(2);
  });

  it('no partners at all: nothing is written, nothing fails', async () => {
    const w: World = {
      plans: [plan('A', [{ dueIn: -7, amount: 1000 }])],
      paid: {},
      users: [],
      notifications: [],
    };
    expect(await service(w).notifyOverdue()).toEqual({
      overdueInstalments: 1,
      notifications: 0,
    });
  });

  it('reading the overdue summary tells nobody', async () => {
    const w: World = {
      plans: [plan('A', [{ dueIn: -7, amount: 1000 }])],
      paid: {},
      users: partners(),
      notifications: [],
    };
    const summary = await service(w).overdueSummary();

    expect(summary.data.totalOverdueEgp).toBe(1000);
    expect(w.notifications).toEqual([]);
  });
});

describe('GET /jobs/overdue-payments — the door the cron knocks on', () => {
  const original = process.env.CRON_SECRET;
  afterEach(() => {
    if (original === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = original;
  });

  function controller() {
    const plans = {
      notifyOverdue: jest.fn(() =>
        Promise.resolve({ overdueInstalments: 1, notifications: 2 }),
      ),
    };
    const lenders = {
      notifyOverdue: jest.fn(() =>
        Promise.resolve({ overdueInstalments: 1, notifications: 3 }),
      ),
    };
    const sales = {
      notifySamplesReminders: jest.fn(() =>
        Promise.resolve({ samplesDue: 1, notifications: 3 }),
      ),
    };
    const jobs = new JobsController(
      {} as HoldsScheduler,
      plans as unknown as PaymentPlansService,
      lenders as unknown as LendersService,
      sales as unknown as SalesService,
    );
    return { jobs, plans, lenders, sales };
  }

  async function codeOf(p: Promise<unknown>) {
    try {
      await p;
    } catch (e) {
      const err = e as HttpException;
      return [err.getStatus(), (err.getResponse() as any).code];
    }
    return 'not refused';
  }

  it('no CRON_SECRET on the deployment → 401 CRON_NOT_CONFIGURED, nothing runs', async () => {
    delete process.env.CRON_SECRET;
    const { jobs, plans } = controller();
    expect(await codeOf(jobs.overduePayments('Bearer anything'))).toEqual([
      401,
      'CRON_NOT_CONFIGURED',
    ]);
    expect(plans.notifyOverdue).not.toHaveBeenCalled();
  });

  it("a friend's overdue instalment rides the same call — no cron of its own (§18)", async () => {
    process.env.CRON_SECRET = 'right-secret';
    const { jobs, lenders } = controller();
    const res = await jobs.overduePayments('Bearer right-secret');
    expect(lenders.notifyOverdue).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({
      lenders: { overdueInstalments: 1, notifications: 3 },
    });
  });

  it('samples at a shop for 14 days ride the same call — no cron of their own (§4)', async () => {
    process.env.CRON_SECRET = 'right-secret';
    const { jobs, sales } = controller();
    const res = await jobs.overduePayments('Bearer right-secret');
    expect(sales.notifySamplesReminders).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ samples: { samplesDue: 1, notifications: 3 } });
  });

  it('the wrong secret sends no samples reminder either', async () => {
    process.env.CRON_SECRET = 'right-secret';
    const { jobs, sales } = controller();
    await jobs.overduePayments('Bearer wrong').catch(() => undefined);
    expect(sales.notifySamplesReminders).not.toHaveBeenCalled();
  });

  it('no header, or the wrong secret → 401 CRON_FORBIDDEN, nothing runs', async () => {
    process.env.CRON_SECRET = 'right-secret';
    const { jobs, plans } = controller();
    expect(await codeOf(jobs.overduePayments(undefined))).toEqual([
      401,
      'CRON_FORBIDDEN',
    ]);
    expect(await codeOf(jobs.overduePayments('Bearer wrong'))).toEqual([
      401,
      'CRON_FORBIDDEN',
    ]);
    expect(await codeOf(jobs.overduePayments('right-secret'))).toEqual([
      401,
      'CRON_FORBIDDEN',
    ]);
    expect(plans.notifyOverdue).not.toHaveBeenCalled();
  });

  it('the right secret runs the check and says what it did', async () => {
    process.env.CRON_SECRET = 'right-secret';
    const { jobs, plans } = controller();
    const res = await jobs.overduePayments('Bearer right-secret');
    expect(plans.notifyOverdue).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({
      ok: true,
      overdueInstalments: 1,
      notifications: 2,
    });
  });
});
