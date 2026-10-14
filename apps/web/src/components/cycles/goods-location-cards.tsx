'use client';

import { useMemo } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { localName } from '@/lib/localized-name';
import type { LucideIcon } from 'lucide-react';
import { ArrowRightLeft, Factory, PackageX, ShoppingBag, Ship, Store, Truck, Warehouse } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import type { Shipment } from '@/components/shipment/shipment-model';
import { LatinText } from '@/components/ui/latin-text';
import { useNumberFormat } from '@/lib/numbers';
import { locateGoods, type GoodsBuckets, type LocationBatch, type LocationTransfer } from './goods-location';

type Place = 'inChina' | 'toUae' | 'inUae' | 'toEgypt' | 'inEgypt' | 'sold' | 'lost' | 'moved';

/** Icon and badge colour per place, in the dashboard tiles' look. */
const LOOK: Record<Place, { icon: LucideIcon; color: string }> = {
  inChina: { icon: Factory, color: 'bg-slate-500' },
  toUae: { icon: Ship, color: 'bg-sky-500' },
  inUae: { icon: Warehouse, color: 'bg-amber-500' },
  toEgypt: { icon: Truck, color: 'bg-indigo-500' },
  inEgypt: { icon: Store, color: 'bg-emerald-600' },
  sold: { icon: ShoppingBag, color: 'bg-green-500' },
  lost: { icon: PackageX, color: 'bg-rose-500' },
  moved: { icon: ArrowRightLeft, color: 'bg-violet-500' },
};

/**
 * Columns per number of cards, so no row is left half empty: four in one row;
 * five in a row from 1024px; six in two rows of three, then one row from
 * 1280px; seven in a row from 1280px. Written out whole for Tailwind.
 */
const GRID: Record<number, string> = {
  4: 'sm:grid-cols-4',
  5: 'sm:grid-cols-3 lg:grid-cols-5',
  6: 'sm:grid-cols-3 xl:grid-cols-6',
  7: 'sm:grid-cols-4 xl:grid-cols-7',
  8: 'sm:grid-cols-4 xl:grid-cols-8',
};

/**
 * The places a cycle of this route shows, in the order the goods travel. Lost
 * only when something was; Moved to another cycle (§8, L5) only when something was.
 */
export function placesFor(direct: boolean, totals: GoodsBuckets): Place[] {
  const places: Place[] = direct
    ? ['inUae', 'toEgypt', 'inEgypt', 'sold']
    : ['inChina', 'toUae', 'inUae', 'toEgypt', 'inEgypt', 'sold'];
  if (totals.lost > 0) places.push('lost');
  if (totals.moved > 0) places.push('moved');
  return places;
}

/**
 * Where the cycle's goods are, at the top of its page (I3, layout A, chosen by
 * the owner 2026-10-11): a card per place with the cycle's total, then the same
 * places per product — a table, or a small card per product on a phone.
 *
 * Every figure is `locateGoods` over the shipment the page already holds and
 * the cycle's own batches: nothing is entered, nothing is fetched.
 */
export function GoodsLocationCards({
  originType,
  shipment,
  batches,
  transfers,
}: {
  originType: string;
  shipment: Shipment | undefined;
  batches: LocationBatch[];
  /** Leftovers moved out of and into this cycle (§8, L5) — `GET /cycles/:id/transfers`. */
  transfers?: { out: LocationTransfer[]; in: LocationTransfer[] };
}) {
  const t = useTranslations('goodsLocation');
  const locale = useLocale();
  const { formatNumber } = useNumberFormat();
  const located = useMemo(
    () => locateGoods({ originType, shipment, batches, transfers }),
    [originType, shipment, batches, transfers],
  );
  if (!shipment || (located.products.length === 0 && located.fromCycles.length === 0)) return null;

  const fmt = (n: number) => formatNumber(n, { maximumFractionDigits: 3 });
  const places = placesFor(located.direct, located.totals);
  const { totals } = located;

  return (
    <section data-testid="goods-location" aria-label={t('title')} className="space-y-3">
      <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
      {located.products.length > 0 && (
        <>
          <div data-testid="location-cards" className={`grid grid-cols-2 gap-3 ${GRID[places.length] ?? GRID[6]}`}>
            {places.map((place) => {
              const { icon: Icon, color } = LOOK[place];
              return (
                <div key={place} data-testid="location-card" data-place={place} className="min-h-11 rounded-xl border border-border bg-card p-3 sm:p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-muted-foreground sm:text-sm">{t(place)}</p>
                      <p data-testid="location-value" className="mt-1 text-base font-bold tabular-nums text-card-foreground sm:text-2xl">
                        <bdi dir="ltr">{fmt(totals[place])}</bdi>
                      </p>
                      {place === 'inEgypt' && totals.notCheckedIn > 0 && (
                        <p data-testid="location-not-checked-in" className="mt-0.5 text-xs text-muted-foreground">
                          {t('notCheckedIn', { count: fmt(totals.notCheckedIn) })}
                        </p>
                      )}
                    </div>
                    {/* In a row of six or seven there is no room for the badge beside the label. */}
                    <div
                      className={`${color} hidden shrink-0 rounded-lg p-2 sm:block ${places.length >= 6 ? 'xl:hidden' : ''}`}
                      aria-hidden="true"
                    >
                      <Icon className="size-4 text-primary-foreground" />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Per product: a table from 640px up, a card per product below it. */}
          <div className="hidden overflow-x-auto rounded-xl border border-border bg-card sm:block">
            <table data-testid="location-table" className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="px-4 py-2 text-start font-medium">{t('product')}</th>
                  <th className="px-3 py-2 text-end font-medium">{t('ordered')}</th>
                  {places.map((place) => (
                    <th key={place} className="px-3 py-2 text-end font-medium">{t(place)}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {located.products.map((p) => (
                  <tr key={p.productId} data-testid="location-row" data-product={p.productName}>
                    {/* Wraps rather than truncates: at 1024px eight columns left the name three letters. */}
                    <td className="min-w-40 break-words px-4 py-2 font-medium text-foreground">
                      <LatinText>{localName({ name: p.productName, nameAr: p.productNameAr }, locale)}</LatinText>
                    </td>
                    <td data-place="ordered" className="px-3 py-2 text-end tabular-nums text-foreground">{fmt(p.ordered)}</td>
                    {places.map((place) => (
                      <td key={place} data-place={place} className="px-3 py-2 text-end tabular-nums text-foreground">
                        {fmt(p[place])}
                        {place === 'inEgypt' && p.notCheckedIn > 0 && (
                          <span className="block text-xs font-normal text-muted-foreground">
                            {t('notCheckedIn', { count: fmt(p.notCheckedIn) })}
                          </span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="space-y-2 sm:hidden">
            {located.products.map((p) => (
              <li key={p.productId} data-testid="location-product-card" data-product={p.productName} className="rounded-lg border border-border bg-card p-3">
                <p className="break-words text-sm font-medium text-foreground">
                  <LatinText>{localName({ name: p.productName, nameAr: p.productNameAr }, locale)}</LatinText>
                </p>
                <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <dt className="text-muted-foreground">{t('ordered')}</dt>
                    <dd data-place="ordered" className="font-medium tabular-nums text-foreground">{fmt(p.ordered)}</dd>
                  </div>
                  {places.map((place) => (
                    <div key={place}>
                      <dt className="text-muted-foreground">{t(place)}</dt>
                      <dd data-place={place} className="font-medium tabular-nums text-foreground">{fmt(p[place])}</dd>
                    </div>
                  ))}
                </dl>
                {p.notCheckedIn > 0 && (
                  <p className="mt-2 text-xs text-muted-foreground">{t('notCheckedIn', { count: fmt(p.notCheckedIn) })}</p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {/* Leftovers another cycle moved in at their cost — not part of what this cycle ordered (§8, L5). */}
      {located.fromCycles.length > 0 && (
        <ul data-testid="location-from-cycles" className="space-y-2">
          {located.fromCycles.map((f) => (
            <li
              key={f.cycleId}
              data-testid="location-from-cycle"
              data-cycle={f.cycleCode}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-card px-3 py-2 text-sm"
            >
              <ArrowRightLeft className="h-4 w-4 shrink-0 text-muted-foreground rtl:-scale-x-100" aria-hidden="true" />
              <span className="font-medium text-foreground">
                {t.rich('fromCycle', {
                  code: () => (
                    <Link href={`/cycles/${f.cycleId}/details`} className="font-mono underline-offset-2 hover:underline">
                      <bdi dir="ltr">{f.cycleCode}</bdi>
                    </Link>
                  ),
                })}
              </span>
              <span className="text-muted-foreground">
                {t('fromCycleUnits', {
                  units: fmt(f.units),
                  onShelf: fmt(f.onShelf),
                  sold: fmt(f.sold),
                })}
              </span>
              {f.movedOn > 0 && (
                <span className="text-muted-foreground">{t('fromCycleMovedOn', { count: fmt(f.movedOn) })}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
