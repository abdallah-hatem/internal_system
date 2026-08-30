'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { isAxiosError } from 'axios';

import { api } from '../../lib/api';
import type { CataloguePage, Category, ProductDetail } from './types';

/**
 * Every read the catalogue screens make.
 *
 * Client-side on purpose: the token lives in `localStorage`, and a price
 * fetched on the server would be the anonymous one. A signed-in shop shown
 * retail is not a missing feature, it is the wrong number.
 */

const PAGE_SIZE = 24;

/** A 404 from the API — a SKU that was never there, or has been withdrawn. */
export function isNotFound(error: unknown): boolean {
  return isAxiosError(error) && error.response?.status === 404;
}

export function useCatalogue(search: string, categoryId: string) {
  return useInfiniteQuery({
    queryKey: ['catalogue', 'list', { search, categoryId }],
    initialPageParam: 1,
    queryFn: async ({ pageParam }) => {
      const { data } = await api.get<{ data: CataloguePage }>('/portal/catalogue', {
        // Axios drops undefined params, so an empty filter is an absent one
        // rather than `?search=`, which the API would treat as a search for "".
        params: {
          search: search || undefined,
          categoryId: categoryId || undefined,
          page: pageParam,
          limit: PAGE_SIZE,
        },
      });
      return data.data;
    },
    getNextPageParam: (last) => (last.page < last.totalPages ? last.page + 1 : undefined),
  });
}

export function useCategories() {
  return useQuery({
    queryKey: ['catalogue', 'categories'],
    queryFn: async () => {
      const { data } = await api.get<{ data: Category[] }>('/portal/categories');
      return data.data;
    },
    // The filter list changes on the scale of weeks, not of a browsing session.
    staleTime: 5 * 60_000,
  });
}

export function useProduct(sku: string) {
  return useQuery({
    queryKey: ['catalogue', 'product', sku],
    queryFn: async () => {
      const { data } = await api.get<{ data: ProductDetail }>(
        `/portal/catalogue/${encodeURIComponent(sku)}`,
      );
      return data.data;
    },
    // A withdrawn SKU is not a blip on the network. Retrying it only delays
    // the 404 page by a round trip.
    retry: (failureCount, error) => !isNotFound(error) && failureCount < 1,
  });
}
