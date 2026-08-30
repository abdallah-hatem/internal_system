import { api } from '../../lib/api';

/**
 * Where an image the API named actually lives.
 *
 * The API returns a path — `/api/v1/portal/images/<key>` — and not a URL, on
 * purpose: it does not know which host is in front of it, and baking one in
 * would make a stored response depend on the environment that produced it.
 *
 * Behind the proxy the store and the API share an origin and the path resolves
 * as it stands. In development they are two ports, so the API's origin has to
 * be put back — taken from the axios client rather than read from the
 * environment a second time, so there is one answer to "where is the API".
 */
const API_ORIGIN = (() => {
  try {
    return new URL(api.defaults.baseURL ?? '').origin;
  } catch {
    // A relative base URL means the API is on this origin already.
    return '';
  }
})();

export function imageSrc(path: string | null | undefined): string | null {
  if (!path) return null;
  if (/^(https?:)?\/\//i.test(path) || path.startsWith('data:')) return path;
  return path.startsWith('/') ? `${API_ORIGIN}${path}` : `${API_ORIGIN}/${path}`;
}
