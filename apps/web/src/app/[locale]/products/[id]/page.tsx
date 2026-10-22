'use client';

import { useTranslations } from 'next-intl';
import { Money } from '../../../../components/ui/money';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../../lib/api';
import { useToast } from '../../../../components/ui/toast';
import { useDateFormat } from '../../../../lib/dates';
import { MoneyInput } from '../../../../components/ui/money-input';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  Package, DollarSign, TrendingUp, Boxes, ShoppingCart, Truck, Store, Loader2,
  History, Check, PackageOpen,
} from '@/components/ui/icons';
import { ProductSamplesCard, useProductSamples } from '@/components/products/product-samples';

import { useApiError } from '../../../../lib/api-error';
import { ProductPhotos } from '../../../../components/products/product-photos';
import { BackLink } from '../../../../components/ui/back-link';
import { useCodeLabel } from '@/lib/labels';
import { useCan } from '@/lib/can';
import { EmptyState } from '@/components/ui/empty-state';
import { useNumberFormat } from '@/lib/numbers';
import { usePriceCheck } from '@/lib/price-check';
import { BelowCostPrice } from '@/components/sales/below-cost';
import { ProductStatusAction } from '@/components/products/product-status-action';
import { localName } from '@/lib/localized-name';
import { Skeleton, SkeletonRegion, SkeletonText, repeat } from '@/components/ui/skeleton';
import { listPriceOf, type ListPrice, type ListPrices } from '@/lib/list-price';
import { DefaultPriceHint } from '@/components/products/default-price-hint';
import { ProductBatches, ProductBatchesSkeleton, type ProductBatch } from '@/components/products/product-batches';
// ─── Types ────────────────────────────────────────────────────────────
interface Product {
  id: string;
  sku: string;
  name: string;
  nameAr?: string | null;
  description?: string;
  descriptionAr?: string | null;
  barcode?: string;
  status?: string;
  minStock?: number;
  createdAt?: string;
  category?: { id: string; name: string; nameAr?: string | null };
  prices?: PriceEntry[];
  listPrices?: ListPrices | null;
}

interface PriceEntry {
  id: string;
  channel: string;
  currency: string;
  amount: number;
  effectiveFrom?: string;
  effectiveTo?: string | null;
}

interface PriceHistoryEntry {
  id: string;
  channel: string;
  currency: string;
  amount: number;
  effectiveFrom?: string;
  effectiveTo?: string | null;
}

interface StockSummary {
  productId: string;
  productName: string;
  totalStock: number;
  reservedStock: number;
  availableStock: number;
  /** Remaining units × landed cost, the dashboard's Inventory Value for this product. */
  stockValueEgp?: number;
  batches: ProductBatch[];
}

// ─── Layout ───────────────────────────────────────────────────────────
// One arrangement, used by the page and its skeleton alike (2026-10-22 audit):
//
//   xl (1280+)  photos · details   | current prices · price history · samples
//               the batches, the whole width beneath both
//   narrower    one column: current prices first, right under the stock tiles
//               — the figure a partner opens the page for — then price
//               history, samples, photos, details, batches.
//
// The prices come first in the markup and are placed in the third column on a
// wide screen, so a phone (and a screen reader) meets them first. The right
// column used to end ~820px above the left, which carried the batches and a
// Movement History card besides. Two columns start at xl, not lg: at 1024 the
// sidebar leaves 718px, a third of which squeezed the price field to 35px.
const GRID = 'grid grid-cols-1 gap-6 xl:grid-cols-3 xl:items-start';
const SIDE = 'space-y-6 xl:col-start-3 xl:row-start-1';
const MAIN = 'space-y-6 xl:col-span-2 xl:col-start-1 xl:row-start-1';

/** Icon above the figure where a tile is narrow — a phone's two columns, md–lg's four — beside it otherwise. */
const STAT_LAYOUT =
  'flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3 md:flex-col md:items-start md:gap-2 xl:flex-row xl:items-center xl:gap-3';

/** `full`: the whole row at every width. `wide`: the whole row on a phone, one column from md. */
type DetailSpan = 'full' | 'wide';
const DETAIL_SPAN: Record<DetailSpan, string> = {
  full: 'col-span-2 md:col-span-3',
  wide: 'col-span-2 md:col-span-1',
};

// ─── Skeletons ────────────────────────────────────────────────────────
// Traced from the page below and its sub-components: the same header, the
// same four stat cards, the same columns of cards. Change one, change the
// other.

/** A card of the page — `p-5`, a text-sm heading line with `mb-4` under it. */
function SectionCardSkeleton({ children, heading = 'w-32' }: { children: React.ReactNode; heading?: string }) {
  return (
    <div className="bg-card rounded-xl border border-border p-5">
      <SkeletonText lineClassName="mb-4" className={heading} />
      {children}
    </div>
  );
}

/** `StatCard`: a 40px icon square beside (on a phone, above) a text-xs label over the figure. */
function StatCardSkeleton() {
  return (
    <div data-testid="skeleton-row" className="bg-card rounded-xl border border-border p-4">
      <div className={STAT_LAYOUT}>
        <Skeleton className="h-10 w-10 rounded-lg" />
        <div>
          <SkeletonText size="xs" className="w-16" />
          <SkeletonText size="lg" className="w-12" />
        </div>
      </div>
    </div>
  );
}

/** `DetailItem`: a text-xs label over a text-sm value. */
function DetailItemSkeleton({ span }: { span?: DetailSpan }) {
  return (
    <div className={span ? DETAIL_SPAN[span] : ''}>
      <SkeletonText size="xs" lineClassName="mb-0.5" className="w-16" />
      <SkeletonText className={span === 'full' ? 'w-2/3' : 'w-24'} />
    </div>
  );
}

/** `PriceRow` for someone who may set a price: label line, then currency, input and Save. */
function PriceRowSkeleton() {
  return (
    <div className="rounded-lg bg-muted/50 px-4 py-3">
      <div className="mb-2 flex items-center gap-2">
        <Skeleton className="size-4 rounded" />
        <SkeletonText className="w-20" />
      </div>
      <div className="flex items-center gap-2">
        <SkeletonText size="xs" className="w-7" />
        <Skeleton className="h-11 flex-1 rounded-lg sm:h-[34px]" />
        <Skeleton className="h-11 w-20 shrink-0 rounded-lg sm:h-[34px] sm:w-16" />
      </div>
    </div>
  );
}

/** One price-history entry: the channel badge, the amount over its date at the end. */
function PriceHistoryRowSkeleton() {
  return (
    <div data-testid="skeleton-row" className="flex items-center justify-between rounded-lg bg-muted/50 px-3 py-2.5">
      <Skeleton className="h-5 w-16 rounded-full" />
      <div className="flex flex-col items-end">
        <SkeletonText className="w-20" />
        <SkeletonText size="xs" className="w-16" />
      </div>
    </div>
  );
}

/** The whole page before the product and its stock arrive. */
function ProductDetailSkeleton() {
  return (
    <SkeletonRegion className="space-y-6">
      {/* Header: name and status badge, the SKU under them, the status button at the end. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <SkeletonText size="2xl" className="w-56" />
            <Skeleton className="h-5 w-14 rounded-full" />
          </div>
          <SkeletonText className="w-24" />
        </div>
        <Skeleton className="h-11 w-32 rounded-lg sm:h-9" />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {repeat(4, (i) => <StatCardSkeleton key={i} />)}
      </div>

      <div className={GRID}>
        <div className={SIDE}>
          <SectionCardSkeleton>
            <div className="space-y-3">{repeat(2, (i) => <PriceRowSkeleton key={i} />)}</div>
          </SectionCardSkeleton>
          <SectionCardSkeleton heading="w-24">
            <div className="space-y-2">{repeat(2, (i) => <PriceHistoryRowSkeleton key={i} />)}</div>
          </SectionCardSkeleton>
          <SectionCardSkeleton heading="w-20">
            <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2.5">
              <Skeleton className="h-7 w-7 shrink-0 rounded-full" />
              <SkeletonText className="w-28" />
            </div>
          </SectionCardSkeleton>
        </div>
        <div className={MAIN}>
          {/* Photos: heading and Add photo button, the empty line under. */}
          <div className="bg-card rounded-xl border border-border p-5">
            <div className="mb-4 flex items-center justify-between">
              <SkeletonText className="w-16" />
              <Skeleton className="h-[34px] w-28 rounded-lg" />
            </div>
            <Skeleton className="h-[68px] w-full rounded-lg" />
          </div>
          <SectionCardSkeleton heading="w-20">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              {repeat(6, (i) => <DetailItemSkeleton key={i} />)}
              <DetailItemSkeleton span="full" />
              <DetailItemSkeleton span="full" />
              <DetailItemSkeleton span="wide" />
            </div>
          </SectionCardSkeleton>
        </div>
      </div>

      <ProductBatchesSkeleton />
    </SkeletonRegion>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────
export default function ProductDetailPage() {
  const codeLabel = useCodeLabel();
  const { formatDate } = useDateFormat();
  const t = useTranslations('products');
  const tc = useTranslations('common');
  const { formatMoney, formatNumber } = useNumberFormat();
  const router = useRouter();
  const params = useParams();
  const productId = params.id as string;
  const locale = String(params.locale ?? 'en');

  // ── Queries ───────────────────────────────────────────────────────
  const { data: product, isLoading: loadingProduct } = useQuery({
    queryKey: ['product', productId],
    queryFn: () => api.get(`/products/${productId}`).then((r) => r.data.data ?? r.data),
    enabled: !!productId,
  });

  const { data: priceHistory = [], isLoading: loadingPrices } = useQuery({
    queryKey: ['priceHistory', productId],
    queryFn: () =>
      api.get(`/products/${productId}/prices`).then((r) => r.data.data ?? r.data),
    enabled: !!productId,
  });

  const { data: inventory = [], isLoading: loadingInventory } = useQuery({
    queryKey: ['inventory'],
    queryFn: () => api.get('/inventory').then((r) => r.data.data ?? r.data),
  });

  const stock: StockSummary | undefined = Array.isArray(inventory)
    ? inventory.find((item: StockSummary) => item.productId === productId)
    : undefined;

  // ── Derived data ──────────────────────────────────────────────────
  const productData: Product | null = product ?? null;

  const activePrices: PriceEntry[] = Array.isArray(productData?.prices)
    ? productData.prices.filter((p) => !p.effectiveTo)
    : [];

  const activeB2B = activePrices.find((p) => p.channel === 'B2B');
  const activeB2C = activePrices.find((p) => p.channel === 'B2C');

  const samplesOut = useProductSamples(productId);

  const isLoading = loadingProduct || loadingInventory;

  // ── Loading state ─────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="space-y-3">
        <BackLink onClick={() => router.back()} />
        <ProductDetailSkeleton />
      </div>
    );
  }

  // ── Not found state ──────────────────────────────────────────────
  if (!productData) {
    return (
      <div className="space-y-6">
        <BackLink onClick={() => router.back()} />
        <div className="bg-white rounded-xl border border-gray-200">
          <EmptyState
            icon={Package}
            title={t('notFoundTitle')}
            description={t('notFoundHint')}
            action={{ label: t('backToProducts'), href: '/products' }}
          />
        </div>
      </div>
    );
  }

  const isActive = productData.status === 'ACTIVE';

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* ── Header ──────────────────────────────────────────────────── */}
      <div className="space-y-3">
        <BackLink onClick={() => router.back()} />
        {/* The SKU sits under the name it belongs to and the status action at
            the end, beside them — on a phone it used to fall between the two. */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="min-w-0 break-words text-2xl font-bold text-gray-900" data-testid="product-title">
                {localName(productData, locale)}
              </h1>
              <span
                data-testid="product-status"
                className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                  isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'
                }`}
              >
                {isActive ? t('active') : t('inactive')}
              </span>
            </div>
            <p data-testid="product-sku" className="font-mono text-sm text-gray-500">
              <bdi dir="ltr">{productData.sku}</bdi>
            </p>
          </div>
          <div className="shrink-0">
            <ProductStatusAction product={productData} look="button" />
          </div>
        </div>
        {!isActive && (
          <p className="rounded-lg border border-border bg-muted px-4 py-3 text-sm text-foreground">
            {t('inactiveNotice')}
          </p>
        )}
      </div>

      {/* ── Stat Cards ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          icon={<Boxes className="h-5 w-5" />}
          label={t('totalStock')}
          value={formatNumber(stock?.totalStock ?? 0)}
          iconBg="bg-gray-100 text-gray-600"
        />
        <StatCard
          icon={<TrendingUp className="h-5 w-5" />}
          label={t('available')}
          value={formatNumber(stock?.availableStock ?? 0)}
          iconBg="bg-green-100 text-green-600"
          valueColor="text-green-600"
        />
        {/* What the shelf cost us (owner 2026-10-19), in Reserved's place —
            nothing ever reserved stock. Same rule as the dashboard's
            Inventory Value (common/stock-value.ts). */}
        <StatCard
          icon={<DollarSign className="h-5 w-5" />}
          label={t('stockValue')}
          value={
            <bdi dir="ltr" data-testid="product-stock-value">
              {formatMoney(stock?.stockValueEgp ?? 0)}
            </bdi>
          }
          iconBg="bg-orange-100 text-orange-600"
        />
        {/* Units out as samples at shops (§4, owner 2026-10-18 round 2), in
            the place the B2C price card had — the prices are in their own
            card below. */}
        <StatCard
          icon={<PackageOpen className="h-5 w-5" />}
          label={t('samples.title')}
          value={<span data-testid="product-samples-stat">{formatNumber(samplesOut.units)}</span>}
          iconBg="bg-accent-100 text-accent-800"
          valueColor={samplesOut.units > 0 ? 'text-accent-800' : 'text-gray-900'}
        />
      </div>

      <div className={GRID}>
        {/* ── Prices: first on a phone, the third column on a wide screen ── */}
        <div className={SIDE}>
          <div data-testid="current-prices" className="bg-white rounded-xl border border-gray-200 p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <DollarSign className="h-4 w-4 text-gray-400" />
              {t('currentPrices')}
            </h2>
            <div className="space-y-3">
              <PriceRow
                productId={productId}
                channel="B2B"
                label={t('b2bPrice')}
                icon={<Truck className="h-4 w-4 text-blue-500" />}
                current={activeB2B}
                resolved={listPriceOf(productData, 'B2B')}
              />
              <PriceRow
                productId={productId}
                channel="B2C"
                label={t('b2cPrice')}
                icon={<Store className="h-4 w-4 text-primary-500" />}
                current={activeB2C}
                resolved={listPriceOf(productData, 'B2C')}
              />
            </div>
          </div>

          {/* ── Price History ──────────────────────────────────────── */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <History className="h-4 w-4 text-gray-400" />
              {t('priceHistory')}
            </h2>
            {loadingPrices ? (
              <SkeletonRegion className="space-y-2">
                {repeat(2, (i) => <PriceHistoryRowSkeleton key={i} />)}
              </SkeletonRegion>
            ) : priceHistory.length === 0 ? (
              <EmptyState size="compact" icon={DollarSign} title={t('noPriceHistoryTitle')} description={t('noPriceHistoryHint')} />
            ) : (
              <div className="space-y-2">
                {priceHistory.map((entry: PriceHistoryEntry) => (
                  <div
                    key={entry.id}
                    className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2.5"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                          entry.channel === 'B2B'
                            ? 'bg-blue-100 text-blue-700'
                            : 'bg-primary-100 text-primary-700'
                        }`}
                      >
                        {entry.channel === 'B2B' ? (
                          <Truck className="h-3 w-3" />
                        ) : (
                          <ShoppingCart className="h-3 w-3" />
                        )}
                        {codeLabel('channel', entry.channel)}
                      </span>
                    </div>
                    <div className="text-end">
                      <span className="text-sm font-medium text-gray-900">
                        <Money value={entry.amount} currency={entry.currency} />
                      </span>
                      <p className="whitespace-nowrap text-xs text-gray-500">
                        {formatDate(entry.effectiveFrom)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Samples at shops ─────────────────────────────────── */}
          {/* In this column, not under the details: there the left ran ~210px
              past the prices at 1440 (measured 2026-10-22). */}
          <ProductSamplesCard productId={productId} />

          {/* Suppliers and Compatibility cards removed (owner 2026-10-18). */}
        </div>

        {/* ── Photos, details, samples ─────────────────────────────── */}
        <div className={MAIN}>
          {/* First, because it is what a shop sees first. The catalogue card
              and the product page in the store both render these. */}
          <ProductPhotos productId={productId} />

          {/* ── Product Details ──────────────────────────────────── */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <Package className="h-4 w-4 text-gray-400" />
              {tc('details')}
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <DetailItem label={t('sku')} value={productData.sku} mono />
              {/* Both names as stored, whichever the title shows — so a partner
                  on /en can see the Arabic is there, and on /ar the English. */}
              <DetailItem label={t('name')} value={productData.name} />
              <DetailItem label={t('nameAr')} value={productData.nameAr || '—'} rtl />
              <DetailItem
                label={t('category')}
                value={productData.category ? localName(productData.category, locale) : '—'}
              />
              <DetailItem
                label={t('barcode')}
                value={productData.barcode ?? '—'}
                mono
              />
              <DetailItem
                label={t('minStock')}
                value={String(productData.minStock ?? 0)}
              />
              <DetailItem
                label={t('description')}
                value={productData.description || '—'}
                span="full"
              />
              <DetailItem
                label={t('descriptionAr')}
                value={productData.descriptionAr || '—'}
                rtl
                span="full"
              />
              {/* A date with its time does not fit half a phone's width: the
                  whole row there, one column of three on a wider screen. */}
              <DetailItem
                label={t('createdAt')}
                value={formatDate(productData.createdAt, { includeTime: true })}
                span="wide"
              />
            </div>
          </div>

        </div>
      </div>

      {/* ── Inventory Batches: the whole width, beneath both columns ── */}
      <ProductBatches batches={Array.isArray(stock?.batches) ? stock.batches : []} />
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────

function StatCard({
  icon,
  label,
  value,
  iconBg,
  valueColor = 'text-gray-900',
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  iconBg: string;
  valueColor?: string;
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className={STAT_LAYOUT}>
        <div className={`h-10 w-10 shrink-0 rounded-lg flex items-center justify-center ${iconBg}`}>
          {icon}
        </div>
        <div className="min-w-0">
          <p className="text-xs text-gray-500">{label}</p>
          {/* One line, always: "2,034.40 EGP" broke in two on a phone. */}
          <p className={`whitespace-nowrap text-base font-bold tabular-nums xl:text-lg ${valueColor}`}>{value}</p>
        </div>
      </div>
    </div>
  );
}


function DetailItem({
  label,
  value,
  mono = false,
  span,
  rtl = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  span?: DetailSpan;
  /**
   * Arabic text: ordered right to left even on /en, so "هوندا CBR 150" does
   * not come out scrambled, while the cell stays aligned with its neighbours.
   */
  rtl?: boolean;
}) {
  return (
    <div className={span ? DETAIL_SPAN[span] : ''}>
      <span className="text-xs text-gray-500 block mb-0.5">{label}</span>
      <p className={`text-sm font-medium text-gray-900 ${mono ? 'font-mono' : ''}`}>
        {/* Each value is its own run: an English description on /ar put its full stop first. */}
        {rtl ? <bdi dir="rtl">{value}</bdi> : <bdi>{value}</bdi>}
      </p>
    </div>
  );
}

/**
 * The selling price for one channel.
 *
 * Setting a price closes the previous one and opens a new one rather than
 * editing it, so what a product sold at last month stays answerable — the price
 * list below this is that history. The API does the closing; this only sends
 * the new amount.
 *
 * The prices were displayed on three screens and settable on none, so the
 * columns had read "—" since the product was created.
 */
function PriceRow({
  productId,
  channel,
  label,
  icon,
  current,
  resolved,
}: {
  productId: string;
  channel: 'B2B' | 'B2C';
  label: string;
  icon: React.ReactNode;
  current?: { amount: number; currency: string };
  /** The API's price for the channel: a DEFAULT (landed + markup) when none is set (§3, 2026-10-18). */
  resolved?: ListPrice | null;
}) {
  // Shown, never filled in: saving it would turn a default into a set price.
  const fallback = !current && resolved?.source === 'DEFAULT' ? resolved : null;
  const tc = useTranslations('common');
  const tp = useTranslations('products');
  const tph = useTranslations('placeholders');
  const apiError = useApiError();
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const [value, setValue] = useState(current ? String(current.amount) : '');
  // Setting a price is a partner's (R1c); anyone else reads it.
  const maySet = useCan('product.setPrice');

  // A price saved elsewhere, or the first load finishing, should show here.
  useEffect(() => {
    setValue(current ? String(current.amount) : '');
  }, [current?.amount]);

  const save = useMutation({
    mutationFn: () =>
      api.post(`/products/${productId}/prices`, {
        channel,
        currency: current?.currency ?? 'EGP',
        amount: Number(value),
      }),
    onSuccess: () => {
      // Both the product (which carries the active prices) and the history
      // list below it are now stale.
      queryClient.invalidateQueries({ queryKey: ['product', productId] });
      queryClient.invalidateQueries({ queryKey: ['priceHistory', productId] });
      queryClient.invalidateQueries({ queryKey: ['products'] });
      addToast(tp('priceUpdated', { label }), 'success');
    },
    onError: (e: any) =>
      addToast(
        apiError(e, tp('priceSaveFailed')),
        'error',
      ),
  });

  const changed = value !== '' && Number(value) !== Number(current?.amount ?? NaN);
  const valid = value !== '' && Number(value) > 0;

  // Below cost (§4, 2026-10-11): the price against the oldest batch on the
  // shelf — what one unit sold at it would draw under FIFO, so the same
  // check as a sale of one. Only for whoever may set the price; a warning,
  // and Save still works.
  const priceCheck = usePriceCheck(
    [{ productId, quantity: 1, unitPrice: valid ? value : 0 }],
    current?.currency ?? 'EGP',
    { enabled: maySet && valid },
  );

  return (
    <div className="rounded-lg bg-gray-50 px-4 py-3">
      <div className="mb-2 flex items-center gap-2">
        {icon}
        <span className="text-sm font-medium text-gray-700">{label}</span>
        {!current && <span className="text-xs text-gray-400">{tp('priceNotSet')}</span>}
      </div>
      {!maySet ? (
        <p data-testid="price-readonly" className="text-sm font-medium text-foreground">
          {current ? (
            <Money value={current.amount} currency={current.currency} />
          ) : fallback ? (
            <Money value={Number(fallback.amount)} currency={fallback.currency} />
          ) : (
            '—'
          )}
          <DefaultPriceHint price={fallback} />
        </p>
      ) : (
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-400">{current?.currency ?? 'EGP'}</span>
        <MoneyInput
          value={value}
          onChange={setValue}
          // Never the default figure: grey "1221" in the box read as a price
          // already typed (2026-10-22 audit). The default is the line under
          // the field, with its figure and what it is.
          placeholder={fallback ? '' : tph('money')}
          aria-describedby={fallback ? `default-price-${channel}` : undefined}
          className="h-11 w-full min-w-0 rounded-lg border border-gray-200 px-3 text-start text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 sm:h-[34px]"
        />
        <button
          type="button"
          data-testid="set-price-action"
          onClick={() => save.mutate()}
          disabled={!changed || !valid || save.isPending}
          // 44px to a thumb on a phone, the field's own height from sm.
          className="inline-flex h-11 shrink-0 items-center gap-1 rounded-lg bg-primary-600 px-4 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-40 sm:h-[34px] sm:px-3 sm:text-xs"
        >
          {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          {tc('save')}
        </button>
      </div>
      )}
      {maySet && fallback && (
        <p id={`default-price-${channel}`} data-testid="default-price" className="mt-1.5 text-xs text-muted-foreground">
          <Money value={Number(fallback.amount)} currency={fallback.currency} />{' '}
          <DefaultPriceHint price={fallback} className="inline" />
        </p>
      )}
      {maySet && <BelowCostPrice check={priceCheck?.lines[0]} />}
    </div>
  );
}
