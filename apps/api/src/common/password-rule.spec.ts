import { assertStrongPassword } from './assert-password';
import { PASSWORD_MIN_LENGTH, isStrongPassword } from './password-rule';

describe('the password rule (2026-10-14)', () => {
  it.each([
    'abcdefg1',
    'password123',
    'StrongPassword@123',
    '1234567a',
    'a1      ',
    'كلمةسر٣٤٥٦', // Arabic letters and Arabic-Indic digits
    'كلمة سر 2026',
  ])('accepts %j', (pw) => {
    expect(isStrongPassword(pw)).toBe(true);
    expect(() => assertStrongPassword(pw)).not.toThrow();
  });

  it.each([
    '',
    'a1',
    'abcdef1', // seven: one short of the limit
    'abcdefgh',
    '12345678',
    '!!!!????',
    '@@@@1234',
    '        ',
  ])('refuses %j', (pw) => {
    expect(isStrongPassword(pw)).toBe(false);
  });

  it.each([undefined, null, 12345678, {}, ['abcdefg1']])(
    'refuses a non-string %j',
    (pw) => {
      expect(isStrongPassword(pw)).toBe(false);
    },
  );

  it('refuses with a code and the minimum as a parameter', () => {
    try {
      assertStrongPassword('short1');
      throw new Error('did not refuse');
    } catch (e) {
      const body = (e as { getResponse(): unknown }).getResponse();
      expect(body).toEqual({
        code: 'PASSWORD_TOO_WEAK',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- jest's asymmetric matcher is typed any
        message: expect.stringContaining(String(PASSWORD_MIN_LENGTH)),
        params: { min: PASSWORD_MIN_LENGTH },
      });
    }
  });
});
