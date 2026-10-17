import { redirect } from 'next/navigation';
import { requestsLanding } from '@/lib/requests-route';

/**
 * Order requests became the first tab of Requests (owner, 2026-10-17). The old
 * address — a bookmark, a push alert the API still points here — lands on that
 * tab, or on the dashboard where the page is switched off.
 */
export default async function OrderRequestsRedirect({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  redirect(requestsLanding(locale, 'orders'));
}
