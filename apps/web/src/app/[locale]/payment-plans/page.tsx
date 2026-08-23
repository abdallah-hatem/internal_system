'use client';

import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../../lib/api';
import { formatDate } from '../../../lib/dates';
import { useToast } from '../../../components/ui/toast';
import { CustomerLink } from '../../../components/ui/entity-link';
import { Money } from '../../../components/ui/money';
import { Select } from '../../../components/ui/select';
import { DatePicker } from '../../../components/ui/date-picker';
import { MoneyInput } from '../../../components/ui/money-input';
import {
  CalendarClock, Plus, X, Loader2, AlertTriangle, Check, Trash2, Ban,
} from 'lucide-react';

type InstalmentState = 'PAID' | 'DUE' | 'OVERDUE' | 'UPCOMING';

interface Instalment {
  id: string;
  sequence: number;
  dueOn: string;
  amount: number | string;
  paidEgp: number | string;
  outstandingEgp: number | string;
  state: InstalmentState;
  note?: string | null;
}

interface Plan {
  id: string;
  reference: string;
  status: string;
  agreedOn: string;
  note?: string | null;
  customer: { id: string; displayName: string; phone?: string | null };
  instalments: Instalment[];
  totalEgp: number | string;
  paidEgp: number | string;
  remainingEgp: number | string;
  overdueEgp: number | string;
  isOverdue: boolean;
  nextDueOn: string | null;
  nextDueEgp: number | string | null;
}

/** A draft row in the create form. */
interface DraftLine {
  dueOn: string;
  amount: string;
  note: string;
}

const STATE_STYLE: Record<InstalmentState, string> = {
  PAID: 'bg-green-100 text-green-700',
  DUE: 'bg-amber-100 text-amber-700',
  OVERDUE: 'bg-red-100 text-red-700',
  UPCOMING: 'bg-gray-100 text-gray-600',
};

const asDay = (d: Date) =>
  [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');

/**
 * The first Sunday strictly after the given day — collections happen on
 * Sundays, so each new line defaults a week on from the previous one.
 */
function nextSundayAfter(day: string) {
  const d = new Date(`${day}T12:00:00`);
  do {
    d.setDate(d.getDate() + 1);
  } while (d.getDay() !== 0);
  return asDay(d);
}

const today = () => asDay(new Date());

export default function PaymentPlansPage() {
  const t = useTranslations('paymentPlans');
  const tc = useTranslations('common');
  const queryClient = useQueryClient();
  const { addToast } = useToast();

  const [showCreate, setShowCreate] = useState(false);
  const [customerId, setCustomerId] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data: plans = [], isLoading } = useQuery<Plan[]>({
    queryKey: ['paymentPlans'],
    queryFn: () => api.get('/payment-plans?limit=100').then((r) => r.data.data ?? r.data),
  });

  const { data: customers = [] } = useQuery({
    queryKey: ['customers'],
    queryFn: () => api.get('/customers?limit=200').then((r) => r.data.data ?? r.data),
  });

  const createMutation = useMutation({
    mutationFn: (data: any) => api.post('/payment-plans', data),
    onSuccess: () => {
      addToast(t('created'), 'success');
      queryClient.invalidateQueries({ queryKey: ['paymentPlans'] });
      setShowCreate(false);
      setCustomerId('');
      setLines([]);
    },
    onError: (e: any) =>
      addToast(
        e?.response?.data?.error?.message || e?.response?.data?.message || t('createFailed'),
        'error',
      ),
  });

  const cancelMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.post(`/payment-plans/${id}/cancel`, { reason }),
    onSuccess: () => {
      addToast(t('cancelled'), 'success');
      queryClient.invalidateQueries({ queryKey: ['paymentPlans'] });
    },
    onError: (e: any) =>
      addToast(e?.response?.data?.error?.message || t('cancelFailed'), 'error'),
  });

  const list = Array.isArray(plans) ? plans : [];
  // Whoever is behind comes first — this page is a collections list.
  const ordered = [...list].sort((a, b) => Number(b.isOverdue) - Number(a.isOverdue));
  const totalOverdue = list.reduce((s, p) => s + Number(p.overdueEgp), 0);

  // Derived inside the updater from the current last row: computing it from
  // the closure meant several quick clicks all read a stale list and landed on
  // the same date.
  const addLine = () =>
    setLines((l) => {
      const last = l[l.length - 1]?.dueOn ?? today();
      return [...l, { dueOn: nextSundayAfter(last), amount: '', note: '' }];
    });

  const draftTotal = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
          <p className="text-sm text-gray-500 mt-1">{t('subtitle')}</p>
        </div>
        <button
          onClick={() => {
            setShowCreate(true);
            if (lines.length === 0) {
              // Seed with an upfront line dated today, which is how these are
              // usually agreed at the shop.
              setLines([{ dueOn: today(), amount: '', note: '' }]);
            }
          }}
          className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700"
        >
          <Plus className="h-4 w-4" /> {t('create')}
        </button>
      </div>

      {totalOverdue > 0 && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
          <AlertTriangle className="h-4 w-4 shrink-0 text-red-500" />
          <p className="text-sm text-red-800">
            {t('overdueBanner')} <Money value={totalOverdue} className="font-semibold" />
          </p>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-12 text-gray-500">
          <Loader2 className="me-2 h-5 w-5 animate-spin" /> {tc('loading')}
        </div>
      ) : ordered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 bg-white p-12 text-center text-gray-400">
          {t('noData')}
        </div>
      ) : (
        <div className="space-y-3">
          {ordered.map((plan) => (
            <div
              key={plan.id}
              className={`rounded-xl border bg-white ${plan.isOverdue ? 'border-red-200' : 'border-gray-200'}`}
            >
              <button
                onClick={() => setExpanded(expanded === plan.id ? null : plan.id)}
                className="flex w-full items-center justify-between gap-3 p-4 text-start"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900">
                      <CustomerLink id={plan.customer.id} name={plan.customer.displayName} />
                    </span>
                    <span className="font-mono text-xs text-gray-400">{plan.reference}</span>
                    {plan.isOverdue && (
                      <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                        {t('overdue')}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-gray-500">
                    {plan.nextDueOn
                      ? `${t('nextDue')}: ${formatDate(plan.nextDueOn)} · `
                      : ''}
                    {t('remaining')}: <Money value={plan.remainingEgp} /> {t('of')}{' '}
                    <Money value={plan.totalEgp} />
                  </p>
                </div>
                <div className="shrink-0 text-end">
                  {plan.isOverdue ? (
                    <p className="font-semibold text-red-600">
                      <Money value={plan.overdueEgp} />
                    </p>
                  ) : (
                    <p className="font-medium text-gray-700">
                      <Money value={plan.paidEgp} />
                    </p>
                  )}
                  <p className="text-xs text-gray-400">
                    {plan.isOverdue ? t('behind') : t('paidSoFar')}
                  </p>
                </div>
              </button>

              {expanded === plan.id && (
                <div className="border-t border-gray-100 px-4 py-3">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-gray-500">
                        <th className="py-1.5 text-start font-medium">{t('dueOn')}</th>
                        <th className="py-1.5 text-end font-medium">{t('amount')}</th>
                        <th className="py-1.5 text-end font-medium">{t('paid')}</th>
                        <th className="py-1.5 text-end font-medium">{tc('status')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {plan.instalments.map((i) => (
                        <tr key={i.id}>
                          <td className="py-2 text-gray-700">
                            {formatDate(i.dueOn)}
                            {i.note && <span className="ms-2 text-xs text-gray-400">{i.note}</span>}
                          </td>
                          <td className="py-2 text-end text-gray-900">
                            <Money value={i.amount} />
                          </td>
                          <td className="py-2 text-end text-gray-500">
                            <Money value={i.paidEgp} />
                          </td>
                          <td className="py-2 text-end">
                            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATE_STYLE[i.state]}`}>
                              {t(i.state.toLowerCase())}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {/* Payments are applied to the earliest promise first, so a
                      shop that pays generously early is not chased. */}
                  <p className="mt-3 text-xs text-gray-400">{t('cumulativeNote')}</p>

                  {plan.status === 'ACTIVE' && (
                    <div className="mt-3 flex justify-end">
                      <button
                        onClick={() => {
                          const reason = window.prompt(t('cancelReason'));
                          if (reason && reason.trim().length >= 3) {
                            cancelMutation.mutate({ id: plan.id, reason });
                          }
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50"
                      >
                        <Ban className="h-3.5 w-3.5" /> {t('cancelPlan')}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ─── Create ────────────────────────────────────────────────── */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden p-4">
          <div className="fixed inset-0 bg-black/50" onClick={() => setShowCreate(false)} />
          <div className="relative flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl bg-white shadow-xl">
            <div className="flex shrink-0 items-center justify-between border-b border-gray-200 px-6 py-4">
              <h2 className="text-lg font-semibold text-gray-900">{t('create')}</h2>
              <button onClick={() => setShowCreate(false)} className="text-gray-400 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                const instalments = lines
                  .filter((l) => Number(l.amount) > 0 && l.dueOn)
                  .map((l) => ({
                    dueOn: l.dueOn,
                    amount: Number(l.amount),
                    note: l.note || undefined,
                  }));

                if (!customerId) return addToast(t('needCustomer'), 'error');
                if (instalments.length === 0) return addToast(t('needInstalment'), 'error');

                createMutation.mutate({ customerId, instalments });
              }}
              className="min-h-0 space-y-4 overflow-y-auto p-6"
            >
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">
                  {t('customer')}<span className="ms-1 text-red-500">*</span>
                </label>
                <Select
                  value={customerId}
                  onChange={setCustomerId}
                  placeholder={t('customer')}
                  searchPlaceholder={tc('search')}
                  options={(Array.isArray(customers) ? customers : []).map((c: any) => ({
                    value: c.id,
                    label: c.displayName,
                    hint: c.phone ?? c.type,
                  }))}
                />
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <label className="text-sm font-medium text-gray-700">{t('instalments')}</label>
                  <button
                    type="button"
                    onClick={addLine}
                    className="inline-flex items-center gap-1 text-sm text-primary-600 hover:underline"
                  >
                    <Plus className="h-3.5 w-3.5" /> {t('addInstalment')}
                  </button>
                </div>

                {/* Amounts are whatever was agreed — the dates default to the
                    next Sundays but nothing forces equal splits. */}
                <p className="mb-2 text-xs text-gray-400">{t('amountsNote')}</p>

                <div className="space-y-2">
                  {lines.map((line, idx) => (
                    <div key={idx} className="flex items-start gap-2">
                      <div className="w-40 shrink-0">
                        <DatePicker
                          name={`due-${idx}`}
                          value={line.dueOn}
                          onChange={(v: string) =>
                            setLines((l) => l.map((x, i) => (i === idx ? { ...x, dueOn: v } : x)))
                          }
                        />
                      </div>
                      <MoneyInput
                        placeholder="0.00"
                        value={line.amount}
                        onChange={(raw) =>
                          setLines((l) => l.map((x, i) => (i === idx ? { ...x, amount: raw } : x)))
                        }
                        className="w-32 rounded-lg border border-gray-200 px-3 py-2 text-end text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                      />
                      <input
                        type="text"
                        placeholder={t('notePlaceholder')}
                        value={line.note}
                        onChange={(e) =>
                          setLines((l) => l.map((x, i) => (i === idx ? { ...x, note: e.target.value } : x)))
                        }
                        className="min-w-0 flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                      />
                      <button
                        type="button"
                        aria-label={tc('delete')}
                        onClick={() => setLines((l) => l.filter((_, i) => i !== idx))}
                        className="mt-1 rounded p-1.5 text-gray-300 hover:bg-gray-100 hover:text-red-600"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>

                {lines.length > 0 && (
                  <div className="mt-3 flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                    <span className="text-sm text-gray-600">{t('planTotal')}</span>
                    <Money value={draftTotal} className="text-sm font-semibold text-gray-900" />
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100"
                >
                  {tc('cancel')}
                </button>
                <button
                  type="submit"
                  disabled={createMutation.isPending}
                  className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm text-white hover:bg-primary-700 disabled:opacity-50"
                >
                  {createMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Check className="h-4 w-4" />
                  )}
                  {t('agree')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
