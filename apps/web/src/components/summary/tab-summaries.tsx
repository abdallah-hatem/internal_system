'use client';

import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Money } from '@/components/ui/money';
import { SummaryStrip, SUMMARY_MAX, type SummaryCard } from '@/components/ui/summary-strip';
import { mostProfitableCycles, topSoldProducts } from '@/components/analytics/analytics-top';
import { useLocalName } from '@/lib/localized-name';
import { useNumberFormat } from '@/lib/numbers';

/**
 * The summary at the top of Cycles, Products and Sales (owner 2026-10-18).
 * Each reads the endpoint Analytics already reads — cycle profitability, top
 * products, top orders — and picks with Analytics' own rules
 * (`analytics-top.ts`), so a figure here is the figure there (rule 11).
 */

/** One line of GET /analytics/cycle-profitability. */
export interface CycleProfitRow {
  cycleId: string;
  cycleCode: string;
  profit: number;
  roiPct: number | null;
}

/** One line of GET /analytics/top-products. */
export interface TopProductRow {
  productId: string;
  name: string;
  nameAr?: string | null;
  totalQuantitySold: number;
  revenueEgp: number;
}

/** One side of GET /analytics/top-orders. */
export interface TopOrder {
  orderId: string;
  orderNo: string;
  customer: { id: string; displayName: string; isWalkIn?: boolean } | null;
  revenueEgp: number;
  units: number;
  lines: number;
}
export interface TopOrders {
  mostRevenue: TopOrder | null;
  mostUnits: TopOrder | null;
}

/** The API's `{ data }` envelope, unwrapped as the other screens do. */
const rows = <T,>(r: { data: { data?: unknown } }) => (r.data.data ?? r.data) as T;
const UNITS = { maximumFractionDigits: 3 } as const;

/**
 * The three most profitable cycles. A cycle that has not made money is not
 * "top-earning", so a loss or a zero never takes a card (GUESS, as the
 * zero-sales rule on Top products).
 */
export function topEarningCycles<T extends CycleProfitRow>(list: readonly T[]): T[] {
  return mostProfitableCycles(list.filter((c) => c.profit > 0)).slice(0, SUMMARY_MAX);
}

/** Cycles: the most profitable, from the list's own profitability query (same key, one request). */
export function CyclesSummary() {
  const t = useTranslations('tabSummary');
  const { formatNumber } = useNumberFormat();
  const { data, isLoading } = useQuery({
    queryKey: ['analytics', 'cycle-profitability'],
    queryFn: () => api.get('/analytics/cycle-profitability').then(rows<CycleProfitRow[]>),
  });
  const cards: SummaryCard[] = topEarningCycles(Array.isArray(data) ? data : []).map((c, i) => ({
    key: c.cycleId,
    label: t('cycleRank', { rank: formatNumber(i + 1) }),
    subject: c.cycleCode,
    value: <Money value={c.profit} className="text-success" />,
    sub: c.roiPct == null ? undefined : t('roi', { pct: formatNumber(c.roiPct, { maximumFractionDigits: 1 }) }),
    href: `/cycles/${c.cycleId}/details`,
  }));
  return <SummaryStrip cards={cards} isLoading={isLoading} label={t('cyclesLabel')} testId="cycles-summary" />;
}

/** Products: the best sellers by units, as the dashboard's default ranking. */
export function ProductsSummary() {
  const t = useTranslations('tabSummary');
  const name = useLocalName();
  const { formatNumber } = useNumberFormat();
  const { data, isLoading } = useQuery({
    queryKey: ['analytics', 'top-products', 'summary'],
    queryFn: () =>
      api.get(`/analytics/top-products?limit=${SUMMARY_MAX}&by=units`).then(rows<TopProductRow[]>),
  });
  const top = topSoldProducts(Array.isArray(data) ? data : []).slice(0, SUMMARY_MAX);
  const cards: SummaryCard[] = top.map((p, i) => ({
    key: p.productId,
    label: t('productRank', { rank: formatNumber(i + 1) }),
    subject: name(p),
    value: t('unitsSold', { units: formatNumber(p.totalQuantitySold, UNITS) }),
    sub: <Money value={p.revenueEgp} />,
    href: `/products/${p.productId}`,
  }));
  return <SummaryStrip cards={cards} isLoading={isLoading} label={t('productsLabel')} testId="products-summary" />;
}

/**
 * Sales: the sale that brought in the most and the one that sent out the
 * most units, all time. Under the `sales` key so every change to a sale
 * (confirm, cancel, return) refreshes it with the list.
 */
export function SalesSummary({ onOpen }: { onOpen: (orderId: string) => void }) {
  const t = useTranslations('tabSummary');
  const ts = useTranslations('sales');
  const { formatNumber } = useNumberFormat();
  const { data, isLoading } = useQuery({
    queryKey: ['sales', 'top-orders'],
    queryFn: () => api.get('/analytics/top-orders').then(rows<TopOrders>),
  });
  const buyer = (o: TopOrder) => (o.customer?.isWalkIn ? ts('walkInCustomer') : o.customer?.displayName ?? '—');
  const cards: SummaryCard[] = [];
  if (data?.mostRevenue) {
    const o = data.mostRevenue;
    cards.push({
      key: 'most-revenue',
      label: t('mostRevenue'),
      subject: o.orderNo,
      value: <Money value={o.revenueEgp} />,
      sub: <bdi>{buyer(o)}</bdi>,
      onClick: () => onOpen(o.orderId),
    });
  }
  if (data?.mostUnits) {
    const o = data.mostUnits;
    cards.push({
      key: 'most-units',
      label: t('mostUnits'),
      subject: o.orderNo,
      value: t('units', { units: formatNumber(o.units, UNITS) }),
      sub: t('lines', { count: o.lines, lines: formatNumber(o.lines) }),
      onClick: () => onOpen(o.orderId),
    });
  }
  return (
    <SummaryStrip cards={cards} isLoading={isLoading} label={t('salesLabel')} testId="sales-summary" skeletonCount={2} />
  );
}
