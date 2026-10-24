import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/locales/en.json';
import { Select } from './select';
import { TOUCH_QUERY } from '@/lib/use-phone';

/**
 * Opening a picker on a touch screen does not put the cursor in its search box
 * (owner 2026-10-23/24): the keyboard jumped up over the very list the picker
 * was opened to show. On a computer the cursor still goes straight to search.
 */

const options = (n: number) => Array.from({ length: n }, (_, i) => ({ value: `c${i}`, label: `Customer ${i + 1}` }));

function screenIs(touch: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: touch && q === TOUCH_QUERY,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  }));
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function open(n = 12) {
  render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
      <Select name="customer" options={options(n)} placeholder="Choose a customer" />
    </NextIntlClientProvider>,
  );
  await act(async () => {
    fireEvent.click(screen.getByRole('combobox'));
  });
  await act(() => new Promise((r) => setTimeout(r, 30)));
}

const search = () => document.querySelector<HTMLInputElement>('[cmdk-input]');

describe('a picker opening', () => {
  it('on a computer: the cursor is in the search box, ready to type', async () => {
    screenIs(false);
    await open();
    expect(search()).toBeTruthy();
    expect(document.activeElement).toBe(search());
  });

  it('on a touch screen: the list shows, the search box waits — no keyboard', async () => {
    screenIs(true);
    await open();
    expect(search()).toBeTruthy();
    expect(document.activeElement).not.toBe(search());
    expect(document.activeElement?.hasAttribute('cmdk-root')).toBe(true);
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0);
  });

  it('on a touch screen, tapping the search box still lets you type and narrows the list', async () => {
    screenIs(true);
    await open();
    const input = search()!;
    act(() => input.focus());
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: 'Customer 12' } });
    await act(() => new Promise((r) => setTimeout(r, 30)));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Customer 12']);
  });

  it('a short list with no search box: the list takes focus, on either screen', async () => {
    for (const touch of [false, true]) {
      screenIs(touch);
      await open(3);
      expect(search()).toBeNull();
      expect(document.activeElement?.hasAttribute('cmdk-root')).toBe(true);
      cleanup();
    }
  });
});
