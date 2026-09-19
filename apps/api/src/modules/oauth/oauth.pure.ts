import { createHash, randomBytes } from 'node:crypto';

/**
 * The rules of the OAuth door that need nothing but their arguments.
 *
 * Kept apart from the service so each can be tested with no database and no
 * clock: which redirect URIs a client may register, what a PKCE proof is, and
 * where this server says it lives.
 */

/** An authorization code is good for five minutes, and once. */
export const CODE_TTL_SECONDS = 5 * 60;

/** A refresh token lapses after thirty days without being used. */
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** What `issueAssistantToken` signs for. Reported to the client as `expires_in`. */
export const ACCESS_TTL_SECONDS = 60 * 60;

/** The audience an authorization code is signed for — no route accepts it. */
export const CODE_AUDIENCE = 'oauth_code';

/** The `UsedNonce.kind` a spent code is recorded under. */
export const CODE_NONCE_KIND = 'oauth_code';

/**
 * A registration asking for more than this is not Claude. Claude registers one
 * callback; the cap only stops a client storing an arbitrary list.
 */
export const MAX_REDIRECT_URIS = 10;
export const MAX_REDIRECT_URI_LENGTH = 2000;
export const MAX_CLIENT_NAME_LENGTH = 200;
export const MAX_STATE_LENGTH = 1000;

/**
 * Where Claude's own servers receive a code: claude.ai and claude.com.
 * Registration is open by design — claude.ai registers itself — so this list
 * is what stops anyone registering a client that sends a partner's code to
 * their own site.
 */
const CLAUDE_HOSTS = new Set(['claude.ai', 'claude.com']);

/** Claude Desktop and Claude Code receive the code on this machine. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * May a client register this redirect URI? (spec: "Redirect URIs are limited
 * to Claude".)
 *
 * Exact hosts, not suffixes — `claude.ai.evil.example` ends in neither. No
 * credentials in the URL and no fragment, which OAuth forbids in a redirect
 * URI. Loopback over http is how native apps receive a code (RFC 8252); any
 * other http is refused.
 */
export function isAllowedRedirectUri(uri: string): boolean {
  if (uri.length === 0 || uri.length > MAX_REDIRECT_URI_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash || uri.includes('#')) {
    return false;
  }
  if (url.protocol === 'https:' && CLAUDE_HOSTS.has(url.hostname)) {
    return url.port === '';
  }
  if (
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    LOOPBACK_HOSTS.has(url.hostname)
  ) {
    return true;
  }
  return false;
}

/** Base64url of the SHA-256 of the verifier — PKCE's S256 transform. */
export function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * RFC 7636: 43 to 128 characters from the unreserved set. A verifier outside
 * that is refused rather than hashed, so a short guessable one never counts.
 */
export function isValidCodeVerifier(verifier: unknown): verifier is string {
  return (
    typeof verifier === 'string' && /^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)
  );
}

/** An S256 challenge is the base64url of 32 bytes: exactly 43 characters. */
export function isValidCodeChallenge(challenge: unknown): challenge is string {
  return typeof challenge === 'string' && /^[A-Za-z0-9_-]{43}$/.test(challenge);
}

/** Does this verifier prove possession of the challenge sent at authorize? */
export function verifierMatches(verifier: string, challenge: string): boolean {
  return s256(verifier) === challenge;
}

/** A fresh refresh token: 256 random bits, handed out once and never stored. */
export function newRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What is stored in its place. A leaked table yields no usable token. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Client ids are UUID columns. Asking Postgres for `'abc'` fails the cast and
 * surfaces as a 500, so anything else is an unknown client before it gets
 * that far. One definition, in `common/uuid.ts`, shared with the assistant.
 */
export { isUuid } from '../../common/uuid';

/**
 * One parameter, as a string or not at all.
 *
 * Form and query parsers turn a repeated parameter into an array; OAuth says a
 * parameter appears once (RFC 6749 §3.1), so a repeated one is treated as
 * absent rather than guessed at.
 */
export function param(
  source: Record<string, unknown> | undefined,
  name: string,
): string | undefined {
  const value = source?.[name];
  return typeof value === 'string' ? value : undefined;
}

/** The code, or the error, added to the client's registered redirect URI. */
export function redirectWith(
  redirectUri: string,
  params: Record<string, string | undefined>,
): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
