'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';

import type { Category } from './types';

/**
 * Which shelf to look on.
 *
 * A native `<select>` rather than a custom menu: on the phone this is used on,
 * the platform picker is a full-height wheel a thumb can reach, and it mirrors
 * for Arabic without anything here knowing which way it opened.
 *
 * Children are listed under their parent and indented with a real space rather
 * than an `<optgroup>`, because a parent category is itself selectable and an
 * optgroup label is not.
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
  const options = useMemo(() => ordered(categories), [categories]);

  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      aria-label={t('category')}
      className="h-12 w-full rounded-xl border border-gray-300 bg-white px-3 text-base text-gray-900 focus:border-brand-600 focus:outline-2 focus:outline-offset-0 focus:outline-brand-600 sm:w-56"
    >
      <option value="">{t('allCategories')}</option>
      {options.map(({ category, depth }) => (
        <option key={category.id} value={category.id}>
          {'  '.repeat(depth) + category.name}
        </option>
      ))}
    </select>
  );
}
