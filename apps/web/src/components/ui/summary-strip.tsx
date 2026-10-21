'use client';

import type { ReactNode } from 'react';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils';
import { LatinText } from '@/components/ui/latin-text';
import { SkeletonRegion, SkeletonText, repeat } from '@/components/ui/skeleton';

/**
 * One card of a tab's summary: what it is ("No. 1 by profit"), whom it is
 * about (a cycle code, a product, an order number), the figure, and a line
 * under it. `href` makes the whole card a link; `onClick` a button.
 */
export interface SummaryCard {
  key: string;
  label: string;
  /** The record the card is about — a name or code, isolated for RTL. */
  subject: string;
  value: ReactNode;
  sub?: ReactNode;
  href?: string;
  onClick?: () => void;
}

/** Most a strip ever shows: "a few simple summary cards" (owner 2026-10-18). */
export const SUMMARY_MAX = 3;

/**
 * A few cards about the tab at its top (owner 2026-10-18: "top-earning cycles
 * on Cycles, top-selling products on Products, the order with the most revenue
 * and the largest order on Sales"). The strip only lays the figures out —
 * every figure comes from the API's analytics definitions, never summed here.
 *
 * Loading draws cards traced from the real ones; no cards draws nothing, so a
 * new business sees its list and not a row of zeros. On a phone the cards
 * scroll sideways in one row instead of stacking above the list.
 */
export function SummaryStrip({
  cards,
  isLoading = false,
  label,
  testId = 'summary-strip',
  skeletonCount = SUMMARY_MAX,
}: {
  cards: readonly SummaryCard[];
  isLoading?: boolean;
  /** What the strip is, for a screen reader ("Top cycles by profit"). */
  label: string;
  testId?: string;
  skeletonCount?: number;
}) {
  if (isLoading) {
    return (
      <SkeletonRegion className={STRIP} testId={`${testId}-skeleton`}>
        {repeat(Math.min(skeletonCount, SUMMARY_MAX), (i) => (
          <SummaryCardSkeleton key={i} />
        ))}
      </SkeletonRegion>
    );
  }
  if (cards.length === 0) return null;

  return (
    <section aria-label={label} data-testid={testId} className={STRIP}>
      {cards.slice(0, SUMMARY_MAX).map((card) => (
        <SummaryCardView key={card.key} card={card} />
      ))}
    </section>
  );
}

// One row that scrolls on a phone (each card most of the width, snapping),
// a grid from sm up. Logical padding only, so Arabic scrolls from the right.
const STRIP =
  'scrollbar-clean scrollbar-x -mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto px-1 pb-1 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 sm:pb-0 lg:grid-cols-3';
const FRAME =
  'block w-[78%] min-w-0 shrink-0 snap-start rounded-xl border border-border bg-card p-3 text-start sm:w-auto sm:p-4';
const ACTIVE =
  'cursor-pointer touch-manipulation transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';

function SummaryCardView({ card }: { card: SummaryCard }) {
  const body = (
    <>
      <p className="truncate text-xs font-medium text-muted-foreground">{card.label}</p>
      <LatinText truncate className="mt-1 text-sm font-semibold text-card-foreground">
        {card.subject}
      </LatinText>
      <div className="mt-1 truncate text-lg font-bold text-card-foreground">{card.value}</div>
      {card.sub && <div className="truncate text-xs text-muted-foreground">{card.sub}</div>}
    </>
  );
  if (card.href) {
    return (
      <Link href={card.href} data-testid="summary-card" className={cn(FRAME, ACTIVE)}>
        {body}
      </Link>
    );
  }
  if (card.onClick) {
    return (
      <button type="button" data-testid="summary-card" onClick={card.onClick} className={cn(FRAME, ACTIVE)}>
        {body}
      </button>
    );
  }
  return (
    <div data-testid="summary-card" className={FRAME}>
      {body}
    </div>
  );
}

/** A card that has not arrived: the label, subject, figure and sub lines at their sizes. */
function SummaryCardSkeleton() {
  return (
    <div data-testid="summary-card-skeleton" className={FRAME}>
      <SkeletonText size="xs" className="w-24" />
      <SkeletonText size="sm" lineClassName="mt-1" className="w-32" />
      <SkeletonText size="lg" lineClassName="mt-1" className="w-28" />
      <SkeletonText size="xs" className="w-20" />
    </div>
  );
}
