/**
 * Where the API's routes live, and the few that live elsewhere.
 *
 * Everything the office app and the store call sits under `api/v1`. OAuth and
 * MCP clients do not look there: they find the authorization server at
 * `/.well-known/*` on the host (RFC 8414, RFC 9728), follow the absolute URLs
 * it names under `/oauth/*`, and talk to the assistant at `/mcp`. Named here
 * so `main.ts` and the tests that boot the routes read one list.
 */
export const API_PREFIX = 'api/v1';

export const OUTSIDE_API_PREFIX = [
  '.well-known/{*path}',
  'oauth/{*path}',
  'mcp',
];

/**
 * Routes any web origin may call, without cookies.
 *
 * A browser-based MCP client reads the metadata and exchanges its code from
 * its own origin. Nothing here reads a cookie, and a token is only handed to
 * whoever holds the code and its PKCE verifier, so an open origin gives a
 * page nothing it did not already have. The sign-in page is not listed: it is
 * navigated to, never fetched.
 */
export function isOpenOAuthPath(url: string | undefined): boolean {
  const path = (url ?? '').split('?')[0];
  return (
    path.startsWith('/.well-known/') ||
    path === '/oauth/register' ||
    path === '/oauth/token' ||
    path === '/oauth/revoke'
  );
}
