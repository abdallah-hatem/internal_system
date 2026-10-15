/**
 * A table's column widths, written once and read by its header, its real rows
 * and its skeleton rows (owner, 2026-10-15).
 *
 * Left to `table-layout: auto`, a browser sizes each column to its content, so
 * the skeleton's bars set one set of widths and the real names, SKUs and
 * amounts another, and every column jumped sideways when the data landed.
 * With `table-fixed` and one `<colgroup>`, the widths are the same before and
 * after by construction.
 *
 * A width is any CSS length. One column per table is `auto`: it takes what the
 * fixed ones leave — the column whose content varies most (a name). Content
 * that does not fit wraps or truncates; money and counts are sized for their
 * largest ordinary value and never truncate.
 */
export type ColumnWidths = readonly string[];

export function ColGroup({ widths }: { widths: ColumnWidths }) {
  return (
    <colgroup>
      {widths.map((w, i) => (
        <col key={i} style={w === 'auto' ? undefined : { width: w }} />
      ))}
    </colgroup>
  );
}

/**
 * The narrowest the table may get before it scrolls sideways inside its card
 * instead of squeezing its columns: the fixed widths plus room for the `auto`
 * one. Use as an inline style on the `<table>`.
 */
export function minTableWidth(widths: ColumnWidths, autoMin = '14rem'): string {
  return `calc(${widths.map((w) => (w === 'auto' ? autoMin : w)).join(' + ')})`;
}
