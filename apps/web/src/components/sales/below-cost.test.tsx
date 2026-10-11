import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import type { PriceCheckLine, PriceCheckResult } from '@/lib/price-check';
import { BelowCostLine, BelowCostPrice, BelowCostSummary, BelowCostTotal } from './below-cost';

/**
 * The below-cost warning as said on the draft's confirm step and beside a
 * product's price (BUSINESS_LOGIC §4, 2026-10-11). The sale form's own
 * warnings are tested through the form (SaleOrderForm.test.tsx).
 */

afterEach(cleanup);

function inLocale(node: React.ReactNode, locale: 'en' | 'ar' = 'en') {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
      {node}
    </NextIntlClientProvider>,
  );
}

const below = (over: Partial<PriceCheckLine> = {}): PriceCheckLine => ({
  line: 1,
  productId: 'p',
  costed: true,
  belowCost: true,
  code: 'BELOW_COST',
  unitCostEgp: '2616.67',
  unitPriceEgp: '1000.00',
  lossEgp: '145500.00',
  ...over,
});
const fine = (line: number): PriceCheckLine => ({
  line,
  productId: 'q',
  costed: true,
  belowCost: false,
  code: null,
  unitCostEgp: '100.00',
  unitPriceEgp: '150.00',
  lossEgp: '0.00',
});
const result = (lines: PriceCheckLine[], total: string): PriceCheckResult => ({
  currency: 'EGP',
  compared: true,
  lines,
  belowCostLines: lines.filter((l) => l.belowCost).length,
  totalLossEgp: total,
});
const plain = (el: HTMLElement | null) => (el?.textContent ?? '').replace(/[⁦-⁩]/g, '');

describe('BelowCostSummary — the draft’s confirm step', () => {
  it('the helmets: names the line, the cost, the price, the loss and the total, and says Confirm still works', () => {
    inLocale(
      <BelowCostSummary
        result={result([fine(1), below({ line: 2 })], '145500.00')}
        names={['Brake pad', 'Full face helmet']}
      />,
    );
    const lines = screen.getAllByTestId('below-cost-summary-line');
    expect(lines).toHaveLength(1);
    expect(plain(lines[0])).toBe(
      'Full face helmet: each costs 2,616.67 EGP, selling at 1,000.00 EGP, a loss of 145,500.00 EGP.',
    );
    const box = screen.getByTestId('below-cost-summary');
    expect(plain(box)).toContain('a loss of 145,500.00 EGP on this order');
    expect(plain(box)).toContain(en.priceCheck.confirmHint);
    expect(box.getAttribute('role')).toBe('status');
    expect(box.className).toMatch(/accent-50/);
    expect(box.className).not.toMatch(/destructive|red-/);
  });

  it('nothing below cost, nothing shown; no answer yet, nothing shown', () => {
    inLocale(<BelowCostSummary result={result([fine(1)], '0.00')} names={['Brake pad']} />);
    expect(screen.queryByTestId('below-cost-summary')).toBeNull();
    inLocale(<BelowCostSummary result={undefined} names={[]} />);
    expect(screen.queryByTestId('below-cost-summary')).toBeNull();
  });

  it('in Arabic: an Arabic sentence with each amount isolated left-to-right', () => {
    inLocale(<BelowCostSummary result={result([below()], '145500.00')} names={['خوذة']} />, 'ar');
    const box = screen.getByTestId('below-cost-summary');
    expect(box.textContent).toContain('أقل من التكلفة');
    expect(box.textContent).toContain('⁦2,616.67 EGP⁩');
    expect(box.textContent).toContain('⁦145,500.00 EGP⁩');
  });
});

describe('BelowCostPrice — setting a product’s price', () => {
  it('against the oldest batch: what it cost each, and what each unit sold at this price loses', () => {
    inLocale(<BelowCostPrice check={below({ unitPriceEgp: '2000.00', lossEgp: '616.67' })} />);
    expect(plain(screen.getByTestId('below-cost-price'))).toBe(
      'Below cost: the oldest stock on the shelf cost 2,616.67 EGP each, so every unit sold at this price loses 616.67 EGP.',
    );
  });

  it('at or above cost, or with nothing on the shelf, says nothing', () => {
    inLocale(<BelowCostPrice check={fine(1)} />);
    inLocale(<BelowCostPrice check={{ ...fine(1), costed: false, reason: 'NO_STOCK', unitCostEgp: null }} />);
    inLocale(<BelowCostPrice check={undefined} />);
    expect(screen.queryByTestId('below-cost-price')).toBeNull();
  });
});

describe('a code this build has never heard of', () => {
  it('reads as a general warning, never the raw code', () => {
    inLocale(<BelowCostLine check={below({ code: 'BELOW_COST_V2' })} />);
    expect(plain(screen.getByTestId('below-cost-line'))).toBe(en.priceCheck.unknown);
  });

  it('the total is said even when no line is', () => {
    inLocale(<BelowCostTotal result={result([below()], '10.00')} />);
    expect(plain(screen.getByTestId('below-cost-total'))).toBe('Selling below cost: a loss of 10.00 EGP on this order.');
  });
});
