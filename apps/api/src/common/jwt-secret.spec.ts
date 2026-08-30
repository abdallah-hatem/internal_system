import { readJwtSecret } from './jwt-secret';

/**
 * A misconfigured secret is invisible from both ends — every login succeeds and
 * every token verifies, because the same wrong value does both jobs. So the
 * only place it can be caught is here, at the point the value is read.
 */
describe('readJwtSecret', () => {
  it('refuses an unset secret rather than signing with undefined', () => {
    expect(() => readJwtSecret(undefined)).toThrow(/not set/i);
  });

  it('refuses an empty or whitespace secret', () => {
    expect(() => readJwtSecret('')).toThrow(/not set/i);
    expect(() => readJwtSecret('   ')).toThrow(/not set/i);
  });

  it('refuses the placeholder that .env.example ships', () => {
    // The likeliest route to a public secret: copy the example, never edit it.
    expect(() => readJwtSecret('CHANGE_ME_IN_PRODUCTION')).toThrow(/placeholder/i);
    expect(() => readJwtSecret('change-me-in-production')).toThrow(/placeholder/i);
    expect(() => readJwtSecret('"CHANGE_ME_IN_PRODUCTION"')).toThrow(/placeholder/i);
    expect(() => readJwtSecret('changeMeInProduction')).toThrow(/placeholder/i);
  });

  it('is not fooled by which separator the placeholder was written with', () => {
    // The first version compared the literal string with underscores, so the
    // hyphenated spelling fell through to the length check and was refused for
    // the wrong reason — and a 40-character hyphenated placeholder would have
    // been accepted outright.
    for (const spelling of [
      'change_me_in_production',
      'change-me-in-production',
      'CHANGE ME IN PRODUCTION',
      'Change.Me.In.Production',
    ]) {
      expect(() => readJwtSecret(spelling)).toThrow(/placeholder/i);
    }
  });

  it('refuses other published values', () => {
    for (const weak of ['secret', 'changeme', 'dev', 'test', 'your-secret-key']) {
      expect(() => readJwtSecret(weak)).toThrow();
    }
  });

  it('refuses a secret short enough to brute-force offline', () => {
    expect(() => readJwtSecret('a'.repeat(31))).toThrow(/31 characters/);
  });

  it('accepts exactly the minimum, so the boundary is not off by one', () => {
    const thirtyTwo = 'a'.repeat(32);
    expect(readJwtSecret(thirtyTwo)).toBe(thirtyTwo);
  });

  it('accepts a generated secret and returns it unchanged', () => {
    const real = require('crypto').randomBytes(48).toString('base64url');
    expect(readJwtSecret(real)).toBe(real);
  });

  it('trims surrounding whitespace, since .env values often carry it', () => {
    const real = 'a'.repeat(40);
    expect(readJwtSecret(`  ${real}  `)).toBe(real);
  });

  it('accepts the secret this machine is actually configured with', () => {
    // The guard is worthless if it would refuse the running configuration —
    // that is a server that will not boot, found at boot rather than here.
    const configured = process.env.JWT_SECRET;
    if (configured) expect(() => readJwtSecret(configured)).not.toThrow();
  });
});
