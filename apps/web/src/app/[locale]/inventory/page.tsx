'use client';
import { Select } from '../../../components/ui/select';
import { ProductLink } from '../../../components/ui/entity-link';
import { BatchRef } from '../../../components/ui/batch-ref';
import { Money } from '../../../components/ui/money';

import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { formatDate } from '../../../lib/dates';
import { useToast } from '../../../components/ui/toast';
import { useState, useMemo, useEffect } from 'react';
import { Pagination, paginate, PAGE_SIZE } from '../../../components/ui/pagination';
import {
  Boxes, Search, ChevronDown, ChevronRight, X, Loader2, AlertTriangle,
  Package, ArrowUpDown, CheckCircle2, Clock, Plus,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────
interface InventorySummary {
  productId: string;
  productName: string;
  totalStock: number;
  reservedStock: number;
  availableStock: number;
  batches: any[];
}

interface Batch {
  id: string;
  cycleId: string;
  cycle?: { code: string };
  remainingQty: number;
  landedUnitCostEgp: number;
  verificationStatus: string;
}

interface Movement {
  id: string;
  movementType: string;
  qtyDelta: number;
  occurredAt: string;
  referenceType?: string;
  referenceId?: string;
}

// ─── Main Page ────────────────────────────────────────────────────────
export default function InventoryPage() {
  const apiError = useApiError();
  const t = useTranslations('inventory');
  const tc = useTranslations('common');
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [expandedProduct, setExpandedProduct] = useState<string | null>(null);
  const [showVerifyModal, setShowVerifyModal] = useState(false);
  const [verifyingBatch, setVerifyingBatch] = useState<Batch | null>(null);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [search]);

  // ── Queries ───────────────────────────────────────────────────────
  const { data: inventory = [], isLoading } = useQuery({
    queryKey: ['inventory'],
    queryFn: () => api.get('/inventory').then((r) => r.data.data ?? r.data),
  });

  // The verify-stock picker previously rendered an empty dropdown — the
  // options were never fetched, so a cycle could not be chosen at all.
  const { data: cycles = [] } = useQuery({
    queryKey: ['cycles'],
    queryFn: () => api.get('/cycles?limit=200').then((r) => r.data.data ?? r.data),
  });

  const { data: movements = [] } = useQuery({
    queryKey: ['inventoryMovements', selectedBatchId],
    queryFn: () =>
      api.get(`/inventory/batches/${selectedBatchId}/movements`).then((r) => r.data.data ?? r.data),
    enabled: !!selectedBatchId,
  });

  // ── Mutations ─────────────────────────────────────────────────────
  const verifyMutation = useMutation({
    mutationFn: (data: any) => api.post('/receipts/verify', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inventory'] });
      queryClient.invalidateQueries({ queryKey: ['inventoryBatches'] });
      setShowVerifyModal(false);
      setVerifyingBatch(null);
      toast('Stock verified successfully', 'success');
    },
    onError: (error: any) => {
      toast(apiError(error, 'Failed to verify stock'), 'error');
    },
  });

  // ── Derived ───────────────────────────────────────────────────────
  const inventoryList: InventorySummary[] = Array.isArray(inventory) ? inventory : [];
  const movementList: Movement[] = Array.isArray(movements) ? movements : [];

  const filtered = inventoryList.filter((item) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      item.productName?.toLowerCase().includes(q)
    );
  });

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = useMemo(() => paginate(filtered, page), [filtered, page]);

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
        <button
          onClick={() => setShowVerifyModal(true)}
          className="inline-flex items-center gap-2 bg-primary-600 text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-primary-700 transition-colors"
        >
          <CheckCircle2 className="h-4 w-4" />
          {t('verifyStock')}
        </button>
      </div>

      {/* Search */}
      <div className="relative max-w-md">
        <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <input
          type="text"
          placeholder={t('search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full ps-10 pe-4 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
        />
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center justify-center py-12 text-gray-500">
          <Loader2 className="h-5 w-5 animate-spin me-2" /> {tc('loading')}
        </div>
      )}

      {/* Desktop Table */}
      {!isLoading && (
        <div className="hidden md:block bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-start px-4 py-3 w-8" />
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('product')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('totalStock')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('reserved')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('available')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('batches')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-12 text-center text-gray-400">{tc('noData')}</td></tr>
                ) : (
                  paginated.map((item) => {
                    const isExpanded = expandedProduct === item.productId;
                     const isLow = item.batches?.some((b: any) => Number(b.remainingQty) < 10);
                    return (
                      <Fragment key={item.productId}>
                        <tr
                          className={`hover:bg-gray-50 transition-colors cursor-pointer ${isLow ? 'bg-red-50/50' : ''}`}
                          onClick={() => setExpandedProduct(isExpanded ? null : item.productId)}
                        >
                          <td className="px-4 py-3">
                            <ChevronDown className={`h-4 w-4 text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                          </td>
                           <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <div>
                                <p className="font-medium text-gray-900">
                                  <ProductLink id={item.productId} name={item.productName} />
                                </p>
                              </div>
                              {isLow && (
                                <span className="inline-flex items-center gap-1 text-xs text-red-600 bg-red-100 rounded-full px-2 py-0.5">
                                  <AlertTriangle className="h-3 w-3" /> Low
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 font-medium text-gray-900">{item.totalStock}</td>
                          <td className="px-4 py-3 text-gray-600">{item.reservedStock}</td>
                          <td className={`px-4 py-3 font-medium ${isLow ? 'text-red-600' : 'text-green-600'}`}>{item.availableStock}</td>
                          <td className="px-4 py-3 text-gray-600">{item.batches?.length ?? 0}</td>
                        </tr>
                        {isExpanded && (
                          <tr>
                            <td colSpan={6} className="px-4 py-4 bg-gray-50">
                              {(item.batches ?? []).length === 0 ? (
                                <p className="text-sm text-gray-400 text-center py-4">{tc('noData')}</p>
                              ) : (
                                <div className="space-y-3">
                                  <div className="overflow-x-auto">
                                    <table className="w-full text-sm">
                                      <thead>
                                        <tr className="border-b border-gray-200">
                                          <th className="text-start py-2 text-xs text-gray-500 font-medium">{t('batch')}</th>
                                          <th className="text-start py-2 text-xs text-gray-500 font-medium">{t('cycle')}</th>
                                          <th className="text-start py-2 text-xs text-gray-500 font-medium">{t('remaining')}</th>
                                          <th className="text-start py-2 text-xs text-gray-500 font-medium">{t('landedCost')}</th>
                                          <th className="text-start py-2 text-xs text-gray-500 font-medium">{t('verificationStatus')}</th>
                                          <th className="text-start py-2 text-xs text-gray-500 font-medium">{tc('actions')}</th>
                                        </tr>
                                      </thead>
                                      <tbody className="divide-y divide-gray-100">
                                         {(item.batches ?? []).map((batch: any) => (
                                          <tr key={batch.id} className="hover:bg-white">
                                            <td className="py-2 font-mono text-xs text-gray-600"><BatchRef id={batch.id} /></td>
                                            <td className="py-2 text-gray-600">{batch.cycle?.code ?? '—'}</td>
                                             <td className="py-2 font-medium text-gray-900">{batch.remainingQty}</td>
                                            <td className="py-2 text-gray-600"><Money value={batch.landedUnitCostEgp} /></td>
                                            <td className="py-2">
                                              <VerificationBadge status={batch.verificationStatus} />
                                            </td>
                                            <td className="py-2">
                                              <button
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  setSelectedBatchId(selectedBatchId === batch.id ? null : batch.id);
                                                }}
                                                className="inline-flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700 font-medium"
                                              >
                                                <ArrowUpDown className="h-3.5 w-3.5" /> {t('movements')}
                                              </button>
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>

                                  {/* Movements */}
                                  {selectedBatchId && (
                                    <div className="bg-white rounded-lg border border-gray-200 p-4">
                                      <h4 className="text-sm font-semibold text-gray-900 mb-3">{t('movements')}</h4>
                                      {movementList.length === 0 ? (
                                        <p className="text-sm text-gray-400">{tc('noData')}</p>
                                      ) : (
                                        <div className="space-y-2">
                                          {movementList.map((mov) => (
                                            <div key={mov.id} className="flex items-center justify-between bg-gray-50 rounded-lg px-3 py-2 text-sm">
                                              <div className="flex items-center gap-2">
                                                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                                                  mov.movementType === 'RECEIVE' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                                                }`}>
                                                  {mov.movementType}
                                                </span>
                                                <span className="text-gray-700">{mov.qtyDelta}</span>
                                              </div>
                                              <div className="text-right">
                                                <span className="text-gray-500 text-xs">{formatDate(mov.occurredAt)}</span>
                                                {(mov.referenceType || mov.referenceId) && <p className="text-xs text-gray-400">{mov.referenceType}{mov.referenceId ? ` (${mov.referenceId})` : ''}</p>}
                                              </div>
                                            </div>
                                          ))}
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Mobile Cards */}
      {!isLoading && (
        <div className="md:hidden space-y-3">
          {filtered.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200 p-12 text-center text-gray-400">{tc('noData')}</div>
          ) : (
            paginated.map((item) => {
              const isExpanded = expandedProduct === item.productId;
              const isLow = item.batches?.some((b: any) => Number(b.remainingQty) < 10);
              return (
                <div key={item.productId} className={`bg-white rounded-xl border border-gray-200 overflow-hidden ${isLow ? 'border-red-200' : ''}`}>
                  <div
                    onClick={() => setExpandedProduct(isExpanded ? null : item.productId)}
                    className="p-4 cursor-pointer"
                  >
                    <div className="flex items-start justify-between">
                       <div>
                        <p className="font-medium text-gray-900">
                          <ProductLink id={item.productId} name={item.productName} />
                        </p>
                      </div>
                      {isLow && (
                        <span className="inline-flex items-center gap-1 text-xs text-red-600 bg-red-100 rounded-full px-2 py-0.5">
                          <AlertTriangle className="h-3 w-3" /> Low
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-3 gap-3 mt-3 text-sm">
                      <div>
                        <span className="text-gray-500 text-xs">{t('totalStock')}</span>
                        <p className="font-medium">{item.totalStock}</p>
                      </div>
                       <div>
                        <span className="text-gray-500 text-xs">{t('available')}</span>
                        <p className={`font-medium ${isLow ? 'text-red-600' : 'text-green-600'}`}>{item.availableStock}</p>
                      </div>
                      <div>
                        <span className="text-gray-500 text-xs">{t('batches')}</span>
                        <p className="font-medium">{item.batches?.length ?? 0}</p>
                      </div>
                    </div>
                  </div>

                  {isExpanded && (item.batches ?? []).length > 0 && (
                    <div className="border-t border-gray-200 bg-gray-50 p-4 space-y-2">
                      {(item.batches ?? []).map((batch: any) => (
                        <div key={batch.id} className="bg-white rounded-lg p-3 text-sm">
                          <div className="flex items-center justify-between">
                            <BatchRef id={batch.id} className="font-mono text-xs text-gray-500" />
                            <VerificationBadge status={batch.verificationStatus} />
                          </div>
                          <div className="grid grid-cols-2 gap-2 mt-2 text-xs">
                            <div>
                              <span className="text-gray-500">{t('cycle')}:</span>{' '}
                              <span className="font-medium">{batch.cycle?.code ?? '—'}</span>
                            </div>
                             <div>
                              <span className="text-gray-500">{t('remaining')}:</span>{' '}
                              <span className="font-medium">{batch.remainingQty}</span>
                            </div>
                            <div>
                              <span className="text-gray-500">{t('landedCost')}:</span>{' '}
                              <span className="font-medium"><Money value={batch.landedUnitCostEgp} /></span>
                            </div>
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedBatchId(selectedBatchId === batch.id ? null : batch.id);
                            }}
                            className="mt-2 inline-flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700 font-medium"
                          >
                            <ArrowUpDown className="h-3.5 w-3.5" /> {t('movements')}
                          </button>

                          {selectedBatchId === batch.id && movementList.length > 0 && (
                            <div className="mt-2 space-y-1 border-t border-gray-100 pt-2">
                              {movementList.map((mov) => (
                                <div key={mov.id} className="flex items-center justify-between text-xs bg-gray-50 rounded px-2 py-1.5">
                                   <span className={`px-1.5 py-0.5 rounded-full font-medium ${
                                    mov.movementType === 'RECEIVE' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                                  }`}>
                                    {mov.movementType}
                                  </span>
                                  <span>{mov.qtyDelta}</span>
                                  <span className="text-gray-500">{formatDate(mov.occurredAt)}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Pagination */}
      {!isLoading && filtered.length > 0 && (
        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} totalItems={filtered.length} />
      )}

      {/* ─── Verify Stock Modal ────────────────────────────────────── */}
      {showVerifyModal && (
        <Modal title={t('verifyStock')} onClose={() => setShowVerifyModal(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              const items: any[] = [];
              // Parse multi-line inputs
              const productIds = (fd.get('productIds') as string || '').split('\n').filter(Boolean);
              const quantities = (fd.get('quantities') as string || '').split('\n').filter(Boolean);
              const costs = (fd.get('costs') as string || '').split('\n').filter(Boolean);

              for (let i = 0; i < productIds.length; i++) {
                items.push({
                  productId: productIds[i]?.trim(),
                  receivedQty: Number(quantities[i] || 0),
                  landedUnitCostEgp: Number(costs[i] || 0),
                });
              }

              verifyMutation.mutate({
                cycleId: fd.get('cycleId'),
                items,
              });
            }}
            className="space-y-4"
          >
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t('cycle')}</label>
              <Select
                name="cycleId"
                required
                placeholder={t('cycle')}
                searchPlaceholder={tc('search')}
                options={(Array.isArray(cycles) ? cycles : []).map((c: any) => ({
                  value: c.id,
                  label: c.code,
                  hint: [c.originType, c.status].filter(Boolean).join(' · '),
                }))}
              />
            </div>

            <div>
              <p className="text-sm text-gray-600 mb-2">Enter one per line: Product IDs, Quantities, Costs</p>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Product IDs</label>
                  <textarea name="productIds" rows={5} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary-500" placeholder={"prod-1\nprod-2"} />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">{t('receivedQty')}</label>
                  <textarea name="quantities" rows={5} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary-500" placeholder={"100\n50"} />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">{t('unitCost')}</label>
                  <textarea name="costs" rows={5} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary-500" placeholder={"25.50\n18.00"} />
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button type="button" onClick={() => setShowVerifyModal(false)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">{tc('cancel')}</button>
              <button type="submit" disabled={verifyMutation.isPending} className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 inline-flex items-center gap-2">
                {verifyMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {tc('submit')}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────
import { Fragment } from 'react';

import { useApiError } from '../../../lib/api-error';
function VerificationBadge({ status }: { status: string }) {
  const t = useTranslations('inventory');
  if (status === 'VERIFIED') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
        <CheckCircle2 className="h-3 w-3" /> {t('verified')}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-700">
      <Clock className="h-3 w-3" /> {t('pending')}
    </span>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 overflow-hidden">
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 shrink-0">
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="h-5 w-5" /></button>
        </div>
        <div className="p-6 overflow-y-auto min-h-0">{children}</div>
      </div>
    </div>
  );
}
