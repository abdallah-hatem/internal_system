import { describe, expect, it } from 'vitest';
import * as web from './password-rule';
// The server's own file — the definition this copy must agree with.
import * as server from '../../../api/src/common/password-rule';
import en from '../i18n/locales/en.json';
import ar from '../i18n/locales/ar.json';

const samples: unknown[] = [
  '', 'a', 'a1', 'abcdef1', 'abcdefg1', 'abcdefgh', '12345678', '1234567a',
  '!!!!1234', '        ', 'a1      ', 'password123', 'StrongPassword@123',
  'YourCurrentPassword1', 'كلمةسر٣٤٥٦', 'كلمةسرطويلة', '١٢٣٤٥٦٧٨', 'é1234567',
  undefined, null, 12345678,
];

describe('password rule: the web copy equals the server', () => {
  it('has the same minimum', () => {
    expect(web.PASSWORD_MIN_LENGTH).toBe(server.PASSWORD_MIN_LENGTH);
  });

  it.each(samples.map((s) => [s]))('answers the same for %j', (pw) => {
    expect(web.isStrongPassword(pw)).toBe(server.isStrongPassword(pw));
  });

  it('the placeholders the form shows are themselves valid passwords', () => {
    // A placeholder that fails the rule teaches the wrong rule.
    for (const locale of [en, ar]) {
      const s = locale.settings as Record<string, string>;
      expect(server.isStrongPassword(s.currentPasswordPlaceholder)).toBe(true);
      expect(server.isStrongPassword(s.newPasswordPlaceholder)).toBe(true);
      expect(s.confirmPasswordPlaceholder).toBe(s.newPasswordPlaceholder);
    }
  });
});
