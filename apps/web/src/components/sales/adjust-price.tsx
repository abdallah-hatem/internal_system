'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, TrendingDown } from '@/components/ui/icons';

import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { businessToday } from '@/lib/dates';
import { useNumberFormat } from '@/lib/numbers';
import { useCan } from '@/lib/can';
import { localName } from '@/lib/localized-name';
import { Dialog, DialogAlert, DialogCancel } from '@/components/ui/dialog';
import { DatePicker } from '@/components/ui/date-picker';
import { MoneyInput } from '@/components/ui/money-input';
import { Money } from '@/components/ui/money';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { useOrderHistory, type HistoryProduct } from './order-history';

/**
 * Lowering a price after the order is confirmed (BUSINESS_LOGIC §4, owner
 * 2026-10-22): the "Adjust price" button on the sale order popup and the
 * popup behind it. The server decides everything — which units it covers,
 * what it takes off, what the shop owes after — and refuses with a code; this
 * shows its preview as the person types and sends exactly what they saw.
 */

/** A sale the shop still owes on: the only kind the server lowers. */
const ADJUSTABLE_STATUSES = ['CONFIRMED', 'PARTIALLY_PAID'];

export interface AdjustSale {
  id: string;
  orderNo: string;
  status: string;
  currency: string;
  orderedAt?: string;
  createdAt?: string;
  /** From `GET /sales/orders/:id`: the sale's live plan, or null. */
  contractPlan?: { reference: string; status: string } | null;
}

/** Whether the button is offered at all: a draft, a paid, returned or cancelled sale never is. */
export function canOfferPriceAdjustment(sale: Pick<AdjustSale, 'status'>): boolean {
  return ADJUSTABLE_STATUSES.includes(sale.status);
}

export function AdjustPriceButton({ sale, onOpen }: { sale: AdjustSale; onOpen: () => void }) {
  const t = useTranslations('sales.adjustPrice');
  const may = useCan('sale.adjustPrice');
  if (!may || !canOfferPriceAdjustment(sale)) return null;
  return (
    <button
      type="button"
      data-testid="order-adjust-price"
      onClick={onOpen}
      className="bg-background inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm text-foreground hover:bg-muted"
    >
      <TrendingDown className="h-4 w-4" />
      {t('open')}
    </button>
  );
}

/** The text `ms` after it last changed — what the preview is asked about. */
function useSettled(value: string, ms: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}

/** How long typing pauses before the preview is asked. */
export const PREVIEW_DELAY_MS = 350;

interface PreviewResult {
  saleItemId: string;
  product: string;
  adjustedOn: string;
  previousUnitPrice: string;
  newUnitPrice: string;
  qty: string;
  amountEgp: string;
  owedBefore: string;
  owedAfter: string;
}

/**
 * Everything a lower price changes, and nothing else: the order and its
 * history, the sales list, the shop's balance and statement, and every revenue
 * figure — dashboard, P&L, a cycle's profit and its settlement. Stock and
 * payments do not move.
 */
export const PRICE_ADJUSTMENT_INVALIDATES = (orderId: string) => [
  ['sale', orderId],
  ['sales'],
  ['customers'],
  ['customer'],
  ['analytics'],
  ['cycle'],
  ['settlements'],
];

export function AdjustPriceDialog({ sale, onClose }: { sale: AdjustSale; onClose: () => void }) {
  const t = useTranslations('sales.adjustPrice');
  const tc = useTranslations('common');
  const te = useTranslations('errors');
  const tph = useTranslations('placeholders');
  const locale = useLocale();
  const apiError = useApiError();
  const { addToast } = useToast();
  const { formatMoney: money, formatNumber } = useNumberFormat();
  // An amount inside an Arabic sentence is its own left-to-right run, or
  // "1,200.00 EGP" is drawn as "EGP 1,200.00". English is left as it is.
  const formatMoney = (v: string | number, currency?: string) =>
    locale === 'ar' ? `\u2068${money(v, currency)}\u2069` : money(v, currency);
  const queryClient = useQueryClient();

  const history = useOrderHistory(sale.id);
  const lines: HistoryProduct[] = (history.data?.products ?? []).filter((p) => Number(p.holds) > 0);
  const underContract = sale.contractPlan?.status === 'ACTIVE';

  // Each field is the person's alone: nothing fetched is ever written into
  // them, so a refetch of the order or its history cannot replace a typed price.
  const [chosenLine, setChosenLine] = useState('');
  const [price, setPrice] = useState('');
  const today = businessToday();
  const [day, setDay] = useState(today);
  const [note, setNote] = useState('');

  // With one line to choose, it is chosen; never over a choice already made.
  const lineId = chosenLine || (lines.length === 1 ? lines[0].saleItemId : '');
  const line = lines.find((l) => l.saleItemId === lineId);
  // The server refuses a day before the sale (PRICE_ADJUSTMENT_BEFORE_SALE).
  const soldAt = sale.orderedAt ?? sale.createdAt;
  const soldOn = soldAt ? businessToday(new Date(soldAt)) : undefined;

  const asked = { lineId, price, day };
  const askedKey = JSON.stringify(asked);
  const settledKey = useSettled(askedKey, PREVIEW_DELAY_MS);
  const settled = JSON.parse(settledKey) as typeof asked;
  const ready = Boolean(settled.lineId && settled.price !== '' && settled.day) && !underContract;
  const body = (q: typeof asked) => ({
    saleItemId: q.lineId,
    newUnitPrice: Number(q.price),
    adjustedOn: q.day,
    ...(note.trim() ? { reason: note.trim() } : {}),
  });

  const preview = useQuery({
    // Outside the order's own key: refreshing the order after a save must not
    // ask this question again of an order whose price has already dropped.
    queryKey: ['price-adjustment-preview', sale.id, settled.lineId, settled.price, settled.day],
    queryFn: () =>
      api
        .post(`/sales/orders/${sale.id}/price-adjustments/preview`, body(settled))
        .then((r) => (r.data.data ?? r.data) as PreviewResult),
    enabled: ready,
    retry: false,
    gcTime: 0,
  });

  const current = settledKey === askedKey && ready;
  const shown = current && preview.isSuccess ? preview.data : null;
  const refusal = current && preview.isError ? apiError(preview.error, t('previewFailed')) : null;

  // Set on the first click, before React re-renders the button disabled.
  const sending = useRef(false);
  const save = useMutation({
    mutationFn: () =>
      api
        .post(`/sales/orders/${sale.id}/price-adjustments`, body(asked))
        .then((r) => (r.data.data ?? r.data) as PreviewResult),
    onSuccess: (done) => {
      for (const queryKey of PRICE_ADJUSTMENT_INVALIDATES(sale.id)) {
        void queryClient.invalidateQueries({ queryKey });
      }
      addToast(t('saved', { order: sale.orderNo, owes: formatMoney(done.owedAfter, sale.currency) }), 'success');
      onClose();
    },
    onError: (e: unknown) => addToast(apiError(e, t('failed')), 'error'),
    onSettled: () => {
      sending.current = false;
    },
  });

  const canSave = Boolean(shown) && !preview.isFetching && !save.isPending;
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canSave || sending.current) return;
    sending.current = true;
    save.mutate();
  };

  // Before → after, read in the page's direction.
  const arrow = locale === 'ar' ? '← ' : '→ ';
  const fieldClass =
    'w-full rounded-lg border border-border bg-background px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-ring md:text-sm';

  return (
    <Dialog
      title={t('title')}
      subtitle={sale.orderNo}
      onClose={onClose}
      size="md"
      busy={save.isPending}
      onSubmit={submit}
      cardProps={{ 'data-testid': 'adjust-price-dialog' }}
      footer={
        <>
          <DialogCancel onClick={onClose} disabled={save.isPending} label={tc('cancel')} />
          {!underContract && (
            <button
              type="submit"
              data-testid="adjust-price-save"
              disabled={!canSave}
              aria-busy={save.isPending}
              className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0"
            >
              {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <TrendingDown className="h-4 w-4" />}
              {t('save')}
            </button>
          )}
        </>
      }
    >
      {underContract ? (
        // Knowable from the order, so said before anything is typed (§4 GUESS:
        // not under an instalment contract).
        <DialogAlert
          testId="adjust-price-blocked"
          message={te('PRICE_ADJUSTMENT_UNDER_CONTRACT', {
            order: sale.orderNo,
            plan: sale.contractPlan?.reference ?? '',
          })}
        />
      ) : history.isPending ? (
        <div className="space-y-4" aria-hidden="true" data-testid="adjust-price-skeleton">
          {[0, 1, 2].map((i) => (
            <div key={i} className="space-y-1.5">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-10 w-full" />
            </div>
          ))}
        </div>
      ) : history.isError ? (
        <DialogAlert testId="adjust-price-refusal" message={apiError(history.error, tc('error'))} />
      ) : lines.length === 0 ? (
        <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground" data-testid="adjust-price-no-lines">
          {t('noLines')}
        </p>
      ) : (
        <div className="space-y-4">
          <div>
            <label htmlFor="adjust-line" className="mb-1 block text-sm font-medium text-foreground">
              {t('line')}
            </label>
            <Select
              id="adjust-line"
              value={lineId}
              onChange={setChosenLine}
              placeholder={t('linePlaceholder')}
              disabled={save.isPending}
              options={lines.map((l) => ({
                value: l.saleItemId,
                label: localName({ name: l.product, nameAr: l.productAr }, locale),
                hint: t('lineHint', {
                  held: formatNumber(l.holds),
                  price: formatMoney(l.priceNow, sale.currency),
                }),
                keywords: `${l.product} ${l.productAr ?? ''}`,
              }))}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="adjust-price" className="mb-1 block text-sm font-medium text-foreground">
                {t('newPrice')}
              </label>
              <MoneyInput
                id="adjust-price"
                data-testid="adjust-price-input"
                value={price}
                onChange={setPrice}
                placeholder={tph('money')}
                disabled={save.isPending}
                className={fieldClass}
              />
              {line && (
                <p className="mt-1 text-xs text-muted-foreground" data-testid="adjust-price-current">
                  {t('currentPrice', { price: formatMoney(line.priceNow, sale.currency) })}
                </p>
              )}
            </div>
            <div>
              <label htmlFor="adjust-day" className="mb-1 block text-sm font-medium text-foreground">
                {t('day')}
              </label>
              <DatePicker
                id="adjust-day"
                value={day}
                min={soldOn}
                max={today}
                disableFuture
                clearable={false}
                disabled={save.isPending}
                onChange={(v) => setDay(v)}
                placeholder={t('day')}
              />
            </div>
          </div>

          <div>
            <label htmlFor="adjust-note" className="mb-1 block text-sm font-medium text-foreground">
              {t('note')}
            </label>
            <textarea
              id="adjust-note"
              data-testid="adjust-price-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('notePlaceholder')}
              rows={2}
              maxLength={500}
              disabled={save.isPending}
              className={`${fieldClass} resize-y leading-relaxed`}
            />
          </div>

          <section
            aria-live="polite"
            data-testid="adjust-price-preview"
            className="rounded-lg border border-border bg-muted/40 px-3 py-3 text-sm"
          >
            <h3 className="mb-2 text-xs font-medium text-muted-foreground">{t('previewTitle')}</h3>
            {refusal ? (
              <p role="alert" data-testid="adjust-price-refusal" className="text-destructive">
                {refusal}
              </p>
            ) : shown ? (
              <dl className="grid grid-cols-1 gap-y-1.5">
                <Row label={t('units')} testId="adjust-preview-units">
                  {formatNumber(shown.qty)}
                </Row>
                <Row label={t('price')} testId="adjust-preview-price">
                  <Money value={shown.previousUnitPrice} currency={sale.currency} />{' '}
                  {/* The arrow travels with the new figure when the line wraps. */}
                  <span className="whitespace-nowrap">
                    {arrow}
                    <Money value={shown.newUnitPrice} currency={sale.currency} />
                  </span>
                </Row>
                <Row label={t('cut')} testId="adjust-preview-cut" strong>
                  <Money value={shown.amountEgp} currency={sale.currency} />
                </Row>
                <Row label={t('owes')} testId="adjust-preview-owes" strong>
                  <Money value={shown.owedBefore} currency={sale.currency} />{' '}
                  {/* The arrow travels with the new figure when the line wraps. */}
                  <span className="whitespace-nowrap">
                    {arrow}
                    <Money value={shown.owedAfter} currency={sale.currency} />
                  </span>
                </Row>
              </dl>
            ) : ready || (lineId && price !== '') ? (
              <div className="grid grid-cols-1 gap-y-2" aria-hidden="true" data-testid="adjust-preview-pending">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="flex justify-between gap-3">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-4 w-20" />
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground" data-testid="adjust-preview-empty">
                {t('previewEmpty')}
              </p>
            )}
          </section>
        </div>
      )}
    </Dialog>
  );
}

function Row({
  label,
  children,
  testId,
  strong,
}: {
  label: string;
  children: React.ReactNode;
  testId: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd
        data-testid={testId}
        className={`min-w-0 text-end tabular-nums [&>[data-slot=money]]:whitespace-nowrap ${strong ? 'font-semibold text-foreground' : 'text-foreground'}`}
      >
        {children}
      </dd>
    </div>
  );
}
