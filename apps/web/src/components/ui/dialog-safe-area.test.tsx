import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import en from '@/i18n/locales/en.json';
import { Dialog } from './dialog';

/**
 * On an iPhone every dialog with buttons had an empty strip under them (owner
 * 2026-10-17): the footer added the home indicator's height (34pt in the
 * installed app) under its buttons, on a card that floats 1rem above the
 * bottom edge and never reaches the indicator. The safe area belongs to the
 * layer the card floats in, not to the card's footer.
 */

afterEach(cleanup);

function open(footer = true) {
  render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Africa/Cairo">
      <Dialog title="New Order" onClose={() => {}} footer={footer ? <button type="button">Save</button> : undefined}>
        <p>body</p>
      </Dialog>
    </NextIntlClientProvider>,
  );
  return {
    layer: document.querySelector<HTMLElement>('[data-dialog]')!,
    card: screen.getByRole('dialog'),
    footer: document.querySelector<HTMLElement>('[data-dialog-footer]'),
  };
}

describe('a dialog on a phone keeps clear of the notch and home indicator, once', () => {
  it('the footer pads its buttons evenly — no home-indicator height under them', () => {
    const { footer } = open();
    expect(footer!.className).not.toMatch(/safe-area/);
    expect(footer!.className).toContain('py-4');
  });

  it('the layer the card floats in keeps the margin, or the safe area when that is larger', () => {
    const { layer } = open();
    expect(layer.className).toContain('pt-[max(1rem,env(safe-area-inset-top,0px))]');
    expect(layer.className).toContain('pb-[max(1rem,env(safe-area-inset-bottom,0px))]');
  });

  it('the card is as tall as that space allows and no taller, so it never runs under the indicator', () => {
    const { card } = open();
    expect(card.className).toContain('max-h-full');
    expect(card.className).not.toMatch(/100dvh/);
  });
});

describe('the phone bar and the page under it read one inset', () => {
  const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  it('the bar keeps clear of the indicator without the whole 34pt band, and the page pads by the same value', () => {
    const css = src('../../app/globals.css');
    expect(css).toMatch(/--phone-bar-inset:\s*max\(0\.25rem,\s*calc\(env\(safe-area-inset-bottom, 0px\) - 1rem\)\)/);
    expect(src('../layout/phone-bar.tsx')).toContain('pb-[var(--phone-bar-inset)]');
    expect(src('../layout/app-shell.tsx')).toMatch(/pb-\[calc\([\d.]+rem\+var\(--phone-bar-inset\)\)\]/); // how far: chat-button-room.test.ts
    expect(src('../layout/phone-bar.tsx')).not.toContain('pb-[env(safe-area-inset-bottom');
  });
});
