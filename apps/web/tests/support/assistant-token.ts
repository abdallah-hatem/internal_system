/**
 * Tokens for the assistant's surface, minted the way the API mints them.
 *
 * Built by hand (HS256, signed with the running API's own JWT_SECRET) so a
 * test depends on nothing the API ships — the OAuth flow that hands these out
 * is itself under test elsewhere.
 */
import { expect, type APIRequestContext } from '@playwright/test';
import { createHmac } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { API, EMAIL, PASSWORD } from './fixtures';

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
export function sign(payload: object, secret: string): string {
  const head = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}`;
  return `${head}.${b64url(createHmac('sha256', secret).update(head).digest())}`;
}

/** The core partner's id, from the ordinary internal login. */
export async function partnerId(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${API}/auth/login`, {
    data: { email: EMAIL, password: PASSWORD },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data.user.role).toBe('CORE_PARTNER');
  return body.data.user.id;
}

/** A one-hour `mcp` token for `sub`, as `AuthService.issueAssistantToken` issues it. */
export function mcpTokenFor(sub: string, secret = apiSecret()): string {
  const now = Math.floor(Date.now() / 1000);
  return sign({ sub, aud: 'mcp', iat: now, exp: now + 3600 }, secret);
}

export async function assistantToken(request: APIRequestContext): Promise<string> {
  return mcpTokenFor(await partnerId(request));
}
