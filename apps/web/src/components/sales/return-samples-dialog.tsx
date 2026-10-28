'use client';

import { useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useMutation } from '@tanstack/react-query';

import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { localName } from '@/lib/localized-name';
import { useNumberFormat } from '@/lib/numbers';
import { selectOnFocus } from '@/lib/select-on-focus';
import { cn } from '@/lib/utils';
import { Dialog, DialogAlert, DialogCancel } from '@/components/ui/dialog';
import { Loader2, Undo2 } from '@/components/ui/icons';
import { LatinText } from '@/components/ui/latin-text';

/**
 * "Returned" on a samples order (BUSINESS_LOGIC §4, owner 2026-10-28: "I
 * should be able to pick which sample a shop returned"). Each product the shop
 * holds on the order, with how many came back — all of it unless lowered; 0
 * for what stays. The server decides what that means (`POST
 * …/samples/return` with the lines): the chosen units back on the batches they
 * left, the rest still samples on this order, or the order ended as returned
 * when nothing is left. Every refusal is the server's, shown here.
 *
 * Mounted while the page is, so what was typed would outlive a close: every
 * close — Cancel, ×, Escape, done — goes through `close`, which forgets it
 * (CLAUDE.md §13), and the next visit starts again from "all".
 */

export interface ReturnSamplesOrder {
  id: string;
  orderNo: string;
  customerId: string;
  version: number;
  items?: {
    productId: string;
    product?: { name: string; nameAr?: string | null; sku: string };
    quantity: number | string;
  }[];
}

interface Row {
  productId: string;
  name: string;
  sku: string;
  out: number;
}

/** The products on the order and the units of each at the shop, in line order. */
function rowsOf(order: ReturnSamplesOrder, locale: string): Row[] {
  const rows = new Map<string, Row>();
  for (const item of order.items ?? []) {
    const row = rows.get(item.productId) ?? {
      productId: item.productId,
      name: item.product ? localName(item.product, locale) : item.productId,
      sku: item.product?.sku ?? '',
      out: 0,
    };
    row.out += Number(item.quantity);
    rows.set(item.productId, row);
  }
  return [...rows.values()].filter((r) => r.out > 0);
}

export function ReturnSamplesDialog({
  order,
  onClose,
  onReturned,
}: {
  /** The samples order being returned; null while the dialog is closed. */
  order: ReturnSamplesOrder | null;
  onClose: () => void;
  /** After the server recorded it: the status the order ends in. */
  onReturned: (status: string) => void;
}) {
  const t = useTranslations('sales.samples');
  const tc = useTranslations('common');
  const tph = useTranslations('placeholders');
  const locale = useLocale();
  const apiError = useApiError();
  const { formatNumber } = useNumberFormat();
  // Only what was changed is kept; an untouched product reads "all".
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [refusal, setRefusal] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (body: {
      lines: { productId: string; quantity: number }[];
      customerId: string;
      version: number;
    }) => api.post(`/sales/orders/${order!.id}/samples/return`, body),
    onSuccess: (res) => {
      const status = String(res.data?.data?.status ?? res.data?.status ?? '');
      close();
      onReturned(status);
    },
    onError: (error: unknown) => setRefusal(apiError(error, tc('error'))),
  });

  /** The one way out: what was typed and any refusal go with it. */
  function close() {
    setEdits({});
    setRefusal(null);
    onClose();
  }

  if (!order) return null;

  const rows = rowsOf(order, locale);
  const valueOf = (r: Row) => edits[r.productId] ?? String(r.out);
  const parsed = rows.map((r) => {
    const raw = valueOf(r).trim();
    const qty = raw === '' ? NaN : Number(raw);
    return { ...r, qty, valid: Number.isFinite(qty) && qty >= 0 && qty <= r.out };
  });
  const allValid = parsed.every((p) => p.valid);
  const back = parsed.reduce((s, p) => s + (p.valid ? p.qty : 0), 0);
  const out = parsed.reduce((s, p) => s + p.out, 0);
  const stay = out - back;
  const nothing = allValid && back === 0;

  return (
    <Dialog
      title={t('returnTitle', { orderNo: order.orderNo })}
      onClose={close}
      size="md"
      busy={mutation.isPending}
      onSubmit={(e) => {
        e.preventDefault();
        if (!allValid || nothing) return;
        setRefusal(null);
        mutation.mutate({
          lines: parsed.filter((p) => p.qty > 0).map((p) => ({ productId: p.productId, quantity: p.qty })),
          customerId: order.customerId,
          version: order.version,
        });
      }}
      footer={
        <>
          <DialogCancel onClick={close} disabled={mutation.isPending} label={tc('cancel')} />
          <button
            type="submit"
            data-testid="samples-return-confirm"
            disabled={!allValid || nothing || mutation.isPending}
            className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0"
          >
            {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />}
            {t('returnConfirm')}
          </button>
        </>
      }
    >
      <div className="space-y-4" data-testid="samples-return-dialog">
        <p className="text-sm text-muted-foreground">{t('returnPick')}</p>
        <ul className="space-y-2">
          {parsed.map((p) => (
            <li
              key={p.productId}
              data-testid="samples-return-row"
              data-product={p.productId}
              className="flex items-start justify-between gap-3 rounded-lg border border-border p-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">
                  <LatinText>{p.name}</LatinText>
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('returnAtShop', { units: formatNumber(p.out) })}
                </p>
              </div>
              <div className="w-24 shrink-0">
                <input
                  type="number"
                  min="0"
                  max={p.out}
                  step="any"
                  inputMode="decimal"
                  aria-label={t('returnQtyLabel', { product: p.name })}
                  aria-invalid={!p.valid}
                  placeholder={tph('quantitySmall')}
                  data-field="returned"
                  value={valueOf(p)}
                  onChange={(e) => {
                    const value = e.target.value;
                    setEdits((was) => ({ ...was, [p.productId]: value }));
                  }}
                  {...selectOnFocus}
                  className={cn(
                    'w-full rounded-lg border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2',
                    p.valid ? 'border-border focus:ring-ring' : 'border-destructive focus:ring-destructive',
                  )}
                />
                {!p.valid && (
                  <p className="mt-1 text-[11px] text-destructive" data-testid="samples-return-invalid">
                    {t('returnQtyInvalid', { max: formatNumber(p.out) })}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ul>
        {allValid && (
          <p className="rounded-lg bg-muted px-3 py-2 text-sm text-foreground" data-testid="samples-return-summary">
            {nothing ? t('returnNothing') : stay <= 0 ? t('returnBody') : t('returnPart', { back, stay })}
          </p>
        )}
        <DialogAlert message={refusal} testId="samples-return-refusal" />
      </div>
    </Dialog>
  );
}
