'use client';

import { useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PackageX, Undo2 } from '@/components/ui/icons';
import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { useCan } from '@/lib/can';
import { businessToday, useDateFormat } from '@/lib/dates';
import { useNumberFormat } from '@/lib/numbers';
import { localName } from '@/lib/localized-name';
import { Money } from '@/components/ui/money';
import { LatinText } from '@/components/ui/latin-text';
import { DatePicker } from '@/components/ui/date-picker';
import { useToast } from '@/components/ui/toast';
import { Dialog, DialogAlert, DialogCancel, DialogPrimary } from '@/components/ui/dialog';
import { qtyInputClass } from '@/components/shipment/ShipmentDialog';

/** One damage as `GET /cycles/:id/damages` sends it (§3, 2026-11-28). */
export interface StockDamage {
  id: string;
  batchId: string;
  productId: string;
  productName: string;
  productNameAr?: string | null;
  qty: string;
  unitCostEgp: string;
  costEgp: string;
  damagedOn: string;
  note: string | null;
  createdBy: { id: string; name: string } | null;
  undoneAt: string | null;
  undoneBy: { id: string; name: string } | null;
  undoReason: string | null;
  undo: { allowed: boolean; code?: string; params?: Record<string, string | number> };
}

export interface CycleDamages {
  cycleId: string;
  /** Why nothing can be marked or undone on the cycle now (being settled…), or null. */
  locked: { code: string; params: Record<string, string | number> } | null;
  damages: StockDamage[];
}

/** A batch as the cycle page has it, the fields marking reads. */
export interface DamageBatch {
  id: string;
  productId: string;
  product?: { name?: string; nameAr?: string | null } | null;
  remainingQty: number | string;
  saleableQty?: number | string;
  landedUnitCostEgp: number | string;
  verificationStatus?: string;
  createdAt?: string;
}

/**
 * Everything a damage or its undo changes on another screen: the cycle, its
 * stock, its profit and settlement, Take money and the partners, Analytics.
 */
export const DAMAGE_QUERY_KEYS = [
  'cycle',
  'cycles',
  'cycle-damages',
  'settlements',
  'landedCost',
  'analytics',
  'inventory',
  'inventoryBatches',
  'inventoryMovements',
  'product',
  'products',
  'take-money',
  'account-funding',
  'partner-money',
  'shipment',
  'dashboard',
];

export function useCycleDamages(cycleId: string | undefined) {
  return useQuery<CycleDamages>({
    queryKey: ['cycle-damages', cycleId],
    queryFn: () => api.get(`/cycles/${cycleId}/damages`).then((r) => r.data.data ?? r.data),
    enabled: !!cycleId,
  });
}

/** Whole units, the way the server takes them; null when not a whole number. */
export function wholeUnits(text: string): number | null {
  const t = text.trim();
  if (t === '') return 0;
  if (!/^\d+$/.test(t)) return null;
  return Number(t);
}

/** What a batch has on its shelf to mark: sellable units, verified batches only. */
export function onShelf(b: DamageBatch): number {
  if (b.verificationStatus && b.verificationStatus !== 'VERIFIED') return 0;
  return Math.max(0, Number(b.saleableQty ?? b.remainingQty ?? 0));
}

/** "Mark damaged" on a batch row: core partners, a batch with units, a cycle not being settled. */
export function MarkDamagedButton({
  batch,
  cycleCode,
  locked,
}: {
  batch: DamageBatch;
  cycleCode: string;
  locked: boolean;
}) {
  const t = useTranslations('damages');
  const locale = useLocale();
  const allowed = useCan('stockDamage.mark');
  const [open, setOpen] = useState(false);
  if (!allowed || locked || onShelf(batch) <= 0) return null;
  const name = localName(batch.product ?? {}, locale) || '—';
  return (
    <>
      <button
        type="button"
        data-testid="mark-damaged"
        aria-label={t('markBatch', { product: name })}
        onClick={() => setOpen(true)}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-primary hover:bg-muted sm:min-h-0 sm:py-1"
      >
        <PackageX className="h-3.5 w-3.5" aria-hidden="true" /> {t('markDamaged')}
      </button>
      {open && <MarkDamagedDialog batch={batch} cycleCode={cycleCode} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * Mark units of a batch damaged in storage (§3, owner 2026-11-28): how many,
 * the day they were found (not in the future, not before the batch was
 * received), a note. The loss is shown as it will be booked — units × the
 * batch's landed unit cost. The server has the last word on every rule; a
 * refusal is shown here, translated, and the dialog stays open.
 */
export function MarkDamagedDialog({
  batch,
  cycleCode,
  onClose,
}: {
  batch: DamageBatch;
  cycleCode: string;
  onClose: () => void;
}) {
  const t = useTranslations('damages');
  const tph = useTranslations('placeholders');
  const tc = useTranslations('common');
  const locale = useLocale();
  const apiError = useApiError();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { formatNumber } = useNumberFormat();
  const [qty, setQty] = useState('');
  const [damagedOn, setDamagedOn] = useState(() => businessToday());
  const [note, setNote] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const running = useRef(false);

  const available = onShelf(batch);
  const unit = Number(batch.landedUnitCostEgp);
  const n = wholeUnits(qty);
  const name = localName(batch.product ?? {}, locale) || '—';
  const received = batch.createdAt ? businessToday(new Date(batch.createdAt)) : undefined;

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (running.current) return;
    if (n === null) return setRefusal(t('qtyNotWhole'));
    if (n <= 0) return setRefusal(t('qtyRequired'));
    if (n > available) return setRefusal(t('qtyTooMany', { count: formatNumber(available) }));
    running.current = true;
    setPending(true);
    setRefusal(null);
    try {
      await api.post(`/inventory/batches/${batch.id}/damages`, {
        qty: n,
        damagedOn,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
    } catch (err) {
      setRefusal(apiError(err, t('saveFailed')));
      running.current = false;
      setPending(false);
      return;
    }
    for (const key of DAMAGE_QUERY_KEYS) void queryClient.invalidateQueries({ queryKey: [key] });
    toast.success(t('saved'));
    onClose();
  };

  return (
    <Dialog
      data-shipment-dialog="mark-damaged"
      size="sm"
      title={t('markTitle')}
      subtitle={cycleCode}
      onClose={onClose}
      busy={pending}
      onSubmit={(e) => void submit(e)}
      footer={
        <>
          <DialogCancel onClick={onClose} disabled={pending} label={tc('cancel')} />
          <DialogPrimary pending={pending} label={t('save')} destructive />
        </>
      }
      bodyClassName="space-y-4"
    >
      <p className="text-sm text-muted-foreground">{t('markHint')}</p>
      <div className="rounded-lg bg-muted/50 px-3 py-2 text-sm">
        <p className="break-words font-medium text-foreground">
          <LatinText>{name}</LatinText>
        </p>
        <p className="text-xs text-muted-foreground">
          {t('onShelf', { count: formatNumber(available) })} · <Money value={unit} />
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="damage-qty" className="mb-1 block text-sm font-medium text-foreground">
            {t('qty')}
            <span aria-hidden="true" className="ms-1 text-destructive">*</span>
          </label>
          <input
            id="damage-qty"
            data-testid="damage-qty"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            autoFocus
            placeholder={tph('quantitySmall')}
            value={qty}
            onChange={(e) => {
              setQty(e.target.value);
              setRefusal(null);
            }}
            className={qtyInputClass}
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-foreground">
            {t('damagedOn')}
            <span aria-hidden="true" className="ms-1 text-destructive">*</span>
          </label>
          <DatePicker
            name="damagedOn"
            required
            disableFuture
            min={received}
            value={damagedOn}
            onChange={(v) => setDamagedOn(v || businessToday())}
          />
        </div>
      </div>
      <div>
        <label htmlFor="damage-note" className="mb-1 block text-sm font-medium text-foreground">
          {t('note')}
        </label>
        <input
          id="damage-note"
          data-testid="damage-note"
          type="text"
          maxLength={500}
          placeholder={tph('damageNote')}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-ring md:text-sm"
        />
      </div>
      <p data-testid="damage-cost" className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="text-muted-foreground">{t('cost')}</span>
        <span dir="ltr" className="inline-block whitespace-nowrap font-medium text-foreground">
          {n && n > 0 ? (
            <>
              {formatNumber(n)} × <Money value={unit} /> = <Money value={Math.round(n * unit * 100) / 100} />
            </>
          ) : (
            <Money value={0} />
          )}
        </span>
      </p>
      <DialogAlert message={refusal} />
    </Dialog>
  );
}

/**
 * Damaged in storage on a cycle's page (§3, 2026-11-28): each damage — when,
 * what, how many, its loss, who and why — with Undo while the server would
 * allow it (the server's own refusal sent with each row, so the button is
 * never a dead end). Undone ones stay, struck through.
 */
export function CycleDamagesSection({ cycleId }: { cycleId: string }) {
  const t = useTranslations('damages');
  const locale = useLocale();
  const apiError = useApiError();
  const mayUndo = useCan('stockDamage.undo');
  const { formatDate } = useDateFormat();
  const { formatNumber } = useNumberFormat();
  const { data } = useCycleDamages(cycleId);
  const [undoing, setUndoing] = useState<StockDamage | null>(null);
  const rows = data?.damages ?? [];
  if (rows.length === 0) return null;
  const standing = rows.filter((r) => !r.undoneAt).reduce((s, r) => s + Number(r.costEgp), 0);

  return (
    <section data-testid="cycle-damages" className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <h2 className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm font-semibold text-foreground">
        <span className="flex items-center gap-2">
          <PackageX className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          {t('title')}
        </span>
        <span className="text-xs font-normal text-muted-foreground">
          {t('total')} <span data-testid="damages-total" className="font-medium text-foreground"><Money value={standing} /></span>
        </span>
      </h2>
      <ul className="divide-y divide-border">
        {rows.map((r) => {
          const undone = !!r.undoneAt;
          const why =
            !undone && !r.undo.allowed && r.undo.code
              ? apiError({ response: { data: { error: { code: r.undo.code, message: '', params: r.undo.params } } } }, '')
              : null;
          const product = localName({ name: r.productName, nameAr: r.productNameAr }, locale) || r.productName;
          return (
            <li key={r.id} data-testid="damage-row" data-status={undone ? 'UNDONE' : 'STANDING'} className="space-y-1 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="text-muted-foreground">{formatDate(r.damagedOn)}</span>
                <span className="min-w-0 break-words font-medium text-foreground">
                  <LatinText>{product}</LatinText>{' '}
                  <span dir="ltr" className="inline-block whitespace-nowrap text-muted-foreground">
                    × {formatNumber(Number(r.qty))}
                  </span>
                </span>
                <span data-testid="damage-cost-row" className={undone ? 'text-muted-foreground line-through' : 'text-foreground'}>
                  <Money value={Number(r.costEgp)} />
                </span>
                {undone && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{t('undone')}</span>
                )}
                {!undone && mayUndo && r.undo.allowed && (
                  <button
                    type="button"
                    data-testid="damage-undo"
                    onClick={() => setUndoing(r)}
                    className="ms-auto inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-primary hover:bg-muted sm:min-h-0"
                  >
                    <Undo2 className="h-4 w-4 rtl:-scale-x-100" aria-hidden="true" /> {t('undo')}
                  </button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {r.note ? t('byNote', { name: r.createdBy?.name ?? '—', note: r.note }) : t('by', { name: r.createdBy?.name ?? '—' })}
              </p>
              {undone && r.undoReason && (
                <p className="text-xs text-muted-foreground">
                  {t('undoneBy', { name: r.undoneBy?.name ?? '—', reason: r.undoReason })}
                </p>
              )}
              {why && mayUndo && <p className="text-xs text-muted-foreground">{why}</p>}
            </li>
          );
        })}
      </ul>
      {undoing && <UndoDamageDialog damage={undoing} onClose={() => setUndoing(null)} />}
    </section>
  );
}

/** Undo a damage, with a reason (§9 pattern) — the units go back on their batch. */
function UndoDamageDialog({ damage, onClose }: { damage: StockDamage; onClose: () => void }) {
  const t = useTranslations('damages');
  const tph = useTranslations('placeholders');
  const tc = useTranslations('common');
  const locale = useLocale();
  const apiError = useApiError();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { formatNumber } = useNumberFormat();
  const [reason, setReason] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const running = useRef(false);
  const product = localName({ name: damage.productName, nameAr: damage.productNameAr }, locale) || damage.productName;

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (running.current) return;
    if (!reason.trim()) return setRefusal(t('reasonRequired'));
    running.current = true;
    setPending(true);
    setRefusal(null);
    try {
      await api.post(`/inventory/damages/${damage.id}/undo`, { reason: reason.trim() });
    } catch (err) {
      setRefusal(apiError(err, t('undoFailed')));
      running.current = false;
      setPending(false);
      return;
    }
    for (const key of DAMAGE_QUERY_KEYS) void queryClient.invalidateQueries({ queryKey: [key] });
    toast.success(t('undoDone'));
    onClose();
  };

  return (
    <Dialog
      data-shipment-dialog="undo-damage"
      size="sm"
      title={t('undoTitle')}
      subtitle={`${product} × ${formatNumber(Number(damage.qty))}`}
      onClose={onClose}
      busy={pending}
      onSubmit={(e) => void submit(e)}
      footer={
        <>
          <DialogCancel onClick={onClose} disabled={pending} label={tc('cancel')} />
          <DialogPrimary pending={pending} label={t('undo')} />
        </>
      }
      bodyClassName="space-y-4"
    >
      <p className="text-sm text-muted-foreground">{t('undoHint')}</p>
      <div>
        <label htmlFor="damage-undo-reason" className="mb-1 block text-sm font-medium text-foreground">
          {t('reason')}
          <span aria-hidden="true" className="ms-1 text-destructive">*</span>
        </label>
        <input
          id="damage-undo-reason"
          data-testid="damage-undo-reason"
          type="text"
          maxLength={500}
          placeholder={tph('damageUndoReason')}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            setRefusal(null);
          }}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-ring md:text-sm"
        />
      </div>
      <DialogAlert message={refusal} />
    </Dialog>
  );
}
