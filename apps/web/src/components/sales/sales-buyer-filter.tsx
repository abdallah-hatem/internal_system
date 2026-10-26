'use client';

import { useTranslations } from 'next-intl';
import { Select, type SelectOption } from '@/components/ui/select';

/** The customer filter's choice for the walk-in buyer (the API's `WALK_IN_FILTER`). */
export const WALK_IN_FILTER = 'walk-in';

/**
 * The Sales list's customer filter (owner 2026-10-25): a searchable customer
 * picker, the walk-in buyer its own choice. It lives in the URL
 * (`?customer=`) and the API filters on it (`customerId`).
 */
export function SalesBuyerFilter({
  customers,
  customer,
  onChange,
}: {
  customers: { id: string; displayName: string }[];
  customer: string;
  onChange: (changes: { customer: string | null }) => void;
}) {
  const t = useTranslations('sales');
  const tph = useTranslations('placeholders');

  const customerOptions: SelectOption[] = [
    { value: WALK_IN_FILTER, label: t('walkInCustomer') },
    ...customers.map((c) => ({ value: c.id, label: c.displayName })),
  ];

  return (
    // One shop's orders, or the walk-in buyer's.
    <div data-testid="sales-customer-filter" className="w-full sm:w-56">
      <Select
        value={customer}
        onChange={(id) => onChange({ customer: id || null })}
        clearable
        placeholder={tph('allCustomers')}
        searchPlaceholder={tph('searchCustomers')}
        options={customerOptions}
      />
    </div>
  );
}
