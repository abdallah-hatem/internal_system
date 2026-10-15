'use client';
import { NoMatch } from '@/components/ui/no-match';
import { LatinText } from '@/components/ui/latin-text';
import { useAllRecords } from '@/lib/list-all';
import { ListCapNotice } from '@/components/ui/list-cap-notice';

import { useTranslations } from 'next-intl';
import { useState, useMemo, useEffect } from 'react';
import { Pagination, paginate, PAGE_SIZE } from '../../../components/ui/pagination';
import {
  Plus, Search, Edit, MapPin,
} from 'lucide-react';
import { LoadingStatus, Skeleton, SkeletonGroup, SkeletonText, repeat } from '@/components/ui/skeleton';
import { LegRoute } from '@/components/shipment/LegRoute';
import { Money } from '@/components/ui/money';
import { useNumberFormat } from '@/lib/numbers';

import { useDateFormat } from '../../../lib/dates';
import { useCodeLabel } from '../../../lib/labels';
import { LegCreateForm, LegEditForm, LegFormModal, type LegRow } from '@/components/shipment/LegForm';
import { EmptyState } from '@/components/ui/empty-state';
import { useCan } from '@/lib/can';
// ─── Types ────────────────────────────────────────────────────────────
/** A leg as the list returns it — the shared leg forms' own type. */
type Shipment = LegRow;

const STATUS_COLORS: Record<string, string> = {
  PENDING: 'bg-gray-100 text-gray-600',
  PARTLY_DEPARTED: 'bg-sky-100 text-sky-700',
  IN_TRANSIT: 'bg-yellow-100 text-yellow-700',
  PARTLY_ARRIVED: 'bg-amber-100 text-amber-700',
  ARRIVED: 'bg-green-100 text-green-700',
};


// ─── Skeletons ────────────────────────────────────────────────────────
// The leg row and card below, traced: cycle and leg number, route, provider,
// tracking, status badge, two dates, the two-line cost, and the 28px edit
// button when the reader may edit. Change one, change the other.

/**
 * LegCost: the amount over its 11px basis line, both `leading-tight`.
 * Measured, not derived: in the table cell the inline-flex sits on a text-sm
 * baseline and takes 34.25px; in the card's text-xs footer it is a flex item
 * of 15 + 13.75px.
 */
function LegCostSkeleton({ inCard = false }: { inCard?: boolean }) {
  return (
    <div className="flex flex-col">
      <SkeletonText size={inCard ? 'xs' : 'sm'} className="w-20" lineClassName={inCard ? 'h-[15px]' : 'h-5'} />
      <SkeletonText size="xs" className="w-16 h-2" lineClassName={inCard ? 'h-[13.75px]' : 'h-[14.25px]'} />
    </div>
  );
}

function ShipmentRowSkeleton({ edit }: { edit: boolean }) {
  return (
    <tr data-testid="skeleton-row" className="[&>td:first-child]:ps-4 [&>td:last-child]:pe-4">
      <td className="px-2.5 py-3"><SkeletonText className="w-20" /></td>
      <td className="px-2.5 py-3"><SkeletonText className="w-40" /></td>
      <td className="px-2.5 py-3"><SkeletonText className="w-20" /></td>
      <td className="px-2.5 py-3"><SkeletonText size="xs" className="w-20" /></td>
      <td className="px-2.5 py-3"><Skeleton className="h-5 w-20 rounded-full" /></td>
      <td className="px-2.5 py-3"><SkeletonText size="xs" className="w-16" /></td>
      <td className="px-2.5 py-3"><SkeletonText size="xs" className="w-16" /></td>
      <td className="px-2.5 py-3"><LegCostSkeleton /></td>
      {edit && <td className="px-2.5 py-3"><Skeleton className="size-7 rounded-lg" /></td>}
    </tr>
  );
}

function ShipmentCardSkeleton() {
  return (
    <div data-testid="skeleton-row" className="bg-card rounded-xl border border-border p-4">
      <div className="flex items-center justify-between mb-2">
        <SkeletonText size="xs" className="w-24" />
        <Skeleton className="h-5 w-20 rounded-full" />
      </div>
      <SkeletonText className="w-48" lineClassName="mb-1" />
      <SkeletonText size="xs" className="w-28" />
      <div className="flex items-center justify-between mt-2 pt-2 border-t border-muted">
        <SkeletonText size="xs" className="w-16" />
        <SkeletonText size="xs" className="w-16" />
        <LegCostSkeleton inCard />
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────
export default function ShipmentsPage() {
  const { formatDate } = useDateFormat();
  const t = useTranslations('shipments');
  const tc = useTranslations('common');
  // An investor reads their cycles' legs; adding and editing one are a partner's (R1c).
  const may = { create: useCan('shippingLeg.create'), edit: useCan('shippingLeg.edit') };

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingShipment, setEditingShipment] = useState<Shipment | null>(null);

  // Each form is mounted fresh on open and dropped on close, so nothing typed
  // into one — a provider, a departure — survives into the next (§13).
  const openEdit = (ship: Shipment) => setEditingShipment(ship);
  const closeEdit = () => setEditingShipment(null);
  const openCreate = () => setShowCreateModal(true);
  const closeCreate = () => setShowCreateModal(false);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [search]);

  // ── Queries ───────────────────────────────────────────────────────
  // The page searches and pages on the client, so it needs the whole list,
  // not the API's default first 20: with more legs than that, a leg could be
  // absent from the page and its own cycle code found nothing (L1).
  const { items: shipments, capped, isLoading } = useAllRecords(['shipments'], '/shipping/legs');
  const { items: cycles } = useAllRecords(['cycles'], '/cycles');

  // ── Derived ───────────────────────────────────────────────────────
  const shipmentList: Shipment[] = Array.isArray(shipments) ? shipments : [];
  const cycleList: any[] = Array.isArray(cycles) ? cycles : [];

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

  // Nothing at all says what goes here and offers the first one; nothing for
  // this search or filter says only that (UX #12).
  const emptyList =
    shipmentList.length === 0 ? (
      <EmptyState
        title={t('emptyTitle')}
        description={t('emptyHint')}
        action={may.create ? { label: t('create'), onClick: openCreate } : undefined}
      />
    ) : (
      <NoMatch onClear={() => setSearch('')} />
    );

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
        {may.create && (
        <button
          type="button"
          data-testid="create-action"
          onClick={openCreate}
          className="inline-flex items-center gap-2 bg-primary-600 text-white px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-primary-700 transition-colors cursor-pointer"
        >
          <Plus className="h-4 w-4" />
          {t('create')}
        </button>
        )}
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

      <ListCapNotice capped={capped} count={shipments.length} />

      {/* Loading: the table's own header over skeleton rows, skeleton cards on a phone. */}
      {isLoading && <LoadingStatus />}

      {/* Desktop Table */}
        <div className="hidden md:block bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 [&>th:first-child]:ps-4 [&>th:last-child]:pe-4">
                  <th className="text-start px-2.5 py-3 font-medium text-gray-600 whitespace-nowrap">{t('cycle')}</th>
                  <th className="text-start px-2.5 py-3 font-medium text-gray-600 whitespace-nowrap">{t('route')}</th>
                  <th className="text-start px-2.5 py-3 font-medium text-gray-600 whitespace-nowrap">{t('provider')}</th>
                  <th className="text-start px-2.5 py-3 font-medium text-gray-600 whitespace-nowrap">{t('trackingRef')}</th>
                  <th className="text-start px-2.5 py-3 font-medium text-gray-600 whitespace-nowrap">{t('status')}</th>
                  <th className="text-start px-2.5 py-3 font-medium text-gray-600 whitespace-nowrap">{t('departedOn')}</th>
                  <th className="text-start px-2.5 py-3 font-medium text-gray-600 whitespace-nowrap">{t('arrivedOn')}</th>
                  <th className="text-start px-2.5 py-3 font-medium text-gray-600 whitespace-nowrap">{t('amount')}</th>
                  {may.edit && <th className="text-start px-2.5 py-3 font-medium text-gray-600 whitespace-nowrap">{tc('actions')}</th>}
                </tr>
              </thead>
              {isLoading ? (
                <SkeletonGroup as="tbody" className="divide-y divide-muted">
                  {repeat(PAGE_SIZE, (i) => <ShipmentRowSkeleton key={i} edit={may.edit} />)}
                </SkeletonGroup>
              ) : (
              <tbody className="divide-y divide-gray-100">
                {filtered.length === 0 ? (
                  <tr><td colSpan={may.edit ? 9 : 8}>{emptyList}</td></tr>
                ) : (
                  paginated.map((ship) => (
                    <tr key={ship.id} className="hover:bg-gray-50 transition-colors [&>td:first-child]:ps-4 [&>td:last-child]:pe-4">
                      {/* Short values never wrap (UI audit #29): a code, a date or an
                          amount split over two lines while the route column had room.
                          The leg number shares the cycle's cell, as on the phone card,
                          so the table fits its card at 1440 with the route on one line
                          (re-audit N1). */}
                      <td className="px-2.5 py-3 text-gray-600 whitespace-nowrap">
                        <bdi className="font-mono text-xs">{ship.cycle?.code ?? '—'}</bdi>{' '}
                        <bdi data-testid="leg-sequence" className="text-xs text-gray-500">#{ship.sequence}</bdi>
                      </td>
                      <td className="px-2.5 py-3 whitespace-nowrap">
                        <div className="flex items-center gap-1.5 text-gray-700">
                          <MapPin aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                          <LegRoute nowrap origin={ship.origin} destination={ship.destination} />
                        </div>
                      </td>
                      <td className="px-2.5 py-3 text-gray-600"><LatinText>{ship.provider}</LatinText></td>
                      <td className="px-2.5 py-3 font-mono text-xs text-gray-500 whitespace-nowrap"><bdi>{ship.trackingRef ?? '—'}</bdi></td>
                      <td className="px-2.5 py-3 whitespace-nowrap">
                        <StatusBadge status={ship.status} />
                      </td>
                      <td className="px-2.5 py-3 text-gray-500 text-xs whitespace-nowrap">{formatDate(ship.departedOn)}</td>
                      <td className="px-2.5 py-3 text-gray-500 text-xs whitespace-nowrap">{formatDate(ship.arrivedOn)}</td>
                      <td className="px-2.5 py-3 text-gray-700 whitespace-nowrap">
                        <LegCost ship={ship} />
                      </td>
                      {may.edit && (
                      <td className="px-2.5 py-3">
                        <button
                          type="button"
                          data-testid="edit-action"
                          onClick={() => openEdit(ship)}
                          className="p-1.5 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-colors cursor-pointer"
                          title={tc('edit')}
                        >
                          <Edit className="h-4 w-4" />
                        </button>
                      </td>
                      )}
                    </tr>
                  ))
                )}
              </tbody>
              )}
            </table>
          </div>
        </div>

      {/* Mobile Cards */}
      {isLoading && (
        <SkeletonGroup className="md:hidden space-y-3">
          {repeat(PAGE_SIZE, (i) => <ShipmentCardSkeleton key={i} />)}
        </SkeletonGroup>
      )}
      {!isLoading && (
        <div className="md:hidden space-y-3">
          {filtered.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200">{emptyList}</div>
            ) : (
            paginated.map((ship) => (
              <div
                key={ship.id}
                data-testid={may.edit ? 'edit-action' : undefined}
                onClick={may.edit ? () => openEdit(ship) : undefined}
                className={`bg-white rounded-xl border border-gray-200 p-4 ${may.edit ? 'cursor-pointer hover:shadow-md transition-shadow' : ''}`}
              >
                <div className="flex items-center justify-between mb-2">
                  <bdi className="font-mono text-xs text-gray-500">{ship.cycle?.code ?? '—'} #{ship.sequence}</bdi>
                  <StatusBadge status={ship.status} />
                </div>
                <div className="flex items-center gap-1.5 text-sm text-gray-700 mb-1">
                  <MapPin aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                  <LegRoute origin={ship.origin} destination={ship.destination} />
                </div>
                <div className="flex items-center gap-3 text-xs text-gray-500">
                  <LatinText>{ship.provider}</LatinText>
                  {ship.trackingRef && <bdi className="font-mono">{ship.trackingRef}</bdi>}
                </div>
                <div className="flex items-center justify-between mt-2 pt-2 border-t border-gray-100 text-xs text-gray-500">
                  {/* Through formatDate, not raw. These printed
                      "2026-08-13T00:00:00.000Z" straight onto the card. */}
                  <span>{formatDate(ship.departedOn)}</span>
                  <span>{formatDate(ship.arrivedOn)}</span>
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
      {/* The leg forms are defined once and shared with the cycle page (§13). */}
      {showCreateModal && (
        <LegFormModal title={t('create')} onClose={closeCreate} testId="create">
          <LegCreateForm cycles={cycleList} onDone={closeCreate} />
        </LegFormModal>
      )}

      {/* ─── Edit Modal ────────────────────────────────────────────── */}
      {editingShipment && (
        <LegFormModal
          title={`${tc('edit')} — ${editingShipment.cycle?.code ?? ''} #${editingShipment.sequence}`}
          onClose={closeEdit}
          testId="edit"
        >
          <LegEditForm leg={editingShipment} onDone={closeEdit} />
        </LegFormModal>
      )}
    </div>
  );
}


/**
 * Leg cost in EGP, with the rate that produced it.
 *
 * The amount goes through `Money`, and the basis line ("22 × 180 kg") is a
 * translated string with its unit in the reader's language — it was English,
 * and its Latin run scrambled inside Arabic (UI audit #23).
 */
function LegCost({ ship }: { ship: Shipment }) {
  const t = useTranslations('shipments');
  const { formatNumber } = useNumberFormat();
  const egp = ship.amountEgp ?? ship.amount;
  if (egp === null || egp === undefined || egp === '') return <span>—</span>;

  const value = Number(egp);
  if (!Number.isFinite(value)) return <span>—</span>;

  // Latin digits in both languages (the app's rule for Arabic).
  const fmt = (n: number, max = 0) => formatNumber(n, { maximumFractionDigits: max });
  const rate = ship.ratePerUnit != null ? Number(ship.ratePerUnit) : null;
  const basisHint =
    ship.costBasis === 'PER_PIECE' && rate != null
      ? t('basisPerPiece', { rate: fmt(rate, 4), qty: fmt(Number(ship.chargeablePieces ?? 0)) })
      : ship.costBasis === 'PER_WEIGHT' && rate != null
        ? t('basisPerWeight', { rate: fmt(rate, 4), qty: fmt(Number(ship.chargeableWeightKg ?? 0), 3) })
        : null;

  return (
    <span className="inline-flex flex-col leading-tight">
      <Money value={value} className="font-medium text-gray-800 whitespace-nowrap" />
      {basisHint && <span data-testid="leg-cost-basis" className="text-[11px] text-gray-400 whitespace-nowrap">{basisHint}</span>}
    </span>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: string }) {
  const codeLabel = useCodeLabel();
  const labelKey = codeLabel('legStatus', status);
  const color = STATUS_COLORS[status] ?? 'bg-gray-100 text-gray-600';

  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${color}`}>
      {labelKey}
    </span>
  );
}

