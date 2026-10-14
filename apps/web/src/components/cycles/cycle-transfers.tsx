'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, Forklift, Undo2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { useCan } from '@/lib/can';
import { useDateFormat } from '@/lib/dates';
import { useNumberFormat } from '@/lib/numbers';
import { canMoveFrom, type CycleTransfers as Transfers, type Transfer } from '@/lib/stock-transfer';
import { Link } from '@/i18n/navigation';
import { Money } from '@/components/ui/money';
import { LatinText } from '@/components/ui/latin-text';
import { useToast } from '@/components/ui/toast';
import { DialogAlert, DialogCancel, DialogPrimary, ShipmentDialog } from '@/components/shipment/ShipmentDialog';
import { MoveLeftoversDialog, TRANSFER_QUERY_KEYS } from './move-leftovers-dialog';

/** Leftovers moved out of and into a cycle (§8, L5) — one cache entry per cycle. */
export function useCycleTransfers(cycleId: string | undefined) {
  return useQuery<Transfers>({
    queryKey: ['cycle-transfers', cycleId],
    queryFn: () => api.get(`/cycles/${cycleId}/transfers`).then((r) => r.data.data ?? r.data),
    enabled: !!cycleId,
  });
}

/**
 * "Move leftovers" in a cycle's header (§8, L5): a core partner's, on a cycle
 * selling or settling — the statuses the server takes leftovers from. Whether
 * there is anything to move, and whether the cycle is paid out or still has
 * goods on the way, the dialog asks the server and says.
 *
 * Coming back from "Start a new cycle for them" the page carries `?moveTo=`,
 * which opens the dialog with that cycle chosen (and is then dropped, so a
 * reload does not open it again).
 */
export function MoveLeftoversButton({ cycleId, cycleCode, status }: { cycleId: string; cycleCode: string; status: string | undefined }) {
  const t = useTranslations('transfers');
  const allowed = useCan('stockTransfer.create');
  const [open, setOpen] = useState<{ target?: string } | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    const target = url.searchParams.get('moveTo');
    if (!target) return;
    url.searchParams.delete('moveTo');
    window.history.replaceState(window.history.state, '', url.toString());
    // Reading the address once, after it rendered: there is nothing to sync.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpen({ target });
  }, []);

  if (!allowed || !canMoveFrom(status)) return null;
  return (
    <>
      <button
        type="button"
        data-testid="move-leftovers"
        onClick={() => setOpen({})}
        className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted touch-manipulation"
      >
        <Forklift className="h-4 w-4 rtl:-scale-x-100" aria-hidden="true" /> {t('moveLeftovers')}
      </button>
      {open && (
        <MoveLeftoversDialog
          cycleId={cycleId}
          cycleCode={cycleCode}
          initialTargetId={open.target}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

/**
 * The Transfers section on a cycle's page (§8, L5): what it moved out and what
 * it took in — when, to or from which cycle, what, at what cost, who and why —
 * with Undo while the server would allow it. Whether it would is the server's
 * own `undoRefusal`, sent with each transfer, so the button is never a dead end.
 */
export function CycleTransfersSection({ cycleId }: { cycleId: string }) {
  const t = useTranslations('transfers');
  const { data } = useCycleTransfers(cycleId);
  const [undoing, setUndoing] = useState<Transfer | null>(null);
  const out = data?.out ?? [];
  const inn = data?.in ?? [];
  if (out.length === 0 && inn.length === 0) return null;

  return (
    <section data-testid="cycle-transfers" className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
        <ArrowRightLeft className="h-4 w-4 text-muted-foreground rtl:-scale-x-100" aria-hidden="true" />
        {t('title')}
      </h2>
      <div className="space-y-4">
        {out.length > 0 && <TransferList heading={t('movedOut')} direction="out" rows={out} onUndo={setUndoing} />}
        {inn.length > 0 && <TransferList heading={t('movedIn')} direction="in" rows={inn} onUndo={setUndoing} />}
      </div>
      {undoing && <UndoTransferDialog transfer={undoing} onClose={() => setUndoing(null)} />}
    </section>
  );
}

function TransferList({
  heading,
  direction,
  rows,
  onUndo,
}: {
  heading: string;
  direction: 'out' | 'in';
  rows: Transfer[];
  onUndo: (t: Transfer) => void;
}) {
  const t = useTranslations('transfers');
  const apiError = useApiError();
  const mayUndo = useCan('stockTransfer.undo');
  const { formatDate } = useDateFormat();
  const { formatNumber } = useNumberFormat();
  const fmt = (n: string) => formatNumber(Number(n), { maximumFractionDigits: 3 });

  return (
    <div>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{heading}</h3>
      <ul className="divide-y divide-border">
        {rows.map((r) => {
          const other = direction === 'out' ? r.toCycle : r.fromCycle;
          const undone = r.status === 'REVERSED';
          const why = !undone && !r.undo.allowed
            ? apiError({ response: { data: { error: { code: r.undo.code, message: '', params: r.undo.params } } } }, t('undoNotAllowed'))
            : null;
          return (
            <li key={r.id} data-testid="transfer-row" data-direction={direction} data-status={r.status} className="space-y-1 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="text-muted-foreground">{formatDate(r.movedOn)}</span>
                <span className="font-medium text-foreground">
                  {t.rich(direction === 'out' ? 'toCycle' : 'fromCycle', {
                    code: () => (
                      <Link href={`/cycles/${other.id}/details`} className="font-mono underline-offset-2 hover:underline">
                        <bdi dir="ltr">{other.code}</bdi>
                      </Link>
                    ),
                  })}
                </span>
                <span data-testid="transfer-cost" className={undone ? 'text-muted-foreground line-through' : 'text-foreground'}>
                  <Money value={Number(r.totalCostEgp)} />
                </span>
                {undone && (
                  <span data-testid="transfer-undone" className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    {t('undone')}
                  </span>
                )}
                {!undone && mayUndo && r.undo.allowed && (
                  <button
                    type="button"
                    data-testid="transfer-undo"
                    onClick={() => onUndo(r)}
                    className="ms-auto inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-primary hover:bg-muted sm:min-h-0"
                  >
                    <Undo2 className="h-4 w-4 rtl:-scale-x-100" aria-hidden="true" /> {t('undo')}
                  </button>
                )}
              </div>
              <ul className="text-sm text-foreground">
                {r.lines.map((l) => (
                  <li key={l.id} className="flex flex-wrap gap-x-2">
                    <LatinText>{l.productName}</LatinText>
                    {/* One left-to-right run, so "× 20 @ 100.00 EGP" is not reordered in Arabic. */}
                    <span dir="ltr" className="inline-block whitespace-nowrap text-muted-foreground">
                      × {fmt(l.qty)} @ <Money value={Number(l.unitCostEgp)} />
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                {t('byWhy', { name: r.createdBy.name, reason: r.reason })}
              </p>
              {undone && r.reversalReason && (
                <p className="text-xs text-muted-foreground">
                  {t('undoneBy', { name: r.reversedBy?.name ?? '—', reason: r.reversalReason })}
                </p>
              )}
              {why && mayUndo && (
                <p data-testid="transfer-permanent" className="text-xs text-muted-foreground">{why}</p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Undo a move, with a reason (§9) — the server re-checks that nothing has happened to the units. */
function UndoTransferDialog({ transfer, onClose }: { transfer: Transfer; onClose: () => void }) {
  const t = useTranslations('transfers');
  const tph = useTranslations('placeholders');
  const tc = useTranslations('common');
  const apiError = useApiError();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const running = useRef(false);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (running.current) return;
    if (!reason.trim()) return setRefusal(t('reasonRequired'));
    running.current = true;
    setPending(true);
    setRefusal(null);
    try {
      await api.post(`/stock-transfers/${transfer.id}/undo`, { reason: reason.trim() });
    } catch (err) {
      setRefusal(apiError(err, t('undoFailed')));
      running.current = false;
      setPending(false);
      return;
    }
    for (const key of TRANSFER_QUERY_KEYS) void queryClient.invalidateQueries({ queryKey: [key] });
    toast.success(t('undoDone'));
    onClose();
  };

  return (
    <ShipmentDialog
      testId="undo-transfer"
      size="sm"
      title={t('undoTitle')}
      subtitle={`${transfer.fromCycle.code} → ${transfer.toCycle.code}`}
      onClose={onClose}
      busy={pending}
      onSubmit={(e) => void submit(e)}
      footer={
        <>
          <DialogCancel onClick={onClose} disabled={pending} label={tc('cancel')} />
          <DialogPrimary pending={pending} label={t('undo')} destructive />
        </>
      }
    >
      <p className="text-sm text-muted-foreground">{t('undoHint')}</p>
      <div>
        <label htmlFor="undo-reason" className="mb-1 block text-sm font-medium text-foreground">
          {t('reason')}
          <span aria-hidden="true" className="ms-1 text-destructive">*</span>
        </label>
        <input
          id="undo-reason"
          data-testid="undo-reason"
          type="text"
          maxLength={500}
          placeholder={tph('undoTransferReason')}
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            setRefusal(null);
          }}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-base focus:outline-none focus:ring-2 focus:ring-ring md:text-sm"
        />
      </div>
      <DialogAlert message={refusal} />
    </ShipmentDialog>
  );
}
