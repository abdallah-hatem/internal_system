'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useAllRecords } from '@/lib/list-all';
import type { SelectOption } from '@/components/ui/select';

/**
 * Who did what on the audit log, by name (owner 2026-10-18: "filter by the 3
 * users, me, Fares & Shady").
 *
 * The names are the partners' own `displayName`, read from `/users` — the same
 * list the cycle pages use, under the same query key, so it is one fetch. An
 * account with no partner record (admin support) is shown by its email. The
 * rows use this same list first and the name the audit API sends second, so
 * the filter and the rows never disagree about who someone is.
 */

/** The accounts that work in the office app, and so can appear in the log as acting. */
const OFFICE_ROLES = new Set(['CORE_PARTNER', 'ADMIN_SUPPORT']);

/** `?actor=` value for "Everyone" is no parameter at all; this is only the picker's. */
export const EVERYONE = '__everyone';

interface UserRow {
  id: string;
  email: string;
  role?: string;
  partner?: { displayName?: string | null } | null;
}

export interface AuditActorRef {
  actorUserId?: string | null;
  actor?: { email?: string | null; displayName?: string | null } | null;
}

export function useAuditActors(actorParam: string) {
  const t = useTranslations('auditLogs');
  const { items: users, isLoading } = useAllRecords<UserRow>(['users'], '/users');

  return useMemo(() => {
    const byId = new Map<string, string>();
    for (const u of users) byId.set(u.id, u.partner?.displayName?.trim() || u.email);

    const options: SelectOption[] = [
      { value: EVERYONE, label: t('everyone') },
      ...users
        .filter((u) => OFFICE_ROLES.has(u.role ?? ''))
        .map((u) => ({ value: u.id, label: byId.get(u.id)! }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    ];

    /**
     * The person the address names, once the list of people has arrived and
     * only if they are on it. Until then the audit query waits (the view gates
     * it on `loading`), so a stale link or a typed-in `?actor=fares` falls back
     * to everyone rather than reaching the API as a 404 or a 400.
     */
    const actor =
      isLoading || options.some((o) => o.value === actorParam && o.value !== EVERYONE)
        ? actorParam
        : '';

    /** The name a row shows: never blank, never an id. */
    const nameOf = (log: AuditActorRef): string => {
      if (log.actorUserId && byId.has(log.actorUserId)) return byId.get(log.actorUserId)!;
      const fromRow = log.actor?.displayName?.trim() || log.actor?.email;
      if (fromRow) return fromRow;
      // An id with nobody behind it is someone who was; no id is the system itself.
      return log.actorUserId ? t('formerUser') : t('systemActor');
    };

    return { options, actor, nameOf, loading: isLoading };
  }, [users, isLoading, actorParam, t]);
}
