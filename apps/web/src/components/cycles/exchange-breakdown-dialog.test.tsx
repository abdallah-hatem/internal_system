import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { ExchangeBreakdownDialog, type ExchangeBreakdown } from './exchange-breakdown-dialog';

/**
 * Why the exchange difference is what it is (owner 2026-11-14). The rows are
 * the server's (`exchangeBreakdown`, db spec "exchange breakdown:
 * production’s cycle 2"); these pin how the dialog says them: production's
 * Mohamed Youssef — paid 12,999.13 AED at 15.2, repaid in four — each row a
 * gain, a loss or no difference against his rate, the total the card's
 * figure, in English and Arabic.
 */

/** What the server answers for production's cycle 2 (−304.71, a gain). */
function mohamedYoussef(): ExchangeBreakdown[] {
  const row = (id: string, paidOn: string, amountEgp: string, rateToEgp: string, cleared: string, diff: string) => ({
    id,
    paidOn,
    amountEgp,
    rateToEgp,
    cleared,
    exchangeDifferenceEgp: diff,
  });
  return [
    {
      financingId: 'f-1',
      lender: 'Mohamed Youssef',
      currency: 'AED',
      amount: '12999.13',
      fxRateToEgp: '15.2',
      amountEgp: '197586.78',
      paidOn: '2026-10-01',
      repaidEgp: '197282.07',
      exchangeDifferenceEgp: '-304.71',
      repayments: [
        row('r1', '2026-10-05', '98800.00', '15.2', '6500.00', '0.00'),
        row('r2', '2026-10-20', '60775.00', '15.0443', '4039.73', '-628.90'),
        row('r3', '2026-11-02', '5607.00', '15.2675', '367.25', '24.80'),
        row('r4', '2026-11-10', '32100.07', '15.3431', '2092.15', '299.39'),
      ],
    },
  ];
}

afterEach(() => cleanup());

function wrap(locale: 'en' | 'ar' = 'en', onClose = () => {}, breakdown = mohamedYoussef(), total = '-304.71') {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'ar' ? ar : en} timeZone="Africa/Cairo">
      <ExchangeBreakdownDialog friends="Mohamed Youssef" totalEgp={total} breakdown={breakdown} onClose={onClose} />
    </NextIntlClientProvider>,
  );
}

const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/ /g, ' ');

describe('production’s cycle 2: Mohamed Youssef, repaid in four (owner 2026-11-14)', () => {
  it('says how it works, then each repayment against his 15.20 — none, gained, lost, lost — and the net the card shows', () => {
    wrap();
    const dialog = screen.getByTestId('exchange-breakdown');
    expect(text(dialog)).toContain('Exchange difference on repaying Mohamed Youssef');
    expect(text(screen.getByTestId('exchange-explain'))).toBe(
      'Mohamed Youssef paid 12,999.13 AED at 15.20 = 197,586.78 EGP; you repaid 197,282.07 EGP. Each repayment clears his AED at that day’s rate: a lower rate clears more for the same pounds (a gain), a higher one fewer (a loss).',
    );
    const rows = screen.getAllByTestId('exchange-row');
    expect(rows.map((r) => r.getAttribute('data-result'))).toEqual(['none', 'gain', 'loss', 'loss']);
    expect(rows.map((r) => text(r.querySelector('[data-testid="exchange-row-diff"]')))).toEqual([
      'No difference — rate 15.20, the same as his',
      '628.90 EGP gained — rate 15.0443 below 15.20',
      '24.80 EGP lost — rate 15.2675 above 15.20',
      '299.39 EGP lost — rate 15.3431 above 15.20',
    ]);
    // Each row: its day, the pounds paid, the rate, the dirhams it cleared.
    expect(text(rows[1])).toContain('Oct 20, 2026');
    expect(text(rows[1])).toContain('60,775.00 EGP');
    expect(text(rows[1])).toContain('4,039.73 AED');
    // A gain green, a loss red.
    expect(rows[1].querySelector('[data-testid="exchange-row-diff"] [data-slot="money"]')!.className).toContain('text-success');
    expect(rows[2].querySelector('[data-testid="exchange-row-diff"] [data-slot="money"]')!.className).toContain('text-destructive');
    // The net is the card's figure: a gain of 304.71.
    const total = screen.getByTestId('exchange-total');
    expect(text(total)).toBe('On net+304.71 EGP');
    expect(total.querySelector('[data-result]')!.getAttribute('data-result')).toBe('gain');
  });

  it('the rows add up to the net exactly', () => {
    const [f] = mohamedYoussef();
    const cents = f.repayments.reduce((s, r) => s + Math.round(Number(r.exchangeDifferenceEgp) * 100), 0);
    expect(cents).toBe(Math.round(Number(f.exchangeDifferenceEgp) * 100));
  });

  it('reads in Arabic, with Latin digits, the figures left-to-right, and no English left', () => {
    wrap('ar');
    const dialog = screen.getByTestId('exchange-breakdown');
    expect(text(dialog)).toContain('فرق سعر الصرف في السداد لـ Mohamed Youssef');
    expect(text(screen.getAllByTestId('exchange-row-diff')[1])).toBe('ربح 628.90 EGP — السعر 15.0443 أقل من 15.20');
    expect(text(screen.getAllByTestId('exchange-row-diff')[2])).toBe('خسارة 24.80 EGP — السعر 15.2675 أعلى من 15.20');
    expect(text(screen.getByTestId('exchange-total'))).toBe('في المحصلة+304.71 EGP');
    for (const m of dialog.querySelectorAll('[data-slot="money"]')) expect(m.getAttribute('dir')).toBe('ltr');
    const words = text(dialog).replace(/Mohamed Youssef|EGP|AED/g, '');
    expect(words).not.toMatch(/[A-Za-z]/);
    expect(words).not.toMatch(/[٠-٩]/);
  });

  it('Close closes, and never submits', () => {
    const onClose = vi.fn();
    wrap('en', onClose);
    const close = document.querySelector('[data-dialog-footer] button')!;
    expect(close.getAttribute('type')).toBe('button');
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
