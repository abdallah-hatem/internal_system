import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';

/**
 * "Send a test alert" (owner, 2026-10-16: "I need to test it"): shown once
 * alerts are on for this device, it sends the words in the reader's language
 * and says what happened — or the coded reason it could not.
 */

let subscribed = true;
vi.mock('../../lib/push', () => ({
  needsHomeScreenFirst: () => false,
  pushSupported: () => true,
  readKeys: () => ({ p256dh: 'k', auth: 'a' }),
  urlBase64ToUint8Array: () => new Uint8Array(),
  registerServiceWorker: () =>
    Promise.resolve({ pushManager: { getSubscription: () => Promise.resolve(subscribed ? { endpoint: 'e' } : null) } }),
}));

const post = vi.fn();
vi.mock('../../lib/api', () => ({
  api: {
    get: () => Promise.resolve({ data: { data: { publicKey: 'pub' } } }),
    post: (...args: unknown[]) => post(...args),
    delete: vi.fn(),
  },
}));

import { PushAlerts } from './push-alerts';

function show(locale: 'en' | 'ar' = 'en') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : ar} timeZone="Africa/Cairo">
        <PushAlerts />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  subscribed = true;
  post.mockReset();
  vi.stubGlobal('Notification', { permission: 'granted' });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Send a test alert', () => {
  it("sends the reader's words and says it reached 1 device", async () => {
    post.mockResolvedValue({ data: { data: { sent: 1, removed: 0, devices: 1 } } });
    show();
    fireEvent.click(await screen.findByTestId('push-test'));
    expect(post).toHaveBeenCalledWith('/notifications/push-test', {
      title: en.push.testTitle,
      body: en.push.testBody,
    });
    expect((await screen.findByTestId('push-test-result')).textContent).toBe(
      'Sent to 1 device. It should arrive in a few seconds.',
    );
  });

  it('in Arabic the alert itself is written in Arabic', async () => {
    post.mockResolvedValue({ data: { data: { sent: 2 } } });
    show('ar');
    fireEvent.click(await screen.findByTestId('push-test'));
    expect(post).toHaveBeenCalledWith('/notifications/push-test', {
      title: ar.push.testTitle,
      body: ar.push.testBody,
    });
  });

  it('a coded refusal is shown in words, not a silent nothing', async () => {
    post.mockRejectedValue({
      response: { data: { error: { code: 'NO_PUSH_DEVICE', message: 'No device', params: {} } } },
    });
    show();
    fireEvent.click(await screen.findByTestId('push-test'));
    expect((await screen.findByRole('alert')).textContent).toBe(en.errors.NO_PUSH_DEVICE);
  });

  it('not offered until alerts are on for this device', async () => {
    subscribed = false;
    show();
    expect(await screen.findByText(en.push.turnOn)).toBeTruthy();
    expect(screen.queryByTestId('push-test')).toBeNull();
  });
});
