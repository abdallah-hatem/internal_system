'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from '@/components/ui/icons';
import { Select } from '@/components/ui/select';
import { MoneyInput } from '@/components/ui/money-input';
import { ValidatedForm } from '@/components/ui/validated-form';
import { selectOnFocus } from '@/lib/select-on-focus';

/**
 * Someone joining a cycle: a temporary investor, or a core partner (the
 * Funding card's "+ Add investor", owner 2026-10-26 — moved here unchanged
 * from the old Participants card; investor is now the type it opens on).
 */
export interface ParticipantCandidate {
  id: string;
  email: string;
  role?: string;
  status?: string;
  partner?: { displayName?: string } | null;
}

export function AddParticipantForm({
  users,
  pending,
  onCancel,
  onSubmit,
}: {
  users: ParticipantCandidate[];
  pending: boolean;
  onCancel: () => void;
  onSubmit: (body: Record<string, unknown>) => void;
}) {
  const t = useTranslations('cycles');
  const tph = useTranslations('placeholders');
  const tc = useTranslations('common');
  const [type, setType] = useState('TEMP_INVESTOR');

  return (
    <ValidatedForm
      data-testid="add-participant-form"
      className="mt-3 space-y-4 rounded-lg border border-border bg-muted/40 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const userId = String(fd.get('userId') || '');
        const fee = String(fd.get('investorFeePct') || '');
        const custom = String(fd.get('customProfitPct') || '');
        onSubmit({
          participantType: type,
          // The field the server reads depends on the kind of participant.
          ...(type === 'TEMP_INVESTOR' ? { investorUserId: userId } : { partnerUserId: userId }),
          contributionAmount: Number(fd.get('contributionAmount') || 0),
          ...(custom ? { customProfitPct: Number(custom) } : {}),
          ...(type === 'TEMP_INVESTOR' && fee ? { investorFeePct: Number(fee) } : {}),
        });
      }}
    >
      <div className="field-row grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-sm font-medium text-foreground">{t('participantType')}</label>
          <Select
            name="participantType"
            value={type}
            placeholder={tph('chooseParticipantType')}
            onChange={setType}
            options={[
              { value: 'TEMP_INVESTOR', label: t('tempInvestor') },
              { value: 'CORE_PARTNER', label: t('corePartner') },
            ]}
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-foreground">{t('person')}</label>
          <Select
            name="userId"
            required
            placeholder={tph('choosePerson')}
            searchPlaceholder={tph('searchPeople')}
            /* Only people who can actually hold a share — the same rule as
             * `assertCanParticipate`, stated where the choice is made. A
             * storefront login on a cycle would take a share of the profit. */
            options={users
              .filter(
                (u) =>
                  u.status === 'ACTIVE' &&
                  (u.role === 'CORE_PARTNER' || u.role === 'TEMP_INVESTOR'),
              )
              .map((u) => ({
                value: u.id,
                label: u.partner?.displayName ?? u.email,
                hint: u.email,
              }))}
          />
        </div>
      </div>

      <div className="field-row grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label className="mb-1 block text-sm font-medium text-foreground">{t('contribution')}</label>
          <MoneyInput
            name="contributionAmount" required placeholder={tph('money')}
            className="w-full rounded-lg border border-border px-3 py-2 text-start text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-foreground">
            {t('customProfitPct')} <span className="text-xs font-normal text-muted-foreground">({tc('optional')})</span>
          </label>
          <input
            name="customProfitPct" type="number" step="0.01" min="0" max="100"
            placeholder={tph('percent')} {...selectOnFocus}
            className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
          <p className="mt-1 text-[10px] text-muted-foreground">{t('byContributionHint')}</p>
        </div>
        {type === 'TEMP_INVESTOR' && (
          <div>
            <label className="mb-1 block text-sm font-medium text-foreground">
              {t('investorFeePct')} <span className="text-xs font-normal text-muted-foreground">({tc('optional')})</span>
            </label>
            <input
              name="investorFeePct" type="number" step="0.01" min="0" max="100"
              placeholder={tph('percent')} {...selectOnFocus}
              className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
            <p className="mt-1 text-[10px] text-muted-foreground">{t('feeFromProfit')}</p>
          </div>
        )}
      </div>

      <div className="flex justify-end gap-3">
        <button type="button" onClick={onCancel} className="rounded-lg px-4 py-2 text-sm text-muted-foreground hover:bg-muted">
          {tc('cancel')}
        </button>
        <button
          type="submit" disabled={pending}
          className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-700 disabled:opacity-50"
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          {tc('save')}
        </button>
      </div>
    </ValidatedForm>
  );
}
