/**
 * Where each dashboard figure leads, and which role may act from it — one
 * definition the page, its components and the tests all read (rule 11).
 *
 * The roles mirror the API's guards, not a guess: a link or a button the API
 * would refuse is a dead end with a 403 at the bottom of it (rule 12). If a
 * guard changes, change the matching list here.
 *
 *   sales, payments, ledger, recent activity → CORE_PARTNER, ADMIN_SUPPORT
 *   creating a cycle                          → CORE_PARTNER
 *   customers, inventory, cycles, analytics   → any signed-in role
 */

/** May list and record sales and payments, read the ledger and the activity feed. */
export const SELLING_ROLES = ['CORE_PARTNER', 'ADMIN_SUPPORT'] as const;
/** May start a cycle. */
export const CYCLE_ROLES = ['CORE_PARTNER'] as const;

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
  | 'lowStockAlerts';

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
  receivables: { href: '/customers?sort=balance' },
  cogs: { href: '/analytics' },
  expenses: { href: '/ledger', roles: SELLING_ROLES },
  netProfit: { href: '/analytics' },
  cashOut: { href: '/ledger', roles: SELLING_ROLES },
  cashOnHand: { href: '/ledger', roles: SELLING_ROLES },
  activeCycles: { href: '/cycles' },
  inventoryValue: { href: '/inventory' },
  lowStockAlerts: { href: '/inventory?stock=low' },
};

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

export function canSeeRecentActivity(role: string | undefined): boolean {
  return allows(SELLING_ROLES, role);
}
