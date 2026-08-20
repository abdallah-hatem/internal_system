'use client';

import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../../lib/api';
import { useToast } from '../../../components/ui/toast';
import { Money } from '../../../components/ui/money';
import {
  Scale, Loader2, AlertTriangle, TrendingUp, TrendingDown,
  CheckCircle2, Wallet, RotateCcw, Calculator,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────
interface Line {
  id: string;
  component: string;
  amount: string | number;
  feeAmount?: string | number | null;
  participant: {
    id: string;
    participantType: string;
    partner?: { email?: string; partner?: { displayName?: string } } | null;
    investor?: { email?: string; partner?: { displayName?: string } } | null;
  };
}

interface Settlement {
  id: string;
  status: string;
  cycle?: { id: string; code: string; status: string };
  revenueEgp?: string | null;
  cogsEgp?: string | null;
  expensesEgp?: string | null;
  grossProfitEgp?: string | null;
  unsoldValueEgp?: string | null;
  unitsSold?: string | null;
  unitsRemaining?: string | null;
  calculatedAt?: string | null;
  lines: Line[];
}

const STATUS_STYLE: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-700',
  APPROVED: 'bg-blue-100 text-blue-700',
  PAID: 'bg-green-100 text-green-700',
  REVERSED: 'bg-red-100 text-red-700',
};

const COMPONENT_LABEL: Record<string, string> = {
  CAPITAL_RETURN: 'Capital returned',
  PROFIT_SHARE: 'Profit share',
  INVESTOR_FEE: 'Investor fee',
  INVESTOR_FEE_RECEIVED: 'Fee received',
};

const isBlank = (v: unknown) =>
  v === null || v === undefined || !Number.isFinite(Number(v));

// Prefer a real name over a login address, whichever role the participant
// holds; an investor may also have a partner record.
const nameOf = (l: Line) =>
  l.participant?.partner?.partner?.displayName ||
  l.participant?.investor?.partner?.displayName ||
  l.participant?.partner?.email ||
  l.participant?.investor?.email ||
  'Unknown';

// ─── Page ─────────────────────────────────────────────────────────────
export default function SettlementsPage() {
  const t = useTranslations('settlementsPage');
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const [selectedCycle, setSelectedCycle] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);

  const { data: settlements = [], isLoading } = useQuery({
    queryKey: ['settlements'],
    queryFn: () => api.get('/settlements').then((r) => r.data.data ?? r.data),
  });

  // The default page size hides older cycles, which are exactly the ones
  // ready to settle. Ask for a full list here.
  const { data: cycles = [] } = useQuery({
    queryKey: ['cycles', 'for-settlement'],
    queryFn: () =>
      api.get('/cycles', { params: { limit: 200 } }).then((r) => r.data.data ?? r.data),
  });

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['settlements'] });

  const onError = (e: any) =>
    addToast(
      e?.response?.data?.error?.message ||
        e?.response?.data?.message ||
        'Operation failed',
      'error',
    );

  const calcMutation = useMutation({
    mutationFn: (cycleId: string) =>
      api.post(`/settlements/calculate/${cycleId}`).then((r) => r.data),
    onSuccess: (data: any) => {
      setWarnings(data?.warnings ?? []);
      refresh();
      addToast('Settlement calculated', 'success');
    },
    onError,
  });

  const actionMutation = useMutation({
    mutationFn: ({ id, action }: { id: string; action: string }) =>
      api.post(`/settlements/${id}/${action}`, { reason: 'Reversed from UI' }),
    onSuccess: () => {
      refresh();
      addToast('Settlement updated', 'success');
    },
    onError,
  });

  const list: Settlement[] = Array.isArray(settlements) ? settlements : [];
  const cycleList: any[] = Array.isArray(cycles) ? cycles : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <Scale className="h-6 w-6 text-primary-600" /> {t('title')}
        </h1>

        <div className="flex items-center gap-2">
          <label htmlFor="cycle-select" className="sr-only">
            {t('selectCycle')}
          </label>
          <select
            id="cycle-select"
            value={selectedCycle}
            onChange={(e) => setSelectedCycle(e.target.value)}
            className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          >
            <option value="">{t('selectCycle')}</option>
            {cycleList.map((c: any) => (
              <option key={c.id} value={c.id}>
                {c.code}
              </option>
            ))}
          </select>
          <button
            onClick={() => calcMutation.mutate(selectedCycle)}
            disabled={!selectedCycle || calcMutation.isPending}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {calcMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Calculator className="h-4 w-4" />
            )}
            {t('calculate')}
          </button>
        </div>
      </div>

      {warnings.length > 0 && (
        <div
          role="status"
          className="rounded-xl border border-amber-200 bg-amber-50 p-4 space-y-1"
        >
          {warnings.map((w, i) => (
            <p key={i} className="text-sm text-amber-800 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              {w}
            </p>
          ))}
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
        </div>
      ) : list.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <Scale className="h-10 w-10 text-gray-300 mx-auto mb-3" />
          <p className="text-gray-500">{t('empty')}</p>
          <p className="text-sm text-gray-400 mt-1">
            {t('emptyHint')}
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {list.map((s) => (
            <SettlementCard
              key={s.id}
              settlement={s}
              t={t}
              onAction={(action) =>
                actionMutation.mutate({ id: s.id, action })
              }
              busy={actionMutation.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Card ─────────────────────────────────────────────────────────────
function SettlementCard({
  settlement: s,
  onAction,
  busy,
  t,
}: {
  settlement: Settlement;
  onAction: (action: string) => void;
  busy: boolean;
  t: (key: string, values?: Record<string, string | number | Date>) => string;
}) {
  const profit = Number(s.grossProfitEgp ?? 0);
  const remaining = Number(s.unitsRemaining ?? 0);

  // Group the lines by participant so each person reads as one row.
  const byParticipant = new Map<string, Line[]>();
  for (const l of s.lines ?? []) {
    const k = l.participant?.id ?? l.id;
    byParticipant.set(k, [...(byParticipant.get(k) ?? []), l]);
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-b border-gray-100">
        <div className="flex items-center gap-3">
          <span className="font-mono text-sm text-gray-700">
            {s.cycle?.code ?? '—'}
          </span>
          <span
            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
              STATUS_STYLE[s.status] ?? 'bg-gray-100 text-gray-600'
            }`}
          >
            {s.status}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {s.status === 'DRAFT' && (
            <ActionButton onClick={() => onAction('approve')} busy={busy} icon={CheckCircle2}>
              {t('approve')}
            </ActionButton>
          )}
          {s.status === 'APPROVED' && (
            <ActionButton onClick={() => onAction('pay')} busy={busy} icon={Wallet}>
              {t('markPaid')}
            </ActionButton>
          )}
          {s.status !== 'REVERSED' && (
            <ActionButton
              onClick={() => onAction('reverse')}
              busy={busy}
              icon={RotateCcw}
              tone="danger"
            >
              {t('reverse')}
            </ActionButton>
          )}
        </div>
      </div>

      {/* P&L strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 divide-y sm:divide-y-0 sm:divide-x divide-gray-100 border-b border-gray-100">
        <Metric label={t('revenue')} value={s.revenueEgp} />
        <Metric label={t('cogs')} value={s.cogsEgp} />
        <Metric label={t('expenses')} value={s.expensesEgp} />
        <Metric
          label={t('profit')}
          value={s.grossProfitEgp}
          tone={profit >= 0 ? 'good' : 'bad'}
          icon={profit >= 0 ? TrendingUp : TrendingDown}
        />
        <Metric
          label={t('unsoldStock')}
          value={s.unsoldValueEgp}
          hint={remaining > 0 ? `${remaining.toLocaleString()} ${t('units')}` : undefined}
        />
      </div>

      {remaining > 0 && (
        <p className="px-5 py-2 text-xs text-amber-700 bg-amber-50 border-b border-amber-100">
          {t('unsoldWarning', { units: remaining.toLocaleString() })}
        </p>
      )}

      {/* Participants */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">
            {t('participant')} — {s.cycle?.code}
          </caption>
          <thead className="bg-gray-50 text-xs text-gray-500">
            <tr>
              <th scope="col" className="text-start px-5 py-2 font-medium">{t('participant')}</th>
              <th scope="col" className="text-end px-4 py-2 font-medium">{t('capital')}</th>
              <th scope="col" className="text-end px-4 py-2 font-medium">{t('netProfit')}</th>
              <th scope="col" className="text-end px-4 py-2 font-medium">{t('fee')}</th>
              <th scope="col" className="text-end px-5 py-2 font-medium">{t('payout')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {[...byParticipant.values()].map((lines) => {
              const pick = (c: string) =>
                Number(lines.find((l) => l.component === c)?.amount ?? 0);
              const capital = pick('CAPITAL_RETURN');
              // PROFIT_SHARE is already net of any investor fee, so the
              // INVESTOR_FEE line is shown for transparency but must not be
              // subtracted again when totalling the payout.
              const share = pick('PROFIT_SHARE');
              const feeCharged = pick('INVESTOR_FEE');
              const feeReceived = pick('INVESTOR_FEE_RECEIVED');
              const feeDisplay = feeCharged + feeReceived;
              const payout = capital + share + feeReceived;
              const isInvestor =
                lines[0].participant?.participantType === 'TEMP_INVESTOR';

              return (
                <tr key={lines[0].participant?.id ?? lines[0].id}>
                  <td className="px-5 py-3">
                    <span className="text-gray-800">{nameOf(lines[0])}</span>
                    {isInvestor && (
                      <span className="ms-2 text-[11px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">
                        {t('investor')}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-end text-gray-600 tabular-nums">
                    <Money value={capital} />
                  </td>
                  <td className="px-4 py-3 text-end text-gray-800 tabular-nums">
                    <Money value={share} />
                  </td>
                  <td
                    className={`px-4 py-3 text-end tabular-nums ${
                      feeDisplay < 0
                        ? 'text-red-600'
                        : feeDisplay > 0
                          ? 'text-green-700'
                          : 'text-gray-400'
                    }`}
                    title={
                      feeCharged < 0
                        ? 'Already deducted from the profit share shown'
                        : undefined
                    }
                  >
                    {feeDisplay === 0 ? '—' : <Money value={feeDisplay} />}
                  </td>
                  <td className="px-5 py-3 text-end font-semibold text-gray-900 tabular-nums">
                    <Money value={payout} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="px-5 py-2 text-[11px] text-gray-400 border-t border-gray-100">
        {t('footnote')}
      </p>
    </div>
  );
}

function Metric({
  label, value, tone, icon: Icon, hint,
}: {
  label: string;
  value: number | string | null | undefined;
  tone?: 'good' | 'bad';
  icon?: React.ComponentType<{ className?: string }>;
  hint?: string;
}) {
  const color =
    tone === 'good' ? 'text-green-700' : tone === 'bad' ? 'text-red-600' : 'text-gray-900';
  return (
    <div className="px-5 py-3">
      <p className="text-xs text-gray-500 mb-0.5">{label}</p>
      <p className={`text-sm font-semibold tabular-nums flex items-center gap-1 ${color}`}>
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {isBlank(value) ? '—' : <Money value={value as number} />}
      </p>
      {hint && <p className="text-[11px] text-gray-400 mt-0.5">{hint}</p>}
    </div>
  );
}

function ActionButton({
  onClick, busy, icon: Icon, children, tone,
}: {
  onClick: () => void;
  busy: boolean;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  tone?: 'danger';
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${
        tone === 'danger'
          ? 'text-red-600 hover:bg-red-50'
          : 'text-primary-700 hover:bg-primary-50'
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
      {children}
    </button>
  );
}
