'use client';

import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * A leg's route, "origin → destination", that reads origin-to-destination in
 * both writing directions.
 *
 * The parts are flex items, so they follow the page's direction: in Arabic the
 * origin sits on the right and the arrow is turned to point left, toward the
 * destination. Each place name is a `<bdi>`, so a Latin "Dubai, UAE" keeps its
 * own order and its comma inside an Arabic line (UI audit #6, #11). A bare
 * "A → B" string in RTL put the arrow pointing back at the origin.
 */
export function LegRoute({
  origin,
  destination,
  className,
}: {
  origin?: string | null;
  destination?: string | null;
  className?: string;
}) {
  if (!origin && !destination) return null;
  return (
    <span data-testid="leg-route" className={cn('inline-flex min-w-0 flex-wrap items-center gap-1.5', className)}>
      <bdi data-testid="leg-route-origin">{origin || '—'}</bdi>
      <ArrowRight
        data-testid="leg-route-arrow"
        aria-hidden="true"
        className="h-3 w-3 shrink-0 text-muted-foreground rtl:rotate-180"
      />
      <bdi data-testid="leg-route-destination">{destination || '—'}</bdi>
    </span>
  );
}
