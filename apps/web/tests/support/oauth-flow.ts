/**
 * The OAuth flow as Claude's connector walks it, over HTTP.
 *
 * Register a client, post the partner's login to the sign-in page, follow the
 * redirect, redeem the code with its PKCE verifier. Shared by the OAuth suite,
 * which pulls at each step, and the end-to-end suite, which needs the whole
 * walk to hand it a real access token — no hand-signed shortcut.
 */
import { expect, type APIRequestContext } from '@playwright/test';
import { createHash, randomBytes } from 'crypto';

import { API } from './fixtures';

/** OAuth and /mcp live at the host's root, outside `api/v1`, where clients look. */
export const ROOT = API.replace(/\/api\/v1\/?$/, '');
export const CLAUDE_CB = 'https://claude.ai/api/mcp/auth_callback';

const stamp = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

export async function register(request: APIRequestContext, redirect_uris: unknown) {
  const res = await request.post(`${ROOT}/oauth/register`, {
    data: { client_name: 'Claude', redirect_uris },
  });
  return { status: res.status(), body: await res.json() };
}

export async function newClient(request: APIRequestContext, uri = CLAUDE_CB): Promise<string> {
  const { status, body } = await register(request, [uri]);
  expect(status, JSON.stringify(body)).toBe(201);
  return body.client_id;
}

export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export type Fields = Record<string, string | undefined>;

export function authorizeFields(clientId: string, challenge: string, overrides: Fields = {}): Fields {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CLAUDE_CB,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: `st-${stamp()} /+=&?`,
    ...overrides,
  };
}

export const defined = (f: Fields) =>
  Object.fromEntries(Object.entries(f).filter((e): e is [string, string] => e[1] !== undefined));

export async function signIn(request: APIRequestContext, fields: Fields, email: string, password: string) {
  const res = await request.post(`${ROOT}/oauth/authorize`, {
    form: defined({ ...fields, email, password }),
    maxRedirects: 0,
  });
  return { status: res.status(), location: res.headers()['location'], html: await res.text() };
}

export async function tokenCall(request: APIRequestContext, fields: Fields) {
  const res = await request.post(`${ROOT}/oauth/token`, { form: defined(fields) });
  return { status: res.status(), body: await res.json() };
}

/** A partner signed in through the page: the code, and what redeems it. */
export async function codeFor(request: APIRequestContext, email: string, password: string, clientId?: string) {
  const client = clientId ?? (await newClient(request));
  const { verifier, challenge } = pkce();
  const res = await signIn(request, authorizeFields(client, challenge), email, password);
  expect(res.status, res.html).toBe(302);
  const code = new URL(res.location!).searchParams.get('code')!;
  return { client, verifier, challenge, code };
}

export const redeem = (
  request: APIRequestContext,
  c: { client: string; verifier: string; code: string },
  overrides: Fields = {},
) =>
  tokenCall(request, {
    grant_type: 'authorization_code',
    code: c.code,
    code_verifier: c.verifier,
    client_id: c.client,
    redirect_uri: CLAUDE_CB,
    ...overrides,
  });

export async function tokensFor(request: APIRequestContext, email: string, password: string) {
  const c = await codeFor(request, email, password);
  const res = await redeem(request, c);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { client: c.client, access: res.body.access_token as string, refresh: res.body.refresh_token as string };
}

export const claimsOf = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
