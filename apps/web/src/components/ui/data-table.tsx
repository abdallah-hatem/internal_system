'use client';

import { Fragment, type HTMLAttributes, type ReactNode, type ThHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
import { PAGE_SIZE } from '@/components/ui/pagination';
import { Skeleton, SkeletonGroup, SkeletonText, repeat, type SkeletonTextSize } from '@/components/ui/skeleton';
import { ColGroup, minTableWidth } from '@/components/ui/table-columns';

/**
 * Every table in the office, written once (owner, 2026-10-15).
 *
 * Left to `table-layout: auto`, a browser sizes each column to its content, so
 * a skeleton's bars set one set of widths and the real names and amounts
 * another, and every column jumped sideways when the data landed. Here the
 * table is `table-fixed` with one `<colgroup>`, read by the header, the real
 * rows and the skeleton rows alike, so the widths are the same before and
 * after by construction. Header titles never wrap; each column is sized by the
 * page to fit its title in English and in Arabic.
 *
 * A page says what its columns are; this decides how they behave:
 *
 * - `width`: any CSS length, or `'auto'` for exactly one column — the one that
 *   takes what the fixed ones leave (a name). Checked in development.
 * - `kind`: what happens to content too wide for the column.
 *   `name` wraps to two lines and is cut after them, the whole of it on hover;
 *   `label` stays on one line and is cut, the whole of it on hover;
 *   `value` (money, quantities, counts, dates) never wraps and is never cut —
 *   the column is sized for its largest ordinary value instead.
 * - `skeleton`: the bar that stands in for the cell while loading, as a share
 *   of the column (`w-3/4`), never a guessed width.
 *
 * Phone cards stay with each page — each list's card differs. Only the
 * desktop table is shared.
 */

/** How a column's content behaves when it is wider than the column. */
export type ColumnKind = 'name' | 'label' | 'value' | 'plain';

/** What stands in for a cell while its row is loading. */
export type SkeletonShape =
  /** A line of text; `share` is the bar's width as a share of the column. */
  | { kind: 'text'; share?: string; size?: SkeletonTextSize; line?: string }
  /** A rounded chip — a status badge. */
  | { kind: 'pill'; share?: string }
  /** `count` 28px icon buttons, as the real row's actions. */
  | { kind: 'buttons'; count: number }
  /** Nothing: an empty cell (a chevron's column, an action not offered). */
  | { kind: 'none' }
  /** A shape the others cannot draw (a two-line figure). */
  | { kind: 'custom'; render: () => ReactNode };

export interface Column<Row> {
  key: string;
  /** Already translated by the page. Never wraps. */
  header: ReactNode;
  /** A CSS length, or 'auto' for the one column that takes the rest. */
  width: string;
  cell: (row: Row, index: number) => ReactNode;
  kind?: ColumnKind;
  /** Logical: `end` is the right in English, the left in Arabic. */
  align?: 'start' | 'end';
  /** Hover text for a `name` or `label` cell — the whole of what may be cut. */
  title?: (row: Row) => string | null | undefined;
  /** Defaults to a text bar half the column wide. */
  skeleton?: SkeletonShape;
  /** Extra classes for this column's cells (colour, font). */
  className?: string | ((row: Row) => string | undefined);
  /** Extra classes for this column's header cell. */
  headerClassName?: string;
  /** Hover text for the header (a hint about what the column means). */
  headerTitle?: string;
  /** Extra attributes for the header cell (aria-sort). */
  headerProps?: ThHTMLAttributes<HTMLTableCellElement>;
  /** Hidden, with its cells and its width, below this breakpoint (printed always). */
  hiddenBelow?: 'sm' | 'md';
  /** Extra attributes for this column's cells (data-testid). */
  cellProps?: (row: Row) => HTMLAttributes<HTMLTableCellElement> & Record<`data-${string}`, string | undefined>;
}

export interface DataTableProps<Row> {
  columns: readonly Column<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row, index: number) => string;
  /** First load: the real header over `skeletonRows` skeleton rows. */
  isLoading?: boolean;
  skeletonRows?: number;
  /** A refetch of rows already shown: they stay, dimmed and marked busy. */
  stale?: boolean;
  /** Shown across the whole width when there are no rows. */
  empty?: ReactNode;
  onRowClick?: (row: Row) => void;
  rowClassName?: (row: Row) => string | undefined;
  /** Extra attributes for each real row (data-testid, data-*). */
  rowProps?: (row: Row) => HTMLAttributes<HTMLTableRowElement> & Record<`data-${string}`, string | undefined>;
  /** Anything that belongs under a row — an expanded detail row. Full `<tr>`s. */
  afterRow?: (row: Row) => ReactNode;
  /** A `<tfoot>`'s rows — totals that may repeat on every printed sheet. */
  footer?: ReactNode;
  /**
   * Whole `<tr>`s at the top and the bottom of the body, around the rows — a
   * statement's opening and closing lines, which print once. Shown while
   * loading too, so pass their skeletons then (`DataTableSkeletonRow`).
   */
  beforeRows?: ReactNode;
  afterRows?: ReactNode;
  /** The space the `auto` column may shrink to before the table scrolls instead. */
  autoMin?: string;
  /**
   * Padding of every cell: `normal` for a list; `tight` for a list with many
   * columns (narrower gaps, the card's own 16px at either end); `compact` for
   * a table inside a card or a window, flush with its edges; `dense` for a
   * small table in a card of its own, 16px in from the card's edges.
   */
  density?: 'normal' | 'tight' | 'compact' | 'dense';
  /** `card`: in its own bordered card, scrolling sideways inside it; `none`: just the scroller. */
  frame?: 'card' | 'none';
  /** Classes for the outermost element (`hidden md:block`). */
  className?: string;
  tableClassName?: string;
  /** On the outermost element. */
  testId?: string;
  /** On the `<table>` itself. */
  tableTestId?: string;
  /** What the table is, for a screen reader (rendered visually hidden). */
  caption?: ReactNode;
  /**
   * The test id each skeleton row carries (`skeleton-row`). `null` for a table
   * whose section counts its skeleton by something else (its cards).
   */
  skeletonRowTestId?: string | null;
}

const PAD = {
  normal: 'px-4 py-3',
  tight: 'px-2.5 py-3 first:ps-4 last:pe-4',
  compact: 'px-2 py-2 first:ps-0 last:pe-0',
  dense: 'px-3 py-2 first:ps-4 last:pe-4',
} as const;

/** A cell's padding at a density — for a row a page adds itself (`beforeRows`). */
export const cellPadding = (density: NonNullable<DataTableProps<unknown>['density']> = 'normal') => PAD[density];

const HEAD = {
  normal: { row: 'bg-gray-50 border-b border-gray-200', cell: 'font-medium text-gray-600' },
  tight: { row: 'bg-gray-50 border-b border-gray-200', cell: 'font-medium text-gray-600' },
  compact: { row: 'border-b border-gray-200', cell: 'text-xs font-medium text-gray-500' },
  dense: { row: 'border-b border-gray-200', cell: 'text-xs font-medium text-gray-500' },
} as const;

// Written out whole, so Tailwind sees each class. Paper always has the room:
// a column hidden on a phone is printed.
const HIDDEN_CELL = { sm: 'hidden sm:table-cell print:table-cell', md: 'hidden md:table-cell print:table-cell' } as const;
const HIDDEN_COL = { sm: 'hidden sm:table-column print:table-column', md: 'hidden md:table-column print:table-column' } as const;

const KIND_CLASS: Record<ColumnKind, string> = {
  name: '',
  label: '',
  value: 'whitespace-nowrap tabular-nums',
  plain: '',
};

/** The one-`auto` rule. A table with none or two cannot share out its width. */
export function checkColumns(columns: readonly { key: string; width: string }[]) {
  const autos = columns.filter((c) => c.width === 'auto');
  if (autos.length !== 1) {
    throw new Error(
      `DataTable: exactly one column must be 'auto' (the one that takes what is left); got ${autos.length}` +
        (autos.length ? ` (${autos.map((c) => c.key).join(', ')})` : ''),
    );
  }
}

function SkeletonCell({ shape, align }: { shape: SkeletonShape; align?: 'start' | 'end' }) {
  switch (shape.kind) {
    case 'none':
      return null;
    case 'custom':
      return <>{shape.render()}</>;
    case 'buttons':
      return (
        <div className={cn('flex items-center gap-1', align === 'end' && 'justify-end')}>
          {repeat(shape.count, (i) => <Skeleton key={i} className="size-7 rounded-lg" />)}
        </div>
      );
    case 'pill':
      return <Skeleton className={cn('h-5 rounded-full', shape.share ?? 'w-2/3', align === 'end' && 'ms-auto')} />;
    case 'text':
      return (
        <SkeletonText
          size={shape.size}
          className={shape.share ?? 'w-1/2'}
          lineClassName={cn(align === 'end' && 'justify-end', shape.line)}
        />
      );
  }
}

/**
 * One skeleton row of a table: each column's `skeleton`, in its own padding.
 * DataTable draws its loading rows with it; a page uses it for a row it adds
 * around them (`beforeRows`, `afterRows`).
 */
export function DataTableSkeletonRow<Row>({
  columns,
  density = 'normal',
  testId = 'skeleton-row',
  className,
}: {
  columns: readonly Column<Row>[];
  density?: DataTableProps<Row>['density'];
  /** `null` for none. */
  testId?: string | null;
  className?: string;
}) {
  const pad = PAD[density ?? 'normal'];
  return (
    <tr data-testid={testId ?? undefined} className={className}>
      {columns.map((c) => (
        <td key={c.key} className={cn(pad, c.hiddenBelow && HIDDEN_CELL[c.hiddenBelow])}>
          <SkeletonCell shape={c.skeleton ?? { kind: 'text' }} align={c.align} />
        </td>
      ))}
    </tr>
  );
}

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  isLoading = false,
  skeletonRows = PAGE_SIZE,
  stale = false,
  empty,
  onRowClick,
  rowClassName,
  rowProps,
  afterRow,
  footer,
  beforeRows,
  afterRows,
  autoMin,
  density = 'normal',
  frame = 'card',
  className,
  tableClassName,
  testId,
  tableTestId,
  caption,
  skeletonRowTestId = 'skeleton-row',
}: DataTableProps<Row>) {
  if (process.env.NODE_ENV !== 'production') checkColumns(columns);

  const widths = columns.map((c) => c.width);
  const pad = PAD[density];
  const head = HEAD[density];
  const alignClass = (c: Column<Row>) => (c.align === 'end' ? 'text-end' : 'text-start');
  const hidden = (c: Column<Row>) => (c.hiddenBelow ? HIDDEN_CELL[c.hiddenBelow] : undefined);

  const table = (
    <div className="overflow-x-auto">
      <table
        data-testid={tableTestId}
        data-slot="data-table"
        className={cn('w-full table-fixed text-sm', tableClassName)}
        style={{ minWidth: minTableWidth(widths, autoMin) }}
      >
        {caption && <caption className="sr-only">{caption}</caption>}
        <ColGroup widths={widths} classNames={columns.map((c) => (c.hiddenBelow ? HIDDEN_COL[c.hiddenBelow] : undefined))} />
        <thead>
          <tr className={head.row}>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                title={c.headerTitle}
                {...c.headerProps}
                className={cn(pad, head.cell, 'whitespace-nowrap', alignClass(c), hidden(c), c.headerClassName)}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        {isLoading ? (
          <SkeletonGroup as="tbody" className="divide-y divide-muted">
            {beforeRows}
            {repeat(skeletonRows, (i) => (
              <DataTableSkeletonRow key={i} columns={columns} density={density} testId={skeletonRowTestId} />
            ))}
            {afterRows}
          </SkeletonGroup>
        ) : (
          <tbody className="divide-y divide-gray-100">
            {beforeRows}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length}>{empty}</td>
              </tr>
            ) : (
              rows.map((row, i) => (
                <Fragment key={rowKey(row, i)}>
                  <tr
                    {...rowProps?.(row)}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    className={cn(
                      'transition-colors hover:bg-gray-50',
                      onRowClick && 'cursor-pointer',
                      rowClassName?.(row),
                    )}
                  >
                    {columns.map((c) => {
                      const kind = c.kind ?? 'plain';
                      const extra = typeof c.className === 'function' ? c.className(row) : c.className;
                      const hover = kind === 'name' || kind === 'label' ? c.title?.(row) ?? undefined : undefined;
                      const content = c.cell(row, i);
                      return (
                        <td
                          key={c.key}
                          title={hover}
                          {...c.cellProps?.(row)}
                          className={cn(pad, alignClass(c), KIND_CLASS[kind], hidden(c), extra)}
                        >
                          {/* A name wraps to a second line and is cut after it. A label
                              is cut on its one line at its own end: `dir="auto"` puts the
                              ellipsis after a Latin code in an Arabic row, not before
                              its tail, and `w-fit` keeps a short one on the row's start
                              edge (LatinText does the same). */}
                          {kind === 'name' ? (
                            <div className="line-clamp-2 break-words">{content}</div>
                          ) : kind === 'label' ? (
                            <div dir="auto" className="w-fit max-w-full truncate">{content}</div>
                          ) : (
                            content
                          )}
                        </td>
                      );
                    })}
                  </tr>
                  {afterRow?.(row)}
                </Fragment>
              ))
            )}
            {afterRows}
          </tbody>
        )}
        {footer && !isLoading && <tfoot>{footer}</tfoot>}
      </table>
    </div>
  );

  return (
    <div
      data-testid={testId}
      aria-busy={stale}
      className={cn(
        frame === 'card' && 'bg-white rounded-xl border border-gray-200 overflow-hidden',
        'transition-opacity',
        stale && 'opacity-60',
        className,
      )}
    >
      {table}
    </div>
  );
}

/**
 * The common badge in a table cell: never wraps, and cut rather than spilling
 * when a translation is longer than its column.
 */
export function CellBadge({ className, children, title }: { className?: string; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={cn('inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium', className)}
    >
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}
