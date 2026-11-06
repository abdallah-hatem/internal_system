import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The inventory table opens a product's batches and a batch's movements in the
 * row beneath it, ~944px wide. From md it scrolled sideways at 768 and at 1024
 * beside the sidebar (UI re-check 2, 2026-11-06, N3), so the table starts at xl
 * and everything narrower gets the cards, which open the product page.
 */
const page = readFileSync(join(__dirname, 'page.tsx'), 'utf8');

describe('the inventory list: cards up to xl, the table from xl', () => {
  it('the table is hidden below xl', () => {
    const table = /<DataTable\s+className="([^"]+)"\s+columns=\{columns\}/.exec(page)?.[1] ?? '';
    expect(table.split(/\s+/)).toEqual(['hidden', 'xl:block']);
  });

  it('the cards and their skeletons show below xl, and only there', () => {
    const cards = [...page.matchAll(/className="(xl|md|lg):hidden space-y-3"/g)].map((m) => m[1]);
    expect(cards).toEqual(['xl', 'xl']);
  });
});
