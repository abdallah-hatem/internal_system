import { redirect } from 'next/navigation';
import { requestsLanding } from '@/lib/requests-route';

/**
 * Import requests became the second tab of Requests (owner, 2026-10-17). The
 * old address — a bookmark, a push alert the API still points here — lands on
 * that tab, or on the dashboard where the page is switched off.
 */
export default async function ImportRequestsRedirect({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  redirect(requestsLanding(locale, 'imports'));
}
