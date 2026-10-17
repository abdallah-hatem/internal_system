'use client';

import { useTranslations } from 'next-intl';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { TabBar } from '@/components/ui/tab-bar';
import { requestsViewOf, type RequestsView } from '@/lib/requests-route';
import { OrderRequestsList } from './order-requests-list';
import { ImportRequestsList } from './import-requests-list';

/**
 * Order requests and import requests, as two tabs of one page (owner,
 * 2026-10-17) — the two used to be menu entries of their own. The open tab
 * lives in the URL (`?view=imports`), so a refresh or the back button returns
 * to it, and switching does not move the page (`scroll: false`). Each tab is
 * the list it always was, unchanged.
 */
export function RequestsViews() {
  const t = useTranslations();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const view = requestsViewOf(searchParams.get('view'));

  const show = (next: RequestsView) => {
    if (next === view) return;
    const params = new URLSearchParams(searchParams.toString());
    if (next === 'imports') params.set('view', 'imports');
    else params.delete('view');
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  return (
    <div className="space-y-6">
      <TabBar
        label={t('requests.tabs.label')}
        value={view}
        onChange={show}
        tabs={[
          { key: 'orders', label: t('orderRequests.title') },
          { key: 'imports', label: t('importRequests.title') },
        ]}
      />
      <div role="tabpanel" aria-labelledby={`tab-${view}`}>
        {view === 'imports' ? <ImportRequestsList /> : <OrderRequestsList />}
      </div>
    </div>
  );
}
