'use client';

import { useTranslations } from 'next-intl';
import { Money } from '@/components/ui/money';
import { DataTable, type Column } from '@/components/ui/data-table';

/**
 * Who gets what from one settlement.
 *
 * A five-column table does not fit a phone: at 390px the Fee column was cut
 * off, "EGP" wrapped onto a line of its own and names broke mid-word (UI audit
 * 2026-10-10, #1). Below `md` each participant is a small card with labelled
 * amounts; from `md` up it is the table. Same figures, worked out once.
 */

export interface SettlementLine {
  id: string;
  component: string;
  amount: string | number;
  participant: {
    id: string;
    participantType: string;
    partner?: { id?: string; email?: string; partner?: { displayName?: string } } | null;
    investor?: { email?: string; partner?: { displayName?: string } } | null;
  };
}

export interface ParticipantRow {
  key: string;
  name: string | null;
  isInvestor: boolean;
  capital: number;
  share: number;
  feeCharged: number;
  fee: number;
  /** His share of the running costs taken from this payout (L7), negative. */
  runningCosts: number;
  payout: number;
}

// Prefer a real name over a login address, whichever role the participant
// holds; an investor may also have a partner record.
const nameOf = (l: SettlementLine) =>
  l.participant?.partner?.partner?.displayName ||
  l.participant?.investor?.partner?.displayName ||
  l.participant?.partner?.email ||
  l.participant?.investor?.email ||
  null;

/** Group the lines by participant so each person reads as one row. */
/**
 * `projected`: before a settlement is paid it has no RUNNING_COSTS line yet;
 * what paying today would take comes from its breakdown (participantId →
 * amount, negative), so the table and the breakdown under it agree (L7).
 */
export function participantRows(
  lines: SettlementLine[],
  projected: Record<string, number> = {},
): ParticipantRow[] {
  const byParticipant = new Map<string, SettlementLine[]>();
  for (const l of lines) {
    const k = l.participant?.id ?? l.id;
    byParticipant.set(k, [...(byParticipant.get(k) ?? []), l]);
  }

  return [...byParticipant.entries()].map(([key, group]) => {
    const pick = (c: string) =>
      Number(group.find((l) => l.component === c)?.amount ?? 0);
    const capital = pick('CAPITAL_RETURN');
    // PROFIT_SHARE is already net of any investor fee, so the INVESTOR_FEE
    // line is shown for transparency but must not be subtracted again when
    // totalling the payout.
    const share = pick('PROFIT_SHARE');
    const feeCharged = pick('INVESTOR_FEE');
    const feeReceived = pick('INVESTOR_FEE_RECEIVED');
    // Running costs come out of a core partner's payout (§8, L7).
    const hasLine = group.some((l) => l.component === 'RUNNING_COSTS');
    const runningCosts = hasLine ? pick('RUNNING_COSTS') : (projected[key] ?? 0);
    return {
      key,
      name: nameOf(group[0]),
      isInvestor: group[0].participant?.participantType === 'TEMP_INVESTOR',
      capital,
      share,
      feeCharged,
      fee: feeCharged + feeReceived,
      runningCosts,
      payout: capital + share + feeReceived + runningCosts,
    };
  });
}

const feeTone = (fee: number) =>
  fee < 0 ? 'text-destructive' : fee > 0 ? 'text-foreground' : 'text-muted-foreground';

export function SettlementParticipants({
  lines,
  cycleCode,
  projectedRunningCosts,
}: {
  lines: SettlementLine[];
  cycleCode?: string;
  /** Before it is paid: what paying today would take, per participant (L7). */
  projectedRunningCosts?: Record<string, number>;
}) {
  const t = useTranslations('settlementsPage');
  const rows = participantRows(lines, projectedRunningCosts);
  const name = (r: ParticipantRow) => r.name ?? t('unknownParticipant');
  const feeTitle = (r: ParticipantRow) =>
    r.feeCharged < 0 ? t('feeAlreadyDeducted') : undefined;
  const fee = (r: ParticipantRow) =>
    r.fee === 0 ? '—' : <Money value={r.fee} />;
  const running = (r: ParticipantRow) =>
    r.runningCosts === 0 ? '—' : <Money value={r.runningCosts} />;

  // The participant takes what is left and wraps; every amount fits
  // "-123,456.00 EGP" and never cuts.
  const columns: Column<ParticipantRow>[] = [
    {
      key: 'participant', header: t('participant'), width: 'auto', kind: 'name', title: name,
      cell: (r) => (
        <>
          <span className="text-foreground"><bdi>{name(r)}</bdi></span>
          {r.isInvestor && (
            <span className="ms-2 text-[11px] px-1.5 py-0.5 rounded bg-primary/10 text-primary whitespace-nowrap">
              {t('investor')}
            </span>
          )}
        </>
      ),
    },
    { key: 'capital', header: t('capital'), width: '8.75rem', kind: 'value', align: 'end', className: 'text-muted-foreground', cell: (r) => <Money value={r.capital} /> },
    { key: 'share', header: t('netProfit'), width: '8.75rem', kind: 'value', align: 'end', className: 'text-foreground', cell: (r) => <Money value={r.share} /> },
    {
      key: 'fee', header: t('fee'), width: '8.75rem', kind: 'value', align: 'end', className: (r) => feeTone(r.fee),
      cellProps: (r) => ({ title: feeTitle(r) }), cell: fee,
    },
    { key: 'running', header: t('runningCosts'), width: '8.75rem', kind: 'value', align: 'end', className: 'text-muted-foreground', cell: running },
    { key: 'payout', header: t('payout'), width: '9.25rem', kind: 'value', align: 'end', className: 'font-semibold text-foreground', cell: (r) => <Money value={r.payout} /> },
  ];

  return (
    <>
      {/* Phone: one card per participant. */}
      <ul data-testid="settlement-participants-cards" className="divide-y divide-border md:hidden">
        {rows.map((r) => (
          <li key={r.key} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="min-w-0 break-words font-medium text-foreground [overflow-wrap:anywhere]">
                <bdi>{name(r)}</bdi>
              </span>
              {r.isInvestor && (
                <span className="text-[11px] px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                  {t('investor')}
                </span>
              )}
            </div>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">{t('capital')}</dt>
                <dd className="whitespace-nowrap tabular-nums text-muted-foreground"><Money value={r.capital} /></dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">{t('netProfit')}</dt>
                <dd className="whitespace-nowrap tabular-nums text-foreground"><Money value={r.share} /></dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">{t('fee')}</dt>
                <dd className={`whitespace-nowrap tabular-nums ${feeTone(r.fee)}`} title={feeTitle(r)}>
                  {fee(r)}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">{t('runningCosts')}</dt>
                <dd className="whitespace-nowrap tabular-nums text-muted-foreground">{running(r)}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">{t('payout')}</dt>
                <dd className="whitespace-nowrap tabular-nums font-semibold text-foreground"><Money value={r.payout} /></dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>

      {/* Tablet and up: the table (components/ui/data-table.tsx). */}
      <DataTable
        className="hidden md:block"
        frame="none"
        density="dense"
        autoMin="10rem"
        caption={<>{t('participant')} — {cycleCode}</>}
        rows={rows}
        rowKey={(r) => r.key}
        columns={columns}
      />
    </>
  );
}
