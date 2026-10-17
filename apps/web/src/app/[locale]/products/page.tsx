'use client';

import { Suspense } from 'react';
import { PageViews } from '@/components/ui/page-views';
import ProductsView from '@/components/views/products-view';
import CategoriesView from '@/components/views/categories-view';

/** Products, with the categories that group them as a tab (owner, 2026-10-18; lib/page-views.ts). */
export default function Page() {
  return (
    <Suspense fallback={null}>
      <PageViews page="products" views={{ products: ProductsView, categories: CategoriesView }} />
    </Suspense>
  );
}
