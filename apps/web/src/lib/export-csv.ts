'use client';

/**
 * Take a table out of the app as a CSV.
 *
 * "Export" has been a translated label in both locales since the beginning with
 * nothing behind it — the same shape as the expenses card that was fetched and
 * never rendered. This is the thing behind it.
 *
 * CSV rather than xlsx on purpose: it opens in Excel and Google Sheets without
 * a library, and the figures here are money that an accountant will want to
 * check rather than a formatted report anybody will read as-is.
 */

export interface CsvColumn<Row> {
  /** Column heading, already translated by the caller. */
  header: string;
  /** The cell value. Return a number for money, so the spreadsheet can sum it. */
  value: (row: Row) => string | number | null | undefined;
}

/**
 * Quote a field the way a spreadsheet expects.
 *
 * Product names carry commas, addresses carry newlines, and a supplier called
 * O"Brien would otherwise end the field early. Doubling the quote is the escape
 * CSV actually defines — backslashes are not.
 */
function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  // A leading =, +, - or @ is read as a formula by Excel and Sheets, so a
  // product code like "=A1" would execute rather than display. Prefixing a
  // quote is the standard defence and is invisible once opened.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv<Row>(rows: Row[], columns: CsvColumn<Row>[]): string {
  const head = columns.map((c) => cell(c.header)).join(',');
  const body = rows.map((row) => columns.map((c) => cell(c.value(row))).join(','));
  return [head, ...body].join('\r\n');
}

/**
 * Hand the file to the browser.
 *
 * The BOM is not decoration: without it Excel on Windows reads UTF-8 as its own
 * legacy encoding, and every Arabic name in the file arrives as mojibake.
 */
export function downloadCsv<Row>(
  filename: string,
  rows: Row[],
  columns: CsvColumn<Row>[],
): void {
  const csv = toCsv(rows, columns);
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  // Chrome keeps the blob alive until the document unloads otherwise, which on
  // a long session with several exports is a real amount of memory.
  URL.revokeObjectURL(url);
}

/** `partners-2026-08-24.csv` — dated, so a folder of them stays sortable. */
export function datedFilename(base: string): string {
  const d = new Date();
  const day = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
  return `${base}-${day}.csv`;
}
