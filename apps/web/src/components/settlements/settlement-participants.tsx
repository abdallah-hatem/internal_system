'use client';

import { useTranslations } from 'next-intl';
import { Money } from '@/components/ui/money';

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
    partner?: { email?: string; partner?: { displayName?: string } } | null;
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
    return {
      key,
      name: nameOf(group[0]),
      isInvestor: group[0].participant?.participantType === 'TEMP_INVESTOR',
      capital,
      share,
      feeCharged,
      fee: feeCharged + feeReceived,
      payout: capital + share + feeReceived,
    };
  });
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
                <dt className="text-xs text-muted-foreground">{t('payout')}</dt>
                <dd className="whitespace-nowrap tabular-nums font-semibold text-foreground"><Money value={r.payout} /></dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>

      {/* Tablet and up: the table. */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <caption className="sr-only">
            {t('participant')} — {cycleCode}
          </caption>
          <thead className="bg-muted text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="text-start px-5 py-2 font-medium">{t('participant')}</th>
              <th scope="col" className="text-end px-4 py-2 font-medium whitespace-nowrap">{t('capital')}</th>
              <th scope="col" className="text-end px-4 py-2 font-medium whitespace-nowrap">{t('netProfit')}</th>
              <th scope="col" className="text-end px-4 py-2 font-medium whitespace-nowrap">{t('fee')}</th>
              <th scope="col" className="text-end px-5 py-2 font-medium whitespace-nowrap">{t('payout')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.key}>
                <td className="px-5 py-3 min-w-[10rem]">
                  <span className="text-foreground break-words"><bdi>{name(r)}</bdi></span>
                  {r.isInvestor && (
                    <span className="ms-2 text-[11px] px-1.5 py-0.5 rounded bg-primary/10 text-primary whitespace-nowrap">
                      {t('investor')}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-end text-muted-foreground tabular-nums whitespace-nowrap">
                  <Money value={r.capital} />
                </td>
                <td className="px-4 py-3 text-end text-foreground tabular-nums whitespace-nowrap">
                  <Money value={r.share} />
                </td>
                <td className={`px-4 py-3 text-end tabular-nums whitespace-nowrap ${feeTone(r.fee)}`} title={feeTitle(r)}>
                  {fee(r)}
                </td>
                <td className="px-5 py-3 text-end font-semibold text-foreground tabular-nums whitespace-nowrap">
                  <Money value={r.payout} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
