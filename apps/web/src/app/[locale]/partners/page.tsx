'use client';

import { Suspense } from 'react';
import { PageViews } from '@/components/ui/page-views';
import PartnersView from '@/components/views/partners-view';
import SettlementsView from '@/components/views/settlements-view';

/** Partners, with the settlements that split the profit between them as a tab (owner, 2026-10-18; lib/page-views.ts). */
export default function Page() {
  return (
    <Suspense fallback={null}>
      <PageViews page="partners" views={{ partners: PartnersView, settlements: SettlementsView }} />
    </Suspense>
  );
}
