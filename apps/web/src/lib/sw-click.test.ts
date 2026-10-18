import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

/**
 * The office's service worker (`public/sw.js`): what a tap on a push opens.
 *
 * Every page here lives under `/en/` or `/ar/`, and the API sends paths with
 * no language (`/notifications/open?…`, `/settings` for the test alert). Until
 * 2026-10-18 the worker opened them as they came, which this app answers with
 * a 404. The worker is run as it ships, in a sandbox standing in for the
 * browser, and the tap is made the way a phone makes it.
 */

const source = readFileSync(join(__dirname, '../../public/sw.js'), 'utf8');

type Client = { url: string; navigate: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> };

function worker(clients: Client[]) {
  const handlers: Record<string, (event: unknown) => void> = {};
  const openWindow = vi.fn(() => Promise.resolve(null));
  const self = {
    location: { origin: 'https://office.example' },
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      handlers[type] = fn;
    },
    skipWaiting: () => undefined,
    clients: {
      claim: () => Promise.resolve(),
      matchAll: () => Promise.resolve(clients),
      openWindow,
    },
    registration: { showNotification: vi.fn(() => Promise.resolve()) },
  };
  runInNewContext(source, { self, URL });

  async function tap(data: Record<string, unknown>) {
    let work: Promise<unknown> = Promise.resolve();
    handlers.notificationclick({
      notification: { close: () => undefined, data },
      waitUntil: (p: Promise<unknown>) => {
        work = p;
      },
    });
    await work;
  }

  async function push(payload: Record<string, unknown>) {
    let work: Promise<unknown> = Promise.resolve();
    handlers.push({
      data: { json: () => payload, text: () => JSON.stringify(payload) },
      waitUntil: (p: Promise<unknown>) => {
        work = p;
      },
    });
    await work;
    return self.registration.showNotification.mock.calls.at(-1) as unknown as [
      string,
      { data: Record<string, unknown> },
    ];
  }

  return { tap, push, openWindow };
}

const client = (url: string): Client => ({
  url,
  navigate: vi.fn(() => Promise.resolve(null)),
  focus: vi.fn(() => Promise.resolve(null)),
});

describe('the office service worker opens the page a push names', () => {
  it('with no window open: under the language the push is worded in', async () => {
    const w = worker([]);
    await w.tap({ url: '/notifications/open?event=LOW_STOCK_DETECTED', locale: 'ar' });
    expect(w.openWindow).toHaveBeenCalledWith('/ar/notifications/open?event=LOW_STOCK_DETECTED');
  });

  it('with the office open in English: there, in English, in that window', async () => {
    const open = client('https://office.example/en/dashboard');
    const w = worker([open]);
    await w.tap({ url: '/notifications/open?event=CYCLE_CREATED&cycleId=c-1', locale: 'ar' });
    expect(open.navigate).toHaveBeenCalledWith('/en/notifications/open?event=CYCLE_CREATED&cycleId=c-1');
    expect(open.focus).toHaveBeenCalled();
    expect(w.openWindow).not.toHaveBeenCalled();
  });

  it('a push that names no language (the test alert): Arabic, not a 404', async () => {
    const w = worker([]);
    await w.tap({ url: '/settings' });
    expect(w.openWindow).toHaveBeenCalledWith('/ar/settings');
  });

  it('a path that already has its language is left alone', async () => {
    const w = worker([]);
    await w.tap({ url: '/en/inventory', locale: 'ar' });
    expect(w.openWindow).toHaveBeenCalledWith('/en/inventory');
  });

  it('nothing to open, or something off-site, opens the app’s front page', async () => {
    const w = worker([]);
    await w.tap({});
    await w.tap({ url: 'https://evil.example/x', locale: 'ar' });
    await w.tap({ url: '//evil.example/x', locale: 'en' });
    expect(w.openWindow.mock.calls.map((c: unknown[]) => c[0])).toEqual(['/ar', '/ar', '/en']);
  });

  it('a window the worker cannot steer gets a new window instead of nothing', async () => {
    const stuck = client('https://office.example/ar/sales');
    stuck.navigate.mockRejectedValue(new TypeError('not controlled'));
    const w = worker([stuck]);
    await w.tap({ url: '/inventory', locale: 'en' });
    expect(w.openWindow).toHaveBeenCalledWith('/ar/inventory');
  });

  it('the push keeps its language for the tap', async () => {
    const w = worker([]);
    const [, options] = await w.push({ title: 't', body: 'b', url: '/x', locale: 'ar' });
    expect(options.data).toEqual({ url: '/x', locale: 'ar' });
  });
});
