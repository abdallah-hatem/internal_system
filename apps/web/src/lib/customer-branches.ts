'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/**
 * A customer's branches (BUSINESS_LOGIC §7, owner 2026-10-25): one owner pays
 * for all of them; each has its own orders, balance and statement. Read from
 * `GET /customers/:id/branches`, which also says what is owed on no branch and
 * in total, so the page never adds money up itself.
 */
export interface CustomerBranch {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  isDefault: boolean;
  archivedAt: string | null;
  orderCount: number;
  /** What its confirmed orders still owe, "0.00" when nothing. */
  owed: string;
}

export interface CustomerBranches {
  branches: CustomerBranch[];
  /** Branches that can take an order: not archived. */
  open: CustomerBranch[];
  /** Where an order goes when none is picked — the server's rule too. */
  defaultBranch: CustomerBranch | null;
  noBranchOwed: string;
  totalOwed: string;
  isLoading: boolean;
}

/** The query key, so a change can refresh every reader of it. */
export const branchesKey = (customerId: string | undefined) => ['customerBranches', customerId];

/** Branches when the customer has any; an empty list for none or no customer. */
export function useCustomerBranches(customerId: string | undefined): CustomerBranches {
  const { data, isLoading } = useQuery<{
    data: CustomerBranch[];
    meta: { noBranchOwed: string; totalOwed: string };
  }>({
    queryKey: branchesKey(customerId),
    queryFn: () => api.get(`/customers/${customerId}/branches`).then((r) => r.data),
    enabled: !!customerId,
  });
  const branches = data?.data ?? [];
  const open = branches.filter((b) => !b.archivedAt);
  return {
    branches,
    open,
    defaultBranch: open.find((b) => b.isDefault) ?? null,
    noBranchOwed: data?.meta.noBranchOwed ?? '0.00',
    totalOwed: data?.meta.totalOwed ?? '0.00',
    isLoading: !!customerId && isLoading,
  };
}
