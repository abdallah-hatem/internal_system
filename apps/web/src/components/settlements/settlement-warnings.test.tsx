import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
// The server's own list of codes, to hold the locale files to.
import { SETTLEMENT_WARNING_CODES } from '../../../../api/src/modules/settlements/settlement-warnings';
import { SettlementWarnings, type SettlementWarning } from './settlement-warnings';

/**
 * R1c — a settlement's warnings arrive as codes with numbers, and are said in
 * the reader's language (rule 9). They used to be English sentences printed
 * as they came, so an Arabic page read "40 units are still in stock…".
 */

afterEach(cleanup);

function show(locale: 'en' | 'ar', warnings: SettlementWarning[]) {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === 'en' ? en : ar} timeZone="Africa/Cairo">
      <SettlementWarnings warnings={warnings} />
    </NextIntlClientProvider>,
  );
}

const UNSOLD: SettlementWarning = { code: 'UNSOLD_STOCK', params: { units: 1284, valueEgp: 1250000.5 } };
const NO_SALES: SettlementWarning = { code: 'NO_REALISED_SALES', params: {} };

describe('settlement warnings', () => {
  it('in Arabic, both warnings are Arabic, with the numbers grouped in Latin digits and the amount at 2dp', () => {
    show('ar', [UNSOLD, NO_SALES]);
    const lines = screen.getAllByRole('status')[0].querySelectorAll('p');
    expect(lines).toHaveLength(2);
    expect(lines[0].textContent).toContain(ar.settlementsPage.warnings.UNSOLD_STOCK.split('{')[0].trim());
    // Latin digits on an Arabic page (decision log, 2026-10-10).
    expect(lines[0].textContent).toContain('1,284');
    expect(lines[0].textContent).toContain('1,250,000.50');
    expect(lines[0].textContent).not.toMatch(/[٠-٩]/);
    expect(lines[1].textContent).toBe(ar.settlementsPage.warnings.NO_REALISED_SALES);
    // No English word reaches an Arabic reader.
    for (const p of lines) expect(p.textContent).not.toMatch(/[A-Za-z]{3,}/);
  });

  it('in English, the sentence the API used to send is now said here', () => {
    show('en', [UNSOLD]);
    expect(screen.getByRole('status').textContent).toMatch(/units are still in stock/);
  });

  it('a code this build does not know shows one line saying so — not the code, not a blank', () => {
    show('ar', [{ code: 'SOMETHING_NEW', params: { units: 3 } }]);
    const text = screen.getByRole('status').textContent ?? '';
    expect(text).toBe(ar.settlementsPage.warnings.unknown);
    expect(text).not.toContain('SOMETHING_NEW');
  });

  it('a string the old API sent is not printed raw either', () => {
    show('en', ['This cycle has no realised sales yet.' as unknown as SettlementWarning]);
    expect(screen.getByRole('status').textContent).toBe(en.settlementsPage.warnings.unknown);
  });

  it('no warnings, no box', () => {
    const { container } = show('en', []);
    expect(container.textContent).toBe('');
  });

  it('every code the API can send is worded in both languages, with the same params, and no key outlives its code', () => {
    for (const locale of [en, ar]) {
      const keys = Object.keys(locale.settlementsPage.warnings).filter((k) => k !== 'unknown').sort();
      expect(keys).toEqual([...SETTLEMENT_WARNING_CODES].sort());
    }
    const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const code of SETTLEMENT_WARNING_CODES) {
      const e = (en.settlementsPage.warnings as Record<string, string>)[code];
      const a = (ar.settlementsPage.warnings as Record<string, string>)[code];
      expect(params(a), code).toEqual(params(e));
      expect(a, code).not.toBe(e);
    }
  });
});
