'use client';

import { useTranslations } from 'next-intl';
import { Money } from '../../../../components/ui/money';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../../lib/api';
import { useToast } from '../../../../components/ui/toast';
import { formatDate } from '../../../../lib/dates';
import { MoneyInput } from '../../../../components/ui/money-input';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  ArrowLeft, Package, Tag, Barcode, DollarSign, TrendingUp, TrendingDown,
  Boxes, AlertTriangle, ShoppingCart, Truck, Store, Loader2, ChevronDown,
  ChevronUp, Layers, History, ArrowUpRight, ArrowDownRight, Check,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────
interface Product {
  id: string;
  sku: string;
  name: string;
  description?: string;
  barcode?: string;
  status?: string;
  minStock?: number;
  createdAt?: string;
  category?: { id: string; name: string };
  suppliers?: { supplier: { id: string; name: string } }[];
  prices?: PriceEntry[];
  compatibilities?: { motorcycleModel: { id: string; name: string } }[];
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
  batches: Batch[];
}

interface Batch {
  id: string;
  batchNo?: string;
  cycleId: string;
  cycle?: { code: string };
  receivedQty: number;
  remainingQty: number;
  landedUnitCostEgp: number;
}

interface Movement {
  id: string;
  movementType: string;
  qtyDelta: number;
  occurredAt: string;
  referenceType?: string;
  referenceId?: string;
}

// ─── Movement badge helpers ───────────────────────────────────────────
function movementTypeBadge(type: string): string {
  switch (type) {
    case 'PURCHASE_RECEIPT':
      return 'bg-green-100 text-green-700';
    case 'SALE_ALLOCATION':
      return 'bg-blue-100 text-blue-700';
    case 'ADJUSTMENT':
      return 'bg-amber-100 text-amber-700';
    default:
      return 'bg-gray-100 text-gray-600';
  }
}

function movementTypeIcon(type: string) {
  switch (type) {
    case 'PURCHASE_RECEIPT':
      return <ArrowDownRight className="h-3.5 w-3.5" />;
    case 'SALE_ALLOCATION':
      return <ArrowUpRight className="h-3.5 w-3.5" />;
    case 'ADJUSTMENT':
      return <AlertTriangle className="h-3.5 w-3.5" />;
    default:
      return <Package className="h-3.5 w-3.5" />;
  }
}

// ─── Main Page ────────────────────────────────────────────────────────
export default function ProductDetailPage() {
  const t = useTranslations('products');
  const tc = useTranslations('common');
  const router = useRouter();
  const params = useParams();
  const productId = params.id as string;

  const [expandedBatch, setExpandedBatch] = useState<string | null>(null);

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

  const { data: batchMovements = [], isLoading: loadingMovements } = useQuery({
    queryKey: ['batchMovements', expandedBatch],
    queryFn: () =>
      api.get(`/inventory/batches/${expandedBatch}/movements`).then((r) => r.data.data ?? r.data),
    enabled: !!expandedBatch,
  });

  // ── Derived data ──────────────────────────────────────────────────
  const productData: Product | null = product ?? null;

  const activePrices: PriceEntry[] = Array.isArray(productData?.prices)
    ? productData.prices.filter((p) => !p.effectiveTo)
    : [];

  const activeB2B = activePrices.find((p) => p.channel === 'B2B');
  const activeB2C = activePrices.find((p) => p.channel === 'B2C');

  const allMovements: Movement[] = Array.isArray(batchMovements) ? batchMovements : [];

  // Collect all movements from all batches if no specific batch is expanded
  const batchIds: string[] = Array.isArray(stock?.batches) ? stock.batches.map((b: Batch) => b.id) : [];

  const isLoading = loadingProduct || loadingInventory;

  // ── Loading state ─────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24 text-gray-500">
        <Loader2 className="h-5 w-5 animate-spin me-2" /> {tc('loading')}
      </div>
    );
  }

  // ── Not found state ──────────────────────────────────────────────
  if (!productData) {
    return (
      <div className="space-y-6">
        <button
          onClick={() => router.back()}
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" /> {tc('back')}
        </button>
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center text-gray-400">
          {tc('noData')}
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
        <button
          onClick={() => router.back()}
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" /> {tc('back')}
        </button>
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
          <h1 className="text-2xl font-bold text-gray-900">{productData.name}</h1>
          <span
            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
              isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'
            }`}
          >
            {isActive ? t('active') : t('inactive')}
          </span>
        </div>
        <p className="font-mono text-sm text-gray-500">{productData.sku}</p>
      </div>

      {/* ── Stat Cards ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard
          icon={<Boxes className="h-5 w-5" />}
          label={t('totalStock')}
          value={stock?.totalStock ?? 0}
          iconBg="bg-gray-100 text-gray-600"
        />
        <StatCard
          icon={<TrendingUp className="h-5 w-5" />}
          label={t('available')}
          value={stock?.availableStock ?? 0}
          iconBg="bg-green-100 text-green-600"
          valueColor="text-green-600"
        />
        <StatCard
          icon={<AlertTriangle className="h-5 w-5" />}
          label={t('reserved')}
          value={stock?.reservedStock ?? 0}
          iconBg="bg-amber-100 text-amber-600"
          valueColor="text-amber-600"
        />
        <StatCard
          icon={<DollarSign className="h-5 w-5" />}
          label={t('b2cPrice')}
          value={activeB2C ? `${activeB2C.currency} ${activeB2C.amount.toLocaleString()}` : '—'}
          iconBg="bg-primary-100 text-primary-600"
          valueColor="text-primary-600"
        />
      </div>

      {/* ── Two-column Layout ───────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ── Left Column ─────────────────────────────────────────── */}
        <div className="lg:col-span-2 space-y-6">
          {/* ── Product Details ──────────────────────────────────── */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <Package className="h-4 w-4 text-gray-400" />
              {tc('details')}
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <DetailItem label={t('sku')} value={productData.sku} mono />
              <DetailItem
                label={t('category')}
                value={productData.category?.name ?? '—'}
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
                value={productData.description ?? '—'}
                full
              />
              <DetailItem
                label={t('createdAt')}
                value={formatDate(productData.createdAt, { includeTime: true })}
              />
            </div>
          </div>

          {/* ── Inventory Batches ────────────────────────────────── */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <Layers className="h-4 w-4 text-gray-400" />
              {t('inventoryBatches') ?? 'Inventory Batches'}
            </h2>
            {!stock || !stock.batches || stock.batches.length === 0 ? (
              <p className="text-sm text-gray-400">{tc('noData')}</p>
            ) : (
              <div className="space-y-3">
                {stock.batches.map((batch: Batch) => {
                  const isExpanded = expandedBatch === batch.id;
                  return (
                    <div
                      key={batch.id}
                      className="border border-gray-100 rounded-lg overflow-hidden"
                    >
                      <button
                        onClick={() => setExpandedBatch(isExpanded ? null : batch.id)}
                        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors text-start"
                      >
                        <div className="flex items-center gap-4 text-sm">
                          <span className="font-mono text-xs text-gray-500">
                            #{batch.batchNo ?? batch.id.slice(0, 8)}
                          </span>
                          <span className="text-gray-600">
                            {t('cycle')}: {batch.cycle?.code ?? '—'}
                          </span>
                          <span className="text-gray-600">
                            {t('receivedQty')}: {batch.receivedQty}
                          </span>
                          <span className="text-gray-600">
                            {t('remainingQty')}: {batch.remainingQty}
                          </span>
                          <span className="text-gray-600">
                            {t('landedCost')}:{' '}
                            <Money value={batch.landedUnitCostEgp} />
                          </span>
                        </div>
                        {isExpanded ? (
                          <ChevronUp className="h-4 w-4 text-gray-400 shrink-0" />
                        ) : (
                          <ChevronDown className="h-4 w-4 text-gray-400 shrink-0" />
                        )}
                      </button>
                      {isExpanded && (
                        <div className="border-t border-gray-100 bg-gray-50 px-4 py-3">
                          {loadingMovements ? (
                            <div className="flex items-center justify-center py-4 text-gray-500 text-sm">
                              <Loader2 className="h-4 w-4 animate-spin me-2" /> {tc('loading')}
                            </div>
                          ) : allMovements.length === 0 ? (
                            <p className="text-sm text-gray-400 text-center py-4">{tc('noData')}</p>
                          ) : (
                            <div className="space-y-2">
                              {allMovements.map((mov) => (
                                <div
                                  key={mov.id}
                                  className="flex items-center justify-between bg-white rounded-lg px-3 py-2 text-sm border border-gray-100"
                                >
                                  <div className="flex items-center gap-2">
                                    <span
                                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${movementTypeBadge(mov.movementType)}`}
                                    >
                                      {movementTypeIcon(mov.movementType)}
                                      {mov.movementType}
                                    </span>
                                    <span
                                      className={`font-medium ${mov.qtyDelta >= 0 ? 'text-green-600' : 'text-red-600'}`}
                                    >
                                      {mov.qtyDelta >= 0 ? '+' : ''}
                                      {mov.qtyDelta}
                                    </span>
                                  </div>
                                  <div className="text-end">
                                    <span className="text-gray-500 text-xs">
                                      {formatDate(mov.occurredAt, { includeTime: true })}
                                    </span>
                                    {(mov.referenceType || mov.referenceId) && (
                                      <p className="text-xs text-gray-400">
                                        {mov.referenceType}
                                        {mov.referenceId ? ` (${mov.referenceId})` : ''}
                                      </p>
                                    )}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* ── Movement History ──────────────────────────────────── */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <History className="h-4 w-4 text-gray-400" />
              {t('movementHistory') ?? 'Movement History'}
            </h2>
            {allMovements.length === 0 ? (
              <p className="text-sm text-gray-400">{tc('noData')}</p>
            ) : (
              <div className="relative">
                {/* Timeline line */}
                <div className="absolute start-[18px] top-0 bottom-0 w-px bg-gray-200" />
                <div className="space-y-4">
                  {[...allMovements]
                    .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
                    .map((mov) => (
                      <div key={mov.id} className="relative flex items-start gap-4 ps-0">
                        {/* Timeline dot */}
                        <div
                          className={`relative z-10 h-9 w-9 rounded-full flex items-center justify-center shrink-0 ${
                            mov.movementType === 'PURCHASE_RECEIPT'
                              ? 'bg-green-100 text-green-600'
                              : mov.movementType === 'SALE_ALLOCATION'
                                ? 'bg-blue-100 text-blue-600'
                                : mov.movementType === 'ADJUSTMENT'
                                  ? 'bg-amber-100 text-amber-600'
                                  : 'bg-gray-100 text-gray-600'
                          }`}
                        >
                          {movementTypeIcon(mov.movementType)}
                        </div>
                        <div className="flex-1 bg-gray-50 rounded-lg px-4 py-3 border border-gray-100">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span
                                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${movementTypeBadge(mov.movementType)}`}
                              >
                                {mov.movementType}
                              </span>
                              <span
                                className={`text-sm font-semibold ${mov.qtyDelta >= 0 ? 'text-green-600' : 'text-red-600'}`}
                              >
                                {mov.qtyDelta >= 0 ? '+' : ''}
                                {mov.qtyDelta}
                              </span>
                            </div>
                            <span className="text-xs text-gray-500">
                              {formatDate(mov.occurredAt, { includeTime: true })}
                            </span>
                          </div>
                          {(mov.referenceType || mov.referenceId) && (
                            <p className="text-xs text-gray-400 mt-1">
                              {mov.referenceType}
                              {mov.referenceId ? ` (${mov.referenceId})` : ''}
                            </p>
                          )}
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── Right Column ─────────────────────────────────────────── */}
        <div className="space-y-6">
          {/* ── Current Prices ────────────────────────────────────── */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <DollarSign className="h-4 w-4 text-gray-400" />
              {t('currentPrices') ?? 'Current Prices'}
            </h2>
            <div className="space-y-3">
              <PriceRow
                productId={productId}
                channel="B2B"
                label={t('b2bPrice')}
                icon={<Truck className="h-4 w-4 text-blue-500" />}
                current={activeB2B}
              />
              <PriceRow
                productId={productId}
                channel="B2C"
                label={t('b2cPrice')}
                icon={<Store className="h-4 w-4 text-primary-500" />}
                current={activeB2C}
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
              <div className="flex items-center justify-center py-4 text-gray-500 text-sm">
                <Loader2 className="h-4 w-4 animate-spin me-2" /> {tc('loading')}
              </div>
            ) : priceHistory.length === 0 ? (
              <p className="text-sm text-gray-400">{tc('noData')}</p>
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
                        {entry.channel}
                      </span>
                    </div>
                    <div className="text-end">
                      <span className="text-sm font-medium text-gray-900">
                        {entry.currency} {entry.amount.toLocaleString()}
                      </span>
                      <p className="text-xs text-gray-500">
                        {formatDate(entry.effectiveFrom)}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Suppliers ──────────────────────────────────────────── */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <Truck className="h-4 w-4 text-gray-400" />
              {t('suppliers') ?? 'Suppliers'}
            </h2>
            {!productData.suppliers || productData.suppliers.length === 0 ? (
              <p className="text-sm text-gray-400">{tc('noData')}</p>
            ) : (
              <div className="space-y-2">
                {productData.suppliers.map((s, idx) => (
                  <div
                    key={s.supplier?.id ?? idx}
                    className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2.5"
                  >
                    <div className="h-7 w-7 bg-primary-100 text-primary-700 rounded-full flex items-center justify-center text-xs font-bold shrink-0">
                      {s.supplier?.name?.[0]?.toUpperCase() ?? '?'}
                    </div>
                    <span className="text-sm font-medium text-gray-900">
                      {s.supplier?.name ?? '—'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Compatibility ──────────────────────────────────────── */}
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <h2 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <Tag className="h-4 w-4 text-gray-400" />
              {t('compatibility') ?? 'Compatibility'}
            </h2>
            {!productData.compatibilities || productData.compatibilities.length === 0 ? (
              <p className="text-sm text-gray-400">{tc('noData')}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {productData.compatibilities.map((c, idx) => (
                  <span
                    key={c.motorcycleModel?.id ?? idx}
                    className="inline-flex items-center gap-1 bg-gray-100 rounded-full px-2.5 py-1 text-xs font-medium text-gray-700"
                  >
                    <Tag className="h-3 w-3 text-gray-400" />
                    {c.motorcycleModel?.name ?? '—'}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
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
  value: string | number;
  iconBg: string;
  valueColor?: string;
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="flex items-center gap-3">
        <div className={`h-10 w-10 rounded-lg flex items-center justify-center ${iconBg}`}>
          {icon}
        </div>
        <div>
          <p className="text-xs text-gray-500">{label}</p>
          <p className={`text-lg font-bold ${valueColor}`}>{value}</p>
        </div>
      </div>
    </div>
  );
}

function DetailItem({
  label,
  value,
  mono = false,
  full = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  full?: boolean;
}) {
  return (
    <div className={full ? 'col-span-2 md:col-span-3' : ''}>
      <span className="text-xs text-gray-500 block mb-0.5">{label}</span>
      <p className={`text-sm font-medium text-gray-900 ${mono ? 'font-mono' : ''}`}>{value}</p>
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
}: {
  productId: string;
  channel: 'B2B' | 'B2C';
  label: string;
  icon: React.ReactNode;
  current?: { amount: number; currency: string };
}) {
  const tc = useTranslations('common');
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const [value, setValue] = useState(current ? String(current.amount) : '');

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
      addToast(`${label} updated`, 'success');
    },
    onError: (e: any) =>
      addToast(
        e?.response?.data?.error?.message || e?.response?.data?.message || 'Could not save the price',
        'error',
      ),
  });

  const changed = value !== '' && Number(value) !== Number(current?.amount ?? NaN);
  const valid = value !== '' && Number(value) > 0;

  return (
    <div className="rounded-lg bg-gray-50 px-4 py-3">
      <div className="mb-2 flex items-center gap-2">
        {icon}
        <span className="text-sm font-medium text-gray-700">{label}</span>
        {!current && <span className="text-xs text-gray-400">not set</span>}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-400">{current?.currency ?? 'EGP'}</span>
        <MoneyInput
          value={value}
          onChange={setValue}
          placeholder="0.00"
          className="w-full rounded-lg border border-gray-200 px-3 py-1.5 text-end text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
        />
        <button
          type="button"
          onClick={() => save.mutate()}
          disabled={!changed || !valid || save.isPending}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-primary-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-700 disabled:opacity-40"
        >
          {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          {tc('save')}
        </button>
      </div>
    </div>
  );
}
