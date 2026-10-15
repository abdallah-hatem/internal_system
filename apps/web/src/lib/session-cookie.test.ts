import { describe, expect, it } from 'vitest';
import { decodeSessionUser, encodeSessionUser } from './session-cookie';

const user = { id: 'u1', email: 'a@b.com', role: 'CORE_PARTNER', displayName: 'Abdallah' };

describe('session cookie', () => {
  it('round-trips the four fields the screen needs', () => {
    expect(decodeSessionUser(encodeSessionUser(user))).toEqual(user);
  });

  it('keeps nothing else — a token or anything extra never reaches the cookie', () => {
    const raw = encodeSessionUser({ ...user, token: 'eyJabc', partner: { displayName: 'X' } } as never);
    expect(decodeURIComponent(raw)).not.toContain('eyJabc');
    expect(Object.keys(JSON.parse(decodeURIComponent(raw))).sort()).toEqual(['displayName', 'email', 'id', 'role']);
  });

  it('takes the nested partner name when the flat one is missing', () => {
    const raw = encodeSessionUser({ id: 'u1', email: 'a@b.com', role: 'CORE_PARTNER', partner: { displayName: 'Shady' } });
    expect(decodeSessionUser(raw)?.displayName).toBe('Shady');
  });

  it('a name in Arabic and characters that break cookies survive', () => {
    const odd = { ...user, displayName: 'عبدالله; =,"x"' };
    expect(decodeSessionUser(encodeSessionUser(odd))).toEqual(odd);
    expect(encodeSessionUser(odd)).not.toMatch(/[;,\s"]/);
  });

  it.each([
    ['nothing', undefined],
    ['empty', ''],
    ['not JSON', 'abc'],
    ['broken escape', '%E0%A4%A'],
    ['JSON but no role', encodeURIComponent(JSON.stringify({ id: 'u', email: 'e' }))],
    ['role not text', encodeURIComponent(JSON.stringify({ id: 'u', email: 'e', role: 1 }))],
    ['an array', encodeURIComponent('[]')],
    ['null', encodeURIComponent('null')],
  ])('%s is no user, never an error', (_label, raw) => {
    expect(decodeSessionUser(raw)).toBeNull();
  });
});
