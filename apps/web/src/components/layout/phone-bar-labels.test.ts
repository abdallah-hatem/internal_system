import { describe, expect, it } from 'vitest';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The phone bar has six equal cells; at 320px each holds about 45px of 11px
 * text. "Dashboard", "Customers" and "Inventory" (nine letters) were cut to
 * "Dashb…", "Custo…", "Invent…" there, and "Dashboa…" even at 375 (UI audit
 * 2026-11, M14), while "Cycles" fitted. Arabic letters are narrower: every
 * Arabic label, eight letters at most, showed whole at 320. jsdom measures no
 * text, so the labels' length is the bound.
 */
const LIMIT = { en: 7, ar: 8 } as const;
const bar = readFileSync(join(__dirname, 'phone-bar.tsx'), 'utf8');

describe('phone bar labels fit a 320px phone', () => {
  for (const [locale, messages] of [['en', en], ['ar', ar]] as const) {
    it(`${locale}: every label, More included, is ${LIMIT[locale]} letters or fewer`, () => {
      const labels = [...Object.values(messages.nav.short), messages.nav.more];
      expect(Object.keys(messages.nav.short).sort()).toEqual(['customers', 'cycles', 'dashboard', 'inventory', 'sales']);
      for (const label of labels) {
        expect(label.trim()).not.toBe('');
        expect([...label].length, label).toBeLessThanOrEqual(LIMIT[locale]);
      }
    });
  }

  it('the bar draws the short labels, not the full menu names', () => {
    expect(bar).toContain('t(`short.${item.key}` as never)');
  });
});
