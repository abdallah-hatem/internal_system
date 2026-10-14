import type { HttpException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  arabicSearchKey,
  arabicText,
  bilingualProductSearch,
  DESCRIPTION_AR_MAX,
  displayDescription,
  displayName,
  NAME_AR_MAX,
  nameArSearchFor,
} from './arabic-names';
import { nameKey } from '../modules/assistant/receipt/name-matching';

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

/** The table the office's and the storefront's copies are pinned to as well. */
const cases = JSON.parse(
  readFileSync(join(__dirname, 'arabic-search-cases.json'), 'utf8'),
) as {
  keys: [string, string][];
  same: [string, string][];
  different: [string, string][];
};

describe('arabicSearchKey — spelling differences an Arabic search forgives (§3, 2026-10-15)', () => {
  it.each(cases.keys)('%j → %j', (text, key) => {
    expect(arabicSearchKey(text)).toBe(key);
  });

  it.each(cases.same)('%s finds %s, and the other way round', (a, b) => {
    expect(arabicSearchKey(a)).toBe(arabicSearchKey(b));
    // Inside a longer name too — a search is "contains", not "equals".
    expect(arabicSearchKey(`قطعة ${a} اصلية`)).toContain(arabicSearchKey(b));
    expect(arabicSearchKey(`قطعة ${b} اصلية`)).toContain(arabicSearchKey(a));
  });

  it.each(cases.different)('%s does NOT find %s', (a, b) => {
    expect(arabicSearchKey(a)).not.toBe(arabicSearchKey(b));
  });

  it('every rule in both directions: أ إ آ ↔ ا, ة ↔ ه, ى ↔ ي, marks and tatweel ↔ none', () => {
    const k = arabicSearchKey;
    expect(k('إطار')).toBe(k('اطار'));
    expect(k('أطار')).toBe(k('اطار'));
    expect(k('آلات')).toBe(k('الات'));
    expect(k('خوذة')).toBe(k('خوذه'));
    expect(k('هوندى')).toBe(k('هوندي'));
    expect(k('فَرَامِلُ')).toBe(k('فرامل'));
    expect(k('فـرامـل')).toBe(k('فرامل'));
  });

  it('nothing → empty, never a crash', () => {
    expect(arabicSearchKey(null)).toBe('');
    expect(arabicSearchKey(undefined)).toBe('');
    expect(arabicSearchKey('')).toBe('');
    expect(arabicSearchKey(' \t\n ')).toBe('');
  });

  it('English is lower-cased and nothing else — accents, digits and punctuation stay', () => {
    expect(arabicSearchKey('Café Racer-2')).toBe('café racer-2');
  });

  it('agrees with the assistant on Arabic: its matcher folds the same pairs, and only those', () => {
    // On Latin the matcher goes further (accents, punctuation) — that is
    // matching a printed receipt, not a search box, and stays its own.
    const arabic = ([a]: [string, string]) => /[\u0600-\u06FF]/.test(a);
    for (const [a, b] of cases.same.filter(arabic)) {
      expect(nameKey(a)).toBe(nameKey(b));
    }
    for (const [a, b] of cases.different.filter(arabic)) {
      expect(nameKey(a)).not.toBe(nameKey(b));
    }
  });
});

describe('nameArSearchFor — what is stored beside an Arabic name', () => {
  it('not sent leaves it alone; cleared clears it; a name stores its key', () => {
    expect(nameArSearchFor(undefined)).toBeUndefined();
    expect(nameArSearchFor(null)).toBeNull();
    expect(nameArSearchFor('خوذة')).toBe('خوذه');
  });
  it('a name that is nothing but marks stores no key, not an empty one', () => {
    expect(nameArSearchFor('ـــ')).toBeNull();
  });
});

describe('bilingualProductSearch — one search, both languages, and the SKU', () => {
  it('asks for the English name and the SKU as typed, and the Arabic through its key', () => {
    const where = bilingualProductSearch('خوذة');
    const fields = where.map((w) => Object.keys(w)[0]);
    expect(fields.sort()).toEqual(['name', 'nameArSearch', 'sku']);
    expect(where).toContainEqual({
      name: { contains: 'خوذة', mode: 'insensitive' },
    });
    expect(where).toContainEqual({
      sku: { contains: 'خوذة', mode: 'insensitive' },
    });
    expect(where).toContainEqual({
      nameArSearch: { contains: 'خوذه', mode: 'insensitive' },
    });
  });

  it('a search that is nothing but marks does not match every Arabic name', () => {
    const fields = bilingualProductSearch('ـ').map((w) => Object.keys(w)[0]);
    expect(fields).not.toContain('nameArSearch');
  });
});
