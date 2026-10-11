import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTranslator } from 'next-intl';
import ar from '@/i18n/locales/ar.json';
import en from '@/i18n/locales/en.json';
import { PARAM_KINDS, resolveApiError, type CodeLabel } from './api-error';

/**
 * R1b, rule 9 — a refusal's params that are codes are said in the reader's
 * language. The API sends `owner: 'SALE_RETURN'`; the Arabic sentence must say
 * «مرتجع بيع», not the code and not the English words.
 */

type Messages = typeof en;
const readerOf = (messages: Messages, locale: string) => {
  const t = createTranslator({ locale, messages, namespace: 'errors' }) as unknown as (
    key: string,
    values?: Record<string, string | number>,
  ) => string;
  const codes = messages.codes as unknown as Record<string, Record<string, string>>;
  const codeLabel: CodeLabel = (kind, code) => codes[kind]?.[code] ?? code;
  return (code: string, params: Record<string, string>) =>
    resolveApiError({ response: { data: { error: { code, message: 'english', params } } } }, t, 'fb', codeLabel);
};
const inArabic = readerOf(ar as unknown as Messages, 'ar');
const inEnglish = readerOf(en, 'en');

describe('refusal params that are codes', () => {
  it('ENTRY_OWNED_ELSEWHERE names the owner in Arabic, with no English and no raw code', () => {
    const said = inArabic('ENTRY_OWNED_ELSEWHERE', { owner: 'SALE_RETURN' });
    expect(said).toContain('مرتجع بيع');
    expect(said).not.toMatch(/SALE_RETURN|sale return/i);
  });

  it('…and in English for an English reader', () => {
    expect(inEnglish('ENTRY_OWNED_ELSEWHERE', { owner: 'SUPPLIER_REFUND' })).toContain('Supplier refund');
  });

  it('a calendar day in a param stays one left-to-right run in Arabic (not reordered to 11-10-2026)', () => {
    const said = inArabic('DATE_RANGE_REVERSED', { from: '2026-10-11', to: '2026-10-06' });
    expect(said).toContain('⁦2026-10-11⁩');
    expect(said).toContain('⁦2026-10-06⁩');
    // English is left exactly as it was — no marks at all.
    expect(inEnglish('DATE_RANGE_REVERSED', { from: '2026-10-11', to: '2026-10-06' })).toBe(
      'The range starts on 2026-10-11, after it ends on 2026-10-06.',
    );
  });

  it('DATE_IN_FUTURE says which date in the reader\'s language', () => {
    const said = inArabic('DATE_IN_FUTURE', { label: 'PAYMENT_RECEIVED', day: '2026-10-11' });
    expect(said).toContain('تاريخ استلام الدفعة');
    expect(said).not.toContain('PAYMENT_RECEIVED');
  });

  it('a status transition names every status, the allowed list each one on its own', () => {
    const said = inArabic('BAD_STATUS_TRANSITION', { from: 'SELLING', to: 'PLANNING', allowed: 'SETTLEMENT, CLOSED' });
    expect(said).not.toMatch(/[A-Z]{3,}/);
  });

  it('an owner the app has no word for yet shows the code, never a blank or a crash', () => {
    expect(inArabic('ENTRY_OWNED_ELSEWHERE', { owner: 'SOMETHING_NEW' })).toContain('SOMETHING_NEW');
  });

  it('every kind named in the map has an entry in both locales for each code the API can send there', () => {
    // dateField is the one kind R1b added; it must match the API's DATE_FIELDS
    // exactly, read from the API's own source so the two cannot drift.
    const source = readFileSync(join(__dirname, '../../../api/src/common/dates.ts'), 'utf8');
    const block = source.slice(source.indexOf('export const DATE_FIELDS'), source.indexOf('} as const'));
    const api = [...block.matchAll(/^\s+([A-Z_]+):/gm)].map((m) => m[1]);
    expect(api.length).toBeGreaterThan(0);
    for (const m of [en, ar] as unknown as Messages[]) {
      const codes = m.codes as unknown as Record<string, Record<string, string>>;
      expect(Object.keys(codes.dateField).sort()).toEqual([...api].sort());
      for (const kinds of Object.values(PARAM_KINDS)) {
        for (const kind of Object.values(kinds)) expect(codes[kind], kind).toBeTruthy();
      }
    }
  });
});
