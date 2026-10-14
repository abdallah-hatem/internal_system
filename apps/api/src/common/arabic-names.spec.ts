import type { HttpException } from '@nestjs/common';
import {
  arabicText,
  bilingualProductSearch,
  DESCRIPTION_AR_MAX,
  displayDescription,
  displayName,
  NAME_AR_MAX,
} from './arabic-names';

/** The code a refusal carries, or null when nothing was thrown. */
function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    const body = (e as HttpException).getResponse() as { code: string };
    return body.code;
  }
}

describe('displayName — which name a reader sees (§3, 2026-10-14)', () => {
  const pads = { name: 'Brake pads', nameAr: 'تيل فرامل' };

  it('Arabic reader, Arabic name present → the Arabic', () => {
    expect(displayName(pads, 'ar')).toBe('تيل فرامل');
  });

  it('English reader → the English, even when an Arabic exists', () => {
    expect(displayName(pads, 'en')).toBe('Brake pads');
  });

  it('Arabic reader, no Arabic name → the English, never blank', () => {
    expect(displayName({ name: 'Chain kit', nameAr: null }, 'ar')).toBe(
      'Chain kit',
    );
    expect(displayName({ name: 'Chain kit' }, 'ar')).toBe('Chain kit');
  });

  it('an Arabic name of only spaces is no Arabic name', () => {
    expect(displayName({ name: 'Chain kit', nameAr: '   ' }, 'ar')).toBe(
      'Chain kit',
    );
    expect(displayName({ name: 'Chain kit', nameAr: '' }, 'ar')).toBe(
      'Chain kit',
    );
  });

  it('a locale it does not know is read as English', () => {
    expect(displayName(pads, 'fr')).toBe('Brake pads');
  });

  it('description: Arabic when present, English otherwise, null when neither', () => {
    expect(
      displayDescription(
        { description: 'Front', descriptionAr: 'أمامي' },
        'ar',
      ),
    ).toBe('أمامي');
    expect(
      displayDescription({ description: 'Front', descriptionAr: null }, 'ar'),
    ).toBe('Front');
    expect(
      displayDescription(
        { description: 'Front', descriptionAr: 'أمامي' },
        'en',
      ),
    ).toBe('Front');
    expect(
      displayDescription({ description: null, descriptionAr: null }, 'ar'),
    ).toBeNull();
    expect(
      displayDescription({ description: '', descriptionAr: ' ' }, 'ar'),
    ).toBeNull();
  });
});

describe('arabicText — what an Arabic field may hold', () => {
  it('not sent stays not sent, so an update leaves the stored value alone', () => {
    expect(arabicText(undefined, 'nameAr', NAME_AR_MAX)).toBeUndefined();
  });

  it('trims', () => {
    expect(arabicText('  خوذ  ', 'nameAr', NAME_AR_MAX)).toBe('خوذ');
  });

  it('empty, blank and null all become null — one spelling of "no Arabic"', () => {
    expect(arabicText('', 'nameAr', NAME_AR_MAX)).toBeNull();
    expect(arabicText('   ', 'nameAr', NAME_AR_MAX)).toBeNull();
    expect(arabicText(null, 'nameAr', NAME_AR_MAX)).toBeNull();
  });

  it('exactly the limit is accepted; one past it is refused with a code', () => {
    expect(
      arabicText('ب'.repeat(NAME_AR_MAX), 'nameAr', NAME_AR_MAX),
    ).toHaveLength(NAME_AR_MAX);
    expect(
      codeOf(() =>
        arabicText('ب'.repeat(NAME_AR_MAX + 1), 'nameAr', NAME_AR_MAX),
      ),
    ).toBe('NAME_AR_TOO_LONG');
    expect(
      codeOf(() =>
        arabicText(
          'ب'.repeat(DESCRIPTION_AR_MAX + 1),
          'descriptionAr',
          DESCRIPTION_AR_MAX,
        ),
      ),
    ).toBe('DESCRIPTION_AR_TOO_LONG');
  });

  it('length is counted after trimming — padding does not push it over', () => {
    const padded = `  ${'ب'.repeat(NAME_AR_MAX)}  `;
    expect(arabicText(padded, 'nameAr', NAME_AR_MAX)).toHaveLength(NAME_AR_MAX);
  });

  it('a number or an object is a malformed request, not a name', () => {
    expect(codeOf(() => arabicText(42, 'nameAr', NAME_AR_MAX))).toBe(
      'VALIDATION_FAILED',
    );
    expect(codeOf(() => arabicText({ ar: 'x' }, 'nameAr', NAME_AR_MAX))).toBe(
      'VALIDATION_FAILED',
    );
  });
});

describe('bilingualProductSearch — one search, both languages, and the SKU', () => {
  it('asks for the English name, the Arabic name and the SKU, ignoring case', () => {
    const fields = bilingualProductSearch('تيل').map((w) => Object.keys(w)[0]);
    expect(fields.sort()).toEqual(['name', 'nameAr', 'sku']);
    for (const clause of bilingualProductSearch('تيل')) {
      expect(Object.values(clause)[0]).toEqual({
        contains: 'تيل',
        mode: 'insensitive',
      });
    }
  });
});
