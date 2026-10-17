import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { categoryIndent } from './indent';

describe('categoryIndent (UI #10)', () => {
  it('indents from the start edge, so Arabic shows the hierarchy too', () => {
    const style = categoryIndent(2);
    expect(style).toHaveProperty('paddingInlineStart', '64px');
    expect(style).not.toHaveProperty('paddingLeft');
    expect(style).not.toHaveProperty('paddingRight');
  });

  it('each level sits further in than its parent', () => {
    const px = (d: number) => parseInt(String(categoryIndent(d).paddingInlineStart), 10);
    expect(px(0)).toBe(16);
    expect(px(1)).toBeGreaterThan(px(0));
    expect(px(3)).toBeGreaterThan(px(2));
  });

  it('a negative depth is treated as the top level, never pulled past the edge', () => {
    expect(categoryIndent(-1)).toEqual(categoryIndent(0));
  });

  it('the categories page uses it and no physical padding', () => {
    const src = readFileSync(join(process.cwd(), 'src/components/views/categories-view.tsx'), 'utf8');
    expect(src).toContain('categoryIndent(cat.depth)');
    expect(src).not.toMatch(/paddingLeft|paddingRight/);
  });
});
