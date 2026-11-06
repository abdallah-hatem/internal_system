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

  // UI re-check M8 (2026-11-06): at 430 in Arabic the end date's calendar
  // opened down over the phone bar fixed at the foot of the screen.
  it.each(['en', 'ar'] as const)('on a phone a date picker’s calendar keeps clear of the phone bar (%s)', (locale) => {
    const bar = document.createElement('nav');
    bar.setAttribute('data-testid', 'phone-bar');
    // 56px of bar and 6px of home-indicator inset, as a phone lays it out.
    bar.getBoundingClientRect = () => ({ height: 62, width: 430, top: 870, bottom: 932, left: 0, right: 430, x: 0, y: 870, toJSON() {} });
    document.body.appendChild(bar);
    try {
      render(
        <div dir={locale === 'ar' ? 'rtl' : 'ltr'}>
          <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
            <DatePicker name="to" placeholder="—" />
          </NextIntlClientProvider>
        </div>,
      );
      fireEvent.click(screen.getByRole('button'));
      const padding = lastPanel().collisionPadding as Record<string, number>;
      expect(padding.bottom).toBeGreaterThanOrEqual(62 + POPOVER_GUTTER);
      // The other sides keep the plain gutter.
      for (const side of ['top', 'left', 'right']) expect(padding[side]).toBe(POPOVER_GUTTER);
    } finally {
      bar.remove();
    }
  });

  it('where the phone bar is hidden (md and up, height 0) the gutter is all there is', () => {
    const bar = document.createElement('nav');
    bar.setAttribute('data-testid', 'phone-bar');
    document.body.appendChild(bar);
    try {
      render(
        <Popover open>
          <PopoverTrigger>open</PopoverTrigger>
          <PopoverContent>panel</PopoverContent>
        </Popover>,
      );
      expect(lastPanel().collisionPadding).toBe(POPOVER_GUTTER);
    } finally {
      bar.remove();
    }
  });

  it('a panel that asks for its own padding gets exactly that', () => {
    render(
      <Popover open>
        <PopoverTrigger>open</PopoverTrigger>
        <PopoverContent collisionPadding={20}>panel</PopoverContent>
      </Popover>,
    );
    expect(lastPanel().collisionPadding).toBe(20);
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
