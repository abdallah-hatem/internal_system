import type { Page } from '@playwright/test';

/**
 * Measures every visible `.field-row` on the page the way a reader sees it.
 *
 * A row's fields are grouped into visual lines by whether they sit beside
 * each other: two fields share a line when their blocks overlap vertically by
 * more than half the shorter one (a two-column grid on a desktop is one line;
 * the same grid on a phone stacks into several, which do not overlap at all).
 * Not by where each block starts: under the old bottom alignment a field with
 * an error line under it started 20px higher than its neighbour, so grouping
 * by start put the two on different "lines" and measured nothing — blind to
 * exactly the bug this exists to catch. Within a line every field's box — the input, the shared
 * Select or DatePicker trigger, the `+` of a quick-create, the band of a
 * RowAction — must share one top and one height. A RowAction's control must
 * also sit centred on its band, so a ✕ or + is level with the boxes beside it.
 *
 * Read from getBoundingClientRect, after layout, so it measures what is on
 * screen rather than what the classes promise.
 */
export interface RowLine {
  /** Where the row is, for the failure message: its first label or field name. */
  row: string;
  boxes: number;
  /** Largest difference between box tops in the line, px. */
  topDelta: number;
  /** Largest difference between box heights in the line, px. */
  heightDelta: number;
  /** Largest distance from a RowAction control's centre to its band's centre, px. */
  actionDelta: number;
}

export async function measureFieldRows(page: Page, within?: string): Promise<RowLine[]> {
  return page.evaluate((scopeSelector) => {
    const BOX =
      'input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=file]):not([type=range]):not([aria-hidden="true"]), select, [data-slot="select-trigger"], [data-slot="date-picker-trigger"], [data-quick-create], [class*="h-(--field-h)"]';
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const scope = scopeSelector ? document.querySelector(scopeSelector) : document;
    if (!scope) return [];
    const out: RowLine[] = [];
    for (const row of Array.from(scope.querySelectorAll('.field-row')).filter(visible)) {
      const fields: { start: number; end: number; box: DOMRect; action?: DOMRect }[] = [];
      for (const kid of Array.from(row.children).filter(visible)) {
        let box: Element | null = null;
        let action: Element | null = null;
        if (kid.matches('[data-row-action]')) {
          box = kid.children[1] ?? null; // the box-high band
          action = box?.querySelector('button, a') ?? null;
        } else if (kid.matches(BOX)) {
          box = kid;
        } else {
          box = Array.from(kid.querySelectorAll(BOX)).find(visible) ?? null;
        }
        if (!box || !visible(box)) continue;
        const block = kid.getBoundingClientRect();
        fields.push({
          start: block.top,
          end: block.bottom,
          box: box.getBoundingClientRect(),
          action: action && visible(action) ? action.getBoundingClientRect() : undefined,
        });
      }
      const label =
        row.querySelector('label')?.textContent?.trim() ||
        row.querySelector('[name]')?.getAttribute('name') ||
        row.className.slice(0, 40);
      // Group into visual lines: fields whose blocks overlap vertically.
      const lines: (typeof fields)[] = [];
      const beside = (a: (typeof fields)[number], b: (typeof fields)[number]) =>
        Math.min(a.end, b.end) - Math.max(a.start, b.start) >
        0.5 * Math.min(a.end - a.start, b.end - b.start);
      for (const f of fields.sort((a, b) => a.start - b.start)) {
        const line = lines.find((l) => beside(l[0], f));
        if (line) line.push(f);
        else lines.push([f]);
      }
      for (const line of lines) {
        const tops = line.map((f) => f.box.top);
        const heights = line.map((f) => f.box.height);
        const actions = line
          .filter((f) => f.action)
          .map((f) => Math.abs(f.action!.top + f.action!.height / 2 - (f.box.top + f.box.height / 2)));
        out.push({
          row: label.slice(0, 60),
          boxes: line.length,
          topDelta: Math.round((Math.max(...tops) - Math.min(...tops)) * 10) / 10,
          heightDelta: Math.round((Math.max(...heights) - Math.min(...heights)) * 10) / 10,
          actionDelta: actions.length ? Math.round(Math.max(...actions) * 10) / 10 : 0,
        });
      }
    }
    return out;
  }, within ?? null);
}

/** The worst line on the page: the largest of each delta over every line with two or more boxes. */
export function worst(lines: RowLine[]) {
  const shared = lines.filter((l) => l.boxes >= 2 || l.actionDelta > 0);
  return {
    lines: shared.length,
    topDelta: Math.max(0, ...shared.map((l) => l.topDelta)),
    heightDelta: Math.max(0, ...shared.map((l) => l.heightDelta)),
    actionDelta: Math.max(0, ...shared.map((l) => l.actionDelta)),
  };
}
