'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';

import { Select } from '../ui/select';
import type { Category } from './types';

/**
 * Which shelf to look on.
 *
 * The shared `Select`, not a native `<select>`. The owner rejected the native
 * picker in the internal system and asked for the shadcn one, and the same
 * answer holds here: a store that looks like a different product from the
 * office it belongs to is two products.
 *
 * The native element also cannot do what this needs — it is searchable once a
 * catalogue has more than a handful of categories, and an `<option>` cannot
 * carry the hint the shared component renders.
 *
 * Children are listed under their parent and indented with a real space rather
 * than a group heading, because a parent category is itself selectable and a
 * heading is not.
 */
function ordered(categories: Category[]): { category: Category; depth: number }[] {
  const byParent = new Map<string | null, Category[]>();
  for (const category of categories) {
    const siblings = byParent.get(category.parentId) ?? [];
    siblings.push(category);
    byParent.set(category.parentId, siblings);
  }

  const known = new Set(categories.map((c) => c.id));
  const out: { category: Category; depth: number }[] = [];

  const walk = (parentId: string | null, depth: number) => {
    for (const category of byParent.get(parentId) ?? []) {
      out.push({ category, depth });
      if (depth < 3) walk(category.id, depth + 1);
    }
  };

  walk(null, 0);

  // A category whose parent was not in the list would otherwise vanish
  // entirely — better shown flat than not shown at all.
  for (const category of categories) {
    if (category.parentId && !known.has(category.parentId)) {
      out.push({ category, depth: 0 });
    }
  }

  return out;
}

export function CategoryFilter({
  categories,
  value,
  onChange,
}: {
  categories: Category[];
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useTranslations('catalogue');
  const tc = useTranslations('common');
  const options = useMemo(() => ordered(categories), [categories]);

  return (
    <Select
      value={value}
      onChange={onChange}
      placeholder={t('allCategories')}
      searchPlaceholder={tc('search')}
      clearable
      className="w-full sm:w-56"
      options={options.map(({ category, depth }) => ({
        value: category.id,
        // Non-breaking spaces: an ordinary one collapses in HTML and the
        // nesting would disappear.
        label: '\u00a0\u00a0'.repeat(depth) + category.name,
      }))}
    />
  );
}
