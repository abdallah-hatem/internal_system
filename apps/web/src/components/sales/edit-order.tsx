'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, PencilLine, Trash2 } from '@/components/ui/icons';

import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { businessToday } from '@/lib/dates';
import { useNumberFormat } from '@/lib/numbers';
import { useCan } from '@/lib/can';
import { localName } from '@/lib/localized-name';
import { isSellable } from '@/lib/product-status';
import { Dialog, DialogAlert, DialogCancel } from '@/components/ui/dialog';
import { DatePicker } from '@/components/ui/date-picker';
import { MoneyInput } from '@/components/ui/money-input';
import { Money } from '@/components/ui/money';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { useOrderHistory, type HistoryProduct } from './order-history';
import { PRICE_ADJUSTMENT_INVALIDATES } from './adjust-price';
import type { SaleFormProduct, SaleFormStockRow } from './SaleOrderForm';

/**
 * Editing a confirmed order (BUSINESS_LOGIC §4, owner 2026-10-25): add a
 * product, change a quantity, change a price up or down. It feels like
 * editing the order; the server records each change as a dated event and
 * decides everything — what is drawn, what goes back, what the shop owes —
 * refusing with a code. This shows its preview of the whole edit and sends
 * exactly what was previewed, at the version previewed.
 */

/** A sale that happened and still stands: the statuses the server edits. */
const EDITABLE_STATUSES = ['CONFIRMED', 'PARTIALLY_PAID', 'PAID'];

export interface EditSale {
  id: string;
  orderNo: string;
  status: string;
  currency: string;
  orderedAt?: string;
  createdAt?: string;
  customer?: { isWalkIn?: boolean } | null;
  contractPlan?: { reference: string; status: string } | null;
}

/** Whether the button is offered at all — the server's own statuses; walk-in never (paid on the spot). */
export function canOfferOrderEdit(sale: Pick<EditSale, 'status' | 'customer'>): boolean {
  return EDITABLE_STATUSES.includes(sale.status) && !sale.customer?.isWalkIn;
}

export function EditOrderButton({ sale, onOpen }: { sale: EditSale; onOpen: () => void }) {
  const t = useTranslations('sales.editOrder');
  const may = useCan('sale.editOrder');
  if (!may || !canOfferOrderEdit(sale)) return null;
  return (
    <button
      type="button"
      data-testid="order-edit"
      onClick={onOpen}
      className="bg-background inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm text-foreground hover:bg-muted"
    >
      <PencilLine className="h-4 w-4" />
      {t('open')}
    </button>
  );
}

/** One product as the order holds it now: every line of it, summed. */
export interface CurrentLine {
  productId: string;
  product: string;
  productAr?: string | null;
  holds: number;
  /** The price the shop's units are at now: the newest line still held. */
  priceNow: string;
}

/** The history's lines, one per product (an edit's added units are their own line underneath). */
export function currentLines(products: HistoryProduct[]): CurrentLine[] {
  const byProduct = new Map<string, CurrentLine>();
  for (const p of products) {
    const id = p.productId ?? p.saleItemId;
    const seen = byProduct.get(id);
    const holds = (seen?.holds ?? 0) + Number(p.holds);
    byProduct.set(id, {
      productId: id,
      product: p.product,
      productAr: p.productAr,
      holds,
      // Lines come oldest first: the last one still held sets the price.
      priceNow: Number(p.holds) > 0 || !seen ? p.priceNow : seen.priceNow,
    });
  }
  return [...byProduct.values()].filter((l) => l.holds > 0);
}

export interface EditLineBody {
  productId: string;
  quantity: number;
  unitPrice?: number;
}

/**
 * What the person changed, as the server takes it: only lines that differ
 * from what the order holds, and every added product. A typed quantity or
 * price is the person's; a field left alone is never sent.
 */
export function changedLines(
  current: CurrentLine[],
  typedQty: Record<string, string>,
  typedPrice: Record<string, string>,
  added: string[],
): EditLineBody[] {
  const out: EditLineBody[] = [];
  for (const l of current) {
    const q = typedQty[l.productId];
    const p = typedPrice[l.productId];
    const qty = q === undefined || q === '' ? l.holds : Number(q);
    const priceChanged = p !== undefined && p !== '' && Math.round(Number(p) * 100) !== Math.round(Number(l.priceNow) * 100);
    if (qty === l.holds && !priceChanged) continue;
    out.push({ productId: l.productId, quantity: qty, ...(priceChanged ? { unitPrice: Number(p) } : {}) });
  }
  for (const id of added) {
    const q = typedQty[id];
    const p = typedPrice[id];
    out.push({
      productId: id,
      quantity: q === undefined || q === '' ? 1 : Number(q),
      ...(p !== undefined && p !== '' ? { unitPrice: Number(p) } : {}),
    });
  }
  return out;
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

export const EDIT_PREVIEW_DELAY_MS = 350;

interface EditPreview {
  version: number;
  editedOn: string;
  lines: {
    productId: string;
    product: string;
    productAr: string | null;
    qtyBefore: string;
    qtyAfter: string;
    priceBefore: string | null;
    priceAfter: string;
  }[];
  stockTaken: { product: string; qty: string }[];
  stockBack: { product: string; qty: string }[];
  changeEgp: string;
  owedBefore: string;
  owedAfter: string;
  profitChangeEgp: string;
}

/**
 * Everything an edit can move: the order, its history and invoice, the list,
 * the shop's balance and statement, every revenue and profit figure, and the
 * shelf — stock is drawn and given back.
 */
export const ORDER_EDIT_INVALIDATES = (orderId: string) => [
  ...PRICE_ADJUSTMENT_INVALIDATES(orderId),
  ['inventory'],
  ['products'],
];

export function EditOrderDialog({
  sale,
  products,
  stock,
  onClose,
}: {
  sale: EditSale;
  products: SaleFormProduct[];
  stock: SaleFormStockRow[];
  onClose: () => void;
}) {
  const t = useTranslations('sales.editOrder');
  const tc = useTranslations('common');
  const te = useTranslations('errors');
  const tph = useTranslations('placeholders');
  const locale = useLocale();
  const apiError = useApiError();
  const { addToast } = useToast();
  const { formatMoney: money, formatNumber } = useNumberFormat();
  const formatMoney = (v: string | number, currency?: string) =>
    locale === 'ar' ? `⁨${money(v, currency)}⁩` : money(v, currency);
  const queryClient = useQueryClient();

  const history = useOrderHistory(sale.id);
  const current = currentLines(history.data?.products ?? []);
  const underContract = sale.contractPlan?.status === 'ACTIVE';

  // Each field is the person's alone: nothing fetched is written into them.
  const [typedQty, setTypedQty] = useState<Record<string, string>>({});
  const [typedPrice, setTypedPrice] = useState<Record<string, string>>({});
  const [added, setAdded] = useState<string[]>([]);
  const [picking, setPicking] = useState('');
  const today = businessToday();
  const [day, setDay] = useState(today);
  const [note, setNote] = useState('');

  const soldAt = sale.orderedAt ?? sale.createdAt;
  const soldOn = soldAt ? businessToday(new Date(soldAt)) : undefined;

  const stockOf = (productId: string) => Number(stock.find((s) => s.productId === productId)?.availableStock ?? 0);
  const onOrder = new Set(current.map((l) => l.productId));
  const addable = (products as (SaleFormProduct & { nameAr?: string | null })[]).filter(
    (p) => !onOrder.has(p.id) && !added.includes(p.id) && isSellable(p, stockOf(p.id)) && stockOf(p.id) > 0,
  );

  const lines = changedLines(current, typedQty, typedPrice, added);
  const asked = { lines, day, note: note.trim() };
  const askedKey = JSON.stringify(asked);
  const settledKey = useSettled(askedKey, EDIT_PREVIEW_DELAY_MS);
  const settled = JSON.parse(settledKey) as typeof asked;
  const ready = settled.lines.length > 0 && Boolean(settled.day) && !underContract;
  const body = (q: typeof asked) => ({
    editedOn: q.day,
    lines: q.lines,
    ...(q.note ? { reason: q.note } : {}),
  });

  const preview = useQuery({
    // Outside the order's own key: refreshing the order after a save must not
    // ask this question again of an order that has already changed.
    queryKey: ['order-edit-preview', sale.id, settledKey],
    queryFn: () =>
      api.post(`/sales/orders/${sale.id}/edits/preview`, body(settled)).then((r) => (r.data.data ?? r.data) as EditPreview),
    enabled: ready,
    retry: false,
    gcTime: 0,
  });

  const isCurrent = settledKey === askedKey && ready;
  const shown = isCurrent && preview.isSuccess ? preview.data : null;
  const refusal = isCurrent && preview.isError ? apiError(preview.error, t('previewFailed')) : null;

  const sending = useRef(false);
  const save = useMutation({
    mutationFn: (version: number) =>
      api
        .post(`/sales/orders/${sale.id}/edits`, { ...body(asked), version })
        .then((r) => (r.data.data ?? r.data) as EditPreview),
    onSuccess: (done) => {
      for (const queryKey of ORDER_EDIT_INVALIDATES(sale.id)) {
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
    if (!canSave || !shown || sending.current) return;
    sending.current = true;
    // The version previewed: if anyone changed the order since, the server says so.
    save.mutate(shown.version);
  };

  const arrow = locale === 'ar' ? ' ← ' : ' → ';
  const fieldClass =
    'w-full rounded-lg border border-border bg-background px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-ring md:text-sm';
  const nameOf = (p: { product?: string; name?: string; productAr?: string | null; nameAr?: string | null }) =>
    localName({ name: p.product ?? p.name ?? '', nameAr: p.productAr ?? p.nameAr }, locale);

  const row = (
    productId: string,
    label: string,
    qtyPlaceholder: string,
    pricePlaceholder: string,
    hint: string | null,
    removable: boolean,
  ) => (
    <li key={productId} className="rounded-lg border border-border px-3 py-2" data-testid={`edit-line-${productId}`}>
      <div className="flex items-baseline justify-between gap-2">
        <p className="min-w-0 truncate text-sm font-medium text-foreground">{label}</p>
        {removable && (
          <button
            type="button"
            aria-label={t('removeAdded')}
            data-testid="edit-line-remove"
            onClick={() => setAdded((a) => a.filter((x) => x !== productId))}
            className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <div className="mt-2 grid grid-cols-2 gap-3">
        <div>
          <label htmlFor={`edit-qty-${productId}`} className="mb-1 block text-xs text-muted-foreground">
            {t('quantity')}
          </label>
          <input
            id={`edit-qty-${productId}`}
            type="number"
            min={0}
            step="any"
            data-testid="edit-qty"
            value={typedQty[productId] ?? ''}
            placeholder={qtyPlaceholder}
            onChange={(e) => setTypedQty((q) => ({ ...q, [productId]: e.target.value }))}
            disabled={save.isPending}
            className={fieldClass}
          />
        </div>
        <div>
          <label htmlFor={`edit-price-${productId}`} className="mb-1 block text-xs text-muted-foreground">
            {t('unitPrice')}
          </label>
          <MoneyInput
            id={`edit-price-${productId}`}
            data-testid="edit-price"
            value={typedPrice[productId] ?? ''}
            placeholder={pricePlaceholder}
            onChange={(v) => setTypedPrice((p) => ({ ...p, [productId]: v }))}
            disabled={save.isPending}
            className={fieldClass}
          />
        </div>
      </div>
    </li>
  );

  return (
    <Dialog
      title={t('title')}
      subtitle={sale.orderNo}
      onClose={onClose}
      size="lg"
      busy={save.isPending}
      onSubmit={submit}
      cardProps={{ 'data-testid': 'edit-order-dialog' }}
      footer={
        <>
          <DialogCancel onClick={onClose} disabled={save.isPending} label={tc('cancel')} />
          {!underContract && (
            <button
              type="submit"
              data-testid="edit-order-save"
              disabled={!canSave}
              aria-busy={save.isPending}
              className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0"
            >
              {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <PencilLine className="h-4 w-4" />}
              {t('save')}
            </button>
          )}
        </>
      }
    >
      {underContract ? (
        <DialogAlert
          testId="edit-order-blocked"
          message={te('EDIT_ORDER_UNDER_CONTRACT', { order: sale.orderNo, plan: sale.contractPlan?.reference ?? '' })}
        />
      ) : history.isPending ? (
        <div className="space-y-3" aria-hidden="true" data-testid="edit-order-skeleton">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : history.isError ? (
        <DialogAlert testId="edit-order-refusal" message={apiError(history.error, tc('error'))} />
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{t('intro')}</p>
          <ul className="space-y-2" data-testid="edit-lines">
            {current.map((l) =>
              row(
                l.productId,
                nameOf(l),
                formatNumber(l.holds),
                formatNumber(l.priceNow, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
                t('holdsNow', { qty: formatNumber(l.holds), price: formatMoney(l.priceNow, sale.currency) }),
                false,
              ),
            )}
            {added.map((id) => {
              const p = (products as (SaleFormProduct & { nameAr?: string | null })[]).find((x) => x.id === id);
              return row(
                id,
                p ? nameOf(p) : id,
                '1',
                tph('money'),
                t('newLine', { qty: formatNumber(stockOf(id)) }),
                true,
              );
            })}
          </ul>

          <div>
            <label htmlFor="edit-add-product" className="mb-1 block text-sm font-medium text-foreground">
              {t('addProduct')}
            </label>
            <Select
              id="edit-add-product"
              value={picking}
              onChange={(id) => {
                if (id) setAdded((a) => (a.includes(id) ? a : [...a, id]));
                setPicking('');
              }}
              placeholder={t('addProductPlaceholder')}
              disabled={save.isPending}
              options={addable.map((p) => ({
                value: p.id,
                label: nameOf(p),
                hint: t('inStock', { qty: formatNumber(stockOf(p.id)) }),
                keywords: `${p.name} ${(p as { nameAr?: string | null }).nameAr ?? ''} ${p.sku ?? ''}`,
              }))}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="edit-day" className="mb-1 block text-sm font-medium text-foreground">
                {t('day')}
              </label>
              <DatePicker
                id="edit-day"
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
            <div>
              <label htmlFor="edit-note" className="mb-1 block text-sm font-medium text-foreground">
                {t('note')}
              </label>
              <input
                id="edit-note"
                data-testid="edit-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={t('notePlaceholder')}
                maxLength={500}
                disabled={save.isPending}
                className={fieldClass}
              />
            </div>
          </div>

          <section
            aria-live="polite"
            data-testid="edit-order-preview"
            className="rounded-lg border border-border bg-muted/40 px-3 py-3 text-sm"
          >
            <h3 className="mb-2 text-xs font-medium text-muted-foreground">{t('previewTitle')}</h3>
            {refusal ? (
              <p role="alert" data-testid="edit-order-refusal" className="text-destructive">
                {refusal}
              </p>
            ) : shown ? (
              <div className="space-y-2">
                <ul className="space-y-1" data-testid="edit-preview-lines">
                  {shown.lines.map((l) => (
                    <li key={l.productId} className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <span className="min-w-0 truncate">{nameOf(l)}</span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {formatNumber(l.qtyBefore)}
                        {arrow}
                        {formatNumber(l.qtyAfter)}
                        {' · '}
                        {l.priceBefore !== null && l.priceBefore !== l.priceAfter && (
                          <>
                            <Money value={l.priceBefore} currency={sale.currency} />
                            {arrow}
                          </>
                        )}
                        <Money value={l.priceAfter} currency={sale.currency} />
                      </span>
                    </li>
                  ))}
                </ul>
                <dl className="grid grid-cols-1 gap-y-1.5 border-t border-border pt-2">
                  {shown.stockTaken.length > 0 && (
                    <Row label={t('stockTaken')} testId="edit-preview-taken">
                      {shown.stockTaken.map((s) => `${formatNumber(s.qty)} × ${s.product}`).join(', ')}
                    </Row>
                  )}
                  {shown.stockBack.length > 0 && (
                    <Row label={t('stockBack')} testId="edit-preview-back">
                      {shown.stockBack.map((s) => `${formatNumber(s.qty)} × ${s.product}`).join(', ')}
                    </Row>
                  )}
                  <Row label={t('profitChange')} testId="edit-preview-profit">
                    <Money value={shown.profitChangeEgp} currency={sale.currency} />
                  </Row>
                  <Row label={t('owes')} testId="edit-preview-owes" strong>
                    <Money value={shown.owedBefore} currency={sale.currency} />{' '}
                    <span className="whitespace-nowrap">
                      {arrow}
                      <Money value={shown.owedAfter} currency={sale.currency} />
                    </span>
                  </Row>
                </dl>
              </div>
            ) : ready ? (
              <div className="grid grid-cols-1 gap-y-2" aria-hidden="true" data-testid="edit-preview-pending">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="flex justify-between gap-3">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-4 w-20" />
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground" data-testid="edit-preview-empty">
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
