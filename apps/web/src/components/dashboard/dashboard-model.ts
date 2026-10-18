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
  | 'cogs'
  | 'expenses'
  | 'netProfit'
  | 'cashOut'
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
  cogs: { href: '/analytics', roles: SELLING_ROLES },
  expenses: { href: '/ledger', roles: SELLING_ROLES },
  netProfit: { href: '/analytics', roles: SELLING_ROLES },
  cashOut: { href: '/ledger', roles: SELLING_ROLES },
  cashOnHand: { href: '/ledger', roles: SELLING_ROLES },
  activeCycles: { href: '/cycles' },
  inventoryValue: { href: '/inventory' },
  unitsInStock: { href: '/inventory' },
  lowStockAlerts: { href: '/inventory?stock=low' },
  // GET /lenders — @Roles(CORE_PARTNER, ADMIN_SUPPORT) (§18)
  owedToLenders: { href: '/lenders', roles: SELLING_ROLES },
};

/**
 * The figures a phone shows before "See more" (owner 2026-10-18): what was
 * sold, collected and is owed, the profit, the cash, the stock's worth — three
 * rows. The rest are a tap away; a wider screen shows every tile.
 */
export const PHONE_FIRST_TILES: readonly TileKey[] = [
  'revenue',
  'collected',
  'receivables',
  'netProfit',
  'cashOnHand',
  'inventoryValue',
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
 * Which dashboard a role gets (R1, owner 2026-10-10).
 *
 *   'business' — the figures, top products and who to collect from: the API's
 *                /analytics/dashboard and /top-products let these roles in.
 *   'cycles'   — a temporary investor, or any role the business-wide reads
 *                refuse: their own cycles' profitability, which the API scopes.
 *   'loading'  — the role is not known yet, so nothing is fetched; fetching
 *                the business figures first would put a 403 in front of an
 *                investor on every visit.
 */
export function dashboardView(role: string | undefined): 'business' | 'cycles' | 'loading' {
  if (role === undefined) return 'loading';
  return allows(SELLING_ROLES, role) ? 'business' : 'cycles';
}
