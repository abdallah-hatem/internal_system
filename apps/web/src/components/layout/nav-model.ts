/**
 * What the app's navigation contains, and who sees which part of it — kept
 * apart from the icons and markup so the sidebar, the phone bar and the tests
 * all read one definition (rule 11). This file imports nothing on purpose: the
 * unit tests load it straight into Node.
 *
 * The sidebar follows the shape of the business rather than the order the
 * screens were built in: goods are bought and brought in, they become stock,
 * the stock is sold, the money is collected, and what is left is split between
 * the partners. A flat list of nineteen links made related screens — a cycle
 * and the shipment on it, a payment and the plan it belongs to — sit
 * arbitrarily far apart.
 */

export type NavItem = {
  /** The key under `nav` in the locale files, and the icon's key in the shell. */
  key: string;
  href: string;
  /**
   * The roles allowed to see the entry. Absent means every signed-in role —
   * which is what the sidebar has applied to every entry so far. Narrowing an
   * entry here narrows it in the sidebar, the phone bar and "More" at once.
   */
  roles?: readonly string[];
  /**
   * A page that is switched off in some builds (lib/features.ts). The entry
   * shows only when the caller passes this feature as on — so a caller that
   * forgets to pass the features hides it, rather than showing a page that
   * production is meant not to have.
   */
  feature?: Feature;
};

/** Switchable pages. The values come from `ENABLED_FEATURES` in lib/features.ts;
 *  this file imports nothing, so the caller hands them in. */
export type Feature = 'requests';

export type NavGroup = { key: string; items: readonly NavItem[] };

/**
 * The roles on each entry are copied from the `@Roles` on the API endpoint
 * that page lists from — the menu does not decide permissions, it mirrors
 * them, so an entry is shown exactly when its page's data would load. An entry
 * with no `roles` is one whose list endpoint names none (any signed-in office
 * account may call it). A shop never reaches this menu: the office login
 * refuses SHOP_OWNER_PORTAL with USE_PORTAL_LOGIN, and the API's SurfaceGuard
 * refuses a portal token on every office route.
 *
 * When a controller's `@Roles` changes, the entry here changes with it.
 */
const BOOKS_READERS = ['CORE_PARTNER', 'ADMIN_SUPPORT'] as const;

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    key: 'overview',
    items: [
      // Every role: an investor's dashboard shows their own cycles'
      // profitability (GET /analytics/cycle-profitability, scoped) in place of
      // the business-wide figures they may not read.
      { key: 'dashboard', href: '/dashboard' },
      // GET /analytics/revenue-by-month — @Roles(CORE_PARTNER, ADMIN_SUPPORT)
      { key: 'analytics', href: '/analytics', roles: BOOKS_READERS },
    ],
  },
  {
    key: 'importing',
    items: [
      // Purchases and shipments are tabs of Cycles: every one belongs to a
      // cycle (owner, 2026-10-18; lib/page-views.ts).
      { key: 'cycles', href: '/cycles' },
      // Suppliers, who the goods are bought from, with the shipping providers
      // who move them as a second tab.
      { key: 'suppliers', href: '/suppliers' },
    ],
  },
  {
    key: 'catalogue',
    items: [
      // Categories are a tab of Products: they exist only to group them.
      { key: 'products', href: '/products' },
      { key: 'inventory', href: '/inventory' },
    ],
  },
  {
    key: 'selling',
    items: [
      // First in this group on purpose: every pending request is holding stock
      // on a clock, so it is the one thing here that goes stale if it waits.
      // Order requests and import requests are two tabs of one page (owner,
      // 2026-10-17): the same conversation from the shop's side — one asks for
      // what is on the shelf, the other for what is not. Hidden in production
      // for now (`feature`, lib/features.ts).
      // GET /order-requests/pending and GET /import-requests — both
      // @Roles(CORE_PARTNER, ADMIN_SUPPORT)
      { key: 'requests', href: '/requests', roles: BOOKS_READERS, feature: 'requests' },
      // GET /sales/orders — @Roles(CORE_PARTNER, ADMIN_SUPPORT) on the controller
      { key: 'sales', href: '/sales', roles: BOOKS_READERS },
      // GET /customers — @Roles(CORE_PARTNER, ADMIN_SUPPORT) since R1
      { key: 'customers', href: '/customers', roles: BOOKS_READERS },
    ],
  },
  {
    key: 'money',
    items: [
      // GET /payments — @Roles(CORE_PARTNER, ADMIN_SUPPORT) on the controller
      { key: 'payments', href: '/payments', roles: BOOKS_READERS },
      // Contracts are a tab of Payments (`/payments?view=contracts`, owner
      // 2026-10-16, renamed from Instalment plans 2026-10-17), not an entry of their own.
      // GET /lenders — @Roles(CORE_PARTNER, ADMIN_SUPPORT) (§18)
      { key: 'lenders', href: '/lenders', roles: BOOKS_READERS },
      // GET /ledger — @Roles(CORE_PARTNER, ADMIN_SUPPORT) on the controller
      { key: 'ledger', href: '/ledger', roles: BOOKS_READERS },
    ],
  },
  {
    key: 'partners',
    items: [
      // Partners, with Settlements as a tab (owner, 2026-10-18).
      // GET /users/participation — @Roles(CORE_PARTNER, ADMIN_SUPPORT)
      { key: 'partners', href: '/partners', roles: BOOKS_READERS },
    ],
  },
];

/** Pinned to the foot of the sidebar — reached occasionally, not part of the
 *  daily flow, and better out of the way than padding the list above. */
export const SYSTEM_ITEMS: readonly NavItem[] = [
  // Exchange rates and the audit log are tabs of Settings (owner, 2026-10-18);
  // notifications open from the bell in the top bar.
  { key: 'settings', href: '/settings' },
];

/**
 * The five places a phone reaches in one tap, in this order; everything else
 * is under "More". They are the daily flow on a phone: look at the day, sell,
 * see who owes, check the shelf, follow the shipments.
 */
export const PHONE_BAR_KEYS = ['dashboard', 'sales', 'customers', 'inventory', 'cycles'] as const;

/** An entry with no `feature` is always on; one with a feature needs it passed. */
export function isSwitchedOn(item: NavItem, features: readonly Feature[]): boolean {
  return !item.feature || features.includes(item.feature);
}

export function canSee(item: NavItem, role: string | undefined): boolean {
  if (!item.roles) return true;
  return role !== undefined && item.roles.includes(role);
}

/** The menu a role sees: entries it may not open are dropped, and a group
 *  left with nothing in it goes too rather than showing a bare heading. */
export function navForRole(
  role: string | undefined,
  groups: readonly NavGroup[] = NAV_GROUPS,
  features: readonly Feature[] = [],
): NavGroup[] {
  return groups
    .map((g) => ({
      key: g.key,
      items: g.items.filter((i) => canSee(i, role) && isSwitchedOn(i, features)),
    }))
    .filter((g) => g.items.length > 0);
}

export function systemForRole(
  role: string | undefined,
  items: readonly NavItem[] = SYSTEM_ITEMS,
): NavItem[] {
  return items.filter((i) => canSee(i, role));
}

/**
 * The phone bar's entries, taken from the role's own menu so the bar can never
 * offer a page the sidebar hides. An entry the role cannot see leaves a gap
 * that closes up, rather than being swapped for some other page.
 */
export function phoneBarItems(
  role: string | undefined,
  groups: readonly NavGroup[] = NAV_GROUPS,
  features: readonly Feature[] = [],
): NavItem[] {
  const visible = new Map(navForRole(role, groups, features).flatMap((g) => g.items.map((i) => [i.key, i])));
  return PHONE_BAR_KEYS.flatMap((k) => {
    const item = visible.get(k);
    return item ? [item] : [];
  });
}

/**
 * Match on a whole path segment. A plain `includes` would light up two entries
 * as soon as one route's path appeared inside another's.
 */
export function isActiveHref(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** "More" is lit when the page is somewhere the bar does not reach itself. */
export function isMoreActive(pathname: string, barItems: readonly NavItem[]) {
  return !barItems.some((i) => isActiveHref(pathname, i.href));
}
