'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { localName } from '@/lib/localized-name';
import { useNumberFormat } from '@/lib/numbers';
import { selectOnFocus } from '@/lib/select-on-focus';
import { Dialog } from '@/components/ui/dialog';
import { MoneyInput } from '@/components/ui/money-input';
import { Money } from '@/components/ui/money';

/**
 * "They're buying" (BUSINESS_LOGIC §4, samples at shops, owner 2026-10-18).
 *
 * One row per product left at the shop: how many they are buying, how many
 * came back, and the price of what they buy. Buying + returned must be what is
 * out — the server checks the same (`planSamplesDecision`) and its refusal is
 * shown translated if this screen ever lets one through. What they buy becomes
 * the sale, dated today; the rest goes back on the shelf.
 *
 * Defaults: everything bought, nothing back — the usual case when a shop says
 * "ok, let's make a deal". Typing one of the two quantities fills the other
 * with the rest **only while the other has not been typed**; a number the
 * partner typed is never overwritten. The price starts at the price noted when
 * the samples were left, else the product's list price for the order's
 * channel, else empty — and is required for any line with something bought.
 */

export interface SamplesOrderLine {
  id: string;
  productId: string;
  product?: { name: string; nameAr?: string | null; sku?: string };
  quantity: number | string;
  unitPrice: number | string;
}

export interface SamplesOrder {
  id: string;
  orderNo: string;
  channel: string;
  currency: string;
  items?: SamplesOrderLine[];
}

export interface PricedProduct {
  id: string;
  prices?: { channel: string; amount: number | string; effectiveTo?: string | null }[];
}

export interface DecisionRow {
  saleItemId: string;
  out: number;
  buy: string;
  back: string;
  price: string;
  /** Which of the two quantities the partner typed himself. */
  typedBuy: boolean;
  typedBack: boolean;
}

export type RowProblem = 'MUST_ADD_UP' | 'PRICE_NEEDED' | 'NEGATIVE' | null;

/** Thousandths: 0.1 + 0.2 of 0.3 out adds up. */
const milli = (v: number | string) => Math.round(Number(v) * 1000);

/** What is wrong with one row, or null — the client's copy of the server's check. */
export function rowProblem(row: DecisionRow): RowProblem {
  const buy = row.buy.trim() === '' ? NaN : Number(row.buy);
  const back = row.back.trim() === '' ? NaN : Number(row.back);
  if (!Number.isFinite(buy) || !Number.isFinite(back)) return 'MUST_ADD_UP';
  if (buy < 0 || back < 0) return 'NEGATIVE';
  if (milli(buy) + milli(back) !== milli(row.out)) return 'MUST_ADD_UP';
  if (buy > 0 && (row.price.trim() === '' || !Number.isFinite(Number(row.price)) || Number(row.price) < 0)) {
    return 'PRICE_NEEDED';
  }
  return null;
}

/** The starting price: the one noted when left, else the list price for the channel, else empty. */
export function startingPrice(
  line: Pick<SamplesOrderLine, 'productId' | 'unitPrice'>,
  channel: string,
  products: PricedProduct[],
): string {
  if (Number(line.unitPrice) > 0) return String(Number(line.unitPrice));
  const list = products
    .find((p) => p.id === line.productId)
    ?.prices?.find((pr) => pr.channel === channel && !pr.effectiveTo);
  return list ? String(Number(list.amount)) : '';
}

export function initialRows(order: SamplesOrder, products: PricedProduct[]): DecisionRow[] {
  return (order.items ?? []).map((item) => ({
    saleItemId: item.id,
    out: Number(item.quantity),
    buy: String(Number(item.quantity)),
    back: '0',
    price: startingPrice(item, order.channel, products),
    typedBuy: false,
    typedBack: false,
  }));
}

/** The rest, as a field shows it: out − typed, never below zero. */
const rest = (out: number, typed: string) => {
  const n = Number(typed);
  if (typed.trim() === '' || !Number.isFinite(n)) return '';
  return String(Math.max(0, (milli(out) - milli(n)) / 1000));
};

/** A quantity typed: fill the other one with the rest unless the partner typed it. */
export function typeQty(row: DecisionRow, field: 'buy' | 'back', value: string): DecisionRow {
  if (field === 'buy') {
    return { ...row, buy: value, typedBuy: true, back: row.typedBack ? row.back : rest(row.out, value) };
  }
  return { ...row, back: value, typedBack: true, buy: row.typedBuy ? row.buy : rest(row.out, value) };
}

export function SamplesDecideDialog({
  order,
  products,
  onClose,
  onDone,
}: {
  order: SamplesOrder;
  products: PricedProduct[];
  onClose: () => void;
  onDone: (result: { status: string; orderNo: string }) => void;
}) {
  const t = useTranslations('sales.samples');
  const tph = useTranslations('placeholders');
  const tc = useTranslations('common');
  const locale = useLocale();
  const apiError = useApiError();
  const { formatNumber } = useNumberFormat();
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<DecisionRow[]>(() => initialRows(order, products));
  const [checked, setChecked] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const set = (id: string, change: (r: DecisionRow) => DecisionRow) =>
    setRows((prev) => prev.map((r) => (r.saleItemId === id ? change(r) : r)));

  const problems = rows.map(rowProblem);
  const total = rows.reduce(
    (s, r) => s + (Number(r.buy) > 0 && r.price !== '' ? Math.round(Number(r.buy) * Number(r.price) * 100) : 0),
    0,
  );
  const backUnits = rows.reduce((s, r) => s + (Number(r.back) > 0 ? milli(r.back) : 0), 0) / 1000;
  const nothingBought = rows.every((r) => Number(r.buy) === 0);

  const mutation = useMutation({
    mutationFn: () =>
      api.post(`/sales/orders/${order.id}/samples/decide`, {
        lines: rows.map((r) => ({
          saleItemId: r.saleItemId,
          buyQty: Number(r.buy),
          returnQty: Number(r.back),
          ...(Number(r.buy) > 0 ? { unitPrice: Number(r.price) } : {}),
        })),
      }),
    onSuccess: (res) => {
      const data = res.data?.data ?? res.data;
      for (const key of ['sales', 'sale', 'inventory', 'customers', 'analytics']) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
      onDone({ status: data?.status ?? '', orderNo: data?.orderNo ?? order.orderNo });
    },
    onError: (err) => setRefusal(apiError(err, tc('error'))),
  });

  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setRefusal(null);
    if (problems.some(Boolean)) {
      setChecked(true);
      return;
    }
    mutation.mutate();
  };

  const field =
    'w-full min-w-0 rounded-lg border px-2 py-1.5 text-sm focus:outline-none focus:ring-2';
  const problemText = (p: RowProblem, out: number) =>
    p === 'MUST_ADD_UP'
      ? t('mustAddUp', { out: formatNumber(out) })
      : p === 'PRICE_NEEDED'
      ? t('priceNeeded')
      : p === 'NEGATIVE'
      ? t('noNegative')
      : null;

  return (
    <Dialog
      title={t('decideTitle', { orderNo: order.orderNo })}
      description={t('decideHelp')}
      onClose={onClose}
      onSubmit={submit}
      size="lg"
      busy={mutation.isPending}
      cardProps={{ 'data-testid': 'samples-decide' }}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 rounded-lg px-4 py-2 text-sm text-muted-foreground hover:bg-muted sm:min-h-0"
          >
            {tc('cancel')}
          </button>
          <button
            type="submit"
            data-testid="samples-decide-submit"
            disabled={mutation.isPending}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 sm:min-h-0"
          >
            {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
            {nothingBought ? t('returned') : t('recordDecision')}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <ul className="space-y-3">
          {rows.map((row, i) => {
            const item = order.items![i];
            const name = localName(item.product, locale);
            const problem = checked ? problems[i] : null;
            const qtyBad = problem === 'MUST_ADD_UP' || problem === 'NEGATIVE';
            return (
              <li key={row.saleItemId} data-testid="samples-decide-line" className="rounded-lg bg-muted p-3">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="min-w-0 truncate text-sm font-medium text-foreground" title={name}>
                    {name}
                  </p>
                  <p className="shrink-0 text-xs text-muted-foreground">
                    {t('out')}: <span className="font-medium text-foreground">{formatNumber(row.out)}</span>
                  </p>
                </div>
                <div className="field-row mt-2 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.3fr)] gap-2">
                  <div>
                    <label htmlFor={`buy-${row.saleItemId}`} className="mb-1 block text-xs text-muted-foreground">
                      {t('buyQty')}
                    </label>
                    <input
                      id={`buy-${row.saleItemId}`}
                      type="number"
                      inputMode="decimal"
                      min={0}
                      data-field="buyQty"
                      placeholder={tph('quantitySmall')}
                      value={row.buy}
                      onChange={(e) => set(row.saleItemId, (r) => typeQty(r, 'buy', e.target.value))}
                      aria-invalid={qtyBad || undefined}
                      {...selectOnFocus}
                      className={`${field} ${qtyBad ? 'border-destructive focus:ring-destructive' : 'border-border focus:ring-ring'}`}
                    />
                  </div>
                  <div>
                    <label htmlFor={`back-${row.saleItemId}`} className="mb-1 block text-xs text-muted-foreground">
                      {t('returnQty')}
                    </label>
                    <input
                      id={`back-${row.saleItemId}`}
                      type="number"
                      inputMode="decimal"
                      min={0}
                      data-field="returnQty"
                      placeholder={tph('quantitySmall')}
                      value={row.back}
                      onChange={(e) => set(row.saleItemId, (r) => typeQty(r, 'back', e.target.value))}
                      aria-invalid={qtyBad || undefined}
                      {...selectOnFocus}
                      className={`${field} ${qtyBad ? 'border-destructive focus:ring-destructive' : 'border-border focus:ring-ring'}`}
                    />
                  </div>
                  <div>
                    <label htmlFor={`price-${row.saleItemId}`} className="mb-1 block text-xs text-muted-foreground">
                      {t('priceEach')}
                    </label>
                    <MoneyInput
                      id={`price-${row.saleItemId}`}
                      data-field="priceEach"
                      placeholder={tph('money')}
                      value={row.price}
                      disabled={Number(row.buy) === 0}
                      onChange={(raw) => set(row.saleItemId, (r) => ({ ...r, price: raw }))}
                      aria-invalid={problem === 'PRICE_NEEDED' || undefined}
                      className={`${field} text-start disabled:opacity-50 ${
                        problem === 'PRICE_NEEDED' ? 'border-destructive focus:ring-destructive' : 'border-border focus:ring-ring'
                      }`}
                    />
                  </div>
                </div>
                {problem && (
                  <p role="alert" data-testid="samples-decide-problem" className="mt-1 text-[11px] text-destructive">
                    {problemText(problem, row.out)}
                  </p>
                )}
              </li>
            );
          })}
        </ul>

        <dl className="space-y-1 border-t border-border pt-3 text-sm">
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">{t('saleTotal')}</dt>
            <dd className="font-semibold text-foreground" data-testid="samples-decide-total">
              <Money value={total / 100} currency={order.currency} />
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">{t('backOnShelf')}</dt>
            <dd className="text-foreground" data-testid="samples-decide-back">
              {t('units', { count: backUnits })}
            </dd>
          </div>
        </dl>
        {nothingBought && (
          <p className="text-xs text-muted-foreground" data-testid="samples-all-returned">
            {t('allReturnedNote')}
          </p>
        )}
        {refusal && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {refusal}
          </p>
        )}
      </div>
    </Dialog>
  );
}
