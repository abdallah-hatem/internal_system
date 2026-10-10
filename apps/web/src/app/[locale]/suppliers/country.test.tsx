import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import { countryCode, KNOWN_COUNTRIES, useCountryLabel } from './country';

function labelIn(locale: 'en' | 'ar') {
  const messages = locale === 'en' ? en : ar;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <NextIntlClientProvider
      locale={locale}
      messages={messages}
      timeZone="Africa/Cairo"
      onError={(e) => {
        throw e;
      }}
    >
      {children}
    </NextIntlClientProvider>
  );
  return renderHook(() => useCountryLabel(), { wrapper }).result.current;
}

describe('countryCode', () => {
  it('maps the spellings people type to one code', () => {
    for (const typed of ['CN', 'cn', 'China', ' china ', 'CHINA', 'PRC', 'الصين']) {
      expect(countryCode(typed), typed).toBe('CN');
    }
    for (const typed of ['AE', 'UAE', 'U.A.E.', 'uae', 'United Arab Emirates', 'الإمارات']) {
      expect(countryCode(typed), typed).toBe('AE');
    }
  });

  it('knows nothing about what it was not told — no guessing from fragments', () => {
    expect(countryCode('Chin')).toBeNull();
    expect(countryCode('Chinatown')).toBeNull();
    expect(countryCode('Narnia')).toBeNull();
    expect(countryCode('')).toBeNull();
    expect(countryCode(null)).toBeNull();
    expect(countryCode(undefined)).toBeNull();
  });
});

describe('useCountryLabel', () => {
  it('shows CN, China, AE and UAE as one translated name each', () => {
    const enLabel = labelIn('en');
    const arLabel = labelIn('ar');
    expect(['CN', 'China', 'china'].map(enLabel)).toEqual(['China', 'China', 'China']);
    expect(['CN', 'China'].map(arLabel)).toEqual(['الصين', 'الصين']);
    expect(['AE', 'UAE'].map(enLabel)).toEqual(['United Arab Emirates', 'United Arab Emirates']);
    expect(['AE', 'UAE'].map(arLabel)).toEqual(['الإمارات', 'الإمارات']);
  });

  it('falls back to what was typed, trimmed — never blank, never a code', () => {
    expect(labelIn('ar')('Narnia')).toBe('Narnia');
    expect(labelIn('en')('  Atlantis ')).toBe('Atlantis');
  });

  it('shows a dash when nothing was typed', () => {
    const label = labelIn('en');
    expect(label('')).toBe('—');
    expect(label('   ')).toBe('—');
    expect(label(null)).toBe('—');
    expect(label(undefined)).toBe('—');
  });

  it('every known code is named in both languages, and nothing extra', () => {
    const enNames = en.codes.country as Record<string, string>;
    const arNames = ar.codes.country as Record<string, string>;
    expect(Object.keys(enNames).sort()).toEqual([...KNOWN_COUNTRIES].sort());
    expect(Object.keys(arNames).sort()).toEqual([...KNOWN_COUNTRIES].sort());
    for (const v of [...Object.values(enNames), ...Object.values(arNames)]) expect(v.trim()).not.toBe('');
  });
});
