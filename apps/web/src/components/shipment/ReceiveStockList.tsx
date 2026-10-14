'use client';
import { useAllRecords } from '@/lib/list-all';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { localName } from '@/lib/localized-name';
import { useQueries } from '@tanstack/react-query';
import { PackageCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { useCodeLabel } from '@/lib/labels';
import { useDateFormat } from '@/lib/dates';
import { Link } from '@/i18n/navigation';
import { EmptyState } from '@/components/ui/empty-state';
import { ReceiveDeliveryDialog } from './ReceiveDeliveryDialog';
import {
  RECEIVING_STATUSES,
  mayHaveWaiting,
  receivableByLine,
  waitingDeliveries,
  type Shipment,
} from './shipment-model';

/**
 * "Receive stock" on the inventory page (UX #4, BUSINESS_LOGIC §3).
 *
 * Every last-leg delivery, across cycles, with something still to be counted
 * into stock — oldest first — each opening the same Receive dialog the cycle
 * page uses. It replaced a dialog that asked for product IDs typed by hand.
 *
 * It reads each candidate cycle's shipment through the same query the cycle
 * page's panel uses, so receiving in either place refreshes both.
 */
export function ReceiveStockList() {
  const t = useTranslations('shipment');
  const locale = useLocale();
  const codeLabel = useCodeLabel();
  const { formatDate } = useDateFormat();
  const [open, setOpen] = useState<{ cycleId: string; legId: string; deliveryId: string } | null>(null);

  const { items: cycles, isLoading: cyclesLoading } = useAllRecords<{ id: string; status: string }>(
    ['cycles'],
    '/cycles',
  );
  const candidates = (Array.isArray(cycles) ? cycles : []).filter((c) => mayHaveWaiting(c.status));

  const shipments = useQueries({
    queries: candidates.map((c) => ({
      queryKey: ['shipment', c.id],
      queryFn: () => api.get(`/cycles/${c.id}/shipment`).then((r) => r.data.data ?? r.data) as Promise<Shipment>,
    })),
  });
  const loading = cyclesLoading || shipments.some((q) => q.isLoading);
  const loaded = shipments.map((q) => q.data).filter((s): s is Shipment => !!s);
  const rows = waitingDeliveries(loaded);

  const names = (s: Shipment | undefined) =>
    Object.fromEntries((s?.lines ?? []).map((l) => [l.purchaseOrderItemId, localName({ name: l.productName, nameAr: l.productNameAr }, locale) || '—']));

  const openShipment = open ? loaded.find((s) => s.cycleId === open.cycleId) : undefined;
  const openLeg = openShipment?.legs.find((l) => l.legId === open?.legId);
  const openDelivery = openLeg?.deliveries.find((d) => d.id === open?.deliveryId);

  return (
    <section data-testid="receive-stock-list" className="rounded-xl border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">{t('waitingTitle')}</h2>
        <p className="text-xs text-muted-foreground">{t('waitingHint')}</p>
      </div>
      {loading ? (
        <div className="space-y-2 p-4" aria-hidden="true">
          <div className="h-12 animate-pulse rounded-lg bg-muted" />
          <div className="h-12 animate-pulse rounded-lg bg-muted" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState title={t('nothingWaiting')} description={t('nothingWaitingHint')} icon={PackageCheck} />
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((row) => {
            const shipment = loaded.find((s) => s.cycleId === row.cycleId);
            const productNames = names(shipment);
            const receivable = receivableByLine(row.delivery, row.leg);
            const canReceive = RECEIVING_STATUSES.includes(row.cycleStatus);
            return (
              <li
                key={row.delivery.id}
                data-testid="waiting-delivery"
                data-cycle={row.cycleCode}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm"
              >
                <div className="min-w-0">
                  <p className="font-medium text-foreground">
                    <span className="font-mono">{row.cycleCode}</span>
                    <span className="ms-2 text-muted-foreground">
                      {t('legHeading', { leg: row.leg.sequence })} · {formatDate(row.delivery.arrivedOn)}
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {row.delivery.lines
                      .filter((l) => receivable[l.id] > 0)
                      .map((l) => t('waitingLine', { product: productNames[l.purchaseOrderItemId] ?? '—', qty: receivable[l.id] }))
                      .join(' · ')}
                  </p>
                  {!canReceive && (
                    <p className="text-xs text-muted-foreground">
                      {t('cycleNotArrived', { status: codeLabel('cycleStatus', row.cycleStatus) })}
                    </p>
                  )}
                </div>
                {canReceive ? (
                  <button
                    type="button"
                    data-testid="receive-delivery"
                    onClick={() => setOpen({ cycleId: row.cycleId, legId: row.leg.legId, deliveryId: row.delivery.id })}
                    className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 sm:min-h-0"
                  >
                    <PackageCheck className="h-4 w-4" aria-hidden="true" /> {t('receiveIntoStock')}
                  </button>
                ) : (
                  <Link
                    href={`/cycles/${row.cycleId}/details`}
                    className="inline-flex min-h-11 cursor-pointer items-center rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted sm:min-h-0"
                  >
                    {t('openCycle')}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {open && openShipment && openLeg && openDelivery && (
        <ReceiveDeliveryDialog
          cycleId={open.cycleId}
          leg={openLeg}
          delivery={openDelivery}
          productNames={names(openShipment)}
          onClose={() => setOpen(null)}
        />
      )}
    </section>
  );
}
