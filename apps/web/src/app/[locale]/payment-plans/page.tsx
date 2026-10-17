import { redirect } from 'next/navigation';

/**
 * Instalment plans moved into Payments as its second tab (owner, 2026-10-16),
 * and that tab became Contracts (2026-10-17). The old address still works — a
 * bookmark, an old notification, a link typed from memory — and lands on it.
 */
export default async function PaymentPlansRedirect({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  redirect(`/${locale}/payments?view=contracts`);
}
