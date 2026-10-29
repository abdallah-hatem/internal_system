import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The chat button floats over the page's bottom end. The page must be able to
 * scroll its last row clear of it — at 390px it sat on the first ledger card and
 * the partner card's "Take money out" row (owner 2026-10-28, the fuel demo).
 * Read from the classes themselves, so moving the button without the padding
 * (or the other way round) fails here.
 */
const src = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');
const rem = (expr: string) => Number(/([\d.]+)rem/.exec(expr)?.[1] ?? NaN);
const TW = (n: string) => Number(n) / 4; // Tailwind's spacing scale, in rem

const button = /data-testid="assistant-chat-open"[\s\S]*?className="([^"]+)"/.exec(src('assistant/assistant-chat.tsx'))![1];
const main = /<main className="([^"]+)"/.exec(src('layout/app-shell.tsx'))![1];
const cls = (all: string, re: RegExp) => re.exec(all)?.[1] ?? '';

describe('room under the chat button', () => {
  const size = TW(cls(button, /(?:^|\s)size-(\d+)/));

  it('on a phone, the page pads past the top of the button', () => {
    const bottom = rem(cls(button, /(?:^|\s)bottom-\[([^\]]+)\]/));
    const pad = rem(cls(main, /(?:^|\s)pb-\[([^\]]+)\]/));
    // Both are measured from the same phone-bar inset.
    expect(cls(button, /(?:^|\s)bottom-\[([^\]]+)\]/)).toContain('--phone-bar-inset');
    expect(cls(main, /(?:^|\s)pb-\[([^\]]+)\]/)).toContain('--phone-bar-inset');
    expect(pad).toBeGreaterThanOrEqual(bottom + size);
  });

  it('on a wider screen too', () => {
    const bottom = TW(cls(button, /(?:^|\s)md:bottom-(\d+)/));
    const pad = TW(cls(main, /(?:^|\s)md:pb-(\d+)/));
    expect(pad).toBeGreaterThanOrEqual(bottom + size);
  });
});

describe('the Running accounts sentence names expenses he paid, as the card does', () => {
  it('in English and Arabic', () => {
    const locale = (f: string) => JSON.parse(src(`../i18n/locales/${f}`)).accounts;
    expect(locale('en.json').hint.toLowerCase()).toContain('expenses he paid');
    expect(locale('ar.json').hint).toContain('المصروفات التي دفعها');
  });
});
