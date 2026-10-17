'use client';

import type { ComponentType } from 'react';
import { useTranslations } from 'next-intl';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { TabBar } from '@/components/ui/tab-bar';
import { PAGE_VIEWS, viewOf, viewPath, type ViewPage, type ViewSlug } from '@/lib/page-views';

/**
 * A page made of several views as tabs (lib/page-views.ts). The open tab lives
 * in the URL, so a refresh or the back button returns to it. Switching drops
 * the other view's parameters — a purchase's `?open=` means nothing on the
 * shipments tab — and does not move the page (`scroll: false`).
 *
 * Reads `useSearchParams`, so the page wraps it in a Suspense boundary or
 * `next build` fails on that page.
 */
export function PageViews<P extends ViewPage>({
  page,
  views,
}: {
  page: P;
  views: Record<ViewSlug<P>, ComponentType>;
}) {
  const t = useTranslations('nav');
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const view = viewOf(page, searchParams.get('view'));
  const View: ComponentType = views[view];
  const defs = PAGE_VIEWS[page];

  const show = (next: ViewSlug<P>) => {
    if (next === view) return;
    // pathname carries the locale; viewPath's own page prefix is swapped for it.
    const query = viewPath(next).split('?')[1];
    router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  return (
    <div className="space-y-6">
      <TabBar
        label={t(defs[0].navKey)}
        value={view}
        onChange={show}
        tabs={defs.map((d) => ({ key: d.slug as ViewSlug<P>, label: t(d.navKey) }))}
      />
      <div role="tabpanel" aria-labelledby={`tab-${view}`}>
        <View />
      </div>
    </div>
  );
}
