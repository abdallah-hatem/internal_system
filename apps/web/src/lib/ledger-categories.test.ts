import { describe, expect, it } from 'vitest';
import en from '@/i18n/locales/en.json';
import ar from '@/i18n/locales/ar.json';
import * as web from './ledger-categories';
// The server's own file — the definition this copy must agree with.
import * as server from '../../../api/src/common/manual-ledger-categories';

/**
 * One list, kept in two files (rule 11, L6). The form offers from this copy
 * and the server refuses from its own; drift means a category on the form
 * that ends in a refusal, or one the server allows that nobody can pick.
 */
describe('manual ledger categories', () => {
  it('are the same lists the server enforces', () => {
    expect(web.MANUAL_EXPENSE_CATEGORIES).toEqual(server.MANUAL_EXPENSE_CATEGORIES);
    expect(web.OTHER_INCOME_CATEGORIES).toEqual(server.OTHER_INCOME_CATEGORIES);
    expect(web.MANUAL_ENTRY_KINDS).toEqual(server.MANUAL_ENTRY_KINDS);
    expect(web.CYCLE_REQUIRED_CATEGORIES).toEqual(server.CYCLE_REQUIRED_CATEGORIES);
    expect(web.CLOSED_CYCLE_STATUSES).toEqual(server.CLOSED_CYCLE_STATUSES);
  });

  it('every category and kind has a label in both locales', () => {
    type Codes = { codes: Record<string, Record<string, string>> };
    for (const messages of [en, ar] as unknown as Codes[]) {
      for (const c of web.MANUAL_CATEGORIES) {
        expect(messages.codes.ledgerCategory[c], c).toBeTruthy();
      }
      for (const k of Object.keys(web.MANUAL_ENTRY_KINDS)) {
        expect(messages.codes.ledgerKind[k], k).toBeTruthy();
      }
      expect(messages.codes.dateField.LEDGER_ENTRY).toBeTruthy();
    }
  });

  it('says which kind a category is, and nothing for a system or free-text one', () => {
    expect(web.manualKindOf('rent')).toBe('EXPENSE');
    expect(web.manualKindOf('interest')).toBe('OTHER_INCOME');
    for (const c of ['purchase', 'settlement', 'contribution', 'Rent', '', null, undefined]) {
      expect(web.manualKindOf(c)).toBeNull();
    }
  });
});
