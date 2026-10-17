'use client';

import { Suspense } from 'react';
import { PageViews } from '@/components/ui/page-views';
import CyclesView from '@/components/views/cycles-view';
import PurchasesView from '@/components/views/purchases-view';
import ShipmentsView from '@/components/views/shipments-view';

/** Cycles, with the purchases and shipments that belong to them as tabs (owner, 2026-10-18; lib/page-views.ts). */
export default function Page() {
  return (
    <Suspense fallback={null}>
      <PageViews page="cycles" views={{ cycles: CyclesView, purchases: PurchasesView, shipments: ShipmentsView }} />
    </Suspense>
  );
}
