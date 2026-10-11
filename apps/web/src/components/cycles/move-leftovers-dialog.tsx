'use client';

import { useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { useCodeLabel } from '@/lib/labels';
import { businessToday } from '@/lib/dates';
import { useAllRecords } from '@/lib/list-all';
import { useNumberFormat } from '@/lib/numbers';
import { moveCost, transferTargets, type MovableAnswer } from '@/lib/stock-transfer';
import { Link } from '@/i18n/navigation';
import { DatePicker } from '@/components/ui/date-picker';
import { Select } from '@/components/ui/select';
import { Money } from '@/components/ui/money';
import { LatinText } from '@/components/ui/latin-text';
import { useToast } from '@/components/ui/toast';
import { fieldValue, parseQty } from '@/components/shipment/shipment-model';
import { DialogAlert, DialogCancel, DialogPrimary, ShipmentDialog, qtyInputClass } from '@/components/shipment/ShipmentDialog';

/** Everything a move changes on another screen: both cycles, stock, settlements, profit, funding. */
export const TRANSFER_QUERY_KEYS = [
  'cycle',
  'cycles',
  'cycle-transfers',
  'settlements',
  'landedCost',
  'analytics',
  'inventory',
  'inventoryBatches',
  'shipment',
];

/** The query `GET /cycles/:id/transfers/movable` is cached under. */
export const movableKey = (cycleId: string) => ['cycle-transfers', cycleId, 'movable'];

/**
 * Move a cycle's leftovers to another cycle at their cost (BUSINESS_LOGIC §8,
 * L5): pick the cycle that takes them — or start a new one for them through
 * the wizard — the day, why, and per product how many. Every product starts at
 * all of it, the usual case; a number typed is never overwritten.
 *
 * The server has the last word on every rule (`StockTransfersService`); a
 * refusal is shown here, translated, with the dialog left open. When the cycle
 * cannot hand anything on at all, the dialog says why instead of a form.
 *
 * `onSaved` runs once the server accepted the move, before the dialog closes,
 * so a caller can tell a save from a cancel (the unsold-stock prompt retries
 * paying out after a save).
 */
export function MoveLeftoversDialog({
  cycleId,
  cycleCode,
  initialTargetId,
  onSaved,
  onClose,
}: {
  cycleId: string;
  cycleCode: string;
  initialTargetId?: string;
  onSaved?: () => void;
  onClose: () => void;
}) {
  const t = useTranslations('transfers');
  const tc = useTranslations('common');
  const apiError = useApiError();
  const codeLabel = useCodeLabel();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { formatNumber } = useNumberFormat();

  const { data: movable, isLoading } = useQuery<MovableAnswer>({
    queryKey: movableKey(cycleId),
    queryFn: () => api.get(`/cycles/${cycleId}/transfers/movable`).then((r) => r.data.data ?? r.data),
  });
  const { items: cycles } = useAllRecords(['cycles'], '/cycles');
  const targets = useMemo(
    () => transferTargets((Array.isArray(cycles) ? cycles : []) as { id: string; code: string; status: string }[], cycleId),
    [cycles, cycleId],
  );

  const [toCycleId, setToCycleId] = useState(initialTargetId ?? '');
  const [movedOn, setMovedOn] = useState(() => businessToday());
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);

  const products = useMemo(() => movable?.products ?? [], [movable]);
  const prefill = useMemo(
    () => Object.fromEntries(products.map((p) => [p.productId, Number(p.available)])),
    [products],
  );
  const qtyOf = (productId: string) => parseQty(fieldValue(typed, prefill, productId));
  const total = products.reduce((s, p) => {
    const q = qtyOf(p.productId);
    return s + (q && q > 0 ? moveCost(p, Math.min(q, Number(p.available))) : 0);
  }, 0);
  const fmt = (n: number | string) => formatNumber(Number(n), { maximumFractionDigits: 3 });
  const cannot = movable?.refusal
    ? apiError({ response: { data: { error: movable.refusal } } }, t('cannotMove'))
    : null;

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (submitting.current) return;
    if (!toCycleId) return setRefusal(t('pickTarget'));
    if (!reason.trim()) return setRefusal(t('reasonRequired'));

    const lines: { productId: string; qty: number }[] = [];
    for (const p of products) {
      const qty = qtyOf(p.productId);
      if (qty === null) return setRefusal(t('qtyNotNumber', { product: p.productName }));
      if (qty !== 0) lines.push({ productId: p.productId, qty });
    }
    if (lines.length === 0) return setRefusal(t('nothingChosen'));

    submitting.current = true;
    setPending(true);
    setRefusal(null);
    try {
      await api.post(`/cycles/${cycleId}/transfers`, { toCycleId, movedOn, reason: reason.trim(), lines });
    } catch (err) {
      setRefusal(apiError(err, t('moveFailed')));
      submitting.current = false;
      setPending(false);
      return;
    }
    for (const key of TRANSFER_QUERY_KEYS) void queryClient.invalidateQueries({ queryKey: [key] });
    toast.success(t('moved'));
    onSaved?.();
    onClose();
  };

  return (
    <ShipmentDialog
      testId="move-leftovers"
      title={t('moveTitle')}
      subtitle={cycleCode}
      onClose={onClose}
      busy={pending}
      onSubmit={cannot ? undefined : (e) => void submit(e)}
      footer={
        <>
          <DialogCancel onClick={onClose} disabled={pending} label={tc('cancel')} />
          {!cannot && products.length > 0 && <DialogPrimary pending={pending} label={t('move')} />}
        </>
      }
    >
      {isLoading ? (
        <p className="text-sm text-muted-foreground">{tc('loading')}</p>
      ) : cannot ? (
        <p role="alert" data-testid="move-cannot" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {cannot}
        </p>
      ) : products.length === 0 ? (
        <p data-testid="move-nothing" className="text-sm text-muted-foreground">{t('nothingOnShelf')}</p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">{t('moveHint')}</p>

          <div>
            <label htmlFor="move-target" className="mb-1 block text-sm font-medium text-foreground">
              {t('target')}
              <span aria-hidden="true" className="ms-1 text-destructive">*</span>
            </label>
            <Select
              id="move-target"
              value={toCycleId}
              onChange={(v) => {
                setToCycleId(v);
                setRefusal(null);
              }}
              placeholder={t('pickTarget')}
              searchPlaceholder={tc('search')}
              emptyText={t('noTargets')}
              options={targets.map((c) => ({
                value: c.id,
                label: c.code,
                hint: codeLabel('cycleStatus', c.status),
              }))}
            />
            <Link
              href={`/cycles/new?leftoversFrom=${cycleId}`}
              data-testid="move-new-cycle"
              className="mt-2 inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-primary hover:underline sm:min-h-0"
            >
              <Plus className="h-4 w-4" aria-hidden="true" /> {t('newCycle')}
            </Link>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-sm font-medium text-foreground">
                {t('movedOn')}
                <span aria-hidden="true" className="ms-1 text-destructive">*</span>
              </label>
              <DatePicker name="movedOn" required disableFuture value={movedOn} onChange={(v) => setMovedOn(v || businessToday())} />
            </div>
            <div>
              <label htmlFor="move-reason" className="mb-1 block text-sm font-medium text-foreground">
                {t('reason')}
                <span aria-hidden="true" className="ms-1 text-destructive">*</span>
              </label>
              <input
                id="move-reason"
                data-testid="move-reason"
                type="text"
                maxLength={500}
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  setRefusal(null);
                }}
                placeholder={t('reasonHint')}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-ring md:text-sm"
              />
            </div>
          </div>

          <div>
            <p className="mb-2 text-sm font-medium text-foreground">{t('qtyPerProduct')}</p>
            <ul className="space-y-2">
              {products.map((p) => {
                const inputId = `move-qty-${p.productId}`;
                const q = qtyOf(p.productId);
                return (
                  <li key={p.productId} data-testid="move-row" data-product={p.productName} className="grid grid-cols-[1fr_7rem] items-center gap-3">
                    <label htmlFor={inputId} className="min-w-0 text-sm">
                      <span className="block break-words font-medium text-foreground">
                        <LatinText>{p.productName}</LatinText>
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {t('onShelf', { count: fmt(p.available) })}
                        {q && q > 0 ? (
                          <>
                            {' · '}
                            <Money value={moveCost(p, Math.min(q, Number(p.available)))} />
                          </>
                        ) : null}
                      </span>
                    </label>
                    <input
                      id={inputId}
                      data-testid="move-qty"
                      data-product={p.productName}
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      value={fieldValue(typed, prefill, p.productId)}
                      onChange={(e) => {
                        const value = e.target.value;
                        setTyped((prev) => ({ ...prev, [p.productId]: value }));
                        setRefusal(null);
                      }}
                      className={qtyInputClass}
                    />
                  </li>
                );
              })}
            </ul>
            <p data-testid="move-total" className="mt-3 text-end text-sm text-foreground">
              {t('totalCost')} <Money value={total} />
            </p>
          </div>

          <DialogAlert message={refusal} />
        </>
      )}
    </ShipmentDialog>
  );
}
