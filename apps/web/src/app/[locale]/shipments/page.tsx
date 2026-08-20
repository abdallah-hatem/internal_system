'use client';

import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { useState, useMemo, useEffect } from 'react';
import { Pagination, paginate, PAGE_SIZE } from '../../../components/ui/pagination';
import { useToast } from '../../../components/ui/toast';
import { ShippingCostFields, readShippingCostFields } from '../../../components/shipping/ShippingCostFields';
import {
  Truck, Plus, Search, Edit, X, Loader2, MapPin, Package, Calendar,
  ArrowRight,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────
interface Shipment {
  id: string;
  cycleId: string;
  cycle?: { code: string };
  sequence: number;
  origin: string;
  destination: string;
  provider: string;
  trackingRef?: string;
  status: string;
  departedOn?: string;
  arrivedOn?: string;
  amount?: number | string | null;
  costBasis?: 'PER_PIECE' | 'PER_WEIGHT' | 'FLAT';
  ratePerUnit?: number | string | null;
  chargeablePieces?: number | string | null;
  chargeableWeightKg?: number | string | null;
  currency?: string;
  fxRateToEgp?: number | string | null;
  amountEgp?: number | string | null;
}

const STATUS_COLORS: Record<string, string> = {
  PENDING: 'bg-gray-100 text-gray-600',
  IN_TRANSIT: 'bg-yellow-100 text-yellow-700',
  ARRIVED: 'bg-green-100 text-green-700',
};

const STATUS_LABELS: Record<string, string> = {
  PENDING: 'pending',
  IN_TRANSIT: 'inTransit',
  ARRIVED: 'arrived',
};

// ─── Main Page ────────────────────────────────────────────────────────
export default function ShipmentsPage() {
  const t = useTranslations('shipments');
  const tc = useTranslations('common');
  const queryClient = useQueryClient();
  const { addToast } = useToast();

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingShipment, setEditingShipment] = useState<Shipment | null>(null);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [search]);

  // ── Queries ───────────────────────────────────────────────────────
  const { data: shipments = [], isLoading } = useQuery({
    queryKey: ['shipments'],
    queryFn: () => api.get('/shipping/legs').then((r) => r.data.data ?? r.data),
  });

  const { data: cycles = [] } = useQuery({
    queryKey: ['cycles'],
    queryFn: () => api.get('/cycles').then((r) => r.data.data ?? r.data),
  });

  const { data: providersData = [] } = useQuery({
    queryKey: ['providers'],
    queryFn: () => api.get('/providers').then((r) => r.data.data ?? r.data),
  });

  // ── Mutations ─────────────────────────────────────────────────────
  const createMutation = useMutation({
    mutationFn: (data: any) => {
      const { cycleId, ...body } = data;
      return api.post(`/cycles/${cycleId}/shipping-legs`, body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['shipments'] });
      setShowCreateModal(false);
      addToast('Shipment created successfully', 'success');
    },
    onError: (error: any) => {
      addToast(error?.response?.data?.message || error?.message || 'Operation failed', 'error');
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...data }: any) => api.put(`/shipping/legs/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['shipments'] });
      setEditingShipment(null);
      addToast('Shipment updated successfully', 'success');
    },
    onError: (error: any) => {
      addToast(error?.response?.data?.message || error?.message || 'Operation failed', 'error');
    },
  });

  // ── Derived ───────────────────────────────────────────────────────
  const shipmentList: Shipment[] = Array.isArray(shipments) ? shipments : [];
  const cycleList: any[] = Array.isArray(cycles) ? cycles : [];
  const providerList: any[] = Array.isArray(providersData) ? providersData : [];

  const filtered = shipmentList.filter((s) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      s.cycle?.code?.toLowerCase().includes(q) ||
      s.provider?.toLowerCase().includes(q) ||
      s.trackingRef?.toLowerCase().includes(q) ||
      s.origin?.toLowerCase().includes(q) ||
      s.destination?.toLowerCase().includes(q)
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
          onClick={() => setShowCreateModal(true)}
          className="inline-flex items-center gap-2 bg-primary-600 text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-primary-700 transition-colors"
        >
          <Plus className="h-4 w-4" />
          {t('create')}
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
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('cycle')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('sequence')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('origin')} → {t('destination')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('provider')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('trackingRef')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('status')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('departedOn')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('arrivedOn')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('amount')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{tc('actions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.length === 0 ? (
                  <tr><td colSpan={10} className="px-4 py-12 text-center text-gray-400">{tc('noData')}</td></tr>
                ) : (
                  paginated.map((ship) => (
                    <tr key={ship.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 font-mono text-xs text-gray-600">{ship.cycle?.code ?? '—'}</td>
                      <td className="px-4 py-3 text-gray-600">#{ship.sequence}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5 text-gray-700">
                          <MapPin className="h-3.5 w-3.5 text-gray-400" />
                          <span>{ship.origin}</span>
                          <ArrowRight className="h-3 w-3 text-gray-400" />
                          <span>{ship.destination}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-600">{ship.provider}</td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-500">{ship.trackingRef ?? '—'}</td>
                      <td className="px-4 py-3">
                        <StatusBadge status={ship.status} />
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs">{ship.departedOn ?? '—'}</td>
                      <td className="px-4 py-3 text-gray-500 text-xs">{ship.arrivedOn ?? '—'}</td>
                      <td className="px-4 py-3 text-gray-700">
                        <LegCost ship={ship} />
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => setEditingShipment(ship)}
                          className="p-1.5 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-colors"
                          title={tc('edit')}
                        >
                          <Edit className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  ))
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
            paginated.map((ship) => (
              <div
                key={ship.id}
                onClick={() => setEditingShipment(ship)}
                className="bg-white rounded-xl border border-gray-200 p-4 cursor-pointer hover:shadow-md transition-shadow"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="font-mono text-xs text-gray-500">{ship.cycle?.code ?? '—'} #{ship.sequence}</span>
                  <StatusBadge status={ship.status} />
                </div>
                <div className="flex items-center gap-1.5 text-sm text-gray-700 mb-1">
                  <MapPin className="h-3.5 w-3.5 text-gray-400" />
                  <span>{ship.origin}</span>
                  <ArrowRight className="h-3 w-3 text-gray-400" />
                  <span>{ship.destination}</span>
                </div>
                <div className="flex items-center gap-3 text-xs text-gray-500">
                  <span>{ship.provider}</span>
                  {ship.trackingRef && <span className="font-mono">{ship.trackingRef}</span>}
                </div>
                <div className="flex items-center justify-between mt-2 pt-2 border-t border-gray-100 text-xs text-gray-500">
                  <span>{ship.departedOn ?? '—'}</span>
                  <span>{ship.arrivedOn ?? '—'}</span>
                  <span className="font-medium text-gray-700">
                    <LegCost ship={ship} />
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Pagination */}
      {!isLoading && filtered.length > 0 && (
        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} totalItems={filtered.length} />
      )}

      {/* ─── Create Modal ──────────────────────────────────────────── */}
      {showCreateModal && (
        <Modal title={t('create')} onClose={() => setShowCreateModal(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              createMutation.mutate({
                cycleId: fd.get('cycleId'),
                sequence: Number(fd.get('sequence')),
                origin: fd.get('origin'),
                destination: fd.get('destination'),
                provider: fd.get('provider'),
                trackingRef: fd.get('trackingRef'),
                ...readShippingCostFields(fd),
              });
            }}
            className="space-y-4"
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('cycle')}</label>
                <select name="cycleId" required className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500">
                  <option value="">—</option>
                  {cycleList.map((c: any) => (
                    <option key={c.id} value={c.id}>{c.code}</option>
                  ))}
                </select>
              </div>
              <InputField label={t('sequence')} name="sequence" type="number" required placeholder="0" />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <InputField label={t('origin')} name="origin" required />
              <InputField label={t('destination')} name="destination" required />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {t('provider')}<span className="text-red-500 ms-1">*</span>
                </label>
                <select name="provider" required className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500">
                  <option value="">—</option>
                  {providerList.map((p: any) => (
                    <option key={p.id} value={p.name}>{p.name}</option>
                  ))}
                </select>
              </div>
              <InputField label={t('trackingRef')} name="trackingRef" />
            </div>

            <ShippingCostFields />

            <div className="flex justify-end gap-3 pt-2">
              <button type="button" onClick={() => setShowCreateModal(false)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">{tc('cancel')}</button>
              <button type="submit" disabled={createMutation.isPending} className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed">
                {createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {tc('create')}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* ─── Edit Modal ────────────────────────────────────────────── */}
      {editingShipment && (
        <Modal title={`${tc('edit')} — ${editingShipment.cycle?.code ?? ''} #${editingShipment.sequence}`} onClose={() => setEditingShipment(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const fd = new FormData(e.currentTarget);
              updateMutation.mutate({
                id: editingShipment.id,
                status: fd.get('status'),
                departedOn: fd.get('departedOn') || null,
                arrivedOn: fd.get('arrivedOn') || null,
                provider: fd.get('provider'),
                trackingRef: fd.get('trackingRef'),
                ...readShippingCostFields(fd),
              });
            }}
            className="space-y-4"
          >
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t('status')}</label>
              <select name="status" defaultValue={editingShipment.status} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500">
                <option value="PENDING">{t('pending')}</option>
                <option value="IN_TRANSIT">{t('inTransit')}</option>
                <option value="ARRIVED">{t('arrived')}</option>
              </select>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <InputField label={t('departedOn')} name="departedOn" type="date" defaultValue={editingShipment.departedOn} />
              <InputField label={t('arrivedOn')} name="arrivedOn" type="date" defaultValue={editingShipment.arrivedOn} />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('provider')}</label>
                <select name="provider" defaultValue={editingShipment.provider} className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500">
                  <option value="">—</option>
                  {providerList.map((p: any) => (
                    <option key={p.id} value={p.name}>{p.name}</option>
                  ))}
                </select>
              </div>
              <InputField label={t('trackingRef')} name="trackingRef" defaultValue={editingShipment.trackingRef} />
            </div>

            <ShippingCostFields
              defaults={{
                costBasis: editingShipment.costBasis ?? 'FLAT',
                ratePerUnit: editingShipment.ratePerUnit ?? '',
                chargeablePieces: editingShipment.chargeablePieces ?? '',
                chargeableWeightKg: editingShipment.chargeableWeightKg ?? '',
                amount: editingShipment.amount ?? '',
                currency: editingShipment.currency ?? 'EGP',
                fxRateToEgp: editingShipment.fxRateToEgp ?? 1,
              }}
            />

            <div className="flex justify-end gap-3 pt-2">
              <button type="button" onClick={() => setEditingShipment(null)} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">{tc('cancel')}</button>
              <button type="submit" disabled={updateMutation.isPending} className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed">
                {updateMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {tc('save')}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}


/** Leg cost in EGP, with the rate that produced it. */
function LegCost({ ship }: { ship: Shipment }) {
  const egp = ship.amountEgp ?? ship.amount;
  if (egp === null || egp === undefined || egp === '') return <span>—</span>;

  const value = Number(egp);
  if (!Number.isFinite(value)) return <span>—</span>;

  const rate = ship.ratePerUnit != null ? Number(ship.ratePerUnit) : null;
  const basisHint =
    ship.costBasis === 'PER_PIECE' && rate != null
      ? `${rate.toLocaleString(undefined, { maximumFractionDigits: 4 })} x ${Number(ship.chargeablePieces ?? 0).toLocaleString()} pcs`
      : ship.costBasis === 'PER_WEIGHT' && rate != null
        ? `${rate.toLocaleString(undefined, { maximumFractionDigits: 4 })} x ${Number(ship.chargeableWeightKg ?? 0).toLocaleString()} kg`
        : null;

  return (
    <span className="inline-flex flex-col leading-tight">
      <span className="font-medium text-gray-800">
        {value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EGP
      </span>
      {basisHint && <span className="text-[11px] text-gray-400">{basisHint}</span>}
    </span>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: string }) {
  const labelKey = STATUS_LABELS[status] ?? status;
  const color = STATUS_COLORS[status] ?? 'bg-gray-100 text-gray-600';

  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${color}`}>
      {labelKey}
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

function InputField({ label, name, type = 'text', defaultValue, required, placeholder }: { label: string; name: string; type?: string; defaultValue?: string; required?: boolean; placeholder?: string }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label}
        {required ? <span className="text-red-500 ms-1">*</span> : <span className="text-gray-400 ms-1 text-xs font-normal">(Optional)</span>}
      </label>
      <input type={type} name={name} defaultValue={defaultValue} required={required} placeholder={placeholder}
        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500" />
    </div>
  );
}
