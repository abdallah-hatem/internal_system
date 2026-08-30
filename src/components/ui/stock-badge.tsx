'use client';

import { useTranslations } from 'next-intl';

export type StockBand = 'IN_STOCK' | 'LOW' | 'OUT';

/**
 * How much there is, without saying how much there is.
 *
 * A band, never a count. A public page reading "12 left" tells a competitor the
 * exact position, and a shop needs only to know whether it is worth asking.
 * The API sends the band already decided, so there is no threshold in the
 * browser that could disagree with the one on the server.
 */
export function StockBadge({ stock }: { stock: StockBand }) {
  const t = useTranslations('catalogue');

  const style = {
    IN_STOCK: 'bg-green-50 text-green-700 ring-green-600/20',
    LOW: 'bg-amber-50 text-amber-800 ring-amber-600/20',
    OUT: 'bg-gray-100 text-gray-500 ring-gray-500/20',
  }[stock];

  const label = { IN_STOCK: t('inStock'), LOW: t('low'), OUT: t('out') }[stock];

  return (
    <span
      data-stock={stock}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${style}`}
    >
      {label}
    </span>
  );
}
