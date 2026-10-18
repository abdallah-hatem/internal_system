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
  type Deps = ConstructorParameters<typeof NotificationsService>;
  const push = {
    sendToUsers: jest.fn(() => Promise.resolve({ sent: 0, removed: 0 })),
  };
  const service = new NotificationsService(
    prisma as unknown as Deps[0],
    push as unknown as Deps[1],
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
      expect(pushLocaleFor({ locale: 'en' })).toBe('en');
      expect(pushLocaleFor({ locale: 'ar' })).toBe('ar');
    });

    it('without one: Arabic, the business’s language, for shop and office alike (GUESS 2026-10-18)', () => {
      expect(pushLocaleFor({})).toBe('ar');
      expect(pushLocaleFor({ locale: null })).toBe('ar');
    });

    it('a locale that is neither language is ignored, not trusted', () => {
      expect(pushLocaleFor({ locale: 'fr' })).toBe('ar');
    });
  });
});

describe('PortalNotifier', () => {
  /**
   * The real NotificationsService under the notifier, since 2026-10-18 the one
   * place that writes the row and pushes it, over a fake database and a fake
   * push that records what each reader would have been sent.
   */
  function makeNotifier(over: { pushFails?: boolean } = {}) {
    const prisma = {
      user: {
        findMany: jest.fn(() => Promise.resolve([{ id: 'p1' }, { id: 'a1' }])),
      },
      customer: {
        findUnique: jest.fn(() => Promise.resolve({ shopOwnerUserId: 'shop' })),
      },
      notification: {
        createMany: jest.fn((a: { data: Row[] }) =>
          Promise.resolve({ count: a.data.length }),
        ),
      },
    };
    const sent: {
      userId: string;
      title: string;
      body: string;
      url?: string;
    }[] = [];
    const push = {
      sendToUsers: jest.fn(
        (
          userIds: string[],
          payloadFor: (id: string) => {
            title: string;
            body: string;
            url?: string;
          },
        ) => {
          if (over.pushFails) {
            return Promise.reject(new Error('push service down'));
          }
          for (const userId of userIds)
            sent.push({ userId, ...payloadFor(userId) });
          return Promise.resolve({ sent: userIds.length, removed: 0 });
        },
      ),
    };
    type NDeps = ConstructorParameters<typeof NotificationsService>;
    const notifications = new NotificationsService(
      prisma as unknown as NDeps[0],
      push as unknown as NDeps[1],
    );
    jest.spyOn(notifications, 'createForMultipleUsers');
    type Deps = ConstructorParameters<typeof PortalNotifier>;
    const notifier = new PortalNotifier(
      prisma as unknown as Deps[0],
      notifications,
    );
    return {
      notifier,
      notifications: notifications as unknown as {
        createForMultipleUsers: jest.Mock;
      },
      push,
      sent,
      prisma,
    };
  }

  it('the row carries the code and params; the shop’s push is in Arabic', async () => {
    const { notifier, notifications, sent } = makeNotifier();
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
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe('تمت الموافقة على REQ-0042');
    expect(sent[0].body).toBe(
      NOTIFICATION_MESSAGES.ORDER_REQUEST_APPROVED_PARTIAL.ar.body,
    );
    // A storefront page: the office bell's mapping knows nothing of it.
    expect(sent[0].url).toBe('/requests/r-1');
  });

  it('the office’s push for a storefront event is in Arabic too, and opens what the bell opens', async () => {
    const { notifier, push, sent } = makeNotifier();
    await notifier.orderRequestSubmitted({
      requestId: 'r-2',
      requestNo: 'REQ-0043',
      shopName: 'Nile Motors',
    });
    // One lookup for both readers, not one each.
    expect(push.sendToUsers).toHaveBeenCalledTimes(1);
    expect(sent.map((s) => s.userId)).toEqual(['p1', 'a1']);
    const words = renderNotification(
      'ORDER_REQUEST_SUBMITTED',
      { shopName: 'Nile Motors', requestNo: 'REQ-0043' },
      'ar',
    );
    for (const s of sent) {
      expect(s.title).toBe(words.title);
      expect(s.url).toMatch(
        /^\/notifications\/open\?event=ORDER_REQUEST_SUBMITTED&/,
      );
    }
  });

  it('a push that fails never reaches the caller, and the row is still written', async () => {
    const { notifier, notifications, prisma } = makeNotifier({
      pushFails: true,
    });
    await expect(
      notifier.shopSignedUp({ customerId: 'c-9', shopName: 'Delta Spares' }),
    ).resolves.toBeUndefined();
    expect(notifications.createForMultipleUsers).toHaveBeenCalledTimes(1);
    expect(prisma.notification.createMany).toHaveBeenCalledTimes(1);
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
    expect(push.sendToUsers).not.toHaveBeenCalled();
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
