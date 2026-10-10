'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

/**
 * Open a page's own create form when it is reached with `?new=1` — how the
 * dashboard's quick actions land on "New sale" or "Record payment" without a
 * second copy of either form.
 *
 *   useOpenFromQuery(() => setShowCreateModal(true));
 *
 * Runs once per arrival, then drops the parameter (keeping any others) so a
 * refresh or the back button does not reopen a form the user already closed.
 * `ready` holds it back until whatever the form needs has loaded.
 *
 * The page must render under a <Suspense> boundary: `useSearchParams` cannot
 * be prerendered, and `next build` fails without one.
 */
export function useOpenFromQuery(open: () => void, opts: { param?: string; ready?: boolean } = {}) {
  const { param = 'new', ready = true } = opts;
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const done = useRef(false);

  useEffect(() => {
    // Re-armed once the parameter is gone, so arriving with it again — the
    // page still mounted — opens the form a second time.
    if (searchParams.get(param) !== '1') {
      done.current = false;
      return;
    }
    if (done.current || !ready) return;
    done.current = true;
    open();

    const rest = new URLSearchParams(searchParams.toString());
    rest.delete(param);
    const query = rest.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [searchParams, param, ready, pathname, router, open]);
}
