/**
 * Tokens for the assistant's surface, minted the way the API mints them.
 *
 * Built by hand (HS256, signed with the running API's own JWT_SECRET) so a
 * test depends on nothing the API ships — the OAuth flow that hands these out
 * is itself under test elsewhere.
 */
import { expect, type APIRequestContext } from '@playwright/test';
import { API, EMAIL, PASSWORD } from './fixtures';
import { apiSecret, sign } from './api-jwt';

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

export async function assistantToken(
  request: APIRequestContext,
): Promise<string> {
  return mcpTokenFor(await partnerId(request));
}
