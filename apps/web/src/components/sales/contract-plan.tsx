'use client';

import { useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { FileSignature, Loader2 } from 'lucide-react';

import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { businessToday } from '@/lib/dates';
import { useNumberFormat } from '@/lib/numbers';
import { useCan } from '@/lib/can';
import { Dialog } from '@/components/ui/dialog';
import { DatePicker } from '@/components/ui/date-picker';
import { MoneyInput } from '@/components/ui/money-input';
import { Money } from '@/components/ui/money';
import { useToast } from '@/components/ui/toast';

/**
 * A sale's instalment contract (BUSINESS_LOGIC §7, 2026-10-16): the Contract
 * button on the sale order popup, the popup that agrees the plan, and the
 * arithmetic behind its rows. The plan itself is agreed on the server
 * (`POST /sales/orders/:id/contract-plan`), which checks every rule again.
 */

/** The most instalments a contract may have — the API's MAX_CONTRACT_INSTALMENTS. */
export const MAX_INSTALMENTS = 36;
const DEFAULT_COUNT = 3;

/** What the button and the popup read off the sale. */
export interface ContractSale {
  id: string;
  orderNo: string;
  status: string;
  currency: string;
  total: number | string;
  outstanding: number | string;
  customer?: { isWalkIn?: boolean } | null;
  /** From `GET /sales/orders/:id`: the sale's live plan, or null. */
  contractPlan?: { id: string; reference: string; status: string } | null;
}

const OPEN_STATUSES = ['CONFIRMED', 'PARTIALLY_PAID'];

/**
 * Whether a new plan may be agreed for this sale — the server's rules, so the
 * button is not offered where the server would refuse: confirmed or partly
 * paid, in EGP, something outstanding, not a walk-in, no plan yet.
 */
export function canAgreeContract(sale: ContractSale): boolean {
  return (
    OPEN_STATUSES.includes(sale.status) &&
    sale.currency === 'EGP' &&
    Number(sale.outstanding) > 0 &&
    !sale.customer?.isWalkIn &&
    !sale.contractPlan
  );
}

/**
 * `day` (YYYY-MM-DD) moved on `months` calendar months, kept on the same day
 * of the month — or the month's last day where it has none (the 31st of
 * January is followed by the 28th or 29th of February, then the 31st of
 * March). Each row is counted from the first date, never from the row before,
 * so a short month does not pull every later date back.
 */
export function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + months, Math.min(d, lastDay))).toISOString().slice(0, 10);
}

/** `total` split into `count` equal amounts to the piastre; the last one absorbs the rounding. */
export function splitEqually(total: number | string, count: number): string[] {
  const cents = Math.round(Number(total) * 100);
  if (!Number.isFinite(cents) || count < 1) return [];
  const each = Math.floor(cents / count);
  return Array.from({ length: count }, (_, i) =>
    ((i === count - 1 ? cents - each * (count - 1) : each) / 100).toFixed(2),
  );
}

const toCents = (v: string | number) => Math.round((Number(v) || 0) * 100);

/**
 * The Contract button in the sale order popup's footer. A sale with its plan
 * opens the contract; an eligible one opens the plan popup, for whoever may
 * agree a plan. Anything else shows no button.
 */
export function ContractButton({ sale, onAgree }: { sale: ContractSale; onAgree: () => void }) {
  const t = useTranslations('sales.contract');
  const locale = useLocale();
  const router = useRouter();
  const mayAgree = useCan('sale.contractPlan');

  const hasPlan = Boolean(sale.contractPlan);
  if (!hasPlan && !(mayAgree && canAgreeContract(sale))) return null;

  return (
    <button
      type="button"
      data-testid="order-contract"
      onClick={() => (hasPlan ? router.push(`/${locale}/sales/${sale.id}/contract`) : onAgree())}
      className="bg-background inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm text-foreground hover:bg-muted"
    >
      <FileSignature className="h-4 w-4" />
      {t('open')}
    </button>
  );
}

interface RowEdit {
  dueOn?: string;
  amount?: string;
}

/**
 * The plan popup: the sale's total, what has been paid and what remains; how
 * many instalments and when the first falls due; then one row a month, equal
 * amounts, each row's date and amount editable. Create stays disabled until
 * the rows add up to the remaining amount exactly.
 *
 * A row the user edited keeps the edit: moving the first date re-dates only
 * the rows nobody touched. Changing the number of instalments re-splits the
 * amounts — an amount typed for a three-way split means nothing in a five-way
 * one — but keeps any date typed by hand.
 */
export function ContractPlanDialog({
  sale,
  onClose,
}: {
  sale: ContractSale;
  onClose: () => void;
}) {
  const t = useTranslations('sales.contract');
  const tc = useTranslations('common');
  const tph = useTranslations('placeholders');
  const apiError = useApiError();
  const { addToast } = useToast();
  const { formatMoney } = useNumberFormat();
  const queryClient = useQueryClient();
  const router = useRouter();
  const locale = useLocale();

  const remaining = Number(sale.outstanding);
  const paid = Number(sale.total) - remaining;

  const [countText, setCountText] = useState(String(DEFAULT_COUNT));
  const [firstDue, setFirstDue] = useState(() => addMonths(businessToday(), 1));
  const [edits, setEdits] = useState<Record<number, RowEdit>>({});

  const count = /^\d+$/.test(countText) ? Number(countText) : NaN;
  const countValid = Number.isInteger(count) && count >= 1 && count <= MAX_INSTALMENTS;

  const rows = useMemo(() => {
    if (!countValid || !firstDue) return [];
    const equal = splitEqually(remaining, count);
    return equal.map((amount, i) => ({
      dueOn: edits[i]?.dueOn ?? addMonths(firstDue, i),
      amount: edits[i]?.amount ?? amount,
    }));
  }, [countValid, count, firstDue, remaining, edits]);

  const sumCents = rows.reduce((s, r) => s + toCents(r.amount), 0);
  const diffCents = sumCents - toCents(remaining);
  const today = businessToday();
  const rowsValid =
    rows.length > 0 && rows.every((r) => r.dueOn && r.dueOn >= today && toCents(r.amount) > 0);
  const ready = countValid && rowsValid && diffCents === 0;

  const setCount = (text: string) => {
    setCountText(text.replace(/\D/g, '').slice(0, 2));
    // A new split: amounts start equal again, hand-typed dates stay.
    setEdits((e) =>
      Object.fromEntries(
        Object.entries(e)
          .filter(([, v]) => v.dueOn)
          .map(([k, v]) => [k, { dueOn: v.dueOn }]),
      ),
    );
  };
  const editRow = (i: number, change: RowEdit) =>
    setEdits((e) => ({ ...e, [i]: { ...e[i], ...change } }));

  const create = useMutation({
    mutationFn: () =>
      api.post(`/sales/orders/${sale.id}/contract-plan`, {
        instalments: rows.map((r) => ({ dueOn: r.dueOn, amount: Number(r.amount) })),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sale', sale.id] });
      void queryClient.invalidateQueries({ queryKey: ['paymentPlans'] });
      addToast(t('created'), 'success');
      onClose();
      router.push(`/${locale}/sales/${sale.id}/contract`);
    },
    onError: (e: unknown) => addToast(apiError(e, t('createFailed')), 'error'),
  });

  return (
    <Dialog
      title={t('dialogTitle')}
      subtitle={sale.orderNo}
      onClose={onClose}
      size="md"
      busy={create.isPending}
      cardProps={{ 'data-testid': 'contract-plan-dialog' }}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={create.isPending}
            className="rounded-lg px-4 py-2 text-sm text-muted-foreground hover:bg-muted disabled:opacity-50"
          >
            {tc('cancel')}
          </button>
          <button
            type="button"
            data-testid="contract-create"
            onClick={() => create.mutate()}
            disabled={!ready || create.isPending}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSignature className="h-4 w-4" />}
            {t('create')}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <dl className="grid grid-cols-3 gap-2 text-sm">
          <Figure label={t('total')} value={<Money value={sale.total} currency={sale.currency} />} />
          <Figure label={t('paid')} value={<Money value={paid} currency={sale.currency} />} />
          <Figure
            label={t('remaining')}
            value={<Money value={remaining} currency={sale.currency} />}
            testId="contract-remaining"
            strong
          />
        </dl>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="contract-count" className="mb-1 block text-sm font-medium text-foreground">
              {t('count')}
            </label>
            <input
              id="contract-count"
              type="text"
              inputMode="numeric"
              data-testid="contract-count"
              value={countText}
              placeholder={tph('instalmentCount')}
              onChange={(e) => setCount(e.target.value)}
              aria-invalid={!countValid}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            {!countValid && (
              <p className="mt-1 text-xs text-destructive" data-testid="contract-count-error">
                {t('countRange')}
              </p>
            )}
          </div>
          <div>
            <label htmlFor="contract-first-due" className="mb-1 block text-sm font-medium text-foreground">
              {t('firstDue')}
            </label>
            <DatePicker
              id="contract-first-due"
              value={firstDue}
              min={today}
              clearable={false}
              onChange={(v) => setFirstDue(v)}
              placeholder={t('firstDue')}
            />
          </div>
        </div>

        {rows.length > 0 && (
          <div>
            <p className="mb-2 text-sm font-medium text-foreground">{t('schedule')}</p>
            <div className="grid grid-cols-[2rem_1fr_1fr] items-center gap-x-2 gap-y-2 text-sm" data-testid="contract-rows">
              <span className="text-xs text-muted-foreground">{t('line')}</span>
              <span className="text-xs text-muted-foreground">{t('dueOn')}</span>
              <span className="text-xs text-muted-foreground">{t('amount')}</span>
              {rows.map((row, i) => (
                <ContractRow
                  key={i}
                  index={i}
                  row={row}
                  min={today}
                  onDate={(v) => editRow(i, { dueOn: v })}
                  onAmount={(v) => editRow(i, { amount: v })}
                />
              ))}
            </div>
          </div>
        )}

        <div
          data-testid="contract-sum"
          data-diff={(diffCents / 100).toFixed(2)}
          className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm ${
            diffCents === 0 ? 'border-border bg-muted' : 'border-destructive bg-background'
          }`}
        >
          <span className="text-muted-foreground">
            {t('sum')}: <Money value={sumCents / 100} currency={sale.currency} className="font-semibold text-foreground" />
          </span>
          <span
            data-testid="contract-difference"
            className={diffCents === 0 ? 'text-success' : 'font-medium text-destructive'}
          >
            {diffCents === 0
              ? t('matches')
              : t(diffCents < 0 ? 'short' : 'over', {
                  amount: formatMoney(Math.abs(diffCents) / 100, sale.currency),
                })}
          </span>
        </div>
      </div>
    </Dialog>
  );
}

function ContractRow({
  index,
  row,
  min,
  onDate,
  onAmount,
}: {
  index: number;
  row: { dueOn: string; amount: string };
  min: string;
  onDate: (v: string) => void;
  onAmount: (v: string) => void;
}) {
  const t = useTranslations('sales.contract');
  const tph = useTranslations('placeholders');
  const { formatNumber } = useNumberFormat();
  return (
    <>
      <span className="text-muted-foreground tabular-nums">{formatNumber(index + 1)}</span>
      <DatePicker
        id={`contract-due-${index}`}
        value={row.dueOn}
        min={min}
        clearable={false}
        onChange={onDate}
        placeholder={t('dueLabel', { n: index + 1 })}
      />
      <MoneyInput
        data-testid={`contract-amount-${index}`}
        aria-label={t('amountLabel', { n: index + 1 })}
        value={row.amount}
        onChange={onAmount}
        placeholder={tph('money')}
        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />
    </>
  );
}

function Figure({
  label,
  value,
  strong,
  testId,
}: {
  label: string;
  value: React.ReactNode;
  strong?: boolean;
  testId?: string;
}) {
  return (
    <div className="rounded-lg border border-border px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd data-testid={testId} className={`tabular-nums ${strong ? 'font-semibold text-foreground' : 'text-foreground'}`}>
        {value}
      </dd>
    </div>
  );
}
