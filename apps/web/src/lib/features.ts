/**
 * Parts of the office app that exist but are switched off somewhere — defined
 * once here, read by the menu, the notifications and the pages themselves.
 *
 * REQUESTS — the Requests page (order requests and import requests from the
 * shops, two tabs of one page). Hidden in production for now (owner,
 * 2026-10-17, docs/BUSINESS_LOGIC.md). Shops can still send requests; the API
 * and the storefront are unchanged, so they keep arriving and are all there
 * when the page is switched back on.
 *
 *   NEXT_PUBLIC_FEATURE_REQUESTS=on   shows it, production included
 *   NEXT_PUBLIC_FEATURE_REQUESTS=off  hides it everywhere
 *   unset                             hidden on a production deploy, shown
 *                                     everywhere else (local dev, previews)
 *
 * A production deploy is told apart by NEXT_PUBLIC_VERCEL_ENV, which Vercel
 * sets to "production" on its own because the project has "Automatically
 * expose System Environment Variables" on. Both are NEXT_PUBLIC_, so they are
 * fixed into the bundle at build time: changing either needs a redeploy.
 */

export type FeatureEnv = { flag?: string; deployEnv?: string };

/** The rule, apart from the environment so it can be tested on any input. */
export function requestsEnabled({ flag, deployEnv }: FeatureEnv): boolean {
  const v = flag?.trim().toLowerCase();
  if (v === 'on' || v === 'true' || v === '1') return true;
  if (v === 'off' || v === 'false' || v === '0') return false;
  return deployEnv !== 'production';
}

// Spelled out in full: Next only inlines `process.env.NEXT_PUBLIC_…` written
// literally, so these cannot be read through a variable.
export const REQUESTS_ENABLED = requestsEnabled({
  flag: process.env.NEXT_PUBLIC_FEATURE_REQUESTS,
  deployEnv: process.env.NEXT_PUBLIC_VERCEL_ENV,
});

/** The features this build has on, in the form the navigation model takes. */
export const ENABLED_FEATURES: readonly 'requests'[] = REQUESTS_ENABLED ? ['requests'] : [];
