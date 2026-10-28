import type { Prisma } from '@prisma/client';
import { filterOf, searchOf, type ListQuery } from '../../common/list-query';
import { assertUuid } from '../../common/uuid';
import { bilingualProductSearch } from '../../common/arabic-names';

/** The Products list's own filters, beside the search every list reads. */
export interface ProductListFilters extends ListQuery {
  categoryId?: unknown;
  status?: unknown;
}

/** The Products list's status filter: INACTIVE is anything not on (§3). */
export const PRODUCT_STATUS_FILTERS = ['ACTIVE', 'INACTIVE'] as const;

/**
 * Which products the Products list's search, category and status match — the
 * one `where` for that list (CLAUDE.md §11). The table's rows, its count and
 * the cards above it (`GET /products/summary`, owner 2026-10-28) all read it,
 * so the cards cannot count a different set from the one the table pages.
 *
 * - `categoryId`: that category only — its subcategories are not included,
 *   as the table has filtered since it moved to the server (2026-10-25).
 * - `status`: ACTIVE, INACTIVE (anything not on), or absent for all.
 * - `search`: either language and the SKU (§3, `bilingualProductSearch`).
 *
 * A value the list does not offer is refused here, with the list's codes.
 */
export function productListWhere(
  query: ProductListFilters,
): Prisma.ProductWhereInput {
  const where: Prisma.ProductWhereInput = {};
  const { categoryId } = query;
  if (categoryId !== undefined && categoryId !== null && categoryId !== '') {
    assertUuid(categoryId, 'categoryId');
    where.categoryId = categoryId;
  }
  const status = filterOf(query.status, 'status', PRODUCT_STATUS_FILTERS);
  if (status === 'ACTIVE') where.status = 'ACTIVE';
  if (status === 'INACTIVE') where.status = { not: 'ACTIVE' };
  // Either language, and the SKU (§3, owner 2026-10-14): "تيل" finds the
  // brake pads whose Arabic name says so, and "خوذه" the "خوذة" (2026-10-15).
  const search = searchOf(query);
  if (search) where.OR = bilingualProductSearch(search);
  return where;
}
