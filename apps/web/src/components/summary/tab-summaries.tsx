'use client';

import { useTranslations } from 'next-intl';
import { Boxes, DollarSign, HandCoins, Package, ShoppingCart, TrendingUp, Users, Wallet } from '@/components/ui/icons';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Money } from '@/components/ui/money';
import { SummaryStrip, SUMMARY_MAX, type SummaryCard } from '@/components/ui/summary-strip';
import { mostProfitableCycles } from '@/components/analytics/analytics-top';
import { useNumberFormat } from '@/lib/numbers';
import { useDateFormat } from '@/lib/dates';
import { useCodeLabel } from '@/lib/labels';

/**
 * The summary at the top of Cycles, Products, Inventory, Sales, Customers and
 * Payments (owner 2026-10-18, reshaped 2026-10-22). Each reads an analytics
 * endpoint and shows its figures as given — cycle profitability, the
 * dashboard's product and stock counts, top orders, the customer and payment
 * summaries — so a figure here is the figure there (rule 11). Every card wears
 * the dashboard tiles' icon badge, in the dashboard's colours where it has the
 * same figure.
 */

/** One line of GET /analytics/cycle-profitability. */
export interface CycleProfitRow {
  cycleId: string;
  cycleCode: string;
  profit: number;
  roiPct: number | null;
}


/** One side of GET /analytics/top-orders. */
export interface TopOrder {
  orderId: string;
  orderNo: string;
  customer: { id: string; displayName: string; isWalkIn?: boolean } | null;
  revenueEgp: number;
  units: number;
  lines: number;
  /** Kinds of product on the order; absent from an API before 2026-10-22. */
  products?: number;
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
    icon: TrendingUp,
    color: 'bg-blue-500',
  }));
  return <SummaryStrip cards={cards} isLoading={isLoading} label={t('cyclesLabel')} testId="cycles-summary" />;
}

/** GET /analytics/stock-summary: the dashboard's product count and units in stock. */
export interface StockSummaryData {
  totalProducts: number;
  unitsInStock: number;
}

/**
 * Products and Inventory: how many products there are and how many units are
 * on the shelf (owner 2026-10-22, replacing the best sellers) — the
 * dashboard's Units in stock, in its icon and colour.
 */
export function StockSummary({ testId = 'stock-summary' }: { testId?: string }) {
  const t = useTranslations('tabSummary');
  const { formatNumber } = useNumberFormat();
  const { data, isLoading } = useQuery({
    queryKey: ['inventory', 'stock-summary'],
    queryFn: () => api.get('/analytics/stock-summary').then(rows<StockSummaryData>),
  });
  const cards: SummaryCard[] = data
    ? [
        {
          key: 'products',
          label: t('products'),
          value: formatNumber(data.totalProducts),
          sub: t('productsSub'),
          href: '/products',
          icon: Package,
          color: 'bg-indigo-500',
        },
        {
          key: 'units-in-stock',
          label: t('unitsInStock'),
          value: formatNumber(data.unitsInStock, UNITS),
          sub: t('unitsInStockSub'),
          href: '/inventory',
          icon: Boxes,
          color: 'bg-orange-400',
        },
      ]
    : [];
  return (
    <SummaryStrip
      cards={cards}
      isLoading={isLoading}
      label={t('stockLabel')}
      testId={testId}
      skeletonCount={2}
      skeletonSubject={false}
    />
  );
}

/**
 * Sales: the sale that brought in the most and the one that sent out the
 * most units, all time. Under the `sales` key so every change to a sale
 * (confirm, cancel, return) refreshes it with the list.
 */
export function SalesSummary({
  onOpen,
  status = '',
}: {
  onOpen: (orderId: string) => void;
  /** The Sales list's status filter, so the cards answer for the same orders (2026-10-28). */
  status?: string;
}) {
  const t = useTranslations('tabSummary');
  const ts = useTranslations('sales');
  const { formatNumber } = useNumberFormat();
  const { data, isLoading } = useQuery({
    queryKey: ['sales', 'top-orders', status],
    queryFn: () =>
      api.get('/analytics/top-orders', { params: status ? { status } : {} }).then(rows<TopOrders>),
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
      icon: DollarSign,
      color: 'bg-green-500',
    });
  }
  if (data?.mostUnits) {
    const o = data.mostUnits;
    cards.push({
      key: 'most-units',
      label: t('mostUnits'),
      subject: o.orderNo,
      value: t('units', { units: formatNumber(o.units, UNITS) }),
      // Kinds of product, not order lines (owner 2026-10-22: "products instead").
      sub: t('productKinds', { count: o.products ?? o.lines, products: formatNumber(o.products ?? o.lines) }),
      onClick: () => onOpen(o.orderId),
      icon: ShoppingCart,
      color: 'bg-orange-500',
    });
  }
  return (
    <SummaryStrip cards={cards} isLoading={isLoading} label={t('salesLabel')} testId="sales-summary" skeletonCount={2} />
  );
}

/** GET /analytics/customer-summary. */
export interface CustomerSummaryData {
  totalCustomers: number;
  topPayer: { customerId: string; displayName: string; paidEgp: number } | null;
}

/**
 * Customers: how many there are, and the one who has paid the most, all time
 * (owner 2026-10-22). Under the `customers` key so a new customer refreshes it.
 */
export function CustomersSummary() {
  const t = useTranslations('tabSummary');
  const { formatNumber } = useNumberFormat();
  const { data, isLoading } = useQuery({
    queryKey: ['customers', 'customer-summary'],
    queryFn: () => api.get('/analytics/customer-summary').then(rows<CustomerSummaryData>),
  });
  const cards: SummaryCard[] = [];
  if (data) {
    cards.push({
      key: 'customers',
      label: t('customers'),
      value: formatNumber(data.totalCustomers),
      sub: t('customersSub'),
      icon: Users,
      color: 'bg-blue-500',
    });
    if (data.topPayer) {
      cards.push({
        key: 'top-payer',
        label: t('topPayer'),
        subject: data.topPayer.displayName,
        value: <Money value={data.topPayer.paidEgp} />,
        sub: t('allTime'),
        href: `/customers/${data.topPayer.customerId}`,
        icon: HandCoins,
        color: 'bg-emerald-600',
      });
    }
  }
  return (
    <SummaryStrip
      cards={cards}
      isLoading={isLoading}
      label={t('customersLabel')}
      testId="customers-summary"
      skeletonCount={2}
      skeletonSubject={[false, true]}
    />
  );
}

/** GET /analytics/payment-summary. */
export interface PaymentSummaryData {
  largest: {
    paymentId: string;
    amount: number;
    currency: string;
    receivedOn: string;
    reference: string | null;
    method: string | null;
    customer: { id: string; displayName: string; isWalkIn?: boolean } | null;
  } | null;
}

/**
 * Payments: the largest payment standing, and who paid it (owner 2026-10-22).
 * Under the `payments` key so a payment recorded or reversed refreshes it.
 */
export function PaymentsSummary() {
  const t = useTranslations('tabSummary');
  const ts = useTranslations('sales');
  const codeLabel = useCodeLabel();
  const { formatDate } = useDateFormat();
  const { data, isLoading } = useQuery({
    queryKey: ['payments', 'payment-summary'],
    queryFn: () => api.get('/analytics/payment-summary').then(rows<PaymentSummaryData>),
  });
  const p = data?.largest;
  const cards: SummaryCard[] = p
    ? [
        {
          key: 'largest-payment',
          label: t('largestPayment'),
          subject: p.customer?.isWalkIn ? ts('walkInCustomer') : (p.customer?.displayName ?? '—'),
          value: <Money value={p.amount} currency={p.currency} />,
          sub: [formatDate(`${p.receivedOn}T12:00:00Z`), p.method ? codeLabel('paymentMethod', p.method) : null]
            .filter(Boolean)
            .join(' · '),
          href: p.customer && !p.customer.isWalkIn ? `/customers/${p.customer.id}` : undefined,
          icon: Wallet,
          color: 'bg-emerald-600',
        },
      ]
    : [];
  return (
    <SummaryStrip
      cards={cards}
      isLoading={isLoading}
      label={t('paymentsLabel')}
      testId="payments-summary"
      skeletonCount={1}
    />
  );
}
