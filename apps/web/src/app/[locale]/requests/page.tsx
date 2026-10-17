import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { REQUESTS_ENABLED } from '@/lib/features';
import { RequestsViews } from '@/components/requests/requests-views';

/**
 * The shops' requests — order requests and import requests — as two tabs of
 * one page (owner, 2026-10-17). Switched off in production for now
 * (lib/features.ts): there the address goes to the dashboard instead.
 *
 * The tabs read `?view=`, and `useSearchParams` cannot be prerendered, so the
 * views sit in a Suspense boundary or `next build` fails on this page.
 */
export default async function RequestsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!REQUESTS_ENABLED) redirect(`/${locale}/dashboard`);
  return (
    <Suspense fallback={null}>
      <RequestsViews />
    </Suspense>
  );
}
