/* eslint-disable @typescript-eslint/require-await -- the fake prisma's methods return promises like the real ones */
import type { ConfigService } from '@nestjs/config';
import type { HttpException } from '@nestjs/common';

jest.mock('web-push', () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the mocked module, after jest.mock
const webpush = require('web-push') as { sendNotification: jest.Mock };

import { PushService } from './push.service';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * "Send a test alert" (owner, 2026-10-16: "I need to test it"): one alert to
 * the signed-in person's own devices, and a coded refusal for every way it
 * cannot arrive — never a quiet success.
 */

type Sub = {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

function service(subs: Sub[], configured = true) {
  const rows = [...subs];
  const prisma = {
    pushSubscription: {
      count: jest.fn(
        async ({ where }: { where: { userId: string } }) =>
          rows.filter((r) => r.userId === where.userId).length,
      ),
      findMany: jest.fn(
        async ({ where }: { where: { userId: { in: string[] } } }) =>
          rows.filter((r) => where.userId.in.includes(r.userId)),
      ),
      updateMany: jest.fn(async () => ({ count: 1 })),
      deleteMany: jest.fn(
        async ({ where }: { where: { id: { in: string[] } } }) => {
          for (const id of where.id.in) {
            rows.splice(
              rows.findIndex((r) => r.id === id),
              1,
            );
          }
          return { count: where.id.in.length };
        },
      ),
    },
  } as unknown as PrismaService;
  const config = {
    get: (k: string) =>
      configured
        ? (
            { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv' } as Record<
              string,
              string
            >
          )[k]
        : undefined,
  } as unknown as ConfigService;
  return { push: new PushService(prisma, config), rows };
}

const sub = (id: string, userId = 'u1'): Sub => ({
  id,
  userId,
  endpoint: `https://push/${id}`,
  p256dh: 'k',
  auth: 'a',
});
const text = { title: 'S&F System', body: 'Test alert' };

async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return (e as HttpException).getResponse() as {
      code: string;
      params?: Record<string, unknown>;
    };
  }
  throw new Error('expected a refusal');
}

beforeEach(() => webpush.sendNotification.mockReset());

describe('PushService.sendTest', () => {
  it("sends the client's words to each of the caller's devices and says how many it reached", async () => {
    webpush.sendNotification.mockResolvedValue({});
    const { push } = service([sub('a'), sub('b'), sub('other', 'u2')]);
    await expect(push.sendTest('u1', text)).resolves.toEqual({
      sent: 2,
      removed: 0,
      devices: 2,
    });
    expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
    const [[, sentBody]] = webpush.sendNotification.mock.calls as [
      unknown,
      string,
    ][];
    const payload = JSON.parse(sentBody) as Record<string, unknown>;
    expect(payload).toMatchObject({
      title: 'S&F System',
      body: 'Test alert',
      tag: 'test-alert',
    });
  });

  it('push not set up on the server → PUSH_NOT_CONFIGURED', async () => {
    const { push } = service([sub('a')], false);
    expect(await refusal(push.sendTest('u1', text))).toMatchObject({
      code: 'PUSH_NOT_CONFIGURED',
    });
  });

  it('no device of theirs has alerts on → NO_PUSH_DEVICE, and nothing is sent', async () => {
    const { push } = service([sub('other', 'u2')]);
    expect(await refusal(push.sendTest('u1', text))).toMatchObject({
      code: 'NO_PUSH_DEVICE',
    });
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it('every device gone (410) → PUSH_TEST_NOT_DELIVERED, and the dead subscription is removed', async () => {
    webpush.sendNotification.mockRejectedValue({ statusCode: 410 });
    const { push, rows } = service([sub('a')]);
    expect(await refusal(push.sendTest('u1', text))).toMatchObject({
      code: 'PUSH_TEST_NOT_DELIVERED',
      params: { devices: 1, removed: 1 },
    });
    expect(rows).toHaveLength(0);
  });

  it.each([
    ['no title', { body: 'x' }],
    ['no body', { title: 'x' }],
    ['blank', { title: '  ', body: '  ' }],
    ['not text', { title: 1, body: {} }],
    ['too long', { title: 'x'.repeat(121), body: 'x' }],
  ])('%s → VALIDATION_FAILED', async (_l, bad) => {
    const { push } = service([sub('a')]);
    expect(await refusal(push.sendTest('u1', bad))).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});
