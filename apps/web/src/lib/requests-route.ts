import { REQUESTS_ENABLED } from './features';

/**
 * Where the shops' requests live: one page, two tabs (owner, 2026-10-17).
 * Order requests are the first tab and need no parameter; import requests are
 * `?view=imports`. Every link and redirect into the page is built here.
 */
export type RequestsView = 'orders' | 'imports';

export function requestsPath(view: RequestsView): string {
  return view === 'imports' ? '/requests?view=imports' : '/requests';
}

/** The tab a URL's `view` parameter names; anything else is the first tab. */
export function requestsViewOf(param: string | null | undefined): RequestsView {
  return param === 'imports' ? 'imports' : 'orders';
}

/**
 * Where a visit to the page, or to one of its old addresses, should land:
 * the tab, or the dashboard when the page is switched off in this build.
 */
export function requestsLanding(
  locale: string,
  view: RequestsView,
  enabled: boolean = REQUESTS_ENABLED,
): string {
  return enabled ? `/${locale}${requestsPath(view)}` : `/${locale}/dashboard`;
}
