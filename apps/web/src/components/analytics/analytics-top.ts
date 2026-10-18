/**
 * How many rows Analytics' Top products and Cycle profitability each show
 * (owner 2026-10-19: "show only top 5"). BUSINESS_LOGIC, Analytics.
 */
export const ANALYTICS_TOP = 5;

/**
 * The products to show, in the API's order (it ranks by the switch that is
 * on). A product that sold nothing, net of returns, is not a top product:
 * the API lists every active product, so with few sales "Brake Pad Set
 * 0 / 0.00 EGP" took a place.
 */
export function topSoldProducts<T extends { totalQuantitySold: number }>(rows: readonly T[]): T[] {
  return rows.filter((p) => p.totalQuantitySold > 0).slice(0, ANALYTICS_TOP);
}

/**
 * The most profitable cycles, highest profit first, equal profit by code.
 * The API sends cycles in code order and other screens (the dashboard, a
 * cycle's own page) read that full list, so the ranking is done here.
 */
export function mostProfitableCycles<T extends { cycleCode: string; profit: number }>(rows: readonly T[]): T[] {
  return [...rows]
    .sort((a, b) => b.profit - a.profit || a.cycleCode.localeCompare(b.cycleCode))
    .slice(0, ANALYTICS_TOP);
}
