import { createHmac } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Tokens signed the way the running API signs them.
 *
 * For tests that need a token the API would issue but has no route to hand
 * out on demand — an assistant token before OAuth existed, an authorization
 * code that is already six minutes old. Signed by hand, so the test depends on
 * nothing the API ships beyond its secret.
 */

/** JWT_SECRET from apps/api/.env — the secret the running API signs with. */
export function apiSecret(): string {
  const env = readFileSync(join(__dirname, '../../../api/.env'), 'utf8');
  const line = env.split('\n').find((l) => /^\s*JWT_SECRET\s*=/.test(l));
  if (!line) throw new Error('JWT_SECRET is not set in apps/api/.env');
  return line
    .slice(line.indexOf('=') + 1)
    .trim()
    .replace(/^(['"])(.*)\1$/, '$2');
}

const b64url = (value: object | Buffer) =>
  (Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value))).toString('base64url');

/** An HS256 JWT. */
export function sign(payload: object, secret: string = apiSecret()): string {
  const head = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}`;
  return `${head}.${b64url(createHmac('sha256', secret).update(head).digest())}`;
}
