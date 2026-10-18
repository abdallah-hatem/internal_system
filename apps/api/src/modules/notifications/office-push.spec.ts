/* eslint-disable @typescript-eslint/require-await -- the fake prisma's methods return promises like the real ones */
import type { ConfigService } from '@nestjs/config';

jest.mock('web-push', () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the mocked module, after jest.mock
const webpush = require('web-push') as { sendNotification: jest.Mock };

import { PushService } from './push.service';
import {
  NotificationsService,
  bellLink,
  notifyLowStock,
} from './notifications.service';
import { renderNotification } from '../../common/notification-messages';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * Owner, 2026-10-18: a test sale took a product below its minimum, the bell
 * rang on the desktop, and his phone — alerts on, the test alert arriving —
 * stayed silent. Office notifications were only ever written, never pushed.
 *
 * Here the real NotificationsService and the real PushService run over a fake
 * database; only the network call to the push service is mocked. Every test
 * asks what reached a phone, and what the database was asked to do.
 */

type Sub = {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

const sub = (id: string, userId: string): Sub => ({
  id,
  userId,
  endpoint: `https://push.example/${id}`,
  p256dh: 'k',
  auth: 'a',
});

function world(subs: Sub[], opts: { configured?: boolean } = {}) {
  const rows: { userId: string; title: string; eventType: string }[] = [];
  const devices = [...subs];
  const prisma = {
    user: {
      findMany: jest.fn(async () => [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }]),
    },
    notification: {
      create: jest.fn(
        async (a: {
          data: { userId: string; title: string; eventType: string };
        }) => {
          rows.push(a.data);
          return { id: `n-${rows.length}`, ...a.data };
        },
      ),
      createMany: jest.fn(
        async (a: {
          data: { userId: string; title: string; eventType: string }[];
        }) => {
          rows.push(...a.data);
          return { count: a.data.length };
        },
      ),
    },
    pushSubscription: {
      findMany: jest.fn(async (a: { where: { userId: { in: string[] } } }) =>
        devices.filter((d) => a.where.userId.in.includes(d.userId)),
      ),
      updateMany: jest.fn(async () => ({ count: 1 })),
      deleteMany: jest.fn(async (a: { where: { id: { in: string[] } } }) => {
        for (const id of a.where.id.in) {
          devices.splice(
            devices.findIndex((d) => d.id === id),
            1,
          );
        }
        return { count: a.where.id.in.length };
      }),
    },
  };
  const config = {
    get: (k: string) =>
      opts.configured === false
        ? undefined
        : (
            { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' } as Record<
              string,
              string
            >
          )[k],
  } as unknown as ConfigService;
  const db = prisma as unknown as PrismaService;
  const push = new PushService(db, config);
  const notifications = new NotificationsService(db, push);
  return { prisma, rows, devices, notifications, push };
}

/** What each device was handed, by endpoint. */
function delivered() {
  return (
    webpush.sendNotification.mock.calls as [{ endpoint: string }, string][]
  ).map(([target, body]) => ({
    endpoint: target.endpoint,
    ...(JSON.parse(body) as {
      title: string;
      body: string;
      url?: string;
      tag?: string;
      locale?: string;
    }),
  }));
}

const lowStock = [
  {
    productId: 'prod-1',
    productName: 'Brake pad',
    sku: 'BP-1',
    remaining: 2,
    minStockLevel: 5,
  },
];
const lowStockWords = renderNotification(
  'LOW_STOCK_DETECTED',
  { products: 'Brake pad' },
  'ar',
);

beforeEach(() => {
  webpush.sendNotification.mockReset();
  webpush.sendNotification.mockResolvedValue({});
});
afterEach(() => jest.useRealTimers());

describe('office notifications reach the phone', () => {
  it('a low-stock alert for three partners reaches every one of their devices, in the bell’s own words', async () => {
    const w = world([
      sub('p1-phone', 'p1'),
      sub('p1-laptop', 'p1'),
      sub('p2-phone', 'p2'),
      sub('p3-phone', 'p3'),
    ]);
    await notifyLowStock(
      w.prisma as unknown as PrismaService,
      w.notifications,
      lowStock as never,
    );

    expect(w.rows.map((r) => r.userId)).toEqual(['p1', 'p2', 'p3']);
    const sent = delivered();
    expect(sent.map((s) => s.endpoint).sort()).toEqual(
      [
        'https://push.example/p1-laptop',
        'https://push.example/p1-phone',
        'https://push.example/p2-phone',
        'https://push.example/p3-phone',
      ].sort(),
    );
    for (const s of sent) {
      // The bell's sentence, from the same table, in Arabic: nobody stores
      // a language yet (GUESS 2026-10-18, BUSINESS_LOGIC §10).
      expect(s.title).toBe(lowStockWords.title);
      expect(s.title).toBe('مخزون منخفض: Brake pad');
      expect(s.locale).toBe('ar');
    }
  });

  it('the push opens what the bell opens: the event and its ids, to the office’s /notifications/open', async () => {
    const w = world([sub('p1-phone', 'p1')]);
    await w.notifications.create({
      userId: 'p1',
      eventType: 'ADDED_TO_CYCLE',
      code: 'ADDED_TO_CYCLE',
      params: { cycleCode: 'CYC-2026-0007' },
      payload: {
        cycleId: 'c-7',
        cycleCode: 'CYC-2026-0007',
        contribution: 5000,
      },
    });
    const [s] = delivered();
    expect(s.url).toBe(
      '/notifications/open?event=ADDED_TO_CYCLE&cycleId=c-7&cycleCode=CYC-2026-0007&contribution=5000',
    );
    expect(s.url).toBe(
      bellLink('ADDED_TO_CYCLE', {
        cycleId: 'c-7',
        cycleCode: 'CYC-2026-0007',
        contribution: 5000,
      }),
    );
    // A second alert about the same thing replaces this one, not stacks.
    expect(s.tag).toBe(s.url);
    expect(s.title).toBe(
      renderNotification('ADDED_TO_CYCLE', { cycleCode: 'CYC-2026-0007' }, 'ar')
        .title,
    );
  });

  it('a low-stock link carries no product list — only flat ids travel', async () => {
    const w = world([sub('p1-phone', 'p1')]);
    await notifyLowStock(
      w.prisma as unknown as PrismaService,
      w.notifications,
      lowStock as never,
    );
    expect(delivered()[0].url).toBe(
      '/notifications/open?event=LOW_STOCK_DETECTED',
    );
  });

  it('createForMultipleUsers asks for everyone’s devices once, not once per person', async () => {
    const w = world([
      sub('p1-phone', 'p1'),
      sub('p2-phone', 'p2'),
      sub('p3-phone', 'p3'),
    ]);
    await w.notifications.createForMultipleUsers(['p1', 'p2', 'p3'], {
      eventType: 'CYCLE_CREATED',
      code: 'CYCLE_CREATED',
      params: { cycleCode: 'CYC-1' },
      payload: { cycleId: 'c-1' },
    });
    expect(w.prisma.pushSubscription.findMany).toHaveBeenCalledTimes(1);
    expect(
      w.prisma.pushSubscription.findMany.mock.calls[0][0].where.userId.in,
    ).toEqual(['p1', 'p2', 'p3']);
    // And the bookkeeping is one write for all three, not three.
    expect(w.prisma.pushSubscription.updateMany).toHaveBeenCalledTimes(1);
  });

  it('a person named twice gets one push per device, not two', async () => {
    const w = world([sub('p1-phone', 'p1')]);
    await w.notifications.createForMultipleUsers(['p1', 'p1'], {
      eventType: 'CYCLE_CREATED',
      code: 'CYCLE_CREATED',
      params: { cycleCode: 'CYC-1' },
    });
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
  });

  it('someone with no device gets the row and no push; nobody with a device is a no-op with one query', async () => {
    const w = world([sub('p1-phone', 'p1')]);
    await notifyLowStock(
      w.prisma as unknown as PrismaService,
      w.notifications,
      lowStock as never,
    );
    expect(w.rows.map((r) => r.userId)).toEqual(['p1', 'p2', 'p3']);
    expect(delivered().map((s) => s.endpoint)).toEqual([
      'https://push.example/p1-phone',
    ]);

    const none = world([]);
    await notifyLowStock(
      none.prisma as unknown as PrismaService,
      none.notifications,
      lowStock as never,
    );
    expect(none.rows).toHaveLength(3);
    expect(none.prisma.pushSubscription.findMany).toHaveBeenCalledTimes(1);
    expect(none.prisma.pushSubscription.updateMany).not.toHaveBeenCalled();
    expect(none.prisma.pushSubscription.deleteMany).not.toHaveBeenCalled();
  });

  it('a subscription the push service says is gone (410) is removed; the others are kept', async () => {
    const w = world([sub('p1-old', 'p1'), sub('p1-new', 'p1')]);
    webpush.sendNotification.mockImplementation(
      async (target: { endpoint: string }) => {
        if (target.endpoint.endsWith('p1-old'))
          throw Object.assign(new Error('gone'), { statusCode: 410 });
        return {};
      },
    );
    await w.notifications.create({
      userId: 'p1',
      eventType: 'CYCLE_CREATED',
      code: 'CYCLE_CREATED',
      params: { cycleCode: 'CYC-1' },
    });
    expect(w.prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['p1-old'] } },
    });
    expect(w.devices.map((d) => d.id)).toEqual(['p1-new']);
  });

  it('a push service that fails keeps the rows and never fails the request', async () => {
    const w = world([sub('p1-phone', 'p1'), sub('p2-phone', 'p2')]);
    webpush.sendNotification.mockRejectedValue(new Error('push service down'));
    await expect(
      notifyLowStock(
        w.prisma as unknown as PrismaService,
        w.notifications,
        lowStock as never,
      ),
    ).resolves.toBeUndefined();
    expect(w.rows).toHaveLength(3);
    // Counted as a failure, not removed: a bad moment is not a gone device.
    expect(w.prisma.pushSubscription.deleteMany).not.toHaveBeenCalled();
    expect(w.prisma.pushSubscription.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['p1-phone', 'p2-phone'] } },
      data: { failureCount: { increment: 1 } },
    });
  });

  it('a database that cannot list devices, or record how a push went, still loses nothing', async () => {
    const w = world([sub('p1-phone', 'p1')]);
    w.prisma.pushSubscription.findMany.mockRejectedValueOnce(
      new Error('connection reset'),
    );
    const created = await w.notifications.create({
      userId: 'p1',
      eventType: 'CYCLE_CREATED',
      code: 'CYCLE_CREATED',
      params: { cycleCode: 'CYC-1' },
    });
    expect(created).toMatchObject({ userId: 'p1' });

    w.prisma.pushSubscription.updateMany.mockRejectedValueOnce(
      new Error('connection reset'),
    );
    await expect(
      w.notifications.createForMultipleUsers(['p1'], {
        eventType: 'CYCLE_CREATED',
        code: 'CYCLE_CREATED',
        params: { cycleCode: 'CYC-2' },
      }),
    ).resolves.toEqual({ count: 1 });
    expect(w.rows).toHaveLength(2);
  });

  it('a push service that never answers holds the request for the deadline, not forever', async () => {
    jest.useFakeTimers();
    const w = world([sub('p1-phone', 'p1'), sub('p2-phone', 'p2')]);
    webpush.sendNotification.mockImplementation(
      (target: { endpoint: string }) =>
        target.endpoint.endsWith('p1-phone')
          ? new Promise(() => undefined)
          : Promise.resolve({}),
    );
    let done = false;
    const pending = w.notifications
      .createForMultipleUsers(['p1', 'p2'], {
        eventType: 'CYCLE_CREATED',
        code: 'CYCLE_CREATED',
        params: { cycleCode: 'CYC-1' },
      })
      .then(() => {
        done = true;
      });
    await jest.advanceTimersByTimeAsync(PushService.DEADLINE_MS - 100);
    expect(done).toBe(false);
    await jest.advanceTimersByTimeAsync(200);
    await pending;
    expect(done).toBe(true);
    // The one that answered is recorded; the silent one is neither.
    expect(w.prisma.pushSubscription.updateMany).toHaveBeenCalledTimes(1);
    expect(w.prisma.pushSubscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['p2-phone'] } } }),
    );
    // Each send is also told to give up on its own.
    const options = (
      webpush.sendNotification.mock.calls as unknown[][]
    )[0][2] as {
      timeout: number;
    };
    expect(options.timeout).toBeLessThanOrEqual(PushService.DEADLINE_MS);
  });

  it('with push not set up on the server, the row is written and no device is even looked up', async () => {
    const w = world([sub('p1-phone', 'p1')], { configured: false });
    await w.notifications.create({
      userId: 'p1',
      eventType: 'CYCLE_CREATED',
      code: 'CYCLE_CREATED',
      params: { cycleCode: 'CYC-1' },
    });
    expect(w.rows).toHaveLength(1);
    expect(w.prisma.pushSubscription.findMany).not.toHaveBeenCalled();
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it('an event that names its own page (a shop’s storefront link) keeps it', async () => {
    const w = world([sub('shop-phone', 'shop')]);
    await w.notifications.createForMultipleUsers(['shop'], {
      eventType: 'ORDER_REQUEST_APPROVED',
      code: 'ORDER_REQUEST_APPROVED',
      params: { requestNo: 'REQ-1' },
      push: { url: '/requests/r-1', tag: 'order-request-r-1' },
    });
    expect(delivered()[0]).toMatchObject({
      url: '/requests/r-1',
      tag: 'order-request-r-1',
    });
  });

  it('the bell’s link is built from flat values only, and an `event` in the payload cannot replace the real one', () => {
    expect(
      bellLink('SHIPPING_LEG_ARRIVED', {
        event: 'SHOP_SIGNED_UP',
        cycleId: 'c 1&x',
        nested: { a: 1 },
        list: [1, 2],
        long: 'x'.repeat(201),
        missing: null,
      }),
    ).toBe('/notifications/open?event=SHIPPING_LEG_ARRIVED&cycleId=c+1%26x');
  });
});
