import { redirect } from 'next/navigation';
import { pushLanding } from '@/lib/notification-href';

/**
 * What a tap on a push opens (owner, 2026-10-18). The push names the event and
 * its ids; this sends the reader where the bell would, by the bell's own
 * mapping (`pushLanding`).
 */
export default async function OpenNotification({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  redirect(`/${locale}${pushLanding(await searchParams)}`);
}
