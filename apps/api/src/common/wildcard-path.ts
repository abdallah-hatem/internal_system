import type { Request } from 'express';

/**
 * The rest of the path, after a route's prefix.
 *
 * Express 5 hands a named wildcard to Nest as an ARRAY of segments, and
 * `@Param('objectKey')` stringifies it before a handler ever sees it — so
 * `products/a/b.webp` arrives as `"products,a,b.webp"` and every lookup by
 * object key misses. It is not a decoding problem and no amount of
 * `decodeURIComponent` fixes it.
 *
 * Reading the path off the request avoids guessing which shape the parameter
 * took this time. `req.path` excludes the query string, and the prefix is
 * stated by the caller rather than inferred, so a route that moves does not
 * silently start returning a key with a fragment of its own URL in it.
 */
export function wildcardPath(req: Request, prefix: string): string {
  const path = req.path ?? '';
  const at = path.indexOf(prefix);
  const rest = at === -1 ? '' : path.slice(at + prefix.length);
  return decodeURIComponent(rest);
}
