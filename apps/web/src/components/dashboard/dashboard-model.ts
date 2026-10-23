/**
 * Where each dashboard figure leads, and which role may act from it — one
 * definition the page, its components and the tests all read (rule 11).
 *
 * The roles mirror the API's guards, not a guess: a link or a button the API
 * would refuse is a dead end with a 403 at the bottom of it (rule 12). If a
 * guard changes, change the matching list here.
 *
 *   sales, payments, ledger                  → CORE_PARTNER, ADMIN_SUPPORT
 *   the business-wide figures, top products,
 *   customers, analytics                      → CORE_PARTNER, ADMIN_SUPPORT (R1)
 *   creating a cycle                          → CORE_PARTNER
 *   writing the ledger (the Fuel action)      → CORE_PARTNER
 *   inventory, cycles, cycle profitability    → any signed-in role, scoped by
 *                                               the API to an investor's cycles
 */

/** May list and record sales and payments, and read the ledger. */
export const SELLING_ROLES = ['CORE_PARTNER', 'ADMIN_SUPPORT'] as const;
/** May start a cycle. */
export const CYCLE_ROLES = ['CORE_PARTNER'] as const;
/** May record an expense by hand — POST /ledger. */
export const LEDGER_WRITE_ROLES = ['CORE_PARTNER'] as const;

export type TileKey =
  | 'revenue'
  | 'collected'
  | 'receivables'
  | 'expenses'
  | 'netProfit'
  | 'cashOnHand'
  | 'activeCycles'
  | 'inventoryValue'
  | 'unitsInStock'
  | 'lowStockAlerts'
  | 'owedToLenders';

export interface TileTarget {
  href: string;
  /** Absent: every signed-in role may open the list. */
  roles?: readonly string[];
}

/**
 * The list behind each figure, filtered the way the figure is labelled.
 * Receivables opens customers with the largest balance first; low stock opens
 * inventory showing only the products under their minimum.
 */
export const TILE_TARGETS: Record<TileKey, TileTarget> = {
  revenue: { href: '/sales', roles: SELLING_ROLES },
  collected: { href: '/payments', roles: SELLING_ROLES },
  receivables: { href: '/customers?sort=balance', roles: SELLING_ROLES },
  expenses: { href: '/ledger', roles: SELLING_ROLES },
  netProfit: { href: '/analytics', roles: SELLING_ROLES },
  cashOnHand: { href: '/ledger', roles: SELLING_ROLES },
  activeCycles: { href: '/cycles' },
  inventoryValue: { href: '/inventory' },
  unitsInStock: { href: '/inventory' },
  lowStockAlerts: { href: '/inventory?stock=low' },
  // GET /lenders — @Roles(CORE_PARTNER, ADMIN_SUPPORT) (§18)
  owedToLenders: { href: '/lenders', roles: SELLING_ROLES },
};

/**
 * The dashboard in two groups (owner 2026-10-23, picked from a rendered
 * sample), so no figure reads as all time when it is today's or the other way
 * round. Cost of goods sold and cash paid out left it for Analytics' profit
 * and loss.
 *
 * Right now: what the business holds, is owed and owes at this moment. A wide
 * screen lays it out as a row of four, then a row of three.
 */
export const RIGHT_NOW_TILES = [
  'cashOnHand',
  'receivables',
  'owedToLenders',
  'inventoryValue',
  'unitsInStock',
  'lowStockAlerts',
  'activeCycles',
] as const satisfies readonly TileKey[];

/**
 * This month: this calendar month in Cairo, from the API's `month` block —
 * Analytics' profit and loss This month, figure for figure (rule 11).
 */
export const THIS_MONTH_TILES = [
  'revenue',
  'collected',
  'netProfit',
  'expenses',
] as const satisfies readonly TileKey[];

/** Where the This month heading leads: Analytics' profit and loss, on This month. */
export const PNL_THIS_MONTH_HREF = '/analytics?period=month';

/**
 * The figures a phone shows before "See more": the first four of Right now and
 * all of This month. The other three Right now tiles are a tap away; a wider
 * screen shows every tile.
 */
export const PHONE_FIRST_TILES: readonly TileKey[] = [
  ...RIGHT_NOW_TILES.slice(0, 4),
  ...THIS_MONTH_TILES,
];

/**
 * The dashboard's quick actions. Fuel is not one of them (owner 2026-10-18:
 * "remove fuel from dashboard") — it lives on the Ledger page only, gated by
 * `canRecordFuel`.
 */
export type QuickActionKey = 'newSale' | 'recordPayment' | 'newCycle';

export interface QuickAction {
  key: QuickActionKey;
  /** Opens the list's own create form on arrival — no second copy of the form. */
  href: string;
  roles: readonly string[];
}

export const QUICK_ACTIONS: readonly QuickAction[] = [
  { key: 'newSale', href: '/sales?new=1', roles: SELLING_ROLES },
  { key: 'recordPayment', href: '/payments?new=1', roles: SELLING_ROLES },
  { key: 'newCycle', href: '/cycles/new', roles: CYCLE_ROLES },
];

/**
 * Whether the Ledger page's Fuel quick action shows: only a role that may write
 * the ledger (POST /ledger is core partners only) — a button it could not save
 * from would be a dead end.
 */
export function canRecordFuel(role: string | undefined): boolean {
  return allows(LEDGER_WRITE_ROLES, role);
}

export function allows(roles: readonly string[] | undefined, role: string | undefined): boolean {
  if (!roles) return true;
  return role !== undefined && roles.includes(role);
}

/** The tile's link for this role, or null when the role cannot open the list. */
export function tileHref(key: TileKey, role: string | undefined): string | null {
  const target = TILE_TARGETS[key];
  return allows(target.roles, role) ? target.href : null;
}

export function quickActionsFor(role: string | undefined): QuickAction[] {
  return QUICK_ACTIONS.filter((a) => allows(a.roles, role));
}

/**
 * Which dashboard a role gets.
 *
 *   'business' — the figures, top products and who to collect from: the API's
 *                /analytics/dashboard and /top-products let these roles in.
 *   'none'     — any other role: nothing is fetched or shown. Since 2026-10-19
 *                only the partners sign in to the office (an investor is refused
 *                at the door, OFFICE_NOT_FOR_INVESTORS), so the investor's own
 *                "your cycles" dashboard (R1) was removed as unreachable.
 *   'loading'  — the role is not known yet, so nothing is fetched.
 */
export function dashboardView(role: string | undefined): 'business' | 'none' | 'loading' {
  if (role === undefined) return 'loading';
  return allows(SELLING_ROLES, role) ? 'business' : 'none';
}
