/**
 * Pages that hold several views as tabs (owner, 2026-10-18): the sidebar went
 * from twenty entries to twelve by folding screens about the same thing into
 * one page. Each view keeps the address it had as a redirect, so a bookmark, a
 * notification or the assistant's link still lands on it.
 *
 * The first view of a page is its plain address; the others are `?view=<slug>`.
 * Every link and redirect into these pages is built here. This file imports
 * nothing, so the unit tests load it straight into Node.
 */
export type ViewDef = {
  /** `?view=` value, and the old route the view used to live at. */
  slug: string;
  /** Its label: the key under `nav` in the locale files. */
  navKey: string;
};

export const PAGE_VIEWS = {
  cycles: [
    { slug: 'cycles', navKey: 'cycles' },
    { slug: 'purchases', navKey: 'purchases' },
    { slug: 'shipments', navKey: 'shipments' },
  ],
  suppliers: [
    { slug: 'suppliers', navKey: 'suppliers' },
    { slug: 'providers', navKey: 'providers' },
  ],
  products: [
    { slug: 'products', navKey: 'products' },
    { slug: 'categories', navKey: 'categories' },
  ],
  partners: [
    { slug: 'partners', navKey: 'partners' },
    { slug: 'settlements', navKey: 'settlements' },
  ],
  settings: [
    { slug: 'settings', navKey: 'settings' },
    { slug: 'fx-rates', navKey: 'fxRates' },
    { slug: 'audit-logs', navKey: 'auditLogs' },
  ],
} as const satisfies Record<string, readonly ViewDef[]>;

export type ViewPage = keyof typeof PAGE_VIEWS;
export type ViewSlug<P extends ViewPage = ViewPage> = (typeof PAGE_VIEWS)[P][number]['slug'];

/** The view a URL's `view` parameter names on a page; anything else is its first view. */
export function viewOf<P extends ViewPage>(page: P, param: string | null | undefined): ViewSlug<P> {
  const views: readonly ViewDef[] = PAGE_VIEWS[page];
  return (views.find((v) => v.slug === param) ?? views[0]).slug as ViewSlug<P>;
}

/** The page a view now lives on, or undefined for a slug that is not a view. */
export function pageOfView(slug: string): ViewPage | undefined {
  return (Object.keys(PAGE_VIEWS) as ViewPage[]).find((p) =>
    (PAGE_VIEWS[p] as readonly ViewDef[]).some((v) => v.slug === slug),
  );
}

/**
 * The address of a view, with any extra parameters (`open`, filters) kept.
 * The first view of a page needs no `view` parameter.
 */
export function viewPath(slug: string, extra?: URLSearchParams | Record<string, string>): string {
  const page = pageOfView(slug);
  if (!page) throw new Error(`Not a page view: ${slug}`);
  const params = new URLSearchParams(extra);
  params.delete('view');
  if (PAGE_VIEWS[page][0].slug !== slug) params.set('view', slug);
  const query = params.toString();
  return query ? `/${page}?${query}` : `/${page}`;
}

/** Where an old address (`/purchases?open=x`) lands, locale and parameters kept. */
export function movedViewLanding(
  locale: string,
  slug: string,
  searchParams: Record<string, string | string[] | undefined>,
): string {
  const extra = new URLSearchParams();
  for (const [k, v] of Object.entries(searchParams)) {
    if (typeof v === 'string') extra.set(k, v);
    else if (Array.isArray(v)) v.forEach((x) => extra.append(k, x));
  }
  return `/${locale}${viewPath(slug, extra)}`;
}
