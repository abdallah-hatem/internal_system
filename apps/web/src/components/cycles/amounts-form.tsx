'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from '@/components/ui/icons';
import { MoneyInput } from '@/components/ui/money-input';
import { Money } from '@/components/ui/money';
import { useNumberFormat } from '@/lib/numbers';
import { ValidatedForm } from '@/components/ui/validated-form';
import {
  amountFromPct,
  balanceLastPartner,
  pctFromAmount,
  pctTotal,
  splitAcrossPartners,
  type PartnerShareRow,
} from '@/lib/funding-split';

/**
 * Each participant's contribution, typed in place on the cycle page (the
 * funding note's Enter amounts, 2026-10-18).
 *
 * Any split, not only equal (owner 2026-10-19: "it does not have to be
 * equally maybe 30,30,40"). Each core partner's row has an amount and a
 * percentage of what the partners fund — the cost to fund less investors'
 * money, as Split equally takes it — kept in step: type 30 in % and the
 * amount fills; type an amount and the % follows. When the percentages come
 * to exactly 100 the last partner absorbs the rounding (`balanceLastPartner`),
 * so the amounts sum to the cost exactly. A line under the rows says what is
 * entered against the cost to fund, and when the % do not make 100.
 *
 * Starts from what is recorded, once: the rows are this form's own state, so
 * a refetch of the cycle underneath never overwrites what was typed. Save
 * hands back every amount; the page writes only what changed.
 */

export interface AmountsParticipant {
  id: string;
  participantType: string;
  contributionAmount: unknown;
}

const num = (v: unknown) => Number(v ?? 0);
const recorded = (p: AmountsParticipant) =>
  num(p.contributionAmount) ? num(p.contributionAmount).toFixed(2) : '';

export function AmountsForm<P extends AmountsParticipant>({
  participants,
  toFund,
  nameOf,
  roleOf,
  pending,
  onCancel,
  onSubmit,
}: {
  participants: P[];
  /** The server's cost to fund (`toFundEgp`): what the participants fund between them. */
  toFund: number;
  nameOf: (p: P) => string;
  roleOf: (p: P) => string;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (amounts: Record<string, string>) => void;
}) {
  const t = useTranslations('cycles');
  const tph = useTranslations('placeholders');
  const { formatNumber } = useNumberFormat();
  const tc = useTranslations('common');

  const isPartner = (p: AmountsParticipant) => p.participantType === 'CORE_PARTNER';
  const partners = participants.filter(isPartner);
  const others = participants.filter((p) => !isPartner(p));

  // Investors' money is theirs; the partners' 100% is what is left of the cost.
  const [otherAmounts, setOtherAmounts] = useState<Record<string, string>>(() =>
    Object.fromEntries(others.map((p) => [p.id, recorded(p)])),
  );
  const investors = others.reduce((s, p) => s + num(otherAmounts[p.id] || 0), 0);
  const base = Math.max(Math.round((toFund - investors) * 100), 0) / 100;

  const [rows, setRows] = useState<Record<string, PartnerShareRow>>(() =>
    Object.fromEntries(
      partners.map((p) => {
        const amount = recorded(p);
        return [p.id, { amount, pct: pctFromAmount(base, amount), from: null }];
      }),
    ),
  );

  /** Apply one partner's edit, then let the last absorb the rounding when the % make 100. */
  const edit = (id: string, next: (row: PartnerShareRow) => PartnerShareRow | null) =>
    setRows((prev) => {
      const changed = next(prev[id]);
      if (!changed) return prev;
      const order = partners.map((p) => p.id);
      const merged = { ...prev, [id]: changed };
      const balanced = balanceLastPartner(order.map((k) => merged[k]), base);
      return Object.fromEntries(order.map((k, i) => [k, balanced[i]]));
    });

  // MoneyInput reports again on blur with the value it already has: only a
  // real change moves the other field, so tabbing through never re-derives.
  const typeAmount = (id: string, raw: string) =>
    edit(id, (row) =>
      raw === row.amount ? null : { amount: raw, pct: pctFromAmount(base, raw), from: 'amount' },
    );
  const typePct = (id: string, raw: string) =>
    edit(id, (row) =>
      raw === row.pct ? null : { pct: raw, amount: amountFromPct(base, raw), from: 'pct' },
    );

  const amounts: Record<string, string> = {
    ...otherAmounts,
    ...Object.fromEntries(partners.map((p) => [p.id, rows[p.id]?.amount ?? ''])),
  };
  const enteredCents = Object.values(amounts).reduce((s, a) => s + Math.round(num(a || 0) * 100), 0);
  const gapCents = Math.round(toFund * 100) - enteredCents;
  const pcts = partners.map((p) => rows[p.id]?.pct ?? '');
  const anyPct = pcts.some((p) => p.trim() !== '');
  const pctSum = pctTotal(pcts);

  // The example in an empty box is this partner's equal share, so it reads as
  // this cycle's figure rather than a generic one (1,250.00 beside 12.5%).
  const equal = splitAcrossPartners(base, 0, partners.length).shares;
  const equalPct = partners.length ? String(Math.round(10000 / partners.length) / 100) : '';
  const exampleAmount = (i: number) =>
    base > 0 && equal[i] !== undefined
      ? formatNumber(equal[i], { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : tph('money');

  const field =
    'rounded-lg border border-border px-2 py-1.5 text-start text-sm focus:outline-none focus:ring-2 focus:ring-primary-500';

  return (
    <ValidatedForm
      data-testid="amounts-form"
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(amounts);
      }}
    >
      <div className="divide-y divide-border">
        {participants.map((p) => (
          <div key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
            <label htmlFor={`contribution-${p.id}`} className="min-w-[8rem] flex-1 text-sm text-foreground">
              <bdi className="font-medium">{nameOf(p)}</bdi>
              <span className="ms-2 text-xs text-muted-foreground">{roleOf(p)}</span>
            </label>
            <MoneyInput
              id={`contribution-${p.id}`}
              data-field={`contribution-${p.id}`}
              placeholder={isPartner(p) ? exampleAmount(partners.indexOf(p)) : tph('money')}
              value={isPartner(p) ? rows[p.id]?.amount ?? '' : otherAmounts[p.id] ?? ''}
              onChange={(raw) =>
                isPartner(p)
                  ? typeAmount(p.id, raw)
                  : setOtherAmounts((prev) => (prev[p.id] === raw ? prev : { ...prev, [p.id]: raw }))
              }
              className={`w-36 ${field}`}
            />
            {isPartner(p) ? (
              <span className="inline-flex items-center gap-1">
                <MoneyInput
                  id={`pct-${p.id}`}
                  data-field={`pct-${p.id}`}
                  aria-label={t('amountsPctLabel', { name: nameOf(p) })}
                  placeholder={base > 0 ? equalPct : tph('percent')}
                  value={rows[p.id]?.pct ?? ''}
                  onChange={(raw) => typePct(p.id, raw)}
                  className={`w-20 ${field}`}
                />
                <span className="text-xs text-muted-foreground" aria-hidden="true">%</span>
              </span>
            ) : (
              // Keeps the amounts in one column whether or not the row has a %.
              <span className="w-[6.25rem]" aria-hidden="true" />
            )}
          </div>
        ))}
      </div>

      <div className="space-y-0.5 text-xs">
        <p data-testid="amounts-total" className="text-muted-foreground">
          {t.rich('amountsTotal', {
            entered: () => <Money value={enteredCents / 100} className="font-medium text-foreground" />,
            toFund: () => <Money value={toFund} className="font-medium text-foreground" />,
          })}{' '}
          <span data-testid="amounts-gap" className={gapCents === 0 ? 'text-success' : 'text-accent-700'}>
            {gapCents === 0
              ? t('amountsMatch')
              : gapCents > 0
                ? t.rich('amountsLeft', { amount: () => <Money value={gapCents / 100} /> })
                : t.rich('amountsOver', { amount: () => <Money value={-gapCents / 100} /> })}
          </span>
        </p>
        {anyPct && Math.round(pctSum * 100) !== 10000 && (
          <p data-testid="amounts-pct-warning" className="text-accent-700">
            {t('amountsPctNot100', { total: pctSum.toFixed(2) })}
          </p>
        )}
      </div>

      <div className="flex justify-end gap-3">
        <button type="button" onClick={onCancel} className="rounded-lg px-4 py-2 text-sm text-muted-foreground hover:bg-muted">
          {tc('cancel')}
        </button>
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-700 disabled:opacity-50"
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          {tc('save')}
        </button>
      </div>
    </ValidatedForm>
  );
}
