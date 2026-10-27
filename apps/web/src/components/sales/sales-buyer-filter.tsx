'use client';

import { useTranslations } from 'next-intl';
import { Select, type SelectOption } from '@/components/ui/select';
import { NO_BRANCH } from '@/components/customers/customer-branches';
import { useCustomerBranches } from '@/lib/customer-branches';

/** The customer filter's choice for the walk-in buyer (the API's `WALK_IN_FILTER`). */
export const WALK_IN_FILTER = 'walk-in';

/**
 * The Sales list's buyer filters (owner 2026-10-25): a searchable customer
 * picker, the walk-in buyer its own choice, and — once a customer with
 * branches is picked — its branches, with "On the owner" for its orders on no
 * branch (§7). Both live in the URL (`?customer=`, `?branch=`) and the API
 * filters on them (`customerId`, `branchId`).
 *
 * A branch belongs to one customer, so picking another customer, or clearing
 * it, takes the branch off in the same change: the API refuses another
 * customer's branch, and a list narrowed to one would show its refusal.
 */
export function SalesBuyerFilter({
  customers,
  customer,
  branch,
  onChange,
}: {
  customers: { id: string; displayName: string }[];
  customer: string;
  branch: string;
  onChange: (changes: { customer?: string | null; branch: string | null }) => void;
}) {
  const t = useTranslations('sales');
  const tph = useTranslations('placeholders');
  const tb = useTranslations('branches');
  const shop = customer && customer !== WALK_IN_FILTER ? customer : undefined;
  const { branches } = useCustomerBranches(shop);

  const customerOptions: SelectOption[] = [
    { value: WALK_IN_FILTER, label: t('walkInCustomer') },
    ...customers.map((c) => ({ value: c.id, label: c.displayName })),
  ];
  const branchOptions: SelectOption[] = [
    ...branches.map((b) => ({ value: b.id, label: b.archivedAt ? `${b.name} (${tb('archivedTag')})` : b.name })),
    { value: NO_BRANCH, label: tb('noBranch') },
  ];

  return (
    <>
      {/* One shop's orders, or the walk-in buyer's. */}
      <div data-testid="sales-customer-filter" className="w-full sm:w-56">
        <Select
          value={customer}
          onChange={(id) => onChange({ customer: id || null, branch: null })}
          clearable
          placeholder={tph('allCustomers')}
          searchPlaceholder={tph('searchCustomers')}
          options={customerOptions}
        />
      </div>
      {/* Its branches, only for a customer that has them (§7). */}
      {shop && branches.length > 0 && (
        <div data-testid="sales-branch-filter" className="w-full sm:w-48">
          <Select
            value={branch}
            onChange={(id) => onChange({ branch: id || null })}
            clearable
            placeholder={tb('allBranches')}
            options={branchOptions}
          />
        </div>
      )}
    </>
  );
}
