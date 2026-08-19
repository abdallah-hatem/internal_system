'use client';

import { useTranslations, useLocale } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { formatDate } from '../../../lib/dates';
import { useToast } from '../../../components/ui/toast';
import { useRouter } from 'next/navigation';
import { useState, useMemo, useEffect } from 'react';
import { Pagination, paginate, PAGE_SIZE } from '../../../components/ui/pagination';
import Link from 'next/link';
import {
  Route, Plus, Search, Eye, ChevronRight, X, Users, ShoppingCart, Truck, Boxes,
  Clock, CheckCircle2, Circle, Loader2, AlertCircle, ChevronDown,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────
interface Cycle {
  id: string;
  code: string;
  originType: string;
  status: string;
  currency: string;
  startedOn: string;
  participants?: any[];
  purchaseOrders?: any[];
  shippingLegs?: any[];
  inventoryBatches?: any[];
}

const STATUS_ORDER = [
  'PLANNING', 'FUNDING', 'PURCHASING', 'IN_TRANSIT', 'ARRIVED_UAE',
  'IN_TRANSIT_TO_EGYPT', 'ARRIVED_EGYPT', 'VERIFICATION', 'SELLING', 'SETTLEMENT', 'CLOSED',
];

const WIZARD_ACTIVE_STATUSES = ['PLANNING', 'FUNDING', 'PURCHASING', 'IN_TRANSIT', 'ARRIVED_UAE', 'IN_TRANSIT_TO_EGYPT', 'ARRIVED_EGYPT'];

const STATUS_COLORS: Record<string, string> = {
  PLANNING: 'bg-gray-100 text-gray-600',
  FUNDING: 'bg-blue-100 text-blue-700',
  PURCHASING: 'bg-indigo-100 text-indigo-700',
  IN_TRANSIT: 'bg-yellow-100 text-yellow-700',
  ARRIVED_UAE: 'bg-amber-100 text-amber-700',
  IN_TRANSIT_TO_EGYPT: 'bg-orange-100 text-orange-700',
  ARRIVED_EGYPT: 'bg-teal-100 text-teal-700',
  VERIFICATION: 'bg-cyan-100 text-cyan-700',
  SELLING: 'bg-green-100 text-green-700',
  SETTLEMENT: 'bg-emerald-100 text-emerald-700',
  CLOSED: 'bg-gray-200 text-gray-700',
  CANCELLED: 'bg-red-100 text-red-700',
};

const STATUS_LABEL_MAP: Record<string, string> = {
  PLANNING: 'planning', FUNDING: 'funding', PURCHASING: 'purchasing',
  IN_TRANSIT: 'inTransit', ARRIVED_UAE: 'arrivedUae',
  IN_TRANSIT_TO_EGYPT: 'inTransitToEgypt', ARRIVED_EGYPT: 'arrivedEgypt',
  VERIFICATION: 'verification', SELLING: 'selling',
  SETTLEMENT: 'settlementStatus', CLOSED: 'closed', CANCELLED: 'cancelled',
};

// ─── Main Page ────────────────────────────────────────────────────────
export default function CyclesPage() {
  const t = useTranslations('cycles');
  const tc = useTranslations('common');
  const locale = useLocale();
  const router = useRouter();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);
  const [viewingCycle, setViewingCycle] = useState<Cycle | null>(null);
  const [showTransitionModal, setShowTransitionModal] = useState(false);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [search, statusFilter]);

  // ── Queries ───────────────────────────────────────────────────────
  const { data: cycles = [], isLoading } = useQuery({
    queryKey: ['cycles'],
    queryFn: () => api.get('/cycles').then((r) => r.data.data ?? r.data),
  });

  const { data: cycleDetail } = useQuery({
    queryKey: ['cycle', viewingCycle?.id],
    queryFn: () =>
      api.get(`/cycles/${viewingCycle!.id}`).then((r) => r.data.data ?? r.data),
    enabled: !!viewingCycle,
  });

  // ── Mutations ─────────────────────────────────────────────────────

  const transitionMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.post(`/cycles/${id}/transition`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cycles'] });
      queryClient.invalidateQueries({ queryKey: ['cycle'] });
      setShowTransitionModal(false);
      setViewingCycle(null);
      toast.success('Cycle status updated');
    },
    onError: (error: any) => {
      toast.error(error?.response?.data?.message || error?.message || 'Transition failed');
    },
  });

  // ── Derived ───────────────────────────────────────────────────────
  const cycleList: Cycle[] = Array.isArray(cycles) ? cycles : [];
  const filtered = cycleList.filter((c) => {
    const matchSearch = !search || c.code?.toLowerCase().includes(search.toLowerCase());
    const matchStatus = !statusFilter || c.status === statusFilter;
    return matchSearch && matchStatus;
  });

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = useMemo(() => paginate(filtered, page), [filtered, page]);

  const getNextStatuses = (currentStatus: string) => {
    const idx = STATUS_ORDER.indexOf(currentStatus);
    if (idx < 0) return [];
    const next: string[] = [];
    // allow next status
    if (idx + 1 < STATUS_ORDER.length) next.push(STATUS_ORDER[idx + 1]);
    // can always cancel if not closed/cancelled
    if (currentStatus !== 'CLOSED' && currentStatus !== 'CANCELLED') next.push('CANCELLED');
    return next;
  };

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
        <Link
          href={`/${locale}/cycles/new`}
          className="inline-flex items-center gap-2 bg-primary-600 text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-primary-700 transition-colors"
        >
          <Plus className="h-4 w-4" />
          {t('create')}
        </Link>
      </div>

      {/* Status filter tabs */}
      <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
        <button
          onClick={() => setStatusFilter('')}
          className={`whitespace-nowrap px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
            statusFilter === '' ? 'bg-primary-600 text-white' : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
          }`}
        >
          {tc('filter')} ({cycleList.length})
        </button>
        {STATUS_ORDER.map((s) => {
          const count = cycleList.filter((c) => c.status === s).length;
          if (count === 0) return null;
          return (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`whitespace-nowrap px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                statusFilter === s ? 'bg-primary-600 text-white' : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
              }`}
            >
              {t(STATUS_LABEL_MAP[s] as any)} ({count})
            </button>
          );
        })}
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
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="text-start px-4 py-3 font-medium text-gray-600">{t('code')}</th>
                <th className="text-start px-4 py-3 font-medium text-gray-600">{t('origin')}</th>
                <th className="text-start px-4 py-3 font-medium text-gray-600">{t('status')}</th>
                <th className="text-start px-4 py-3 font-medium text-gray-600">{t('participants')}</th>
                <th className="text-start px-4 py-3 font-medium text-gray-600">{t('purchases')}</th>
                <th className="text-start px-4 py-3 font-medium text-gray-600">{tc('date')}</th>
                <th className="text-start px-4 py-3 font-medium text-gray-600">{tc('actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-gray-400">{tc('noData')}</td>
                </tr>
              ) : (
                paginated.map((cycle) => {
                  const canResume = WIZARD_ACTIVE_STATUSES.includes(cycle.status);
                  return (
                    <tr
                      key={cycle.id}
                      onClick={() => canResume ? router.push(`/${locale}/cycles/${cycle.id}`) : setViewingCycle(cycle)}
                      className={`transition-colors ${canResume ? 'hover:bg-primary-50 cursor-pointer' : 'hover:bg-gray-50'}`}
                    >
                      <td className="px-4 py-3 font-mono text-xs font-medium text-gray-900">
                        {cycle.code}
                        {canResume && <span className="ml-2 text-[10px] text-primary-500 font-normal">Click to resume</span>}
                      </td>
                      <td className="px-4 py-3 text-gray-600">{cycle.originType === 'CHINA' ? t('china') : t('uaeDirect')}</td>
                      <td className="px-4 py-3">
                        <StatusBadge status={cycle.status} />
                      </td>
                      <td className="px-4 py-3 text-gray-600">{cycle.participants?.length ?? 0}</td>
                      <td className="px-4 py-3 text-gray-600">{cycle.purchaseOrders?.length ?? 0}</td>
                      <td className="px-4 py-3 text-gray-500 text-xs">{formatDate(cycle.startedOn)}</td>
                      <td className="px-4 py-3">
                        {canResume ? (
                          <span className="inline-flex items-center gap-1 text-primary-600 text-sm font-medium">
                            Resume <ChevronRight className="h-4 w-4" />
                          </span>
                        ) : (
                          <button
                            onClick={(e) => { e.stopPropagation(); setViewingCycle(cycle); }}
                            className="inline-flex items-center gap-1 text-primary-600 hover:text-primary-700 text-sm font-medium"
                          >
                            {tc('details')} <ChevronRight className="h-4 w-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Mobile Cards */}
      {!isLoading && (
        <div className="md:hidden space-y-3">
          {filtered.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200 p-12 text-center text-gray-400">{tc('noData')}</div>
          ) : (
            paginated.map((cycle) => {
                const canResume = WIZARD_ACTIVE_STATUSES.includes(cycle.status);
                return (
              <div
                key={cycle.id}
                onClick={() => canResume ? router.push(`/${locale}/cycles/${cycle.id}`) : setViewingCycle(cycle)}
                className={`bg-white rounded-xl border border-gray-200 p-4 transition-shadow ${
                  canResume ? 'cursor-pointer hover:shadow-md border-primary-200' : 'cursor-pointer hover:shadow-md'
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="font-mono text-sm font-bold text-gray-900">{cycle.code}</span>
                  <StatusBadge status={cycle.status} />
                </div>
                <div className="flex items-center gap-4 text-xs text-gray-500">
                  <span>{cycle.originType === 'CHINA' ? t('china') : t('uaeDirect')}</span>
                   <span>{t('participants')}: {cycle.participants?.length ?? 0}</span>
                  <span>{t('purchases')}: {cycle.purchaseOrders?.length ?? 0}</span>
                </div>
                {canResume && (
                  <p className="text-xs text-primary-500 mt-2 font-medium">Tap to resume wizard →</p>
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

      {/* ─── Detail Slide-over ─────────────────────────────────────── */}
      {viewingCycle && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="fixed inset-0 bg-black/50" onClick={() => setViewingCycle(null)} />
          <div className="relative bg-white w-full max-w-2xl h-full overflow-y-auto shadow-xl">
            <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between z-10">
              <div>
                <h2 className="text-lg font-bold text-gray-900">{viewingCycle.code}</h2>
                <p className="text-sm text-gray-500">{viewingCycle.originType === 'CHINA' ? t('china') : t('uaeDirect')}</p>
              </div>
              <button onClick={() => setViewingCycle(null)} className="text-gray-400 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="p-6 space-y-6">
              {/* Status + Transition */}
              <div className="flex items-center justify-between">
                <StatusBadge status={viewingCycle.status} />
                {getNextStatuses(viewingCycle.status).length > 0 && (
                  <button
                    onClick={() => setShowTransitionModal(true)}
                    className="inline-flex items-center gap-1 bg-primary-50 text-primary-700 px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-primary-100"
                  >
                    <Loader2 className="h-3.5 w-3.5" />
                    {t('transition')}
                  </button>
                )}
              </div>

              {/* Timeline */}
              <div>
                <h3 className="text-sm font-semibold text-gray-900 mb-3">{t('timeline')}</h3>
                <div className="relative">
                  <div className="absolute top-3 start-3 end-3 h-0.5 bg-gray-200" />
                  <div className="relative flex justify-between">
                    {STATUS_ORDER.map((s, i) => {
                      const isCurrent = viewingCycle.status === s;
                      const isPast = STATUS_ORDER.indexOf(viewingCycle.status) > i;
                      return (
                        <div key={s} className="flex flex-col items-center" style={{ width: '9%' }}>
                          <div
                            className={`h-6 w-6 rounded-full flex items-center justify-center text-xs font-bold z-10 ${
                              isPast
                                ? 'bg-green-500 text-white'
                                : isCurrent
                                ? 'bg-primary-600 text-white ring-2 ring-primary-200'
                                : 'bg-gray-200 text-gray-500'
                            }`}
                          >
                            {isPast ? <CheckCircle2 className="h-3.5 w-3.5" /> : i + 1}
                          </div>
                          <span className="text-[10px] text-gray-500 mt-1 text-center leading-tight">
                            {t(STATUS_LABEL_MAP[s] as any)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* Info grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <InfoCard icon={Users} label={t('participants')} value={String(cycleDetail?._count?.participants ?? cycleDetail?.participants?.length ?? 0)} />
                <InfoCard icon={ShoppingCart} label={t('purchases')} value={String(cycleDetail?._count?.purchases ?? cycleDetail?.purchases?.length ?? 0)} />
                 <InfoCard icon={Truck} label={t('shipping')} value={String(cycleDetail?.shippingLegs?.length ?? 0)} />
                <InfoCard icon={Boxes} label={t('inventory')} value={String(cycleDetail?.inventoryBatches?.length ?? 0)} />
              </div>

              {/* Participants section */}
              {cycleDetail?.participants && cycleDetail.participants.length > 0 && (
                <Section title={t('participants')}>
                  <div className="space-y-2">
                    {cycleDetail.participants.map((p: any) => (
                      <div key={p.id} className="flex items-center justify-between bg-gray-50 rounded-lg px-4 py-3 text-sm">
                        <div>
                          <p className="font-medium text-gray-900">{p.partner?.displayName ?? p.partnerId}</p>
                          <p className="text-xs text-gray-500">{t('contribution')}: £ {(p.contributionAmount ?? 0).toLocaleString()}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </Section>
              )}

              {/* Purchases section */}
              {cycleDetail?.purchases && cycleDetail.purchases.length > 0 && (
                <Section title={t('purchases')}>
                  <div className="space-y-2">
                    {cycleDetail.purchases.map((po: any) => (
                      <div key={po.id} className="flex items-center justify-between bg-gray-50 rounded-lg px-4 py-3 text-sm">
                        <div>
                          <p className="font-medium text-gray-900">{po.reference}</p>
                          <p className="text-xs text-gray-500">{po.supplier?.name ?? '—'}</p>
                        </div>
                        <StatusBadge status={po.status} />
                      </div>
                    ))}
                  </div>
                </Section>
              )}

              {/* Shipping section */}
              {cycleDetail?.shippingLegs && cycleDetail.shippingLegs.length > 0 && (
                <Section title={t('shipping')}>
                  <div className="space-y-2">
                    {cycleDetail.shippingLegs.map((leg: any) => (
                      <div key={leg.id} className="flex items-center justify-between bg-gray-50 rounded-lg px-4 py-3 text-sm">
                        <div>
                          <p className="font-medium text-gray-900">{leg.origin} → {leg.destination}</p>
                          <p className="text-xs text-gray-500">{leg.provider} • {leg.trackingRef ?? '—'}</p>
                        </div>
                        <StatusBadge status={leg.status} />
                      </div>
                    ))}
                  </div>
                </Section>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ─── Transition Modal ──────────────────────────────────────── */}
      {showTransitionModal && viewingCycle && (
        <Modal title={t('transition')} onClose={() => setShowTransitionModal(false)}>
          <div className="space-y-3">
            <p className="text-sm text-gray-600">
              Current status: <StatusBadge status={viewingCycle.status} />
            </p>
            <div className="space-y-2">
              {getNextStatuses(viewingCycle.status).map((ns) => (
                <button
                  key={ns}
                  onClick={() => transitionMutation.mutate({ id: viewingCycle.id, status: ns })}
                  className={`w-full text-start px-4 py-3 rounded-lg border text-sm font-medium transition-colors ${
                    ns === 'CANCELLED'
                      ? 'border-red-200 text-red-700 hover:bg-red-50'
                      : 'border-primary-200 text-primary-700 hover:bg-primary-50'
                  }`}
                >
                  {t(STATUS_LABEL_MAP[ns] as any)}
                </button>
              ))}
            </div>
            <div className="flex justify-end pt-2">
              <button onClick={() => setShowTransitionModal(false)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">
                {tc('cancel')}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: string }) {
  const labelMap: Record<string, string> = STATUS_LABEL_MAP;
  const label = labelMap[status] ?? status;
  const color = STATUS_COLORS[status] ?? 'bg-gray-100 text-gray-600';

  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${color}`}>
      {label}
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

function InfoCard({ icon: Icon, label, value }: { icon: any; label: string; value: string }) {
  return (
    <div className="bg-gray-50 rounded-xl p-4 text-center">
      <Icon className="h-5 w-5 text-gray-400 mx-auto mb-1" />
      <p className="text-lg font-bold text-gray-900">{value}</p>
      <p className="text-xs text-gray-500">{label}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-900 mb-3">{title}</h3>
      {children}
    </div>
  );
}
