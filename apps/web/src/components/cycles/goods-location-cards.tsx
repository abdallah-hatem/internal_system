'use client';

import { useMemo } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { localName } from '@/lib/localized-name';
import type { IconComponent } from '@/components/ui/icons';
import { ArrowRightLeft, Factory, PackageX, ShoppingBag, Ship, Store, Truck, Warehouse } from '@/components/ui/icons';
import { Link } from '@/i18n/navigation';
import type { Shipment } from '@/components/shipment/shipment-model';
import { LatinText } from '@/components/ui/latin-text';
import { useNumberFormat } from '@/lib/numbers';
import { Skeleton, SkeletonText, repeat } from '@/components/ui/skeleton';
import { DataTable, type Column } from '@/components/ui/data-table';
import { locateGoods, type GoodsBuckets, type LocationBatch, type LocationTransfer } from './goods-location';

type Place = 'inChina' | 'toUae' | 'inUae' | 'toEgypt' | 'inEgypt' | 'sold' | 'lost' | 'moved';

/** Icon and badge colour per place, in the dashboard tiles' look. */
const LOOK: Record<Place, { icon: IconComponent; color: string }> = {
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
 * 1024px (the badge sits above the label, owner 2026-10-19); seven in a row from 1280px. Written out whole for Tailwind.
 */
const GRID: Record<number, string> = {
  4: 'sm:grid-cols-4',
  5: 'sm:grid-cols-3 lg:grid-cols-5',
  6: 'sm:grid-cols-3 lg:grid-cols-6',
  7: 'sm:grid-cols-4 xl:grid-cols-7',
  8: 'sm:grid-cols-4 xl:grid-cols-8',
};

/**
 * Each place's column width in the per-product table: its title on one line
 * in English and Arabic ("To Egypt", "إلى الإمارات"; longer titles before 2026-10-19).
 */
const PLACE_WIDTH: Record<Place | 'ordered', string> = {
  ordered: '5rem',
  inChina: '5rem',
  toUae: '8.25rem',
  inUae: '5rem',
  toEgypt: '8.75rem',
  inEgypt: '6rem',
  sold: '4rem',
  lost: '4rem',
  moved: '7.5rem',
};

type ProductRow = ReturnType<typeof locateGoods>['products'][number];

/**
 * The per-product table's columns (components/ui/data-table.tsx): the product
 * — which takes what is left and wraps to two lines — then Ordered and a
 * column per place. Counts never cut.
 */
function useLocationColumns(places: Place[], fmt: (n: number) => string): Column<ProductRow>[] {
  const t = useTranslations('goodsLocation');
  const locale = useLocale();
  return [
    {
      key: 'product', header: t('product'), width: 'auto', kind: 'name', className: 'font-medium text-foreground',
      title: (p) => localName({ name: p.productName, nameAr: p.productNameAr }, locale),
      skeleton: { kind: 'text', share: 'w-2/3' },
      cell: (p) => <LatinText>{localName({ name: p.productName, nameAr: p.productNameAr }, locale)}</LatinText>,
    },
    {
      key: 'ordered', header: t('ordered'), width: PLACE_WIDTH.ordered, kind: 'value', align: 'end', className: 'text-foreground',
      cellProps: () => ({ 'data-place': 'ordered' }), skeleton: { kind: 'text', share: 'w-1/3' },
      cell: (p) => fmt(p.ordered),
    },
    ...places.map((place): Column<ProductRow> => ({
      key: place, header: t(place), width: PLACE_WIDTH[place], align: 'end', className: 'tabular-nums text-foreground',
      cellProps: () => ({ 'data-place': place }), skeleton: { kind: 'text', share: 'w-1/3' },
      cell: (p) => (
        <>
          <span className="whitespace-nowrap">{fmt(p[place])}</span>
          {place === 'inEgypt' && p.notCheckedIn > 0 && (
            <span className="block text-xs font-normal text-muted-foreground">
              {t('notCheckedIn', { count: fmt(p.notCheckedIn) })}
            </span>
          )}
        </>
      ),
    })),
  ];
}

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
  const locationColumns = useLocationColumns(
    placesFor(located.direct, located.totals),
    (n) => formatNumber(n, { maximumFractionDigits: 3 }),
  );
  if (!shipment || (located.products.length === 0 && located.fromCycles.length === 0)) return null;

  const fmt = (n: number) => formatNumber(n, { maximumFractionDigits: 3 });
  const places = placesFor(located.direct, located.totals);
  const { totals } = located;
  const columns = locationColumns;

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
                  {/* Option A (owner 2026-10-19): the badge above the label, so six fit in
                      one row without the badge being dropped or the cards stretched. */}
                  <div data-testid="location-badge" className={`${color} mb-2 flex size-8 items-center justify-center rounded-lg`} aria-hidden="true">
                    <Icon className="size-4 text-primary-foreground" />
                  </div>
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
                </div>
              );
            })}
          </div>

          {/* Per product: a table from 640px up, a card per product below it. */}
          <DataTable
            className="hidden sm:block bg-card"
            density="dense"
            autoMin="10rem"
            tableTestId="location-table"
            rows={located.products}
            rowKey={(p) => p.productId}
            rowProps={(p) => ({ 'data-testid': 'location-row', 'data-product': p.productName })}
            columns={columns}
          />
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

/**
 * The section above, traced, for the cycle page while the cycle loads: the
 * heading, a card per place (six on a China route, four on a UAE one — the
 * caller says which, from the cycle list it came from; China when it cannot)
 * and the per-product table, or a card per product on a phone. The labels are
 * the real ones; only the figures wait.
 */
export function GoodsLocationSkeleton({ direct = false, products = 2 }: { direct?: boolean; products?: number }) {
  const t = useTranslations('goodsLocation');
  const places = placesFor(direct, { lost: 0, moved: 0 } as GoodsBuckets);
  const columns = useLocationColumns(places, String);
  return (
    <section aria-hidden="true" className="space-y-3">
      <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
      <div className={`grid grid-cols-2 gap-3 ${GRID[places.length]}`}>
        {places.map((place) => (
          // The real card's own structure (Option A, 2026-10-19: the badge above the
          // label) and its own type classes, so each line is as tall as the real one:
          // the old side-by-side trace came out a pixel short on every width.
          <div key={place} data-testid="skeleton-row" className="min-h-11 rounded-xl border border-border bg-card p-3 sm:p-4">
            <Skeleton className="mb-2 size-8 rounded-lg" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-muted-foreground sm:text-sm">{t(place)}</p>
              <p className="mt-1 text-base font-bold tabular-nums sm:text-2xl">
                {/* An inline block on its own line still gets the paragraph's line box, so the line is the real one's height. */}
                <span className="inline-block h-[0.75em] w-10 rounded bg-muted align-middle motion-safe:animate-pulse" />
              </p>
            </div>
          </div>
        ))}
      </div>
      {/* The section's skeleton is counted by its place cards; the table's rows carry no test id. */}
      <DataTable
        className="hidden sm:block bg-card"
        density="dense"
        autoMin="10rem"
        isLoading
        skeletonRows={products}
        skeletonRowTestId={null}
        rows={[]}
        rowKey={(p) => p.productId}
        columns={columns}
      />
      <ul className="space-y-2 sm:hidden">
        {repeat(products, (i) => (
          <li key={i} className="rounded-lg border border-border bg-card p-3">
            <SkeletonText className="w-32" />
            <div className="mt-2 grid grid-cols-3 gap-2">
              {repeat(places.length + 1, (c) => (
                <div key={c}>
                  <SkeletonText size="xs" className="w-14" />
                  <SkeletonText size="xs" className="w-8" />
                </div>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
