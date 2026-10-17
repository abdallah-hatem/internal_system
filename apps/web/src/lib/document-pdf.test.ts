import { describe, expect, it } from 'vitest';
import { SHEET_HEIGHT_PX, SHEET_WIDTH_PX, onlyFaces, restoreFontSizes, sheetRanges } from './document-pdf';

/**
 * Where a document's sheets break (lib/document-pdf.ts): between blocks, never
 * through one, and one sheet when it all fits.
 */
describe('sheetRanges', () => {
  it('A4 at 96 dpi', () => {
    expect([SHEET_WIDTH_PX, SHEET_HEIGHT_PX]).toEqual([794, 1123]);
  });

  it('a document that fits is one sheet, however many breaks it offers', () => {
    expect(sheetRanges([100, 200, 300], 900, 1000)).toEqual([[0, 900]]);
    expect(sheetRanges([], 1000, 1000)).toEqual([[0, 1000]]);
  });

  it('a sheet ends at the last block that fits, never through a block', () => {
    // Rows end at 400, 700, 1050; a sheet holds 1000 → the third row starts sheet 2.
    expect(sheetRanges([400, 700, 1050, 1400], 1500, 1000)).toEqual([
      [0, 700],
      [700, 1500],
    ]);
  });

  it('a break exactly at the limit is used', () => {
    expect(sheetRanges([500, 1000], 1600, 1000)).toEqual([
      [0, 1000],
      [1000, 1600],
    ]);
  });

  it('a block taller than a sheet is cut at the edge rather than looping forever', () => {
    expect(sheetRanges([2500], 3000, 1000)).toEqual([
      [0, 1000],
      [1000, 2000],
      [2000, 3000],
    ]);
  });

  it('breaks out of order, repeated, or outside the document are ignored', () => {
    expect(sheetRanges([900, -5, 900, 0, 5000, 300], 1500, 1000)).toEqual([
      [0, 900],
      [900, 1500],
    ]);
  });

  it('every pixel is on exactly one sheet', () => {
    const breaks = Array.from({ length: 40 }, (_, i) => (i + 1) * 87);
    const ranges = sheetRanges(breaks, 3500, 1033);
    expect(ranges[0][0]).toBe(0);
    expect(ranges.at(-1)![1]).toBe(3500);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i][0]).toBe(ranges[i - 1][1]);
    for (const [a, b] of ranges) expect(b - a).toBeLessThanOrEqual(1033);
  });

  it('an empty document is one empty sheet; a sheet with no room is refused', () => {
    expect(sheetRanges([], 0, 1000)).toEqual([[0, 0]]);
    expect(() => sheetRanges([], 100, 0)).toThrow();
  });
});

describe('sheetRanges — a table header repeated on the sheets it runs onto', () => {
  // A table whose rows run from 100 to 2100, 50px each, with a 40px header.
  const rows = Array.from({ length: 40 }, (_, i) => 150 + i * 50);
  const header = (start: number) => (start >= 100 && start < 2100 ? 40 : 0);

  it('a sheet that starts among the rows has the header’s height less room', () => {
    const plain = sheetRanges(rows, 2100, 1000);
    const withHeader = sheetRanges(rows, 2100, 1000, header);
    expect(plain[1]).toEqual([1000, 2000]);
    // 1000 of room, 40 of it the repeated header → the second sheet ends one row earlier.
    expect(withHeader[1]).toEqual([1000, 1950]);
    for (const [a, b] of withHeader.slice(1)) expect(b - a + header(a)).toBeLessThanOrEqual(1000);
  });

  it('the first sheet never repeats a header, and a header taller than a sheet is not repeated', () => {
    const ranges = sheetRanges(rows, 2100, 1000, () => 500);
    expect(ranges[0]).toEqual([0, 1000]);
    expect(ranges[1]).toEqual([1000, 1500]);
    expect(sheetRanges(rows, 2100, 300, () => 400).every(([a, b]) => b > a)).toBe(true);
  });
});

describe('restoreFontSizes', () => {
  it('maps each shrunk size back to the page’s', () => {
    const svg = '<div style="font-size: 11.9px;"><p style="font-size: 9.9px; color: red">x</p><b style="font-size: 14.9px">y</b></div>';
    expect(restoreFontSizes(svg, [12.5, 10.5, 15])).toBe(
      '<div style="font-size: 12.5px;"><p style="font-size: 10.5px; color: red">x</p><b style="font-size: 15px">y</b></div>',
    );
  });

  it('the size inside the font shorthand too — not the line height after the slash, not the weight', () => {
    const svg = 'style="font: 400 11.9px / 20.3125px &quot;IBM Plex Sans Arabic&quot;; color: red; font-size: 11.9px"';
    expect(restoreFontSizes(svg, [12.5])).toBe(
      'style="font: 400 12.5px / 20.3125px &quot;IBM Plex Sans Arabic&quot;; color: red; font-size: 12.5px"',
    );
    expect(restoreFontSizes('font: italic 700 14.9px/1.5 serif', [15])).toBe('font: italic 700 15px/1.5 serif');
  });

  it('a size the page never used is left alone; two sizes sharing a whole part take the larger', () => {
    expect(restoreFontSizes('font-size: 7.9px', [12.5])).toBe('font-size: 7.9px');
    expect(restoreFontSizes('font-size: 11.9px', [12, 12.5])).toBe('font-size: 12.5px');
  });
});

describe('onlyFaces', () => {
  const css = [
    "@font-face { font-family: 'IBM Plex Sans Arabic'; src: url(a); unicode-range: U+600-6FF, U+750-77F; }",
    "@font-face { font-family: 'IBM Plex Sans Arabic'; src: url(b); unicode-range: U+460-52F, U+1C80; }",
    "@font-face { font-family: 'IBM Plex Sans'; src: url(c); unicode-range: U+0-FF, U+131; }",
    "@font-face { font-family: 'IBM Plex Mono'; src: url(d); unicode-range: U+0-FF; }",
  ].join('\n');

  it('keeps only the families and subsets asked for', () => {
    const kept = onlyFaces(css, [
      { family: 'IBM Plex Sans Arabic', ranges: ['U+600'] },
      { family: 'IBM Plex Sans', ranges: ['U+0-FF'] },
    ]);
    expect(kept).toContain('url(a)');
    expect(kept).toContain('url(c)');
    expect(kept).not.toContain('url(b)');
    expect(kept).not.toContain('url(d)');
  });

  it('a family named without ranges keeps all its subsets', () => {
    const kept = onlyFaces(css, [{ family: 'IBM Plex Sans Arabic' }]);
    expect(kept).toContain('url(a)');
    expect(kept).toContain('url(b)');
  });
});
