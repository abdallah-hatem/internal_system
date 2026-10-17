import { redirect } from 'next/navigation';
import { movedViewLanding } from '@/lib/page-views';

/** Now a tab of another page (owner, 2026-10-18). The old address still lands on it, parameters kept. */
export default async function MovedView({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  redirect(movedViewLanding(locale, 'shipments', await searchParams));
}
