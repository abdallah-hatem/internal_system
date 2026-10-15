'use client';

import { useEffect, type ReactNode } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { can } from '@/lib/permissions';
import { useCan } from '@/lib/can';

/**
 * The wizard writes a cycle at every step, and only a partner may (R1b). A
 * role that cannot is sent where it can read instead — the cycle's details
 * when there is one, the list when there is not — rather than filling in four
 * steps the server will refuse. Nothing renders while the role is unknown.
 */
export function WizardGate({ cycleId, children }: { cycleId?: string; children: ReactNode }) {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const { locale } = useParams<{ locale: string }>();
  const allowed = can(user?.role, 'cycle.create');
  // Drawn like every other partner-only control until the session is read,
  // so the wizard does not blink away on a refresh; the redirect still waits
  // for the real role.
  const drawn = useCan('cycle.create');

  useEffect(() => {
    if (isLoading || !user || allowed) return;
    router.replace(cycleId ? `/${locale}/cycles/${cycleId}/details` : `/${locale}/cycles`);
  }, [isLoading, user, allowed, cycleId, locale, router]);

  return drawn ? <>{children}</> : null;
}
