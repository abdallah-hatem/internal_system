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
  /**
   * His share of the running costs taken from this payout (L7), negative —
   * only on a settlement paid before 2026-11-08. Since then running costs are
   * shared to the selling cycles and sit inside the cycle's profit (§8).
   */
  runningCosts: number;
  /** Profit he took before settlement, and anything owed from an earlier payout (§8, 2026-11-08), negative. */
  profitDrawn: number;
  /**
   * What his draws came to beyond this payout: owed, and taken off his next
   * payout — the payout shows 0, never below zero because of draws.
   */
  owed: number;
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
export function participantRows(lines: SettlementLine[]): ParticipantRow[] {
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
    // Running costs came out of a core partner's payout until 2026-11-08 (§8,
    // L7); a settlement paid that way keeps its stored line. None is projected
    // any more: they are now a cost inside the cycle's profit.
    const runningCosts = pick('RUNNING_COSTS');
    // Profit taken before settlement comes off the payout (§8, 2026-11-08).
    const profitDrawn = pick('PROFIT_DRAWN');
    const payable = capital + share + feeReceived + runningCosts + profitDrawn;
    const owed = owedAfterPayout(payable, -profitDrawn);
    return {
      key,
      name: nameOf(group[0]),
      isInvestor: group[0].participant?.participantType === 'TEMP_INVESTOR',
      capital,
      share,
      feeCharged,
      fee: feeCharged + feeReceived,
      runningCosts,
      profitDrawn,
      owed,
      // To the piastre: -3,000.10 + 3,000.10 must read 0, not -0.00.
      payout: Math.round((payable + owed) * 100) / 100 || 0,
    };
  });
}

/**
 * What a partner still owes after a payout that came to less than he had
 * already taken — the API's `owedAfterPayout` (common/profit-draws.ts), read
 * the same way: the part of a negative payout his draws account for, never
 * more than he drew, so a loss beyond that stays what it always was. Zero when
 * the payout covers the draws. `drawn` is positive.
 */
export function owedAfterPayout(payable: number, drawn: number): number {
  if (payable >= 0 || drawn <= 0) return 0;
  return Math.min(-payable, drawn);
}

const feeTone = (fee: number) =>
  fee < 0 ? 'text-destructive' : fee > 0 ? 'text-foreground' : 'text-muted-foreground';

export function SettlementParticipants({
  lines,
  cycleCode,
}: {
  lines: SettlementLine[];
  cycleCode?: string;
}) {
  const t = useTranslations('settlementsPage');
  const rows = participantRows(lines);
  const name = (r: ParticipantRow) => r.name ?? t('unknownParticipant');
  const feeTitle = (r: ParticipantRow) =>
    r.feeCharged < 0 ? t('feeAlreadyDeducted') : undefined;
  const fee = (r: ParticipantRow) =>
    r.fee === 0 ? '—' : <Money value={r.fee} />;
  // Running costs taken from payouts: only a settlement paid before
  // 2026-11-08 has them (§8), so only then a column of their own.
  const anyRunning = rows.some((r) => r.runningCosts !== 0);
  const running = (r: ParticipantRow) =>
    r.runningCosts === 0 ? '—' : <Money value={r.runningCosts} />;
  // Profit taken before settlement (§8, 2026-11-08): a column only when
  // someone took some, so a settlement without any reads as it always did.
  const anyDrawn = rows.some((r) => r.profitDrawn !== 0);
  const drawn = (r: ParticipantRow) =>
    r.profitDrawn === 0 ? '—' : <Money value={r.profitDrawn} />;
  const payout = (r: ParticipantRow) => (
    <>
      <Money value={r.payout} />
      {r.owed > 0 && (
        <span data-testid="payout-owed" className="block text-[11px] font-normal text-destructive whitespace-normal">
          {t.rich('owesNote', { amount: () => <Money value={r.owed} /> })}
        </span>
      )}
    </>
  );

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
    ...(anyRunning
      ? [{ key: 'running', header: t('runningCosts'), width: '8.75rem', kind: 'value', align: 'end', className: 'text-muted-foreground', cell: running } satisfies Column<ParticipantRow>]
      : []),
    ...(anyDrawn
      ? [{ key: 'drawn', header: t('profitTaken'), width: '8.75rem', kind: 'value', align: 'end', className: 'text-muted-foreground', cell: drawn } satisfies Column<ParticipantRow>]
      : []),
    { key: 'payout', header: t('payout'), width: '9.25rem', kind: 'value', align: 'end', className: 'font-semibold text-foreground', cell: payout },
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
              {anyRunning && (
                <div className="min-w-0">
                  <dt className="text-xs text-muted-foreground">{t('runningCosts')}</dt>
                  <dd className="whitespace-nowrap tabular-nums text-muted-foreground">{running(r)}</dd>
                </div>
              )}
              {anyDrawn && (
                <div className="min-w-0">
                  <dt className="text-xs text-muted-foreground">{t('profitTaken')}</dt>
                  <dd className="whitespace-nowrap tabular-nums text-muted-foreground">{drawn(r)}</dd>
                </div>
              )}
              <div className="min-w-0">
                <dt className="text-xs text-muted-foreground">{t('payout')}</dt>
                <dd className="whitespace-nowrap tabular-nums font-semibold text-foreground">{payout(r)}</dd>
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
