'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, Edit, Info, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { useCan } from '@/lib/can';
import { useDateFormat } from '@/lib/dates';
import { useNumberFormat } from '@/lib/numbers';
import { selectOnFocus } from '@/lib/select-on-focus';
import { useToast } from '@/components/ui/toast';
import { EmptyState } from '@/components/ui/empty-state';
import { DataTable } from '@/components/ui/data-table';
import { Dialog, DialogAlert, DialogCancel, DialogPrimary } from '@/components/ui/dialog';
import { FieldMark } from '@/components/ui/fields';
import { LoadingStatus, SkeletonGroup, SkeletonText, repeat } from '@/components/ui/skeleton';

/**
 * The exchange-rate page (BUSINESS_LOGIC §22, owner 2026-10-16): every
 * currency with its rate to EGP and when it last changed. A core partner
 * changes a rate or adds a currency; everyone else reads.
 *
 * These rates only prefill forms — a purchase order, a shipping leg, a ledger
 * entry or a friend's payment keeps the rate it was recorded at — and the page
 * says so, so nobody edits one expecting history to move with it.
 *
 * The rules (above zero, at most four decimals, EGP fixed at 1, a new code is
 * three letters and not already here) are the server's; refusals come back
 * coded and are shown in the dialog, translated.
 */
export interface RateRow {
  code: string;
  rateToEgp: string | number | null;
  updatedAt: string;
}

const BASE = 'EGP';

/** The currencies a business like this deals in are a handful. */
const RATE_SKELETONS = 4;

/** What a person typed as a rate, cleaned the way the other rate fields are. */
const rateText = (value: string) => value.replace(/[^\d.]/g, '');

export function ExchangeRates() {
  const t = useTranslations('fxRates');
  const { formatDate } = useDateFormat();
  const { formatNumber } = useNumberFormat();
  const mayEdit = useCan('fxRate.edit');
  const mayAdd = useCan('fxRate.add');
  const [editing, setEditing] = useState<RateRow | null>(null);
  const [adding, setAdding] = useState(false);

  const { data = [], isLoading } = useQuery<RateRow[]>({
    queryKey: ['currency-rates', 'list'],
    queryFn: () => api.get('/currency-rates').then((r) => r.data.data ?? r.data),
  });

  const rateShown = (r: RateRow) =>
    r.rateToEgp === null ? (
      <span className="text-muted-foreground">{t('noRate')}</span>
    ) : (
      <span dir="ltr">{formatNumber(r.rateToEgp, { maximumFractionDigits: 4 })}</span>
    );

  const editButton = (r: RateRow) =>
    mayEdit && r.code !== BASE ? (
      <button
        type="button"
        data-testid="edit-rate"
        aria-label={t('editTitle', { currency: r.code })}
        title={t('editTitle', { currency: r.code })}
        onClick={() => setEditing(r)}
        className="p-1.5 text-muted-foreground hover:text-accent-600 hover:bg-accent-50 rounded-lg transition-colors"
      >
        <Edit className="h-4 w-4" />
      </button>
    ) : r.code === BASE ? (
      <span className="text-xs text-muted-foreground">{t('base')}</span>
    ) : null;

  const empty = (
    <EmptyState
      icon={ArrowLeftRight}
      title={t('emptyTitle')}
      description={t('emptyHint')}
      action={mayAdd ? { label: t('add'), onClick: () => setAdding(true) } : undefined}
    />
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        {mayAdd && (
          <button
            type="button"
            data-testid="add-currency"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary-700"
          >
            <Plus className="h-4 w-4" /> {t('add')}
          </button>
        )}
      </div>

      <p data-testid="prefill-only" className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        {t('prefillOnly')}
      </p>

      {isLoading && <LoadingStatus />}
      <DataTable
        className="hidden md:block"
        skeletonRows={RATE_SKELETONS}
        isLoading={isLoading}
        rows={data}
        rowKey={(r) => r.code}
        rowProps={(r) => ({ 'data-testid': 'rate-row', 'data-code': r.code })}
        empty={empty}
        columns={[
          {
            key: 'code', header: t('currency'), width: 'auto', kind: 'label',
            className: 'font-medium text-foreground', skeleton: { kind: 'text', share: 'w-1/6' },
            cell: (r: RateRow) => <span dir="ltr">{r.code}</span>,
          },
          {
            key: 'rate', header: t('rate'), width: '10rem', kind: 'value', align: 'end',
            skeleton: { kind: 'text', share: 'w-1/2' }, cellProps: () => ({ 'data-testid': 'rate-value' }),
            cell: rateShown,
          },
          {
            key: 'updated', header: t('lastChanged'), width: '10rem', kind: 'value',
            className: 'text-muted-foreground', skeleton: { kind: 'text', share: 'w-2/3' },
            cell: (r: RateRow) => formatDate(r.updatedAt),
          },
          {
            key: 'actions', header: <span className="sr-only">{t('actions')}</span>, width: '6.5rem', align: 'end',
            skeleton: mayEdit ? { kind: 'buttons', count: 1 } : { kind: 'none' },
            cell: editButton,
          },
        ]}
      />

      {/* Phone */}
      {isLoading ? (
        <SkeletonGroup className="space-y-3 md:hidden">
          {repeat(RATE_SKELETONS, (i) => (
            <div key={i} data-testid="skeleton-row" className="flex items-center justify-between rounded-xl border border-border bg-card p-4">
              <div>
                <SkeletonText size="base" className="w-12" />
                <SkeletonText size="xs" className="w-24" lineClassName="mt-0.5" />
              </div>
              <SkeletonText className="w-20" />
            </div>
          ))}
        </SkeletonGroup>
      ) : (
        <div className="space-y-3 md:hidden">
          {data.length === 0 ? (
            <div className="rounded-xl border border-border bg-card">{empty}</div>
          ) : (
            data.map((r) => (
              <div key={r.code} data-testid="rate-card" className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card p-4">
                <div className="min-w-0">
                  <p className="font-medium text-foreground" dir="ltr">{r.code}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t('lastChanged')}: {formatDate(r.updatedAt)}
                  </p>
                </div>
                <div className="flex items-center gap-2 text-sm font-semibold tabular-nums text-foreground">
                  {rateShown(r)}
                  {editButton(r)}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {editing && <EditRateDialog row={editing} onClose={() => setEditing(null)} />}
      {adding && <AddCurrencyDialog onClose={() => setAdding(false)} />}
    </div>
  );
}

/** After any change: this list, and the map every money form prefills from. */
function useRefreshRates() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['currency-rates'] });
    void qc.invalidateQueries({ queryKey: ['currencyRates'] });
  };
}

function RateField({
  id,
  currency,
  value,
  onChange,
}: {
  id: string;
  currency: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useTranslations('fxRates');
  const tph = useTranslations('placeholders');
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-foreground">
        {t('rateFor', { currency: currency || '—' })}
        <FieldMark required />
      </label>
      <input
        id={id}
        name="rateToEgp"
        data-testid="rate-input"
        inputMode="decimal"
        autoComplete="off"
        required
        placeholder={tph('fxRate')}
        value={value}
        onChange={(e) => onChange(rateText(e.target.value))}
        {...selectOnFocus}
        dir="ltr"
        className="w-full rounded-lg border border-border px-3 py-2 text-start text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
      />
      <p className="mt-1 text-xs text-muted-foreground">{t('rateHint')}</p>
    </div>
  );
}

function EditRateDialog({ row, onClose }: { row: RateRow; onClose: () => void }) {
  const t = useTranslations('fxRates');
  const tc = useTranslations('common');
  const apiError = useApiError();
  const { addToast } = useToast();
  const refresh = useRefreshRates();
  const [rate, setRate] = useState(row.rateToEgp === null ? '' : String(Number(row.rateToEgp)));
  const [refusal, setRefusal] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => api.put(`/currency-rates/${row.code}`, { rateToEgp: Number(rate) }),
    onSuccess: () => {
      refresh();
      addToast(t('saved', { currency: row.code }), 'success');
      onClose();
    },
    onError: (e) => setRefusal(apiError(e, t('saveFailed'))),
  });

  return (
    <Dialog
      data-fx-dialog="edit"
      size="sm"
      title={t('editTitle', { currency: row.code })}
      onClose={onClose}
      busy={save.isPending}
      onSubmit={(e) => {
        e.preventDefault();
        if (!rate) return;
        setRefusal(null);
        save.mutate();
      }}
      footer={
        <>
          <DialogCancel onClick={onClose} disabled={save.isPending} label={tc('cancel')} />
          <DialogPrimary pending={save.isPending} label={tc('save')} />
        </>
      }
      bodyClassName="space-y-4"
    >
      <RateField id="fx-edit-rate" currency={row.code} value={rate} onChange={(v) => { setRate(v); setRefusal(null); }} />
      <DialogAlert message={refusal} testId="fx-refusal" />
    </Dialog>
  );
}

function AddCurrencyDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations('fxRates');
  const tc = useTranslations('common');
  const tph = useTranslations('placeholders');
  const apiError = useApiError();
  const { addToast } = useToast();
  const refresh = useRefreshRates();
  const [code, setCode] = useState('');
  const [rate, setRate] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => api.post('/currency-rates', { code, rateToEgp: Number(rate) }),
    onSuccess: () => {
      refresh();
      addToast(t('added', { currency: code }), 'success');
      onClose();
    },
    onError: (e) => setRefusal(apiError(e, t('saveFailed'))),
  });

  return (
    <Dialog
      data-fx-dialog="add"
      size="sm"
      title={t('addTitle')}
      onClose={onClose}
      busy={save.isPending}
      onSubmit={(e) => {
        e.preventDefault();
        if (!code || !rate) return;
        setRefusal(null);
        save.mutate();
      }}
      footer={
        <>
          <DialogCancel onClick={onClose} disabled={save.isPending} label={tc('cancel')} />
          <DialogPrimary pending={save.isPending} label={t('add')} />
        </>
      }
      bodyClassName="space-y-4"
    >
      <div>
        <label htmlFor="fx-add-code" className="mb-1 block text-sm font-medium text-foreground">
          {t('code')}
          <FieldMark required />
        </label>
        <input
          id="fx-add-code"
          name="code"
          data-testid="code-input"
          autoComplete="off"
          required
          maxLength={3}
          placeholder={tph('currencyCode')}
          value={code}
          onChange={(e) => {
            // Letters only, upper case: the code is ISO 4217's three letters.
            setCode(e.target.value.replace(/[^a-z]/gi, '').toUpperCase().slice(0, 3));
            setRefusal(null);
          }}
          dir="ltr"
          className="w-full rounded-lg border border-border px-3 py-2 text-start text-sm uppercase focus:outline-none focus:ring-2 focus:ring-primary-500"
        />
        <p className="mt-1 text-xs text-muted-foreground">{t('codeHint')}</p>
      </div>
      <RateField id="fx-add-rate" currency={code} value={rate} onChange={(v) => { setRate(v); setRefusal(null); }} />
      <DialogAlert message={refusal} testId="fx-refusal" />
    </Dialog>
  );
}
