'use client';

import { Suspense } from 'react';
import { PageViews } from '@/components/ui/page-views';
import SuppliersView from '@/components/views/suppliers-view';
import ProvidersView from '@/components/views/providers-view';

/** The companies goods are bought from, and the ones that move them, as tabs (owner, 2026-10-18; lib/page-views.ts). */
export default function Page() {
  return (
    <Suspense fallback={null}>
      <PageViews page="suppliers" views={{ suppliers: SuppliersView, providers: ProvidersView }} />
    </Suspense>
  );
}
