'use client';

import { useCallback } from 'react';
import { useLocale } from 'next-intl';
import { useCodeLabel } from '@/lib/labels';
import { useNumberFormat } from '@/lib/numbers';
import { RecordLink } from '@/components/ui/entity-link';

/** What the API says an audit row is about (apps/api audit-labels.ts). */
export interface AuditRecordRef {
  entityType: string;
  entityLabel?: string | null;
  entityLabelAr?: string | null;
  entityHref?: string | null;
  entityAmount?: { value: string; currency: string } | null;
}

/**
 * The record an audit row is about, as a reader names it: "ORD-2026-00003",
 * "Nile Motors · 1,500.00 EGP". A record that is gone, or of a type the API
 * cannot name, reads as its type ("Category") — never as its database id.
 */
export function useAuditRecordName(): (ref: AuditRecordRef) => string {
  const locale = useLocale();
  const codeLabel = useCodeLabel();
  const { formatMoney } = useNumberFormat();
  return useCallback(
    (ref: AuditRecordRef) => {
      const label = (locale === 'ar' && ref.entityLabelAr) || ref.entityLabel || codeLabel('entityType', ref.entityType);
      const amount = ref.entityAmount ? formatMoney(ref.entityAmount.value, ref.entityAmount.currency) : null;
      return amount ? `${label} · ${amount}` : label;
    },
    [locale, codeLabel, formatMoney],
  );
}

/** The record's name, linked to its page when the office app has one. */
export function AuditRecord({
  log,
  className,
  truncate = false,
}: {
  log: AuditRecordRef;
  className?: string;
  truncate?: boolean;
}) {
  const nameOf = useAuditRecordName();
  // A record with no label is gone or unknown; its type is not a page to open.
  const href = log.entityLabel || log.entityAmount ? log.entityHref : null;
  return <RecordLink href={href} label={nameOf(log)} className={className} truncate={truncate} />;
}
