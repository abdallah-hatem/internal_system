'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { PackageOpen } from '@/components/ui/icons';
import { api } from '@/lib/api';
import { useDateFormat } from '@/lib/dates';
import { localName } from '@/lib/localized-name';
import { useNumberFormat } from '@/lib/numbers';

/**
 * What a shop holds as samples (BUSINESS_LOGIC §4, "New Order warns when the
 * shop holds samples", owner 2026-10-25), as `GET /sales/orders/samples-at-shop`
 * sends it: the shop's open samples orders, oldest first, each product on it
 * and its units. The API reads it from the same draws as Inventory's "At
 * shops" and the settlement gate, so nothing here works it out again.
 */
export interface ShopSamplesOrder {
  id: string;
  orderNo: string;
  leftOn: string | null;
  lines: { productId: string; name: string; nameAr: string | null; sku: string; units: string }[];
}

/**
 * The shop's open samples, for New Order. Under `sales` so every save that
 * refreshes the sales list — samples left, bought, returned, written off —
 * refreshes this too. Never kept once nothing shows it (`gcTime: 0`): a shop
 * picked again, or the form opened again, reads it afresh rather than showing
 * the last answer while the new one loads — a stale hint would name samples
 * the shop has since bought.
 */
export function useSamplesAtShop(customerId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['sales', 'samples-at-shop', customerId],
    queryFn: () =>
      api
        .get('/sales/orders/samples-at-shop', { params: { customerId } })
        .then((r) => (r.data?.data ?? r.data) as ShopSamplesOrder[]),
    enabled: enabled && !!customerId,
    staleTime: 0,
    gcTime: 0,
  });
}

/**
 * The hint above New Order's lines, and under a record_sale preview in the
 * office chat: "This shop holds 1 Helmet as a sample", per open samples
 * order, with the way to that order's "They're buying" — a button in the form
 * (`onOpen`), a link from the chat (`href`). Amber, the colour of "not a sale
 * yet". A hint only: it holds no state the form submits and never disables
 * anything.
 */
export function SamplesAtShopHint({
  orders,
  onOpen,
  href,
}: {
  orders: ShopSamplesOrder[] | undefined;
  onOpen?: (order: ShopSamplesOrder) => void;
  href?: (order: ShopSamplesOrder) => string;
}) {
  const t = useTranslations('sales.samples');
  const locale = useLocale();
  const { formatNumber } = useNumberFormat();
  const { formatDate } = useDateFormat();
  if (!orders?.length) return null;
  const list = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' });
  const linkClass =
    'mt-1 inline-flex min-h-11 cursor-pointer items-center text-sm font-medium text-accent-900 underline underline-offset-2 hover:text-accent-700 sm:min-h-0';

  return (
    <div
      role="note"
      data-testid="samples-at-shop-hint"
      className="flex items-start gap-2 rounded-lg border border-accent-300 bg-accent-50 px-3 py-2.5 text-sm text-accent-900"
    >
      <PackageOpen className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 space-y-2">
        {orders.map((order) => {
          const units = order.lines.reduce((s, l) => s + Number(l.units), 0);
          const items = list.format(
            order.lines.map((l) => `${formatNumber(Number(l.units))} ${localName(l, locale)}`),
          );
          return (
            <div key={order.id} data-testid="samples-at-shop-order" data-order-no={order.orderNo}>
              <p>
                {t('holds', {
                  items,
                  units,
                  orderNo: order.orderNo,
                  date: formatDate(order.leftOn),
                })}
              </p>
              {onOpen ? (
                <button
                  type="button"
                  data-testid="samples-at-shop-open"
                  onClick={() => onOpen(order)}
                  className={linkClass}
                >
                  {t('holdsOpen', { orderNo: order.orderNo })}
                </button>
              ) : href ? (
                <Link href={href(order)} data-testid="samples-at-shop-open" className={linkClass}>
                  {t('holdsOpen', { orderNo: order.orderNo })}
                </Link>
              ) : null}
            </div>
          );
        })}
        <p className="text-xs">{t('holdsHint')}</p>
      </div>
    </div>
  );
}
