import { describe, expect, it } from 'vitest';
import ar from '@/i18n/locales/ar.json';
import en from '@/i18n/locales/en.json';

/**
 * One Arabic word per thing, app-wide (re-audit N6, decided in UF3):
 *
 *   payment  → دفعة
 *   delivery → تسليمة
 *   batch    → تشغيلة
 *
 * "دفعة" once meant all three, so "delete delivery" read like deleting a
 * payment and an order's stock allocation said it came from a "payment". The
 * rule is checked by meaning: wherever the English string talks about a
 * delivery or a batch and not about a payment, the Arabic must not say دفع.
 */
type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else for (const [k, v] of flatten(value, path)) out.set(k, v);
  }
  return out;
}

const english = flatten(en as Tree);
const arabic = flatten(ar as Tree);

describe('Arabic vocabulary', () => {
  it('a delivery or a batch is never called دفعة', () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const [path, text] of english) {
      const aboutDeliveryOrBatch = /\bdeliver(y|ies)\b|\bbatch(es)?\b/i.test(text) || /deliver|batch/i.test(path.split('.').pop() ?? '');
      if (!aboutDeliveryOrBatch || /payment/i.test(text) || /payment/i.test(path)) continue;
      checked += 1;
      const translated = arabic.get(path) ?? '';
      if (/دفع/.test(translated)) offenders.push(`${path}: ${translated}`);
    }
    expect(checked).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });

  it('uses the agreed word in the places the re-audit named', () => {
    const a = ar as unknown as Record<string, Record<string, string>>;
    expect(a.wizard?.finishHint ?? findKey('finishHint')).toMatch(/تسليم/);
    expect(a.sales.batch).toBe('تشغيلة');
    expect(a.inventory.batches).toMatch(/تشغيل/);
  });

  it('still calls a payment دفعة', () => {
    expect((ar as unknown as Record<string, Record<string, string>>).payments.recordPayment).toMatch(/دفعة/);
  });
});

function findKey(key: string): string {
  for (const [path, text] of arabic) if (path.endsWith(`.${key}`)) return text;
  return '';
}
