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
};

export type NavGroup = { key: string; items: readonly NavItem[] };

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    key: 'overview',
    items: [
      { key: 'dashboard', href: '/dashboard' },
      { key: 'analytics', href: '/analytics' },
    ],
  },
  {
    key: 'importing',
    items: [
      { key: 'cycles', href: '/cycles' },
      { key: 'purchases', href: '/purchases' },
      // Suppliers sit with purchases — they are who the goods are bought from,
      // as distinct from providers below, who move them.
      { key: 'suppliers', href: '/suppliers' },
      { key: 'shipments', href: '/shipments' },
      // Providers are the shipping companies, so they belong beside the
      // shipments rather than with suppliers.
      { key: 'providers', href: '/providers' },
    ],
  },
  {
    key: 'catalogue',
    items: [
      { key: 'products', href: '/products' },
      { key: 'categories', href: '/categories' },
      { key: 'inventory', href: '/inventory' },
    ],
  },
  {
    key: 'selling',
    items: [
      // First in this group on purpose: every pending request is holding stock
      // on a clock, so it is the one thing here that goes stale if it waits.
      { key: 'orderRequests', href: '/order-requests' },
      // Beside order requests, because they are the same conversation from the
      // shop's side: one asks for what is on the shelf, the other for what is
      // not.
      { key: 'importRequests', href: '/import-requests' },
      { key: 'sales', href: '/sales' },
      { key: 'customers', href: '/customers' },
    ],
  },
  {
    key: 'money',
    items: [
      { key: 'payments', href: '/payments' },
      { key: 'paymentPlans', href: '/payment-plans' },
      { key: 'ledger', href: '/ledger' },
    ],
  },
  {
    key: 'partners',
    items: [
      { key: 'partners', href: '/partners' },
      { key: 'settlements', href: '/settlements' },
    ],
  },
];

/** Pinned to the foot of the sidebar — reached occasionally, not part of the
 *  daily flow, and better out of the way than padding the list above. */
export const SYSTEM_ITEMS: readonly NavItem[] = [
  { key: 'notifications', href: '/notifications' },
  { key: 'auditLogs', href: '/audit-logs' },
  { key: 'settings', href: '/settings' },
];

/**
 * The five places a phone reaches in one tap, in this order; everything else
 * is under "More". They are the daily flow on a phone: look at the day, sell,
 * see who owes, check the shelf, follow the shipments.
 */
export const PHONE_BAR_KEYS = ['dashboard', 'sales', 'customers', 'inventory', 'cycles'] as const;

export function canSee(item: NavItem, role: string | undefined): boolean {
  if (!item.roles) return true;
  return role !== undefined && item.roles.includes(role);
}

/** The menu a role sees: entries it may not open are dropped, and a group
 *  left with nothing in it goes too rather than showing a bare heading. */
export function navForRole(
  role: string | undefined,
  groups: readonly NavGroup[] = NAV_GROUPS,
): NavGroup[] {
  return groups
    .map((g) => ({ key: g.key, items: g.items.filter((i) => canSee(i, role)) }))
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
): NavItem[] {
  const visible = new Map(navForRole(role, groups).flatMap((g) => g.items.map((i) => [i.key, i])));
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
