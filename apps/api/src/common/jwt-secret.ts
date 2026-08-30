/**
 * The signing secret, read once and checked.
 *
 * Both places that needed it wrote `configService.get('JWT_SECRET')!`, and the
 * `!` is the whole problem: with no value set, `@nestjs/jwt` signs with
 * `undefined`, which it happily accepts back. Every login works, every request
 * is authorised, and the tokens are forgeable by anybody who knows the
 * algorithm. Nothing looks wrong from either side.
 *
 * So it is checked at boot rather than at first use. A misconfigured server
 * should not start; it should not run for a week and be found out afterwards.
 *
 * The weak-value list is not security theatre. `.env.example` ships
 * CHANGE_ME_IN_PRODUCTION, and a value copied from an example file is the most
 * likely way a real deployment ends up with a secret that is written down in
 * public.
 */

/** Long enough that guessing is not the attack. 32 chars ≈ 190 bits at base64. */
const MINIMUM_LENGTH = 32;

/**
 * Values that are published somewhere, and so are not secrets.
 *
 * Compared after stripping punctuation and case, because these travel between
 * a README, a .env.example and a shell in every spelling: CHANGE_ME_IN_PRODUCTION,
 * change-me-in-production, "changeMeInProduction". Matching the literal string
 * catches one of those and waves the rest through — which is what the first
 * version of this did, and the test for the hyphenated spelling is what found it.
 */
const NOT_SECRETS = [
  'changemeinproduction',
  'changeme',
  'secret',
  'jwtsecret',
  'yoursecretkey',
  'dev',
  'development',
  'test',
  'password',
  'localdev',
];

/** Case, quotes, spaces and separators all removed, so spelling cannot hide. */
const bare = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

export function readJwtSecret(value: string | undefined): string {
  const secret = (value ?? '').trim();

  if (!secret) {
    throw new Error(
      'JWT_SECRET is not set. Every token would be signed with `undefined` and ' +
        'anyone could forge one. Generate a value:\n\n' +
        "  node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\"\n",
    );
  }

  if (NOT_SECRETS.includes(bare(secret))) {
    throw new Error(
      `JWT_SECRET is "${secret}", which is a placeholder from .env.example and is ` +
        'public. Generate a real one:\n\n' +
        "  node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\"\n",
    );
  }

  if (secret.length < MINIMUM_LENGTH) {
    throw new Error(
      `JWT_SECRET is ${secret.length} characters; at least ${MINIMUM_LENGTH} are needed. ` +
        'A short secret is brute-forceable offline against any token you have issued.\n',
    );
  }

  return secret;
}
