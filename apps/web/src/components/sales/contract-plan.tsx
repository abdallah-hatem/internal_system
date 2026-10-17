'use client';

import { useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { FileSignature, Loader2, Plus, Scale, Trash2 } from 'lucide-react';

import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { businessToday } from '@/lib/dates';
import { useNumberFormat } from '@/lib/numbers';
import { useCan } from '@/lib/can';
import { Dialog } from '@/components/ui/dialog';
import { DatePicker } from '@/components/ui/date-picker';
import { MoneyInput } from '@/components/ui/money-input';
import { Money } from '@/components/ui/money';
import { Select } from '@/components/ui/select';
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

/** How far apart the instalments fall (BUSINESS_LOGIC §7, 2026-10-17). */
export const PLAN_INTERVALS = {
  week: { unit: 'week', every: 1 },
  twoWeeks: { unit: 'week', every: 2 },
  month: { unit: 'month', every: 1 },
  twoMonths: { unit: 'month', every: 2 },
  threeMonths: { unit: 'month', every: 3 },
} as const;
export type PlanInterval = keyof typeof PLAN_INTERVALS;
const INTERVAL_KEYS = Object.keys(PLAN_INTERVALS) as PlanInterval[];
const DEFAULT_INTERVAL: PlanInterval = 'month';

/**
 * The date of the instalment `n` intervals after `first` (n = 0 is `first`).
 * Weeks are 7 days each; months are calendar months counted from `first`
 * through `addMonths`, so the 31st clamps to a short month's end and returns.
 */
export function stepDate(first: string, interval: PlanInterval, n: number): string {
  const { unit, every } = PLAN_INTERVALS[interval];
  if (unit === 'month') return addMonths(first, every * n);
  const [y, m, d] = first.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 7 * every * n)).toISOString().slice(0, 10);
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

/**
 * One row as the popup holds it. `dueOn` is set only once someone typed a
 * date; until then the row is dated by its position from the first date.
 */
interface PlanRow {
  key: number;
  amount: string;
  dueOn?: string;
}

/** Keys only need to be unique, so a removed row's inputs never pass to its neighbour. */
let rowKeys = 0;
const newRow = (amount: string, dueOn?: string): PlanRow => ({ key: rowKeys++, amount, dueOn });

/**
 * The plan popup: the sale's total, what has been paid and what remains; how
 * many instalments, how far apart, and when the first falls due; then the
 * rows, equal amounts, each row's date and amount editable, rows added and
 * removed. Create stays disabled until the rows add up to the remaining
 * amount exactly.
 *
 * A row the user re-dated keeps its date: moving the first date or the
 * interval re-dates only the rows nobody touched. Changing the number of
 * instalments re-splits the amounts — an amount typed for a three-way split
 * means nothing in a five-way one — but keeps any date typed by hand. Adding
 * a row adds nothing to split (amount 0) and removing one re-splits nothing;
 * "Split remaining equally" does that on request.
 *
 * The rows are held beyond the count: typing "12" passes through "1", and the
 * dates typed for rows 2 and 3 should still be there when it arrives.
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
  const te = useTranslations('errors');
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
  const [interval, setIntervalKey] = useState<PlanInterval>(DEFAULT_INTERVAL);
  const [firstDue, setFirstDue] = useState(() => addMonths(businessToday(), 1));
  const [held, setHeld] = useState<PlanRow[]>(() =>
    splitEqually(remaining, DEFAULT_COUNT).map((a) => newRow(a)),
  );

  const count = /^\d+$/.test(countText) ? Number(countText) : NaN;
  const countValid = Number.isInteger(count) && count >= 1 && count <= MAX_INSTALMENTS;

  const rows =
    countValid && firstDue
      ? held.slice(0, count).map((r, i) => ({ ...r, dueOn: r.dueOn ?? stepDate(firstDue, interval, i) }))
      : [];

  const sumCents = rows.reduce((s, r) => s + toCents(r.amount), 0);
  const diffCents = sumCents - toCents(remaining);
  const today = businessToday();
  const pastDay = rows.find((r) => r.dueOn < today)?.dueOn;
  const amountMissing = rows.some((r) => toCents(r.amount) <= 0);
  const rowsValid = rows.length > 0 && !pastDay && !amountMissing;
  const ready = countValid && rowsValid && diffCents === 0;

  // Rows held beyond the count are padded on demand, so a count above what is
  // held still has a row for every instalment.
  const padded = (n: number, from: PlanRow[]) =>
    from.length >= n ? from : [...from, ...Array.from({ length: n - from.length }, () => newRow('0'))];

  const setCount = (text: string) => {
    const clean = text.replace(/\D/g, '').slice(0, 2);
    setCountText(clean);
    const n = Number(clean);
    if (!/^\d+$/.test(clean) || n < 1 || n > MAX_INSTALMENTS) return;
    // A new split: amounts start equal again, hand-typed dates stay.
    const equal = splitEqually(remaining, n);
    setHeld((h) => padded(n, h).map((r, i) => (i < n ? { ...r, amount: equal[i] } : r)));
  };

  const editRow = (key: number, change: Partial<PlanRow>) =>
    setHeld((h) => h.map((r) => (r.key === key ? { ...r, ...change } : r)));

  const removeRow = (key: number) => {
    setHeld((h) => h.filter((r) => r.key !== key));
    setCountText(String(Math.max(0, rows.length - 1)));
  };

  const canAdd = Number.isInteger(count) && count >= 0 && count < MAX_INSTALMENTS && Boolean(firstDue);
  const addRow = () => {
    if (!canAdd) return;
    const last = rows[rows.length - 1];
    const lastHeld = last ? held.find((r) => r.key === last.key) : undefined;
    // After a hand-dated row, one interval after that date; otherwise the new
    // row is dated by its position like every other untouched row.
    const dueOn = lastHeld?.dueOn ? stepDate(lastHeld.dueOn, interval, 1) : undefined;
    setHeld((h) => {
      const shown = padded(count, h).slice(0, count);
      return [...shown, newRow('0', dueOn), ...h.slice(count)];
    });
    setCountText(String(count + 1));
  };

  const splitRemaining = () => {
    if (!rows.length) return;
    const equal = splitEqually(remaining, rows.length);
    setHeld((h) => h.map((r, i) => (i < rows.length ? { ...r, amount: equal[i] } : r)));
  };

  // Set on the first click, before React re-renders the button disabled: two
  // clicks inside one frame would otherwise both see it enabled.
  const sending = useRef(false);
  const create = useMutation({
    mutationFn: () =>
      api.post(`/sales/orders/${sale.id}/contract-plan`, {
        // In date order, so the plan's sequence is the order they fall due
        // (the server sorts too; same-day rows keep the order on screen).
        instalments: [...rows]
          .sort((a, b) => (a.dueOn < b.dueOn ? -1 : a.dueOn > b.dueOn ? 1 : 0))
          .map((r) => ({ dueOn: r.dueOn, amount: Number(r.amount) })),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sale', sale.id] });
      void queryClient.invalidateQueries({ queryKey: ['paymentPlans'] });
      addToast(t('created'), 'success');
      onClose();
      router.push(`/${locale}/sales/${sale.id}/contract`);
    },
    onError: (e: unknown) => addToast(apiError(e, t('createFailed')), 'error'),
    onSettled: () => {
      sending.current = false;
    },
  });

  const fieldClass =
    'w-full rounded-lg border border-border bg-background px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-ring md:text-sm';
  const quietButton =
    'inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-sm text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50';

  return (
    <Dialog
      title={t('dialogTitle')}
      subtitle={sale.orderNo}
      onClose={onClose}
      size="lg"
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
            onClick={() => {
              if (!ready || sending.current) return;
              sending.current = true;
              create.mutate();
            }}
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

        <div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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
                className={fieldClass}
              />
              {!countValid && (
                <p className="mt-1 text-xs text-destructive" data-testid="contract-count-error">
                  {t('countRange')}
                </p>
              )}
            </div>
            <div>
              <label htmlFor="contract-interval" className="mb-1 block text-sm font-medium text-foreground">
                {t('every')}
              </label>
              <Select
                id="contract-interval"
                value={interval}
                onChange={(v) => {
                  if (v in PLAN_INTERVALS) setIntervalKey(v as PlanInterval);
                }}
                options={INTERVAL_KEYS.map((k) => ({ value: k, label: t(`intervals.${k}`) }))}
                placeholder={t('every')}
              />
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
          <p className="mt-2 text-xs text-muted-foreground" data-testid="contract-hint">
            {t('hint')}
          </p>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium text-foreground">{t('schedule')}</p>
          {rows.length > 0 && (
            <div
              className="grid grid-cols-[1.25rem_minmax(0,3fr)_minmax(0,2fr)_2.25rem] items-center gap-x-1.5 gap-y-2 text-sm sm:grid-cols-[2rem_minmax(0,1fr)_minmax(0,1fr)_2.5rem] sm:gap-x-2"
              data-testid="contract-rows"
            >
              <span className="text-xs text-muted-foreground max-[359px]:hidden">{t('line')}</span>
              <span className="text-xs text-muted-foreground max-[359px]:hidden">{t('dueOn')}</span>
              <span className="text-xs text-muted-foreground max-[359px]:hidden">{t('amount')}</span>
              <span aria-hidden="true" className="max-[359px]:hidden" />
              {rows.map((row, i) => (
                <ContractRow
                  key={row.key}
                  index={i}
                  row={row}
                  min={today}
                  onDate={(v) => editRow(row.key, { dueOn: v })}
                  onAmount={(v) => editRow(row.key, { amount: v })}
                  onRemove={() => removeRow(row.key)}
                  disabled={create.isPending}
                />
              ))}
            </div>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="contract-add-row"
              onClick={addRow}
              disabled={!canAdd || create.isPending}
              className={quietButton}
            >
              <Plus className="h-4 w-4" />
              {t('addRow')}
            </button>
            <button
              type="button"
              data-testid="contract-split"
              onClick={splitRemaining}
              disabled={rows.length === 0 || create.isPending}
              className={quietButton}
            >
              <Scale className="h-4 w-4" />
              {t('splitEqually')}
            </button>
          </div>

          {pastDay && (
            <p className="mt-2 text-xs text-destructive" data-testid="contract-row-error">
              {te('INSTALMENT_DUE_IN_PAST', { day: pastDay })}
            </p>
          )}
          {!pastDay && amountMissing && (
            <p className="mt-2 text-xs text-destructive" data-testid="contract-row-error">
              {t('amountRequired')}
            </p>
          )}
        </div>

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
  onRemove,
  disabled,
}: {
  index: number;
  row: { dueOn: string; amount: string };
  min: string;
  onDate: (v: string) => void;
  onAmount: (v: string) => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const t = useTranslations('sales.contract');
  const tph = useTranslations('placeholders');
  const { formatNumber } = useNumberFormat();
  // Below 360px a row is two lines — the date over the amount — or both fields
  // truncate, and an amount of 733.33 read as "33.33". Wider, the row's cells
  // sit straight in the table's columns.
  const narrow = 'max-[359px]:col-start-2';
  return (
    <div
      data-testid={`contract-row-${index}`}
      className="contents max-[359px]:col-span-full max-[359px]:grid max-[359px]:grid-cols-[1.25rem_minmax(0,1fr)_2.25rem] max-[359px]:items-center max-[359px]:gap-x-1.5 max-[359px]:gap-y-1.5"
    >
      <span className="text-muted-foreground tabular-nums max-[359px]:row-span-2 max-[359px]:row-start-1">
        {formatNumber(index + 1)}
      </span>
      <DatePicker
        className={`${narrow} max-[359px]:row-start-1`}
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
        aria-invalid={toCents(row.amount) <= 0}
        value={row.amount}
        onChange={onAmount}
        placeholder={tph('money')}
        className={`w-full rounded-lg border border-border bg-background px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-ring md:text-sm ${narrow} max-[359px]:row-start-2`}
      />
      <button
        type="button"
        data-testid={`contract-remove-${index}`}
        aria-label={t('removeLabel', { n: index + 1 })}
        onClick={onRemove}
        disabled={disabled}
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50 max-[359px]:col-start-3 max-[359px]:row-span-2 max-[359px]:row-start-1"
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
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
