import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  COUNTRIES,
  COUNTRY_CODES,
  PREFERRED_COUNTRIES,
  assertCountryCode,
  countriesContaining,
  countryKey,
  countryMigrationMap,
  countryName,
  findCountry,
  resolveCountry,
} from './countries';

/** The refusal's code, or 'none' when nothing was thrown. */
function refusal(fn: () => unknown): string {
  try {
    fn();
    return 'none';
  } catch (e) {
    return (e as { response?: { code?: string } }).response?.code ?? 'uncoded';
  }
}

function params(fn: () => unknown): Record<string, unknown> {
  try {
    fn();
  } catch (e) {
    return (
      (e as { response: { params?: Record<string, unknown> } }).response
        .params ?? {}
    );
  }
  return {};
}

function message(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as { response: { message: string } }).response.message;
  }
  return '';
}

describe('the country list (§21, 2026-10-16)', () => {
  it('is every ISO 3166-1 alpha-2 code, once, A–Z', () => {
    expect(COUNTRY_CODES).toHaveLength(249);
    expect(new Set(COUNTRY_CODES).size).toBe(249);
    expect([...COUNTRY_CODES]).toEqual([...COUNTRY_CODES].sort());
    for (const c of COUNTRY_CODES) expect(c).toMatch(/^[A-Z]{2}$/);
  });

  it('every code has a name in English and Arabic, so no reader is shown a bare code', () => {
    for (const locale of ['en', 'ar']) {
      const names = new Intl.DisplayNames(locale, { type: 'region' });
      const bare = COUNTRY_CODES.filter((c) => {
        const n = names.of(c);
        return !n || n === c;
      });
      expect({ locale, bare }).toEqual({ locale, bare: [] });
    }
  });

  it('the countries offered first are on the list', () => {
    expect([...PREFERRED_COUNTRIES]).toEqual(['CN', 'AE', 'EG', 'TR', 'IN']);
    for (const c of PREFERRED_COUNTRIES) expect(COUNTRY_CODES).toContain(c);
  });

  it('names a code in English; a value that is not a code is shown as it is', () => {
    expect(countryName('CN')).toBe('China');
    expect(countryName('AE')).toBe('United Arab Emirates');
    expect(countryName('Narnia')).toBe('Narnia');
    expect(countryName(null)).toBe('');
  });
});

describe('assertCountryCode — what the supplier form and API may save', () => {
  it('a code, any case, any padding → the upper-case code', () => {
    expect(assertCountryCode('CN')).toBe('CN');
    expect(assertCountryCode('cn')).toBe('CN');
    expect(assertCountryCode(' ae ')).toBe('AE');
  });

  it('a code that is not one → COUNTRY_UNKNOWN, naming what was sent', () => {
    expect(refusal(() => assertCountryCode('XX'))).toBe('COUNTRY_UNKNOWN');
    expect(params(() => assertCountryCode('XX'))).toEqual({ country: 'XX' });
    // UK is what people say, GB is the code.
    expect(refusal(() => assertCountryCode('UK'))).toBe('COUNTRY_UNKNOWN');
  });

  it('a name is not a code: the form sends codes, and the API is not a second way in', () => {
    expect(refusal(() => assertCountryCode('China'))).toBe('COUNTRY_UNKNOWN');
    expect(refusal(() => assertCountryCode('الصين'))).toBe('COUNTRY_UNKNOWN');
    expect(refusal(() => assertCountryCode('CHN'))).toBe('COUNTRY_UNKNOWN');
  });

  it('nothing → COUNTRY_REQUIRED: every supplier is somewhere', () => {
    for (const v of ['', '   ', null, undefined, 42, {}]) {
      expect(refusal(() => assertCountryCode(v))).toBe('COUNTRY_REQUIRED');
    }
  });
});

describe('the free text the migration converts', () => {
  const map = countryMigrationMap();
  const convert = (typed: string) => map.get(countryKey(typed));

  it.each([
    ['China', 'CN'],
    ['china', 'CN'],
    [' CHINA ', 'CN'],
    ['CN', 'CN'],
    ['cn', 'CN'],
    ['PRC', 'CN'],
    ['الصين', 'CN'],
    ['UAE', 'AE'],
    ['U.A.E.', 'AE'],
    ['United Arab Emirates', 'AE'],
    ['united  arab   emirates', 'AE'],
    ['Dubai', 'AE'],
    ['الإمارات', 'AE'],
    ['الامارات', 'AE'],
    ['Egypt', 'EG'],
    ['مصر', 'EG'],
    ['Turkey', 'TR'],
    ['Türkiye', 'TR'],
    ['Turkiye', 'TR'],
    ['تركيا', 'TR'],
    ['India', 'IN'],
    ['الهند', 'IN'],
    ['Hong Kong', 'HK'],
    ["Cote d'Ivoire", 'CI'],
    ['Bosnia and Herzegovina', 'BA'],
    ['UK', 'GB'],
  ])('%s → %s', (typed, code) => {
    expect(convert(typed)).toBe(code);
  });

  it('every English name on the list converts to its own code', () => {
    for (const [code, name] of COUNTRIES) expect(convert(name)).toBe(code);
  });

  it('no fragment, no guess: what spells no country is left for a person', () => {
    for (const typed of [
      'Chin',
      'Chinatown',
      'Narnia',
      'Egypt (Cairo)',
      'Guangzhou',
      '',
    ]) {
      expect(convert(typed)).toBeUndefined();
    }
  });

  it('the migration SQL maps exactly these spellings, no more and no fewer', () => {
    const sql = readFileSync(
      join(
        __dirname,
        '../../prisma/migrations/20261016100000_supplier_country_codes/migration.sql',
      ),
      'utf8',
    );
    const inSql = new Map<string, string>();
    for (const m of sql.matchAll(
      /^\s*\('((?:[^']|'')*)', '([A-Z]{2})'\),?$/gm,
    )) {
      inSql.set(m[1].replace(/''/g, "'"), m[2]);
    }
    expect(inSql.size).toBeGreaterThan(500);
    expect(Object.fromEntries([...inSql].sort())).toEqual(
      Object.fromEntries([...map].sort()),
    );
  });
});

describe('resolveCountry — a country as a partner tells the assistant', () => {
  it.each([
    ['China', 'CN'],
    ['الصين', 'CN'],
    ['cn', 'CN'],
    ['U.A.E.', 'AE'],
    ['Dubai', 'AE'],
    ['مصر', 'EG'],
    // Not on our alias list: the Arabic name Intl knows it by.
    ['فرنسا', 'FR'],
  ])('%s → %s', (typed, code) => {
    expect(resolveCountry(typed)).toBe(code);
  });

  it('Narnia → COUNTRY_UNKNOWN, saying how to give one', () => {
    expect(refusal(() => resolveCountry('Narnia'))).toBe('COUNTRY_UNKNOWN');
    expect(params(() => resolveCountry('Narnia'))).toEqual({
      country: 'Narnia',
    });
    expect(message(() => resolveCountry('Narnia'))).toMatch(/ISO code/);
  });

  it('a fragment is refused too, naming what it is close to', () => {
    expect(refusal(() => resolveCountry('Chin'))).toBe('COUNTRY_UNKNOWN');
    expect(message(() => resolveCountry('Chin'))).toMatch(
      /Did you mean .*China \(CN\)/,
    );
  });

  it('nothing → COUNTRY_REQUIRED', () => {
    expect(refusal(() => resolveCountry('  '))).toBe('COUNTRY_REQUIRED');
  });

  it('findCountry: the same reading for a search box, never a refusal', () => {
    expect(findCountry('الصين')).toBe('CN');
    expect(findCountry('china')).toBe('CN');
    expect(findCountry('Narnia')).toBeNull();
    expect(findCountry('')).toBeNull();
  });
});

/**
 * The Suppliers list searches a country on the server now (server-side lists,
 * owner 2026-10-25), by part of its name in either language or its code — as
 * the office did in the browser over the names it knew.
 */
describe('countriesContaining (the search box of a list)', () => {
  it('part of the English name, any case: "chin" finds China', () => {
    expect(countriesContaining('chin')).toContain('CN');
  });

  it('part of the Arabic name, spelling forgiven: "صين" and "الإمارات" / "الامارات"', () => {
    expect(countriesContaining('صين')).toContain('CN');
    expect(countriesContaining('الامارات')).toContain('AE');
    expect(countriesContaining('الإمارات')).toContain('AE');
  });

  it('the code finds its country; nothing typed finds nothing; nonsense finds nothing', () => {
    expect(countriesContaining('EG')).toContain('EG');
    expect(countriesContaining('  ')).toEqual([]);
    expect(countriesContaining('zzqq')).toEqual([]);
  });
});
