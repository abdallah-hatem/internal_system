'use client';
import { useAllRecords } from '@/lib/list-all';
import { ListCapNotice } from '@/components/ui/list-cap-notice';
import { Select } from '../../../components/ui/select';

import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../../lib/api';
import { useToast } from '../../../components/ui/toast';
import { Money } from '../../../components/ui/money';
import { useNumberFormat } from '@/lib/numbers';
import {
  Scale, Loader2, TrendingUp, TrendingDown,
  CheckCircle2, Wallet, RotateCcw, Calculator, X,
} from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';

import { useApiError } from '../../../lib/api-error';
import { useCodeLabel } from '@/lib/labels';
import { useCan } from '@/lib/can';
import { ValidatedForm } from '@/components/ui/validated-form';
import { SettlementWarnings, type SettlementWarning } from '@/components/settlements/settlement-warnings';
import { SettlementParticipants, type SettlementLine } from '@/components/settlements/settlement-participants';
// ─── Types ────────────────────────────────────────────────────────────
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
  lines: SettlementLine[];
}

const STATUS_STYLE: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-700',
  APPROVED: 'bg-blue-100 text-blue-700',
  PAID: 'bg-green-100 text-green-700',
  REVERSED: 'bg-red-100 text-red-700',
};

const isBlank = (v: unknown) =>
  v === null || v === undefined || !Number.isFinite(Number(v));

type SettlementPermissions = { calculate: boolean; approve: boolean; pay: boolean; reverse: boolean };

// ─── Page ─────────────────────────────────────────────────────────────
export default function SettlementsPage() {
  const codeLabel = useCodeLabel();
  const apiError = useApiError();
  const t = useTranslations('settlementsPage');
  const tc = useTranslations('common');
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const [selectedCycle, setSelectedCycle] = useState('');
  const [warnings, setWarnings] = useState<SettlementWarning[]>([]);
  // An investor reads their cycles' settlements and their own line; every
  // write here is a partner's (R1b). Each flag mirrors its endpoint's @Roles.
  const may: SettlementPermissions = {
    calculate: useCan('settlement.calculate'),
    approve: useCan('settlement.approve'),
    pay: useCan('settlement.pay'),
    reverse: useCan('settlement.reverse'),
  };

  const { items: settlements, capped, isLoading } = useAllRecords(['settlements'], '/settlements');

  // The default page size hid older cycles, which are exactly the ones ready
  // to settle. Every cycle, the same list the cycles page reads.
  const { items: cycles } = useAllRecords(['cycles'], '/cycles', undefined, {
    enabled: may.calculate,
  });

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['settlements'] });

  const onError = (e: any) =>
    addToast(
      apiError(e, tc('operationFailed')),
      'error',
    );

  const calcMutation = useMutation({
    mutationFn: (cycleId: string) =>
      api.post(`/settlements/calculate/${cycleId}`).then((r) => r.data),
    onSuccess: (data: any) => {
      setWarnings(data?.warnings ?? []);
      refresh();
      addToast(t('calculated'), 'success');
    },
    onError,
  });

  // Reversing needs a reason from the person doing it; paying sometimes needs
  // an explicit decision about stock still on the shelf. Both are held here
  // while the dialog is open.
  const [reversing, setReversing] = useState<string | null>(null);
  const [reverseReason, setReverseReason] = useState('');
  const [stockPrompt, setStockPrompt] = useState<{ id: string; message: string } | null>(null);

  const actionMutation = useMutation({
    // Each endpoint takes its OWN body, and the API rejects anything else
    // outright (`property reason should not exist`). Sending one shape to all
    // three made Mark paid fail every time it was pressed.
    mutationFn: ({ id, action, body }: { id: string; action: string; body?: unknown }) =>
      api.post(`/settlements/${id}/${action}`, body ?? {}),
    onSuccess: () => {
      refresh();
      setReversing(null);
      setReverseReason('');
      setStockPrompt(null);
      addToast(t('updated'), 'success');
    },
    onError,
  });

  const payMutation = useMutation({
    mutationFn: ({ id, acceptRemainingStock }: { id: string; acceptRemainingStock?: boolean }) =>
      api.post(`/settlements/${id}/pay`, acceptRemainingStock ? { acceptRemainingStock } : {}),
    onSuccess: () => {
      refresh();
      setStockPrompt(null);
      addToast(t('paid'), 'success');
    },
    onError: (e: any, variables) => {
      // Closing a cycle that still holds stock writes that cost off, so the API
      // refuses until it is asked for deliberately. Ask, rather than showing a
      // refusal the person cannot act on.
      //
      // Matched on the error code, not on the message. This used to test the
      // message against /still holds|remaining/, which stops matching the
      // moment the message is read in Arabic — and the prompt this opens is
      // the only way to complete the close, so the reader would have been
      // stuck with a refusal and no way past it.
      const code = e?.response?.data?.error?.code;
      if (!variables.acceptRemainingStock && code === 'CYCLE_HAS_UNSOLD_STOCK') {
        setStockPrompt({ id: variables.id, message: apiError(e, tc('error')) });
        return;
      }
      onError(e);
    },
  });

  const onAction = (id: string, action: string) => {
    if (action === 'pay') return payMutation.mutate({ id });
    if (action === 'reverse') {
      setReverseReason('');
      setReversing(id);
      return;
    }
    actionMutation.mutate({ id, action });
  };

  const list: Settlement[] = Array.isArray(settlements) ? settlements : [];
  const cycleList: any[] = Array.isArray(cycles) ? cycles : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <Scale className="h-6 w-6 text-primary-600" /> {t('title')}
        </h1>

        {may.calculate && (
        <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
          <label htmlFor="cycle-select" className="sr-only">
            {t('selectCycle')}
          </label>
          <Select
            id="cycle-select"
            className="min-w-0 flex-1 sm:w-64 sm:flex-none"
            value={selectedCycle}
            onChange={setSelectedCycle}
            placeholder={t('selectCycle')}
            searchPlaceholder={tc('search')}
            options={cycleList.map((c: any) => ({
              value: c.id,
              label: c.code,
              hint: [c.originType && codeLabel('originType', c.originType), c.status && codeLabel('cycleStatus', c.status)].filter(Boolean).join(' · '),
            }))}
          />
          <button
            type="button"
            onClick={() => calcMutation.mutate(selectedCycle)}
            disabled={!selectedCycle || calcMutation.isPending}
            className="inline-flex shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap px-4 py-2 rounded-lg text-sm font-medium bg-primary-600 text-white hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {calcMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Calculator className="h-4 w-4" />
            )}
            {t('calculate')}
          </button>
        </div>
        )}
      </div>

      <SettlementWarnings warnings={warnings} />

      <ListCapNotice capped={capped} count={settlements.length} />

      {isLoading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
        </div>
      ) : list.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200">
          <EmptyState icon={Scale} title={t('empty')} description={t('emptyHint')} />
        </div>
      ) : (
        <div className="space-y-5">
          {list.map((s) => (
            <SettlementCard
              key={s.id}
              settlement={s}
              t={t}
              may={may}
              onAction={(action) => onAction(s.id, action)}
              busy={actionMutation.isPending || payMutation.isPending}
            />
          ))}
        </div>
      )}

      {/* Reversing writes balancing ledger entries; the reason travels with them
          and into the audit log, so it has to come from the person reversing. */}
      {reversing && (
        <Modal title={t('reverse')} onClose={() => setReversing(null)}>
          <ValidatedForm
            onSubmit={(e) => {
              e.preventDefault();
              actionMutation.mutate({
                id: reversing,
                action: 'reverse',
                body: { reason: reverseReason.trim() },
              });
            }}
            className="space-y-4"
          >
            <div>
              <label htmlFor="reverse-reason" className="block text-sm font-medium text-gray-700 mb-1">
                {t('reverseReason')}<span className="text-red-500 ms-1">*</span>
              </label>
              <textarea
                id="reverse-reason"
                value={reverseReason}
                onChange={(e) => setReverseReason(e.target.value)}
                required
                minLength={3}
                rows={3}
                placeholder={t('reverseReasonHint')}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
              />
            </div>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setReversing(null)}
                className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg"
              >
                {tc('cancel')}
              </button>
              <button
                type="submit"
                disabled={actionMutation.isPending}
                className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 inline-flex items-center gap-2"
              >
                {actionMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('reverse')}
              </button>
            </div>
          </ValidatedForm>
        </Modal>
      )}

      {/* Unsold stock keeps its cost with the cycle, so closing writes it off. */}
      {stockPrompt && (
        <Modal title={t('markPaid')} onClose={() => setStockPrompt(null)}>
          <div className="space-y-4">
            <p className="text-sm text-gray-600">{stockPrompt.message}</p>
            <p className="text-sm text-gray-600">{t('acceptRemainingStockHint')}</p>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setStockPrompt(null)}
                className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg"
              >
                {tc('cancel')}
              </button>
              <button
                type="button"
                disabled={payMutation.isPending}
                onClick={() =>
                  payMutation.mutate({ id: stockPrompt.id, acceptRemainingStock: true })
                }
                className="px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 inline-flex items-center gap-2"
              >
                {payMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('closeAnyway')}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const closeLabel = useTranslations('common')('close');
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 overflow-hidden">
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 shrink-0">
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          <button type="button" onClick={onClose} aria-label={closeLabel} className="cursor-pointer text-gray-400 hover:text-gray-600"><X className="h-5 w-5" /></button>
        </div>
        <div className="p-6 overflow-y-auto min-h-0">{children}</div>
      </div>
    </div>
  );
}

// ─── Card ─────────────────────────────────────────────────────────────
function SettlementCard({
  settlement: s,
  may,
  onAction,
  busy,
  t,
}: {
  settlement: Settlement;
  may: SettlementPermissions;
  onAction: (action: string) => void;
  busy: boolean;
  t: (key: string, values?: Record<string, string | number | Date>) => string;
}) {
  const codeLabel = useCodeLabel();
  const { formatNumber } = useNumberFormat();
  const profit = Number(s.grossProfitEgp ?? 0);
  const remaining = Number(s.unitsRemaining ?? 0);

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 sm:px-5 py-4 border-b border-gray-100">
        <div className="flex min-w-0 items-center gap-3">
          <span dir="ltr" className="font-mono text-sm text-gray-700 whitespace-nowrap">
            {s.cycle?.code ?? '—'}
          </span>
          <span
            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
              STATUS_STYLE[s.status] ?? 'bg-gray-100 text-gray-600'
            }`}
          >
            {codeLabel('settlementStatus', s.status)}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {may.approve && s.status === 'DRAFT' && (
            <ActionButton onClick={() => onAction('approve')} busy={busy} icon={CheckCircle2}>
              {t('approve')}
            </ActionButton>
          )}
          {may.pay && s.status === 'APPROVED' && (
            <ActionButton onClick={() => onAction('pay')} busy={busy} icon={Wallet}>
              {t('markPaid')}
            </ActionButton>
          )}
          {may.reverse && s.status !== 'REVERSED' && (
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
          hint={remaining > 0 ? t('unitsCount', { units: formatNumber(remaining) }) : undefined}
        />
      </div>

      {remaining > 0 && (
        <p className="px-5 py-2 text-xs text-amber-700 bg-amber-50 border-b border-amber-100">
          {t('unsoldWarning', { units: formatNumber(remaining) })}
        </p>
      )}

      {/* Participants */}
      <SettlementParticipants lines={s.lines ?? []} cycleCode={s.cycle?.code} />

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
    <div className="min-w-0 px-4 py-3 sm:px-5">
      <p className="text-xs text-gray-500 mb-0.5">{label}</p>
      <p className={`text-sm font-semibold tabular-nums flex items-center gap-1 whitespace-nowrap ${color}`}>
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
      type="button"
      onClick={onClick}
      disabled={busy}
      className={`inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${
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
