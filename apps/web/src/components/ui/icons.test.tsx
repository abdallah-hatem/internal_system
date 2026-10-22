import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import * as Icons from './icons';

/**
 * The icons' weight (owner 2026-10-22: "huge icons are a bit smaller than
 * lucide? ... make a bit bigger"). Hugeicons draws stroke 1.5; lucide, which
 * the screens were laid out with, drew 2 — measured, the extent matched and
 * only the ink was lighter. icons.tsx sets 2 once for every icon; this pins it
 * so a refactor of `icon()` cannot quietly drop back to the package default.
 */
afterEach(cleanup);

const all = Object.entries(Icons).filter(
  ([, v]) => typeof v === 'object' && v !== null && 'displayName' in v,
) as [string, Icons.IconComponent][];

function strokes(svg: SVGSVGElement) {
  return [...svg.querySelectorAll('path, circle, rect, line, polyline, polygon, ellipse')].map((el) =>
    el.getAttribute('stroke-width'),
  );
}

describe('icon stroke', () => {
  it('covers the whole module', () => {
    expect(all.length).toBeGreaterThan(90);
  });

  it('every icon draws every part at stroke 2, not the package 1.5', () => {
    for (const [name, Icon] of all) {
      const { container, unmount } = render(<Icon className="h-4 w-4" />);
      const svg = container.querySelector('svg')!;
      const widths = strokes(svg);
      expect(widths.length, name).toBeGreaterThan(0);
      expect(new Set(widths), name).toEqual(new Set(['2']));
      unmount();
    }
  });

  it('leaves the box alone: same 24 viewBox, the class sizes it', () => {
    const { container } = render(<Icons.Plus className="h-4 w-4" />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg.getAttribute('class')).toBe('icon icon-plus h-4 w-4');
  });

  it("a caller's own strokeWidth still wins, heavier or lighter", () => {
    const heavy = render(<Icons.Check strokeWidth={3} />).container.querySelector('svg')!;
    expect(new Set(strokes(heavy))).toEqual(new Set(['3']));
    cleanup();
    const light = render(<Icons.Check strokeWidth={1.5} />).container.querySelector('svg')!;
    expect(new Set(strokes(light))).toEqual(new Set(['1.5']));
  });
});
