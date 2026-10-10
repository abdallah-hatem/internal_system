import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { useCodeLabel, type CodeKind } from './labels';

function labelIn(locale: 'en' | 'ar') {
  const messages = locale === 'en' ? en : ar;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NextIntlClientProvider
      locale={locale}
      messages={messages}
      timeZone="Africa/Cairo"
      // Throwing here would hide the fallback we are testing; next-intl's own
      // missing-key handler must never be reached by useCodeLabel.
      onError={(e) => {
        throw e;
      }}
    >
      {children}
    </NextIntlClientProvider>
  );
  return renderHook(() => useCodeLabel(), { wrapper }).result.current;
}

describe('useCodeLabel', () => {
  it('translates a known code in each language', () => {
    expect(labelIn('en')('orderStatus', 'PARTIALLY_PAID')).toBe('Partially paid');
    expect(labelIn('ar')('orderStatus', 'PARTIALLY_PAID')).toBe('مدفوع جزئياً');
    expect(labelIn('ar')('legStatus', 'PARTLY_ARRIVED')).toBe('وصلت جزئياً');
  });

  it('returns the code itself for an unknown code — never an empty string', () => {
    const label = labelIn('ar');
    expect(label('orderStatus', 'ON_HOLD')).toBe('ON_HOLD');
    expect(label('role', 'SUPER_ADMIN')).toBe('SUPER_ADMIN');
  });

  it('a code from one kind is not translated through another kind', () => {
    // CASH is a payment method, not an order status.
    expect(labelIn('en')('orderStatus', 'CASH')).toBe('CASH');
  });

  it('reads legacy lower-case payment methods', () => {
    expect(labelIn('en')('paymentMethod', 'bank_transfer')).toBe('Bank transfer');
    expect(labelIn('ar')('paymentMethod', 'cash')).toBe('نقدي');
  });

  it('shows a dash for a missing code', () => {
    const label = labelIn('en');
    expect(label('paymentMethod', null)).toBe('—');
    expect(label('paymentMethod', undefined)).toBe('—');
    expect(label('paymentMethod', '')).toBe('—');
  });

  it('every kind has the same codes in English and Arabic, none empty', () => {
    const kinds = Object.keys(en.codes) as CodeKind[];
    expect(Object.keys(ar.codes).sort()).toEqual([...kinds].sort());
    for (const kind of kinds) {
      const enKind = en.codes[kind] as Record<string, string>;
      const arKind = ar.codes[kind] as Record<string, string>;
      expect(Object.keys(arKind).sort(), kind).toEqual(Object.keys(enKind).sort());
      for (const v of [...Object.values(enKind), ...Object.values(arKind)]) expect(v.trim()).not.toBe('');
    }
  });
});
