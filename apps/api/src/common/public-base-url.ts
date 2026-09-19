/**
 * The address the outside world reaches this API at, without a trailing slash.
 *
 * OAuth and MCP clients are handed absolute URLs — where the protected
 * resource's metadata lives, where to sign in — so the API has to name itself.
 * Behind Vercel the request arrives at an internal host over plain http, and
 * only the forwarded headers say what the client actually dialled.
 *
 * `PUBLIC_BASE_URL` wins when set, and should be set in production: forwarded
 * headers are whatever the caller sent when nothing in front rewrites them, and
 * an address a caller can choose is an address a caller can point elsewhere.
 */
type Headers = Record<string, string | string[] | undefined>;

/** The first value of a header that may be repeated or comma-joined by proxies. */
function first(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const head = raw?.split(',')[0]?.trim();
  return head || undefined;
}

export function publicBaseUrl(
  configured: string | undefined,
  request: { headers: Headers; protocol?: string },
): string {
  const fixed = configured?.trim();
  if (fixed) return fixed.replace(/\/+$/, '');

  const proto =
    first(request.headers['x-forwarded-proto']) ?? request.protocol ?? 'http';
  const host =
    first(request.headers['x-forwarded-host']) ??
    first(request.headers.host) ??
    'localhost';
  return `${proto}://${host}`;
}
