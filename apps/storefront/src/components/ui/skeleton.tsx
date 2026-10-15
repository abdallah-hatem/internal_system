'use client';

import type { HTMLAttributes, ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

/**
 * Placeholders for content that has not arrived yet (owner, 2026-10-15:
 * "loading a table is just a loader with Loading text, it needs to be a table
 * skeleton").
 *
 * A skeleton is a tracing of the real component — same heights, same gaps,
 * same rounding, as many rows as a page holds — so nothing moves when the data
 * lands. Each list keeps its row skeleton next to its row, so the two change
 * together. These are only the bricks.
 *
 * Only for the first paint of absent data. A refetch of rows already on screen
 * keeps them (react-query's `isLoading`, not `isFetching`), and a button that
 * is saving keeps its own spinner — that is an action, not content.
 */

/** One grey block. Pulses once per two seconds, and not at all for reduced motion. */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      data-slot="skeleton"
      className={cn('rounded-md bg-muted motion-safe:animate-pulse', className)}
      {...props}
    />
  );
}

/**
 * The line box a line of text occupies at each type size (Tailwind's
 * line-heights), so a skeleton line is exactly as tall as the text it stands
 * for. The bar inside is shorter, the way the glyphs are.
 */
const LINE = {
  xs: 'h-4',
  sm: 'h-5',
  base: 'h-6',
  lg: 'h-7',
  xl: 'h-7',
  '2xl': 'h-8',
  '3xl': 'h-9',
} as const;
const BAR = {
  xs: 'h-2.5',
  sm: 'h-3',
  base: 'h-3.5',
  lg: 'h-4',
  xl: 'h-4.5',
  '2xl': 'h-5',
  '3xl': 'h-6',
} as const;
export type SkeletonTextSize = keyof typeof LINE;

/**
 * A line of text that has not arrived: as tall as `text-<size>`'s line, the
 * bar `className` wide (`w-24`, `w-1/2`).
 */
export function SkeletonText({
  size = 'sm',
  className,
  lineClassName,
}: {
  size?: SkeletonTextSize;
  /** The bar — usually just a width. */
  className?: string;
  /** The line box around it, for layout (`flex-1`, `justify-end`). */
  lineClassName?: string;
}) {
  return (
    <div aria-hidden="true" className={cn('flex items-center', LINE[size], lineClassName)}>
      <Skeleton className={cn('w-24 rounded', BAR[size], className)} />
    </div>
  );
}

/**
 * Says "Loading" once to a screen reader, and nothing on screen. A list whose
 * skeleton is split across a table body and a card list renders one of these
 * beside them, so it is announced once, not twice.
 */
export function LoadingStatus() {
  const tc = useTranslations('common');
  return (
    <div role="status" aria-live="polite" className="sr-only">
      {tc('loading')}
    </div>
  );
}

/**
 * The container of a group of skeletons: hidden from assistive technology
 * (`LoadingStatus` speaks for it), and invisible for its first 200ms so a
 * fast answer never flashes placeholders (`.skeleton-appear`, globals.css).
 * It still takes its space while invisible, so nothing moves when it shows.
 *
 * `as="tbody"` puts the skeleton rows inside the real table, under the real
 * header, so the columns are the table's own.
 */
export function SkeletonGroup({
  as: Tag = 'div',
  className,
  children,
  testId = 'skeleton',
}: {
  as?: 'div' | 'tbody' | 'ul';
  className?: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <Tag aria-hidden="true" data-testid={testId} data-skeleton="" className={cn('skeleton-appear', className)}>
      {children}
    </Tag>
  );
}

/**
 * The usual case in one piece: the announcement and the group together, for
 * a detail page, a dashboard or a card list.
 */
export function SkeletonRegion({
  className,
  children,
  testId,
}: {
  className?: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <>
      <LoadingStatus />
      <SkeletonGroup className={className} testId={testId}>
        {children}
      </SkeletonGroup>
    </>
  );
}

/** `n` of something, keyed by index — `repeat(PAGE_SIZE, (i) => <RowSkeleton key={i} />)`. */
export function repeat(n: number, render: (i: number) => ReactNode): ReactNode[] {
  return Array.from({ length: n }, (_, i) => render(i));
}
