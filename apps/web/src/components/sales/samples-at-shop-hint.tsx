'use client';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Check, PackageOpen, Plus } from '@/components/ui/icons';
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

/** One product a shop holds on one samples order. */
export type ShopSampleLine = ShopSamplesOrder['lines'][number];

/**
 * The hint above New Order's lines, and under a record_sale preview in the
 * office chat: "This shop holds 1 Helmet as a sample", per open samples
 * order, with the way to that order's "They're buying" — a button in the form
 * (`onOpen`), a link from the chat (`href`). Amber, the colour of "not a sale
 * yet". It never disables anything.
 *
 * In New Order (`onAdd`, owner 2026-10-27, "Samples into the current order")
 * it is also a list per product with **Add to order**, and **Add all**: the
 * line it adds is tagged with the samples order and edits like any line; on
 * confirm the server moves those units into the sale. A product already on
 * the order reads "Added".
 */
export function SamplesAtShopHint({
  orders,
  onOpen,
  href,
  onAdd,
  onAddAll,
  isAdded,
}: {
  orders: ShopSamplesOrder[] | undefined;
  onOpen?: (order: ShopSamplesOrder) => void;
  href?: (order: ShopSamplesOrder) => string;
  onAdd?: (order: ShopSamplesOrder, line: ShopSampleLine) => void;
  onAddAll?: () => void;
  isAdded?: (orderId: string, productId: string) => boolean;
}) {
  const t = useTranslations('sales.samples');
  const locale = useLocale();
  const { formatNumber } = useNumberFormat();
  const { formatDate } = useDateFormat();
  if (!orders?.length) return null;
  const list = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' });
  const linkClass =
    'mt-1 inline-flex min-h-11 cursor-pointer items-center text-sm font-medium text-accent-900 underline underline-offset-2 hover:text-accent-700 sm:min-h-0';
  const addClass =
    'inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-1 rounded-lg border border-accent-400 bg-background px-3 py-1 text-xs font-medium text-accent-900 hover:bg-accent-100 disabled:cursor-default disabled:border-transparent disabled:bg-transparent disabled:opacity-80 sm:min-h-0';
  const anyLeft = orders.some((o) => o.lines.some((l) => !isAdded?.(o.id, l.productId)));

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
              {onAdd && (
                <ul className="mt-1.5 space-y-1.5">
                  {order.lines.map((l) => {
                    const added = !!isAdded?.(order.id, l.productId);
                    return (
                      <li
                        key={l.productId}
                        data-testid="samples-at-shop-line"
                        data-product-id={l.productId}
                        className="flex min-w-0 items-center justify-between gap-2"
                      >
                        <span className="min-w-0 break-words">
                          {t('holdsLine', { units: formatNumber(Number(l.units)), product: localName(l, locale) })}
                        </span>
                        <button
                          type="button"
                          data-testid="samples-at-shop-add"
                          disabled={added}
                          onClick={() => onAdd(order, l)}
                          className={addClass}
                        >
                          {added ? (
                            <Check className="h-3.5 w-3.5" aria-hidden />
                          ) : (
                            <Plus className="h-3.5 w-3.5" aria-hidden />
                          )}
                          {added ? t('added') : t('addToOrder')}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
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
        {onAdd && onAddAll && anyLeft && (
          <button type="button" data-testid="samples-at-shop-add-all" onClick={onAddAll} className={addClass}>
            <Plus className="h-3.5 w-3.5" aria-hidden />
            {t('addAll')}
          </button>
        )}
        <p className="text-xs">{onAdd ? t('holdsAddHint') : t('holdsHint')}</p>
      </div>
    </div>
  );
}
