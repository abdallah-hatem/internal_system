import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ComponentProps, ReactNode } from 'react';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';

/**
 * A popover keeps a gutter from the screen's edge (UI audit M8): at 375px the
 * notifications panel sat flush with the edge, and in Arabic a date picker's
 * calendar opened flush at x=0. jsdom has no layout, so what is checked is
 * what makes the gap: the collision padding every panel is placed with, and a
 * width never wider than the screen less that gutter each side.
 */

// The props each Radix popover panel is placed with.
const placed = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));
vi.mock('radix-ui', async (importOriginal) => {
  const real = await importOriginal<typeof import('radix-ui')>();
  const Content = (props: ComponentProps<typeof real.Popover.Content>) => {
    placed.props.push(props as Record<string, unknown>);
    return <real.Popover.Content {...props} />;
  };
  return { ...real, Popover: { ...real.Popover, Content } };
});

vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/api', () => ({
  api: {
    get: () => Promise.resolve({ data: { data: [], meta: { unreadCount: 0 } } }),
    post: () => Promise.resolve({ data: {} }),
  },
}));

import { Popover, PopoverContent, PopoverTrigger, POPOVER_GUTTER } from './popover';
import { DatePicker } from './date-picker';
import { NotificationBell } from '@/components/layout/notification-bell';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
beforeEach(() => {
  placed.props = [];
});
afterEach(cleanup);

const lastPanel = () => placed.props.at(-1)!;
const panelEl = () => document.querySelector<HTMLElement>('[data-slot="popover-content"]')!;

describe('a popover keeps off the screen edge (UI audit M8)', () => {
  it('every panel is placed with at least an 8px gutter, unless it asks otherwise', () => {
    render(
      <Popover open>
        <PopoverTrigger>open</PopoverTrigger>
        <PopoverContent>panel</PopoverContent>
      </Popover>,
    );
    expect(POPOVER_GUTTER).toBeGreaterThanOrEqual(8);
    expect(lastPanel().collisionPadding).toBe(POPOVER_GUTTER);
  });

  it('the notifications panel: the gutter, and never wider than the screen less it', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
          <NotificationBell />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: en.notifications.title }));
    expect(lastPanel().collisionPadding).toBeGreaterThanOrEqual(8);
    expect(panelEl().className).toContain('max-w-[calc(100vw-1rem)]');
  });

  it('in Arabic, the date picker’s calendar: the gutter, and never wider than the screen less it', () => {
    render(
      <div dir="rtl">
        <NextIntlClientProvider locale="ar" messages={ar} timeZone="Africa/Cairo">
          <DatePicker name="to" placeholder="—" />
        </NextIntlClientProvider>
      </div>,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(lastPanel().collisionPadding).toBeGreaterThanOrEqual(8);
    expect(panelEl().className).toContain('max-w-[calc(100vw-1rem)]');
  });
});
