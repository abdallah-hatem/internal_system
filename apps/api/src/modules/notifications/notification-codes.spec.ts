import { NotificationsService } from './notifications.service';
import { PortalNotifier } from './portal-notifier.service';
import {
  NOTIFICATION_MESSAGES,
  pushLocaleFor,
  renderNotification,
  type NotificationCode,
} from '../../common/notification-messages';

/**
 * U5: a notification is stored as a code and its params, and worded by the
 * reader's app in the reader's language. The server words it only for the
 * English `title` (logs, and old clients) and for a push.
 */

interface Row {
  userId: string;
  eventType: string;
  code: string;
  params: Record<string, unknown>;
  title: string;
}

function makeNotifications() {
  const prisma = {
    notification: {
      create: jest.fn((a: { data: Row }) => Promise.resolve(a.data)),
      createMany: jest.fn((a: { data: Row[] }) => Promise.resolve(a)),
    },
  };
  const service = new NotificationsService(
    prisma as unknown as ConstructorParameters<typeof NotificationsService>[0],
  );
  return { prisma, service };
}

const placeholders = (text: string) =>
  [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('notification codes', () => {
  it('create stores the code and params, and derives the English title from them', async () => {
    const { prisma, service } = makeNotifications();
    await service.create({
      userId: 'u-1',
      eventType: 'ADDED_TO_CYCLE',
      code: 'ADDED_TO_CYCLE',
      params: { cycleCode: 'CYC-2026-0007' },
      payload: { cycleId: 'c-7' },
    });
    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: {
        userId: 'u-1',
        eventType: 'ADDED_TO_CYCLE',
        code: 'ADDED_TO_CYCLE',
        params: { cycleCode: 'CYC-2026-0007' },
        title: 'You have been added to cycle CYC-2026-0007',
        payloadJson: { cycleId: 'c-7' },
      },
    });
  });

  it('createForMultipleUsers writes the same code, params and title for every reader', async () => {
    const { prisma, service } = makeNotifications();
    await service.createForMultipleUsers(['a', 'b'], {
      eventType: 'PAYMENT_OVERDUE',
      code: 'PAYMENT_OVERDUE',
      params: {
        customer: 'Nile Motors',
        amount: '1,250.00',
        reference: 'PLN-0003',
      },
    });
    const rows = prisma.notification.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.userId)).toEqual(['a', 'b']);
    for (const row of rows) {
      expect(row.code).toBe('PAYMENT_OVERDUE');
      expect(row.params).toEqual({
        customer: 'Nile Motors',
        amount: '1,250.00',
        reference: 'PLN-0003',
      });
      expect(row.title).toBe('Nile Motors is 1,250.00 EGP behind on PLN-0003');
    }
  });

  it('a param the caller forgot stays visible as {name}, never "undefined"', () => {
    const words = renderNotification(
      'CYCLE_STATUS_CHANGED',
      { cycleCode: 'CYC-1' },
      'en',
    );
    expect(words.title).toBe('Cycle CYC-1 moved to {toStatus}');
    expect(words.title).not.toContain('undefined');
  });

  it('every code is worded in both languages, with the same placeholders in each', () => {
    for (const [code, langs] of Object.entries(NOTIFICATION_MESSAGES)) {
      const en = langs.en as { title: string; body?: string };
      const ar = langs.ar as { title: string; body?: string };
      expect([code, placeholders(ar.title)]).toEqual([
        code,
        placeholders(en.title),
      ]);
      expect([code, Boolean(ar.body)]).toEqual([code, Boolean(en.body)]);
      if (en.body)
        expect([code, placeholders(ar.body!)]).toEqual([
          code,
          placeholders(en.body),
        ]);
      // Arabic means Arabic: not the English copied across.
      expect([code, ar.title === en.title]).toEqual([code, false]);
    }
  });

  describe('which language a push goes out in', () => {
    it('a stored locale wins over everything', () => {
      expect(pushLocaleFor({ role: 'SHOP_OWNER_PORTAL', locale: 'en' })).toBe(
        'en',
      );
      expect(pushLocaleFor({ role: 'CORE_PARTNER', locale: 'ar' })).toBe('ar');
    });

    it('without one: a shop gets Arabic (the storefront default), the office English (the internal default)', () => {
      expect(pushLocaleFor({ role: 'SHOP_OWNER_PORTAL' })).toBe('ar');
      expect(pushLocaleFor({ role: 'CORE_PARTNER' })).toBe('en');
      expect(pushLocaleFor({ role: 'ADMIN_SUPPORT', locale: null })).toBe('en');
    });

    it('a locale that is neither language is ignored, not trusted', () => {
      expect(pushLocaleFor({ role: 'SHOP_OWNER_PORTAL', locale: 'fr' })).toBe(
        'ar',
      );
    });
  });
});

describe('PortalNotifier', () => {
  function makeNotifier(
    over: { roles?: Record<string, string>; pushFails?: boolean } = {},
  ) {
    const roles = over.roles ?? {
      shop: 'SHOP_OWNER_PORTAL',
      p1: 'CORE_PARTNER',
      a1: 'ADMIN_SUPPORT',
    };
    const prisma = {
      user: {
        findMany: jest.fn((args: { where?: { id?: { in: string[] } } }) => {
          const ids = args.where?.id?.in;
          if (ids) {
            return Promise.resolve(
              ids.map((id) => ({ id, role: roles[id] ?? null })),
            );
          }
          return Promise.resolve([{ id: 'p1' }, { id: 'a1' }]);
        }),
      },
      customer: {
        findUnique: jest.fn(() => Promise.resolve({ shopOwnerUserId: 'shop' })),
      },
    };
    const notifications = {
      createForMultipleUsers: jest.fn(
        (_ids: string[], _data: { code: NotificationCode }) =>
          Promise.resolve({ count: 1 }),
      ),
    };
    const push = {
      sendToUser: jest.fn(
        (_userId: string, _payload: { title: string; body: string }) =>
          over.pushFails
            ? Promise.reject(new Error('push service down'))
            : Promise.resolve({ sent: 1, removed: 0 }),
      ),
    };
    type Deps = ConstructorParameters<typeof PortalNotifier>;
    const notifier = new PortalNotifier(
      prisma as unknown as Deps[0],
      notifications as unknown as Deps[1],
      push as unknown as Deps[2],
    );
    return { notifier, notifications, push };
  }

  it('the row carries the code and params; the shop’s push is in Arabic', async () => {
    const { notifier, notifications, push } = makeNotifier();
    await notifier.orderRequestAnswered({
      customerId: 'c-1',
      requestId: 'r-1',
      requestNo: 'REQ-0042',
      approved: true,
      partial: true,
    });

    expect(notifications.createForMultipleUsers).toHaveBeenCalledWith(
      ['shop'],
      expect.objectContaining({
        eventType: 'ORDER_REQUEST_APPROVED',
        code: 'ORDER_REQUEST_APPROVED_PARTIAL',
        params: { requestNo: 'REQ-0042' },
      }),
    );
    const sent = (push.sendToUser.mock.calls[0] as unknown[])[1] as {
      title: string;
      body: string;
    };
    expect(sent.title).toBe('تمت الموافقة على REQ-0042');
    expect(sent.body).toBe(
      NOTIFICATION_MESSAGES.ORDER_REQUEST_APPROVED_PARTIAL.ar.body,
    );
  });

  it('the office’s push for the same storefront event is in English', async () => {
    const { notifier, push } = makeNotifier();
    await notifier.orderRequestSubmitted({
      requestId: 'r-2',
      requestNo: 'REQ-0043',
      shopName: 'Nile Motors',
    });
    expect(push.sendToUser).toHaveBeenCalledTimes(2);
    for (const call of push.sendToUser.mock.calls as unknown[][]) {
      expect((call[1] as { title: string }).title).toBe(
        'Nile Motors asked to buy — REQ-0043',
      );
    }
  });

  it('a push that fails never reaches the caller, and the row is still written', async () => {
    const { notifier, notifications } = makeNotifier({ pushFails: true });
    await expect(
      notifier.shopSignedUp({ customerId: 'c-9', shopName: 'Delta Spares' }),
    ).resolves.toBeUndefined();
    expect(notifications.createForMultipleUsers).toHaveBeenCalledTimes(1);
  });

  it('an import request status with no wording writes nothing rather than a row with no text', async () => {
    const { notifier, notifications, push } = makeNotifier();
    await notifier.importRequestAnswered({
      customerId: 'c-1',
      requestId: 'r-3',
      productName: 'Piston kit',
      status: 'CANCELLED',
    });
    expect(notifications.createForMultipleUsers).not.toHaveBeenCalled();
    expect(push.sendToUser).not.toHaveBeenCalled();
  });

  it('every code the notifier can send is a known code', async () => {
    const { notifier, notifications } = makeNotifier();
    await notifier.importRequestAnswered({
      customerId: 'c',
      requestId: 'r',
      productName: 'x',
      status: 'SOURCING',
    });
    await notifier.importRequestAnswered({
      customerId: 'c',
      requestId: 'r',
      productName: 'x',
      status: 'ANSWERED',
    });
    await notifier.importRequestAnswered({
      customerId: 'c',
      requestId: 'r',
      productName: 'x',
      status: 'DECLINED',
    });
    await notifier.holdExpiringSoon({
      requestId: 'r',
      requestNo: 'REQ-1',
      shopName: 's',
    });
    await notifier.importRequestSubmitted({
      requestId: 'r',
      productName: 'x',
      shopName: 's',
    });
    await notifier.orderRequestAnswered({
      customerId: 'c',
      requestId: 'r',
      requestNo: 'REQ-1',
      approved: false,
    });
    await notifier.orderRequestAnswered({
      customerId: 'c',
      requestId: 'r',
      requestNo: 'REQ-1',
      approved: true,
    });
    const codes = (
      notifications.createForMultipleUsers.mock.calls as unknown[][]
    ).map((c) => (c[1] as { code: NotificationCode }).code);
    expect(codes).toHaveLength(7);
    for (const code of codes)
      expect(Object.keys(NOTIFICATION_MESSAGES)).toContain(code);
  });
});
