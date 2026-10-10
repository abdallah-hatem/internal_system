import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { isolateCodes } from './isolate-codes';

afterEach(cleanup);

const renderText = (text: string) => render(<p dir="rtl">{isolateCodes(text)}</p>).container;

describe('isolateCodes (UI audit 2026-10-10 #35)', () => {
  it('wraps a record code in an unbreakable LTR isolate inside an Arabic sentence', () => {
    const c = renderText('تمت إضافتك إلى الدورة CYC-2026-0007');
    const bdi = c.querySelectorAll('bdi');
    expect(bdi).toHaveLength(1);
    expect(bdi[0].textContent).toBe('CYC-2026-0007');
    expect(bdi[0].getAttribute('dir')).toBe('ltr');
    expect(bdi[0].className).toContain('whitespace-nowrap');
    expect(c.textContent).toBe('تمت إضافتك إلى الدورة CYC-2026-0007');
  });

  it('isolates every code in a sentence that names two', () => {
    const c = renderText('New purchase order PO-2026-0012 created for cycle CYC-2026-0007');
    expect([...c.querySelectorAll('bdi')].map((b) => b.textContent)).toEqual([
      'PO-2026-0012',
      'CYC-2026-0007',
    ]);
  });

  it('leaves ordinary hyphenated names and plain text alone', () => {
    expect(renderText('Al-Nasr Motors signed up').querySelector('bdi')).toBeNull();
    expect(renderText('').textContent).toBe('');
    expect(renderText('مخزون منخفض: UAE').querySelector('bdi')).toBeNull();
  });
});
