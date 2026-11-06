'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Select } from '@/components/ui/select';
import { useNumberFormat } from '@/lib/numbers';

/** The order as the return dialog has it, from the sale's detail. */
export interface ReturnableOrder {
  outstanding: number | string;
  currency?: string;
  customer?: { isWalkIn?: boolean } | null;
  items?: {
    id: string;
    quantity: number | string;
    lineTotal?: number | string;
    priceCut?: boolean;
    unitPriceNow?: string;
  }[];
}

/**
 * What the return is worth, as the API refunds it: each unit at the price the
 * shop holds it at — the last price cut's, or the line's total over its
 * quantity (common/held-price.ts) — summed, then rounded to the cent.
 */
export function returnRefund(order: ReturnableOrder, qty: Record<string, string>): number {
  const total = (order.items ?? []).reduce((sum, it) => {
    const back = Number(qty[it.id] ?? 0);
    if (!(back > 0)) return sum;
    const sold = Number(it.quantity);
    const unit = it.priceCut ? Number(it.unitPriceNow ?? 0) : sold > 0 ? Number(it.lineTotal ?? 0) / sold : 0;
    return sum + unit * back;
  }, 0);
  return Math.round(total * 100) / 100;
}

/**
 * How a return is refunded (BUSINESS_LOGIC §5; the walk-in rule is §4).
 *
 * A walk-in has no account to hold a credit, so it is cash. A shop gets a
 * credit note by default, but a credit note can only lower what the order
 * still owes (owner 2026-11-06): ORD-2026-00016 was paid in full, returned on
 * the default credit note, and the 2,000 vanished. Once the lines picked are
 * worth more than is owed, Cash is chosen and the credit note is disabled with
 * the reason under it. The server refuses the same (RETURN_CREDIT_OVER_OWED).
 *
 * A hidden input named `refundMethod` carries the choice into the form.
 */
export function ReturnRefundMethod({
  order,
  qty,
  placeholder,
}: {
  order: ReturnableOrder;
  qty: Record<string, string>;
  placeholder?: string;
}) {
  const t = useTranslations('sales');
  const { formatMoney } = useNumberFormat();
  const [chosen, setChosen] = useState<string | null>(null);

  const walkIn = !!order.customer?.isWalkIn;
  const owed = Number(order.outstanding ?? 0);
  const creditFits = returnRefund(order, qty) <= owed;
  const method = walkIn || !creditFits ? 'CASH' : (chosen ?? 'CREDIT_NOTE');
  const blocked = !walkIn && !creditFits;
  const why = owed > 0
    ? t('creditOverOwed', { owed: formatMoney(owed, order.currency) })
    : t('creditOverOwedPaid');

  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-foreground">{t('refundMethod')}</label>
      <Select
        name="refundMethod"
        placeholder={placeholder}
        value={method}
        onChange={setChosen}
        options={[
          ...(walkIn
            ? []
            : [{ value: 'CREDIT_NOTE', label: t('creditNote'), disabled: blocked, ...(blocked ? { hint: why } : {}) }]),
          { value: 'CASH', label: t('cashRefund') },
        ]}
      />
      {blocked && (
        <p data-testid="credit-over-owed" className="mt-1 text-xs text-muted-foreground">
          {why}
        </p>
      )}
    </div>
  );
}
