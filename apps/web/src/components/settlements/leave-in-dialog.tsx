'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Dialog } from '@/components/ui/dialog';
import { Loader2 } from '@/components/ui/icons';
import { Checkbox } from '@/components/ui/checkbox';
import type { SettlementLine } from './settlement-participants';

/**
 * Mark a settlement paid with some core partners leaving their payout in
 * their running account (BUSINESS_LOGIC §8, owner 2026-10-25, phase 2). The
 * plain Mark paid stays one click; this is the way to leave some in. The
 * server decides who may (`PAYOUT_LEFT_IN_NOT_A_PARTNER`).
 */
export function LeaveInDialog({
  cycleCode,
  lines,
  paying,
  onPay,
  onClose,
}: {
  cycleCode: string;
  lines: SettlementLine[];
  paying: boolean;
  onPay: (leaveInPartnerUserIds: string[]) => void;
  onClose: () => void;
}) {
  const t = useTranslations('accounts');
  const tc = useTranslations('common');
  const partners = new Map<string, string>();
  for (const l of lines) {
    const user = l.participant?.partner;
    if (l.participant?.participantType !== 'CORE_PARTNER' || !user?.id) continue;
    partners.set(user.id, user.partner?.displayName ?? user.email ?? '');
  }
  const [chosen, setChosen] = useState<string[]>([]);
  const toggle = (id: string) =>
    setChosen((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <Dialog
      title={t('leaveInTitle', { cycle: cycleCode })}
      description={t('leaveInHint')}
      onClose={onClose}
      busy={paying}
      cardProps={{ 'data-testid': 'leave-in-dialog' }}
      footer={
        <>
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-muted-foreground hover:bg-muted rounded-lg">
            {tc('cancel')}
          </button>
          <button
            type="button"
            onClick={() => onPay(chosen)}
            disabled={paying}
            data-testid="leave-in-pay"
            className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-700 disabled:opacity-50"
          >
            {paying && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('payNow')}
          </button>
        </>
      }
    >
      <ul className="space-y-2">
        {[...partners.entries()].map(([id, name]) => (
          <li key={id}>
            <Checkbox checked={chosen.includes(id)} onChange={() => toggle(id)} label={t('leaveInLabel', { name })} />
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
