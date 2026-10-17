/**
 * A printed document (a contract, an invoice) as an A4 PDF, made in the
 * browser from the same markup the screen shows.
 *
 * The page is drawn by the browser itself (html-to-image renders through an
 * SVG foreignObject), not by a PDF library's own text engine: Arabic needs the
 * browser's shaping, and every library that lays text out itself draws it as
 * separate, unjoined letters. The cost is that the PDF holds pictures of the
 * pages rather than selectable text — right for a document that is signed and
 * kept, not searched.
 *
 * Sheets break between blocks a person reads as one (a table row, a clause, a
 * signature box), never through them, and are numbered only when there is
 * more than one (owner, 2026-10-17: "this should only appear if more than one
 * page").
 */

/**
 * The faces a printed document draws with: Plex Arabic and Plex Latin, their
 * Arabic and basic Latin subsets, and Plex Mono's Latin for the numbers set in
 * it (an invoice number) — a face left out is drawn in a wider fallback and
 * wraps where the page did not.
 */
export const DOCUMENT_FONT_FACES = [
  { family: 'IBM Plex Sans Arabic', ranges: ['U+600', 'U+0-FF'] },
  { family: 'IBM Plex Sans', ranges: ['U+0-FF'] },
  { family: 'IBM Plex Mono', ranges: ['U+0-FF'] },
];
export const DOCUMENT_CANVAS_FONT = "'IBM Plex Sans Arabic', 'IBM Plex Sans', sans-serif";

/** A4 at the CSS reference 96 dpi: 210 × 297 mm. */
export const SHEET_WIDTH_PX = 794;
export const SHEET_HEIGHT_PX = Math.round((SHEET_WIDTH_PX * 297) / 210);
/** 12 mm, the same margin the print stylesheet gives a sheet. */
export const SHEET_MARGIN_PX = 45;
/** Room kept at the foot of each sheet for "Page n of N" when there are several. */
const FOOTER_PX = 28;
/** Pixels drawn per CSS pixel: sharp when printed, a few hundred KB per sheet. */
const PIXEL_RATIO = 2;

/**
 * Where each sheet starts and ends, in CSS pixels from the document's top.
 *
 * `breaks` are the places a sheet may end — the bottom of every block that
 * must not be split. A sheet ends at the lowest of them that still fits; when
 * a single block is taller than a whole sheet there is no such place, and it
 * is cut at the sheet's edge rather than looping forever.
 *
 * `headerAt(start)` is the height of a table header repeated at the top of a
 * sheet that starts at `start` — inside a table's rows — and 0 elsewhere; that
 * sheet has that much less room.
 */
export function sheetRanges(
  breaks: readonly number[],
  total: number,
  room: number,
  headerAt: (start: number) => number = () => 0,
): [number, number][] {
  if (total <= 0) return [[0, 0]];
  if (room <= 0) throw new Error('A sheet needs room for content.');

  const sorted = [...new Set(breaks)].filter((b) => b > 0 && b < total).sort((a, b) => a - b);
  const ranges: [number, number][] = [];
  let start = 0;

  for (;;) {
    // A header taller than the sheet would leave no room at all; it is not repeated then.
    const header = start > 0 ? headerAt(start) : 0;
    const fits = header < room ? room - header : room;
    if (total - start <= fits) break;

    const limit = start + fits;
    let end = limit;
    for (const b of sorted) {
      if (b > start && b <= limit) end = b;
      if (b > limit) break;
    }
    ranges.push([start, end]);
    start = end;
  }
  ranges.push([start, total]);
  return ranges;
}

interface TableHead {
  /** Where the header row is drawn, and where the table's rows end. */
  top: number;
  bottom: number;
  end: number;
}

/** Each table's header, so a sheet that starts among its rows can repeat it. */
function tableHeads(doc: HTMLElement): TableHead[] {
  const top = doc.getBoundingClientRect().top;
  return [...doc.querySelectorAll('table')].flatMap((table) => {
    const head = table.tHead?.getBoundingClientRect();
    if (!head || head.height === 0) return [];
    return [{ top: head.top - top, bottom: head.bottom - top, end: table.getBoundingClientRect().bottom - top }];
  });
}

function headAt(heads: TableHead[], start: number): TableHead | undefined {
  return heads.find((h) => start >= h.bottom && start < h.end - 1);
}

/**
 * html-to-image writes every font size onto its copy one notch smaller than
 * the page drew it — `floor(size) - 0.1`, so 12.5px becomes 11.9px — to keep
 * text from overflowing. The copy then wraps differently from the page: a
 * clause that took two lines took one, inside a box still two lines tall (a
 * blank line in the middle of the terms), and every sheet break measured on
 * the page landed somewhere else on the drawing.
 *
 * The page's own sizes are known, so each shrunk value maps back to the one it
 * came from, and the drawing lays out exactly as the page does. Two sizes with
 * the same whole part (12px and 12.5px) would share a shrunk value; the larger
 * one wins, and a document should not use both.
 */
export function restoreFontSizes(svg: string, pageSizes: Iterable<number>): string {
  const back = new Map<string, number>();
  for (const size of pageSizes) {
    const shrunk = String(Math.floor(size) - 0.1);
    back.set(shrunk, Math.max(size, back.get(shrunk) ?? 0));
  }
  const restore = (value: string) => back.get(value) ?? value;
  return (
    svg
      .replace(/font-size:\s*([\d.]+)px/g, (_, value: string) => `font-size: ${restore(value)}px`)
      // The browser writes the longhands back as the `font` shorthand where it
      // can — `font: 400 11.9px / 20.3px "IBM Plex…"` — and the size is its
      // first length; the one after the slash is the line height.
      .replace(/(\bfont:[^;/]*?)([\d.]+)px/g, (_, before: string, value: string) => `${before}${restore(value)}px`)
  );
}

/**
 * Every computed property but the sizes. html-to-image pins each copy to the
 * width and height the page measured. A box exactly as wide as its text (the
 * contract number beside its label) then overflows by a fraction of a pixel in
 * the drawing and wraps onto the line below, and a box pinned to the page's
 * height overlaps whatever wrapped. Without them the drawing lays itself out
 * the way the page did, from the same fonts at the same sizes.
 */
// A grid's rows too: the browser writes them back as the pixel heights it
// measured, and a label that wraps in the drawing then overlaps the row below.
const SIZES = new Set([
  'width', 'inline-size', 'height', 'block-size', 'min-height', 'min-block-size', 'grid-template-rows',
]);
function stylesWithoutSizes(doc: HTMLElement): string[] {
  const style = getComputedStyle(doc);
  return Array.from({ length: style.length }, (_, i) => style.item(i)).filter((p) => !SIZES.has(p));
}

/**
 * With widths left out, a table falls back to its content's width; the page's
 * tables fill their space through a class, which the drawing does not carry.
 * Those that fill it on the page are told so in their own style, which the
 * copy keeps. Only the off-screen sheet is touched.
 */
function pinFullWidthTables(doc: HTMLElement): void {
  for (const table of doc.querySelectorAll<HTMLElement>('table')) {
    const parent = table.parentElement;
    if (!parent) continue;
    const cs = getComputedStyle(parent);
    const room = parent.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    if (Math.abs(table.getBoundingClientRect().width - room) < 1) table.style.width = '100%';
  }
}

function fontSizes(doc: HTMLElement): Set<number> {
  const sizes = new Set<number>();
  for (const el of [doc, ...doc.querySelectorAll<HTMLElement>('*')]) {
    sizes.add(parseFloat(getComputedStyle(el).fontSize));
  }
  return sizes;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The document could not be drawn.'));
    img.decoding = 'sync';
    img.src = src;
  });
}

/** The blocks a sheet may end after: rows, clauses, boxes marked keep-together. */
const BREAK_AFTER = 'tr, li, p, header, footer, [data-print-keep]';

function breakPoints(doc: HTMLElement): number[] {
  const top = doc.getBoundingClientRect().top;
  return (
    [...doc.querySelectorAll<HTMLElement>(BREAK_AFTER)]
      // Never after a header row (a sheet would end on a header with no rows
      // under it), nor inside a block that must stay whole.
      .filter((el) => !el.closest('thead') && !el.parentElement?.closest('[data-print-keep]'))
      .map((el) => Math.round(el.getBoundingClientRect().bottom - top))
  );
}

/**
 * Keep only the @font-face rules the document draws with. The page declares
 * every face of every family the app loads — 57 of them, a megabyte once
 * inlined — and the browser decodes all of it for every sheet.
 */
export function onlyFaces(css: string, faces: DocumentPdfOptions['fontFaces']): string {
  const rules = css.match(/@font-face\s*{[^}]*}/g) ?? [];
  return rules
    .filter((rule) => {
      const family = /font-family:\s*["']?([^"';]+)["']?/.exec(rule)?.[1]?.trim();
      const range = /unicode-range:\s*([^;}]+)/.exec(rule)?.[1] ?? '';
      return faces.some((f) => f.family === family && (!f.ranges || f.ranges.some((r) => range.includes(r))));
    })
    .join('\n');
}

export interface DocumentPdfOptions {
  /**
   * The faces to embed: a family, and optionally the start of the
   * unicode-range of each subset wanted (e.g. 'U+0-FF' for Latin).
   */
  fontFaces: { family: string; ranges?: string[] }[];
  /** "Page 1 of 3", in the document's language. Drawn only when there are several sheets. */
  pageLabel: (page: number, pages: number) => string;
  dir: 'rtl' | 'ltr';
  /**
   * The page number's font, as a canvas reads it: family names only. A CSS
   * variable in it makes the whole value invalid, and the canvas silently
   * falls back to 10px sans-serif.
   */
  canvasFont: string;
}

/**
 * Render `doc` — already laid out at SHEET_WIDTH_PX with its side margins as
 * padding — into a PDF of A4 sheets.
 */
export async function documentToPdf(doc: HTMLElement, options: DocumentPdfOptions): Promise<Blob> {
  const [{ toSvg, getFontEmbedCSS }, { jsPDF }] = await Promise.all([import('html-to-image'), import('jspdf')]);
  const fcss = onlyFaces(await getFontEmbedCSS(doc), options.fontFaces);

  // A sheet drawn before its web font arrives is drawn in the fallback face.
  await document.fonts.ready;

  pinFullWidthTables(doc);
  const total = Math.ceil(doc.getBoundingClientRect().height);
  const svg = await toSvg(doc, {
    backgroundColor: '#ffffff',
    width: SHEET_WIDTH_PX,
    height: total,
    // The clone carries the original's computed position; anything that keeps
    // the original off screen would keep the clone off the canvas too.
    style: { position: 'static', left: '0', top: '0', transform: 'none', margin: '0', width: `${SHEET_WIDTH_PX}px` },
    fontEmbedCSS: fcss,
    includeStyleProperties: stylesWithoutSizes(doc),
  });
  const comma = svg.indexOf(',');
  const drawn = await loadImage(
    svg.slice(0, comma + 1) +
      encodeURIComponent(restoreFontSizes(decodeURIComponent(svg.slice(comma + 1)), fontSizes(doc))),
  );
  const full = document.createElement('canvas');
  full.width = SHEET_WIDTH_PX * PIXEL_RATIO;
  full.height = total * PIXEL_RATIO;
  const fullCtx = full.getContext('2d');
  if (!fullCtx) throw new Error('This browser cannot draw the PDF.');
  fullCtx.fillStyle = '#ffffff';
  fullCtx.fillRect(0, 0, full.width, full.height);
  fullCtx.drawImage(drawn, 0, 0, full.width, full.height);

  const breaks = breakPoints(doc);
  const heads = tableHeads(doc);
  const headerAt = (start: number) => {
    const h = headAt(heads, start);
    return h ? h.bottom - h.top : 0;
  };
  const bare = SHEET_HEIGHT_PX - 2 * SHEET_MARGIN_PX;
  let ranges = sheetRanges(breaks, total, bare, headerAt);
  // Numbered sheets need room for the number, which can push one more block over.
  if (ranges.length > 1) ranges = sheetRanges(breaks, total, bare - FOOTER_PX, headerAt);

  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
  const sheet = document.createElement('canvas');
  sheet.width = SHEET_WIDTH_PX * PIXEL_RATIO;
  sheet.height = SHEET_HEIGHT_PX * PIXEL_RATIO;
  const ctx = sheet.getContext('2d');
  if (!ctx) throw new Error('This browser cannot draw the PDF.');

  ranges.forEach(([start, end], i) => {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, sheet.width, sheet.height);

    // A sheet that starts among a table's rows opens with that table's header.
    let y = SHEET_MARGIN_PX * PIXEL_RATIO;
    const head = i > 0 ? headAt(heads, start) : undefined;
    if (head && head.bottom - head.top < bare) {
      const hh = (head.bottom - head.top) * PIXEL_RATIO;
      ctx.drawImage(full, 0, head.top * PIXEL_RATIO, full.width, hh, 0, y, sheet.width, hh);
      y += hh;
    }

    const h = (end - start) * PIXEL_RATIO;
    ctx.drawImage(full, 0, start * PIXEL_RATIO, full.width, h, 0, y, sheet.width, h);

    if (ranges.length > 1) {
      ctx.fillStyle = '#6b7280';
      ctx.font = `${10.5 * PIXEL_RATIO}px ${options.canvasFont}`;
      ctx.direction = options.dir;
      ctx.textAlign = 'center';
      ctx.fillText(
        options.pageLabel(i + 1, ranges.length),
        sheet.width / 2,
        (SHEET_HEIGHT_PX - SHEET_MARGIN_PX + 4) * PIXEL_RATIO,
      );
    }

    if (i > 0) pdf.addPage('a4', 'portrait');
    pdf.addImage(sheet.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, 210, 297);
  });

  return pdf.output('blob');
}

/** Save a file the way a download link would. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Can this browser hand a PDF to the phone's share sheet (WhatsApp, mail…)? */
export function canSharePdf(): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.canShare !== 'function') return false;
  try {
    return navigator.canShare({ files: [new File([''], 'x.pdf', { type: 'application/pdf' })] });
  } catch {
    return false;
  }
}

/** Share the PDF. Resolves false when the person closed the share sheet. */
export async function sharePdf(blob: Blob, filename: string, title: string): Promise<boolean> {
  const file = new File([blob], filename, { type: 'application/pdf' });
  try {
    await navigator.share({ files: [file], title });
    return true;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return false;
    throw err;
  }
}

/**
 * Print the PDF itself rather than the page: a printed PDF carries no browser
 * header or footer (date, title, address, "1/1"), and its sheets are the ones
 * the PDF numbered. Desktop Chromium and Firefox print a PDF from a frame;
 * Safari and phones do not, and callers fall back to `window.print()` there.
 */
export function canPrintPdf(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const phone = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const safari = /Safari\//.test(ua) && !/Chrome|Chromium|Edg\//.test(ua);
  return !phone && !safari;
}

export function printPdf(blob: Blob): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;inset-inline-end:0;bottom:0;width:0;height:0;border:0;';
    frame.src = url;
    frame.onload = () => {
      try {
        frame.contentWindow?.focus();
        frame.contentWindow?.print();
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        // The print dialog holds the frame open; it is removed well after.
        setTimeout(() => {
          frame.remove();
          URL.revokeObjectURL(url);
        }, 60_000);
      }
    };
    document.body.appendChild(frame);
  });
}
