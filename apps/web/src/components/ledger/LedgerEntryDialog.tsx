'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDownRight, ArrowUpRight, Loader2 } from '@/components/ui/icons';
import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { useCodeLabel } from '@/lib/labels';
import { businessToday } from '@/lib/dates';
import { useAllRecords } from '@/lib/list-all';
import { useCurrencyRates } from '@/lib/currency-rates';
import {
  CLOSED_CYCLE_STATUSES,
  CYCLE_REQUIRED_CATEGORIES,
  MANUAL_ENTRY_KINDS,
  type ManualEntryKind,
} from '@/lib/ledger-categories';
import { Select } from '@/components/ui/select';
import { DatePicker } from '@/components/ui/date-picker';
import { MoneyInput } from '@/components/ui/money-input';
import { CurrencyRateFields } from '@/components/ui/currency-rate-fields';
import { useToast } from '@/components/ui/toast';

interface CycleRow {
  id: string;
  code: string;
  status: string;
}

/**
 * Record money in or out by hand (BUSINESS_LOGIC §9, L6 — mockup accepted by
 * the owner 2026-10-11).
 *
 * The form it replaces offered system types like Purchase, a free-text
 * category, an Inflow/Outflow radio, a free-text cycle id and no date, and the
 * API saved whatever came. Now:
 *
 * - **What is it?** Two cards. The choice sets the direction; there is no
 *   radio to get wrong.
 * - **Category** from the one list (`lib/ledger-categories.ts`, a tested copy
 *   of the API's), changing with the kind.
 * - **Currency** with the rate prefilled from the FX page and editable; for
 *   pounds the rate steps aside.
 * - **Date**, today in Cairo by default, never later.
 * - **Charge to a cycle**, optional — except for extra freight, which is a
 *   cost of one cycle's goods (§2). Closed and cancelled cycles are not
 *   offered.
 *
 * The server checks every one of these again (rule 3); a refusal is shown
 * translated inside the dialog, which keeps everything as typed.
 */
export function LedgerEntryDialog({
  open,
  onClose,
  onRecorded,
  presetCategory,
}: {
  open: boolean;
  onClose: () => void;
  onRecorded?: () => void;
  /** An expense category to open on — the ledger's Fuel shortcut (§9, 2026-10-17). */
  presetCategory?: string;
}) {
  if (!open) return null;
  // Mounted fresh on every open, so nothing typed last time survives a close.
  return <LedgerEntryForm onClose={onClose} onRecorded={onRecorded} presetCategory={presetCategory} />;
}

function LedgerEntryForm({
  onClose,
  onRecorded,
  presetCategory,
}: {
  onClose: () => void;
  onRecorded?: () => void;
  presetCategory?: string;
}) {
  const t = useTranslations('ledger');
  const tph = useTranslations('placeholders');
  const tc = useTranslations('common');
  const te = useTranslations('errors');
  const apiError = useApiError();
  const codeLabel = useCodeLabel();
  const queryClient = useQueryClient();
  const toast = useToast();
  const rates = useCurrencyRates();

  const [kind, setKind] = useState<ManualEntryKind>('EXPENSE');
  // Only an expense category is taken, the kind the form opens on; anything
  // else would be refused by the server, so it opens empty instead.
  const [category, setCategory] = useState(() =>
    presetCategory && MANUAL_ENTRY_KINDS.EXPENSE.categories.includes(presetCategory) ? presetCategory : '',
  );
  const [amount, setAmount] = useState('');
  const [occurredOn, setOccurredOn] = useState(() => businessToday());
  const [cycleId, setCycleId] = useState('');
  const [note, setNote] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const refusalRef = useRef<HTMLParagraphElement>(null);

  // The refusal sits under the last field; on a phone that is below the fold,
  // so a Save that "did nothing" would be all anyone saw.
  useEffect(() => {
    if (refusal) refusalRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [refusal]);

  // Escape closes the form — never while a picker inside it is open, and
  // never mid-save. One definition for every dialog (lib/use-escape-to-close).

  const { items: cycles } = useAllRecords<CycleRow>(['cycles'], '/cycles');
  const cycleOptions = useMemo(
    () =>
      (Array.isArray(cycles) ? cycles : [])
        .filter((c) => !CLOSED_CYCLE_STATUSES.includes(c.status))
        .map((c) => ({ value: c.id, label: `${c.code} · ${codeLabel('cycleStatus', c.status)}` })),
    [cycles, codeLabel],
  );

  const rule = MANUAL_ENTRY_KINDS[kind];
  const categoryOptions = rule.categories.map((c) => ({
    value: c,
    label: codeLabel('ledgerCategory', c),
  }));
  const cycleRequired = CYCLE_REQUIRED_CATEGORIES.includes(category);

  const chooseKind = (next: ManualEntryKind) => {
    setKind(next);
    // A category of the other kind would be refused; drop it rather than send it.
    if (!MANUAL_ENTRY_KINDS[next].categories.includes(category)) setCategory('');
    setRefusal(null);
  };

  /** The form's own checks, in the server's words (rule 3). */
  const problem = (currency: string, rate: number): string | null => {
    if (!category) return t('chooseCategory');
    if (!(Number(amount) > 0)) return te('LEDGER_AMOUNT_NOT_POSITIVE');
    if (currency !== 'EGP' && !(rate > 0)) return te('LEDGER_RATE_NOT_POSITIVE', { currency });
    if (cycleRequired && !cycleId) {
      return te('LEDGER_CYCLE_REQUIRED', { category: codeLabel('ledgerCategory', category) });
    }
    return null;
  };

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (submitting.current) return;
    const fd = new FormData(e.currentTarget);
    const currency = String(fd.get('currency') || 'EGP');
    const rate = Number(fd.get('fxRateToEgp'));
    const invalid = problem(currency, rate);
    if (invalid) {
      setRefusal(invalid);
      return;
    }
    submitting.current = true;
    setPending(true);
    setRefusal(null);
    try {
      await api.post('/ledger', {
        kind,
        direction: rule.direction,
        category,
        amount: Number(amount),
        currency,
        ...(currency === 'EGP' ? {} : { fxRateToEgp: rate }),
        occurredOn,
        ...(cycleId ? { cycleId } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
    } catch (err) {
      setRefusal(apiError(err, t('recordFailed')));
      submitting.current = false;
      setPending(false);
      return;
    }
    submitting.current = false;
    // Expenses and income move the dashboard, the cycle's profit and its
    // settlement preview, not only the ledger.
    for (const key of ['ledger', 'analytics', 'settlements', 'settlement', 'cycle', 'cycles']) {
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
    toast.success(t('entryCreated'));
    onRecorded?.();
    onClose();
  };

  const currencies = useMemo(
    () => ['EGP', ...new Set(['USD', 'AED', ...Object.keys(rates).filter((c) => c !== 'EGP')])],
    [rates],
  );

  const kinds: { key: ManualEntryKind; title: string; hint: string; Icon: typeof ArrowUpRight; tone: string }[] = [
    { key: 'EXPENSE', title: t('kindExpense'), hint: t('kindExpenseHint'), Icon: ArrowDownRight, tone: 'text-destructive' },
    { key: 'OTHER_INCOME', title: t('kindIncome'), hint: t('kindIncomeHint'), Icon: ArrowUpRight, tone: 'text-success' },
  ];

  return (
    <Dialog
      data-ledger-entry-dialog
      title={t('recordTitle')}
      onClose={onClose}
      busy={() => submitting.current}
      onSubmit={(e) => void submit(e)}
      bodyClassName="space-y-4"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="min-h-11 cursor-pointer rounded-lg px-4 py-2 text-sm text-muted-foreground hover:bg-muted disabled:cursor-not-allowed sm:min-h-0"
          >
            {tc('cancel')}
          </button>
          <button
            type="submit"
            disabled={pending}
            className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0"
          >
            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
            {tc('save')}
          </button>
        </>
      }
    >
      <fieldset>
        <legend className="mb-2 block text-sm font-medium text-foreground">{t('whatIsIt')}</legend>
        <div role="radiogroup" aria-label={t('whatIsIt')} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {kinds.map(({ key, title, hint, Icon, tone }) => {
            const on = kind === key;
            return (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={on}
                data-kind={key}
                onClick={() => chooseKind(key)}
                className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-start transition-colors ${
                  on ? 'border-primary bg-primary/5 ring-2 ring-primary/30' : 'border-border hover:bg-muted'
                }`}
              >
                <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${tone}`} aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-foreground">{title}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <div>
        <label htmlFor="ledger-category" className="mb-1 block text-sm font-medium text-foreground">
          {t('category')}
          <span aria-hidden="true" className="ms-1 text-destructive">*</span>
        </label>
        <Select
          id="ledger-category"
          name="category"
          required
          value={category}
          onChange={(v) => {
            setCategory(v);
            setRefusal(null);
          }}
          placeholder={t('chooseCategory')}
          searchPlaceholder={tph('searchCategories')}
          options={categoryOptions}
        />
      </div>

      <div>
        <label htmlFor="ledger-amount" className="mb-1 block text-sm font-medium text-foreground">
          {t('amount')}
          <span aria-hidden="true" className="ms-1 text-destructive">*</span>
        </label>
        <MoneyInput
          id="ledger-amount"
          name="amount"
          required
          value={amount}
          onChange={(raw) => {
            setAmount(raw);
            setRefusal(null);
          }}
          placeholder={tph('money')}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-start text-base focus:outline-none focus:ring-2 focus:ring-ring md:text-sm"
        />
      </div>

      <CurrencyRateFields
        rateName="fxRateToEgp"
        currencies={currencies}
        defaultCurrency="EGP"
        currencyLabel={t('currency')}
        rateLabel={t('fxRate')}
        required
      />

      <div className="field-row grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div data-ledger-date>
          <label className="mb-1 block text-sm font-medium text-foreground">
            {t('occurredOn')}
            <span aria-hidden="true" className="ms-1 text-destructive">*</span>
          </label>
          <DatePicker
            name="occurredOn"
            required
            disableFuture
            value={occurredOn}
            onChange={(v) => setOccurredOn(v || businessToday())}
          />
        </div>
        <div>
          <label htmlFor="ledger-cycle" className="mb-1 block text-sm font-medium text-foreground">
            {t('chargeToCycle')}
            {cycleRequired ? (
              <span aria-hidden="true" className="ms-1 text-destructive">*</span>
            ) : (
              <span className="ms-1 text-xs font-normal text-muted-foreground">{t('optional')}</span>
            )}
          </label>
          <Select
            id="ledger-cycle"
            name="cycleId"
            value={cycleId}
            onChange={(v) => {
              setCycleId(v);
              setRefusal(null);
            }}
            clearable
            required={cycleRequired}
            placeholder={cycleRequired ? t('chooseCycle') : t('noCycle')}
            searchPlaceholder={tph('searchCycles')}
            options={cycleOptions}
          />
          {cycleRequired && (
            <p className="mt-1 text-xs text-muted-foreground">{t('cycleRequiredHint')}</p>
          )}
        </div>
      </div>

      <div>
        <label htmlFor="ledger-note" className="mb-1 block text-sm font-medium text-foreground">
          {t('note')}
          <span className="ms-1 text-xs font-normal text-muted-foreground">{t('optional')}</span>
        </label>
        <textarea
          id="ledger-note"
          name="note"
          rows={2}
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t('notePlaceholder')}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-ring md:text-sm"
        />
      </div>

      {refusal && (
        <p ref={refusalRef} role="alert" data-testid="ledger-refusal" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {refusal}
        </p>
      )}
    </Dialog>
  );
}
