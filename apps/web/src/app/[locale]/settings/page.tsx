'use client';

import { Suspense } from 'react';
import { PageViews } from '@/components/ui/page-views';
import SettingsView from '@/components/views/settings-view';
import { ExchangeRates } from '@/components/fx-rates/exchange-rates';
import AuditLogsView from '@/components/views/audit-logs-view';

/** Settings, exchange rates and the audit log: opened now and then, so they share one entry (owner, 2026-10-18; lib/page-views.ts). */
export default function Page() {
  return (
    <Suspense fallback={null}>
      <PageViews page="settings" views={{ settings: SettingsView, 'fx-rates': ExchangeRates, 'audit-logs': AuditLogsView }} />
    </Suspense>
  );
}
