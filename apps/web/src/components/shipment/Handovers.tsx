'use client';

import { useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { CheckCheck, PackageOpen, Plus, Trash2, Undo2 } from '@/components/ui/icons';
import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { useCan } from '@/lib/can';
import { businessToday, useDateFormat } from '@/lib/dates';
import { useNumberFormat } from '@/lib/numbers';
import { useCurrencyRates } from '@/lib/currency-rates';
import { cn } from '@/lib/utils';
import { Money } from '@/components/ui/money';
import { MoneyInput } from '@/components/ui/money-input';
import { DatePicker } from '@/components/ui/date-picker';
import { Select } from '@/components/ui/select';
import { LatinText } from '@/components/ui/latin-text';
import { FieldWithQuickCreate } from '@/components/ui/quick-create';
import { CurrentRateHint } from '@/components/ui/currency-rate-fields';
import { Dialog, DialogAlert, DialogCancel, DialogPrimary } from '@/components/ui/dialog';
import { ConfirmActionDialog } from './ConfirmActionDialog';
import { qtyInputClass, useRefreshShipment } from './ShipmentDialog';
import { useAnnounceStatusMove } from './status-move';
import { fieldValue, parseQty, type Handover, type ShipmentLeg } from './shipment-model';

/**
 * A UAE leg in handovers (BUSINESS_LOGIC §1, §2, §18 — owner 2026-11-20,
 * mockup A approved): one box per lot handed to the forwarder, with its
 * arrivals under it, and the dialogs that record them. Every figure is the
 * server's (`legHandovers`): the freight a piece, whether it is final, what
 * each lot still has to bring. Nothing is worked out here.
 */

/** Which handover dialog is open — one value, so every close clears it. */
type Open =
  | { kind: 'handOver' }
  | { kind: 'arrival'; handoverId?: string }
  | { kind: 'allArrived'; handoverId: string }
  | { kind: 'undoAllArrived'; handoverId: string }
  | { kind: 'undoHandover'; handoverId: string }
  | { kind: 'undoArrival'; arrivalId: string }
  | null;

const btn =
  'inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted sm:min-h-0';
const quiet =
  'inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground sm:min-h-8 sm:min-w-8';

export function HandoverSection({
  cycleId,
  leg,
  productNames,
  frozen,
}: {
  cycleId: string;
  leg: ShipmentLeg;
  productNames: Record<string, string>;
  frozen: boolean;
}) {
  const t = useTranslations('handovers');
  const { formatDate } = useDateFormat();
  const { formatNumber } = useNumberFormat();
  const may = useCan('shipment.handover') && !frozen;
  const [open, setOpen] = useState<Open>(null);
  const close = () => setOpen(null);
  const s = leg.handovers;
  const handovers = s?.handovers ?? [];
  const waiting = s ? s.stillInUae : (leg.atOrigin ?? 0);
  const n = (v: number) => formatNumber(v, { maximumFractionDigits: 3 });
  const byId = (id: string) => handovers.find((h) => h.id === id);

  return (
    <div data-testid="handovers" className="space-y-3 border-t border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('title')}</h4>
        {handovers.length > 0 && <FreightPill leg={leg} />}
      </div>

      {handovers.length === 0 ? (
        <p data-testid="handovers-empty" className="text-sm text-muted-foreground">
          {t('none', { count: waiting })}
        </p>
      ) : (
        <ul className="space-y-2">
          {handovers.map((h) => (
            <li key={h.id} data-testid="handover" data-number={h.number} className="rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="min-w-0 text-sm">
                  <span className="font-semibold text-foreground">{t('handoverN', { n: h.number })}</span>
                  <span data-testid="handover-facts" className="text-muted-foreground">
                    {' · '}
                    {formatDate(h.handedOverOn)}
                    {' · '}
                    {h.pieces === null ? t('piecesUnknown') : t('pieces', { count: h.pieces })}
                    {' · '}
                    <Money value={h.freightAmount} currency={h.freightCurrency} />
                    {h.provider && (
                      <>
                        {' · '}
                        <LatinText>{h.provider}</LatinText>
                      </>
                    )}
                    {h.paidBy && (
                      <>
                        {' · '}
                        <span data-testid="handover-paid-by">{t('paidByName', { name: h.paidBy.name })}</span>
                      </>
                    )}
                  </span>
                </p>
                <ProgressPill h={h} />
              </div>
              {h.pieces !== null && (
                <div
                  role="progressbar"
                  aria-label={t('progressLabel')}
                  aria-valuemin={0}
                  aria-valuemax={h.pieces}
                  aria-valuenow={h.arrived}
                  className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted"
                >
                  <div
                    className={cn('h-full rounded-full', h.open ? 'bg-primary' : 'bg-success')}
                    style={{ width: `${Math.min(100, Math.round(((h.arrived + h.lost) / h.pieces) * 100))}%` }}
                  />
                </div>
              )}
              {h.owed && Number(h.owed.owed) > 0 && (
                <p data-testid="handover-owed" className="mt-2 text-xs text-muted-foreground">
                  {t.rich('owedTo', {
                    name: h.paidBy?.name ?? '—',
                    amount: () => <Money value={h.owed!.owed} currency={h.owed!.currency} className="font-semibold text-foreground" />,
                  })}
                </p>
              )}
              {h.arrivals.length > 0 && (
                <ul className="mt-2">
                  {h.arrivals.map((a) => (
                    <li
                      key={a.id}
                      data-testid="handover-arrival"
                      className="flex items-center justify-between gap-3 border-t border-dashed border-border py-1.5 ps-3 text-sm text-foreground/80"
                    >
                      <span className="min-w-0">
                        {t('arrivedOn', { date: formatDate(a.arrivedOn) })}
                        {' · '}
                        {a.lines.map((l, i) => (
                          <span key={l.purchaseOrderItemId}>
                            {i > 0 && t('listSeparator')}
                            {/* Name and count isolated from each other and from the list,
                                so "SU8" and "×30" never run together in Arabic. */}
                            <bdi>
                              <LatinText>{productNames[l.purchaseOrderItemId] ?? '—'}</LatinText>{' '}
                              <bdi dir="ltr">×{n(l.qty)}</bdi>
                            </bdi>
                          </span>
                        ))}
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        <b className="font-medium tabular-nums">{n(a.total)}</b>
                        {may && h.open && (
                          <button
                            type="button"
                            data-testid="undo-arrival"
                            aria-label={t('undoArrival')}
                            title={t('undoArrival')}
                            onClick={() => setOpen({ kind: 'undoArrival', arrivalId: a.id })}
                            className={quiet}
                          >
                            <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {may && (
                <div className="mt-2 flex flex-wrap justify-end gap-2">
                  {h.open ? (
                    <>
                      {h.arrivals.length === 0 && (
                        <button
                          type="button"
                          data-testid="undo-handover"
                          onClick={() => setOpen({ kind: 'undoHandover', handoverId: h.id })}
                          className={quiet}
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> {t('undoHandover')}
                        </button>
                      )}
                      <button
                        type="button"
                        data-testid="record-arrival"
                        onClick={() => setOpen({ kind: 'arrival', handoverId: h.id })}
                        className={btn}
                      >
                        <PackageOpen className="h-4 w-4" aria-hidden="true" /> {t('recordArrival')}
                      </button>
                      <button
                        type="button"
                        data-testid="all-arrived"
                        onClick={() => setOpen({ kind: 'allArrived', handoverId: h.id })}
                        className={btn}
                      >
                        <CheckCheck className="h-4 w-4" aria-hidden="true" /> {t('allArrived')}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      data-testid="undo-all-arrived"
                      onClick={() => setOpen({ kind: 'undoAllArrived', handoverId: h.id })}
                      className={quiet}
                    >
                      <Undo2 className="h-3.5 w-3.5" aria-hidden="true" /> {t('undoAllArrived')}
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
        <p data-testid="handovers-footer" className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <span>
            {t('stillInUae')} <b className="font-semibold text-foreground tabular-nums">{n(waiting)}</b>
          </span>
          <span>
            {t('withForwarder')}{' '}
            <b className="font-semibold text-foreground tabular-nums">
              {s && s.withForwarderUnknown > 0
                ? s.withForwarder > 0
                  ? t('plusUnknown', { count: n(s.withForwarder) })
                  : t('unknown')
                : n(s?.withForwarder ?? 0)}
            </b>
          </span>
          <span>
            {t('arrived')} <b className="font-semibold text-foreground tabular-nums">{n(s?.arrived ?? 0)}</b>
          </span>
        </p>
        {may && waiting > 0 && (
          <button
            type="button"
            data-testid="hand-over"
            onClick={() => setOpen({ kind: 'handOver' })}
            className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 sm:min-h-0"
          >
            <Plus className="h-4 w-4" aria-hidden="true" /> {t('handOver')}
          </button>
        )}
      </div>

      {open?.kind === 'handOver' && <HandOverDialog leg={leg} cycleId={cycleId} onClose={close} />}
      {open?.kind === 'arrival' && (
        <RecordArrivalDialog leg={leg} handoverId={open.handoverId} productNames={productNames} onClose={close} />
      )}
      {open?.kind === 'allArrived' && byId(open.handoverId) && (
        <AllArrivedDialog leg={leg} handover={byId(open.handoverId)!} productNames={productNames} onClose={close} />
      )}
      {open?.kind === 'undoAllArrived' && (
        <ConfirmActionDialog
          testId="undo-all-arrived"
          title={t('undoAllArrivedTitle')}
          message={t('undoAllArrivedConfirm')}
          confirmLabel={t('undoAllArrived')}
          successMessage={t('undoneAllArrived')}
          failMessage={t('undoFailed')}
          action={() => api.delete(`/shipping/handovers/${open.handoverId}/all-arrived`)}
          onClose={close}
        />
      )}
      {open?.kind === 'undoHandover' && (
        <ConfirmActionDialog
          testId="undo-handover"
          title={t('undoHandoverTitle')}
          message={t('undoHandoverConfirm')}
          confirmLabel={t('undoHandover')}
          successMessage={t('undoneHandover')}
          failMessage={t('undoFailed')}
          action={() => api.delete(`/shipping/handovers/${open.handoverId}`)}
          onClose={close}
        />
      )}
      {open?.kind === 'undoArrival' && (
        <ConfirmActionDialog
          testId="undo-arrival"
          title={t('undoArrivalTitle')}
          message={t('undoArrivalConfirm')}
          confirmLabel={t('undoArrival')}
          successMessage={t('undoneArrival')}
          failMessage={t('undoFailed')}
          action={() => api.delete(`/shipping/arrivals/${open.arrivalId}`)}
          onClose={close}
        />
      )}
    </div>
  );
}

/** "Freight 53.68 AED a piece · estimate" — or final, or not known yet. */
export function FreightPill({ leg }: { leg: ShipmentLeg }) {
  const t = useTranslations('handovers');
  const s = leg.handovers;
  if (!s) return null;
  const amount = s.perPiece
    ? () => <Money value={s.perPiece!.amount} currency={s.perPiece!.currency} />
    : s.perPieceEgp
      ? () => <Money value={s.perPieceEgp} />
      : null;
  return (
    <span
      data-testid="freight-pill"
      data-final={s.final}
      className={cn(
        'inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium',
        s.final ? 'bg-success/10 text-success' : 'bg-accent-50 text-accent-800',
      )}
    >
      {amount
        ? t.rich(s.final ? 'perPieceFinal' : 'perPieceEstimate', { amount })
        : t('perPieceUnknown')}
    </span>
  );
}

function ProgressPill({ h }: { h: Handover }) {
  const t = useTranslations('handovers');
  const label = !h.open
    ? t('allArrivedPill')
    : h.pieces !== null
      ? t('arrivedOf', { arrived: h.arrived, pieces: h.pieces })
      : t('arrivedSoFar', { arrived: h.arrived });
  return (
    <span
      data-testid="handover-progress"
      className={cn(
        'whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium',
        h.open ? 'bg-primary/10 text-primary' : 'bg-success/10 text-success',
      )}
    >
      {label}
    </span>
  );
}

// ─── The forms ──────────────────────────────────────────────────────────────

interface Provider {
  id: string;
  name: string;
  contactPerson?: string | null;
}
interface AccountHolder {
  partnerUserId: string;
  name: string;
  active: boolean;
}

const BUSINESS = 'business';
const CURRENCIES = ['AED', 'USD', 'EGP'];

/**
 * Hand over goods: the day, the forwarder, the freight paid (amount and
 * currency, with the rate from the Exchange rates page, editable), the
 * pieces when known and who paid. No products: they are counted on arrival.
 * Every refusal is the server's, shown in the dialog with what was typed kept.
 */
export function HandOverDialog({ leg, cycleId, onClose }: { leg: ShipmentLeg; cycleId: string; onClose: () => void }) {
  const t = useTranslations('handovers');
  const tc = useTranslations('common');
  const tph = useTranslations('placeholders');
  const apiError = useApiError();
  const announce = useAnnounceStatusMove();
  const refresh = useRefreshShipment();
  const { formatNumber } = useNumberFormat();
  const rates = useCurrencyRates();

  const { data: providerData } = useQuery({
    queryKey: ['providers'],
    queryFn: () => api.get('/providers').then((r) => r.data.data ?? r.data),
  });
  const providers: Provider[] = Array.isArray(providerData) ? providerData : [];
  const mayAccounts = useCan('partnerAccount.read');
  const { data: holders } = useQuery<AccountHolder[]>({
    queryKey: ['partner-accounts'],
    queryFn: () => api.get('/partner-accounts').then((r) => r.data.data ?? r.data),
    enabled: mayAccounts,
  });
  const payers = useMemo(
    () => [
      { value: BUSINESS, label: t('paidByBusiness') },
      ...(Array.isArray(holders) ? holders : []).filter((h) => h.active).map((h) => ({ value: h.partnerUserId, label: h.name })),
    ],
    [holders, t],
  );

  const [day, setDay] = useState(() => businessToday());
  const [providerId, setProviderId] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('AED');
  const [typedRate, setTypedRate] = useState<string | null>(null);
  const [pieces, setPieces] = useState('');
  const [paidBy, setPaidBy] = useState(BUSINESS);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);

  const rate = currency === 'EGP' ? '1' : (typedRate ?? (rates[currency] != null ? String(rates[currency]) : ''));
  const inEgp = Number(amount) * Number(rate);
  const waiting = leg.handovers ? leg.handovers.stillInUae : (leg.atOrigin ?? 0);
  const payerName = payers.find((p) => p.value === paidBy && paidBy !== BUSINESS)?.label;

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (submitting.current) return;
    if (amount.trim() === '') {
      setRefusal(t('freightRequired'));
      return;
    }
    const count = pieces.trim() === '' ? null : Number(pieces);
    if (count !== null && !Number.isFinite(count)) {
      setRefusal(t('piecesNotNumber'));
      return;
    }
    submitting.current = true;
    setPending(true);
    setRefusal(null);
    try {
      const res = await api.post(`/shipping/legs/${leg.legId}/handovers`, {
        handedOverOn: day,
        providerId: providerId || undefined,
        freightAmount: Number(amount),
        freightCurrency: currency,
        ...(currency === 'EGP' || rate === '' ? {} : { freightRateToEgp: Number(rate) }),
        pieces: count,
        paidByUserId: paidBy === BUSINESS ? undefined : paidBy,
      });
      refresh();
      announce(t('handedOver'), res);
      onClose();
    } catch (err) {
      setRefusal(apiError(err, t('handOverFailed')));
      submitting.current = false;
      setPending(false);
    }
  };

  return (
    <Dialog
      data-shipment-dialog="hand-over"
      cardProps={{ 'data-testid': 'hand-over-dialog', 'data-cycle': cycleId }}
      title={t('handOverTitle')}
      description={t('handOverHint')}
      onClose={onClose}
      busy={pending}
      onSubmit={(e) => void submit(e)}
      footer={
        <>
          <DialogCancel onClick={onClose} disabled={pending} label={tc('cancel')} />
          <DialogPrimary pending={pending} label={tc('save')} />
        </>
      }
      bodyClassName="space-y-4"
    >
      <div>
        <label className="mb-1 block text-sm font-medium text-foreground">
          {t('date')}
          <span aria-hidden="true" className="ms-1 text-destructive">*</span>
        </label>
        <DatePicker name="handedOverOn" required disableFuture value={day} onChange={(v) => setDay(v || businessToday())} />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-foreground">{t('forwarder')}</label>
        <FieldWithQuickCreate entity="provider" onCreated={(p) => setProviderId(p.id)}>
          <Select
            name="providerId"
            value={providerId}
            onChange={setProviderId}
            placeholder={tph('chooseProvider')}
            searchPlaceholder={tph('searchProviders')}
            options={providers.map((p) => ({ value: p.id, label: p.name, hint: p.contactPerson ?? undefined }))}
          />
        </FieldWithQuickCreate>
      </div>

      <div>
        <label htmlFor="handover-freight" className="mb-1 block text-sm font-medium text-foreground">
          {t('freightPaid')}
          <span aria-hidden="true" className="ms-1 text-destructive">*</span>
        </label>
        <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-2">
          <MoneyInput
            id="handover-freight"
            name="freightAmount"
            value={amount}
            onChange={(v) => {
              setAmount(v);
              setRefusal(null);
            }}
            placeholder={tph('money')}
            className="w-full min-w-0 rounded-lg border border-border bg-background px-3 py-2 text-start text-base focus:outline-none focus:ring-2 focus:ring-ring md:text-sm"
          />
          <Select
            name="freightCurrency"
            value={currency}
            onChange={(v) => {
              setCurrency(v);
              setTypedRate(null);
            }}
            options={CURRENCIES.map((c) => ({ value: c, label: c }))}
          />
        </div>
        {currency !== 'EGP' && (
          <div className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
            <label htmlFor="handover-rate" className="text-xs text-muted-foreground">
              {t('rateFor', { currency })}
            </label>
            <input
              id="handover-rate"
              name="freightRateToEgp"
              inputMode="decimal"
              dir="ltr"
              value={rate}
              onChange={(e) => setTypedRate(e.target.value.replace(/[^\d.]/g, ''))}
              placeholder={tph('fxRate')}
              className="w-full min-w-0 rounded-lg border border-border bg-background px-3 py-1.5 text-start text-base tabular-nums focus:outline-none focus:ring-2 focus:ring-ring md:text-sm"
            />
          </div>
        )}
        <p data-testid="handover-freight-hint" className="mt-1 text-xs text-muted-foreground">
          {currency !== 'EGP' && rates[currency] != null && (
            <>
              <CurrentRateHint currency={currency} rate={rates[currency]} />
              {' · '}
            </>
          )}
          {Number.isFinite(inEgp) && amount !== '' && <Money value={inEgp.toFixed(2)} />}
        </p>
      </div>

      <div>
        <label htmlFor="handover-pieces" className="mb-1 block text-sm font-medium text-foreground">
          {t('piecesIfKnown')}
        </label>
        <input
          id="handover-pieces"
          name="pieces"
          inputMode="numeric"
          autoComplete="off"
          value={pieces}
          onChange={(e) => {
            setPieces(e.target.value.replace(/[^\d]/g, ''));
            setRefusal(null);
          }}
          placeholder={t('piecesPlaceholder')}
          className={qtyInputClass}
        />
        <p className="mt-1 text-xs text-muted-foreground">{t('stillInUaeHint', { count: formatNumber(waiting) })}</p>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-foreground">{t('paidBy')}</label>
        <Select name="paidBy" value={paidBy} onChange={(v) => setPaidBy(v || BUSINESS)} options={payers} />
        {payerName && (
          <p data-testid="handover-paid-by-hint" className="mt-1 text-xs text-muted-foreground">
            {t('paidByHint', { partner: payerName, currency })}
          </p>
        )}
      </div>

      <DialogAlert message={refusal} />
    </Dialog>
  );
}

/**
 * Record an arrival: which handover it came from (picked by itself when only
 * one is open), the day, and per product how many came. Products are entered
 * only here; each starts empty and shows what still waits in the UAE.
 */
export function RecordArrivalDialog({
  leg,
  handoverId,
  productNames,
  onClose,
}: {
  leg: ShipmentLeg;
  handoverId?: string;
  productNames: Record<string, string>;
  onClose: () => void;
}) {
  const t = useTranslations('handovers');
  const tc = useTranslations('common');
  const apiError = useApiError();
  const announce = useAnnounceStatusMove();
  const refresh = useRefreshShipment();
  const { formatDate } = useDateFormat();
  const { formatNumber } = useNumberFormat();

  const open = (leg.handovers?.handovers ?? []).filter((h) => h.open);
  const [from, setFrom] = useState(handoverId ?? (open.length === 1 ? open[0].id : ''));
  const [day, setDay] = useState(() => businessToday());
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const rows = leg.lines.filter((l) => (l.atOrigin ?? 0) > 0 || Object.prototype.hasOwnProperty.call(typed, l.purchaseOrderItemId));
  const total = rows.reduce((s, r) => s + (parseQty(typed[r.purchaseOrderItemId] ?? '') ?? 0), 0);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (submitting.current) return;
    if (!from) {
      setRefusal(t('pickHandover'));
      return;
    }
    const lines: { purchaseOrderItemId: string; qty: number }[] = [];
    for (const row of rows) {
      const qty = parseQty(fieldValue(typed, {}, row.purchaseOrderItemId));
      if (qty === null) {
        setRefusal(t('qtyNotNumber', { product: productNames[row.purchaseOrderItemId] ?? '' }));
        return;
      }
      if (qty !== 0) lines.push({ purchaseOrderItemId: row.purchaseOrderItemId, qty });
    }
    if (lines.length === 0) {
      setRefusal(t('nothingEntered'));
      return;
    }
    submitting.current = true;
    setPending(true);
    setRefusal(null);
    try {
      const res = await api.post(`/shipping/legs/${leg.legId}/arrivals`, { handoverId: from, arrivedOn: day, lines });
      refresh();
      announce(t('arrivalRecorded'), res);
      onClose();
    } catch (err) {
      setRefusal(apiError(err, t('arrivalFailed')));
      submitting.current = false;
      setPending(false);
    }
  };

  return (
    <Dialog
      data-shipment-dialog="record-arrival"
      cardProps={{ 'data-testid': 'record-arrival-dialog' }}
      title={t('arrivalTitle')}
      description={t('arrivalHint')}
      onClose={onClose}
      busy={pending}
      onSubmit={(e) => void submit(e)}
      footer={
        <>
          <DialogCancel onClick={onClose} disabled={pending} label={tc('cancel')} />
          <DialogPrimary pending={pending} label={tc('save')} />
        </>
      }
      bodyClassName="space-y-4"
    >
      <div>
        <label className="mb-1 block text-sm font-medium text-foreground">
          {t('from')}
          <span aria-hidden="true" className="ms-1 text-destructive">*</span>
        </label>
        <Select
          name="handoverId"
          value={from}
          onChange={setFrom}
          placeholder={t('pickHandover')}
          options={open.map((h) => ({
            value: h.id,
            label: `${t('handoverN', { n: h.number })} · ${formatDate(h.handedOverOn)}`,
            hint: h.toCome === null ? t('arrivedSoFar', { arrived: h.arrived }) : t('toCome', { count: h.toCome }),
          }))}
        />
      </div>
      <div>
        <label className="mb-1 block text-sm font-medium text-foreground">
          {t('arrivedOnLabel')}
          <span aria-hidden="true" className="ms-1 text-destructive">*</span>
        </label>
        <DatePicker name="arrivedOn" required disableFuture value={day} onChange={(v) => setDay(v || businessToday())} />
      </div>
      <div>
        <div className="mb-1 grid grid-cols-[minmax(0,1fr)_4.5rem_6rem] gap-2 text-xs text-muted-foreground">
          <span>{t('product')}</span>
          <span className="text-end">{t('inUae')}</span>
          <span>{t('arrivedCol')}</span>
        </div>
        <ul className="space-y-2">
          {rows.map((row) => {
            const id = row.purchaseOrderItemId;
            return (
              <li key={id} className="grid grid-cols-[minmax(0,1fr)_4.5rem_6rem] items-center gap-2 border-t border-border pt-2">
                <label htmlFor={`arrival-qty-${id}`} className="min-w-0 text-sm">
                  <LatinText truncate className="font-medium text-foreground">{productNames[id] ?? '—'}</LatinText>
                </label>
                <span className="text-end text-sm tabular-nums text-muted-foreground">{formatNumber(row.atOrigin ?? 0)}</span>
                <input
                  id={`arrival-qty-${id}`}
                  data-testid="arrival-qty"
                  data-line={id}
                  inputMode="decimal"
                  autoComplete="off"
                  value={typed[id] ?? ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    setTyped((p) => ({ ...p, [id]: v }));
                    setRefusal(null);
                  }}
                  placeholder="0"
                  className={qtyInputClass}
                />
              </li>
            );
          })}
        </ul>
        <p data-testid="arrival-total" className="mt-2 text-xs text-muted-foreground">
          {t('arrivalTotal', { count: formatNumber(total) })}
        </p>
      </div>
      <DialogAlert message={refusal} />
    </Dialog>
  );
}

/**
 * All arrived: closes the handover. When its count says pieces are missing,
 * which products they were — exactly as many as are missing — become lost at
 * full landed cost (§2).
 */
export function AllArrivedDialog({
  leg,
  handover,
  productNames,
  onClose,
}: {
  leg: ShipmentLeg;
  handover: Handover;
  productNames: Record<string, string>;
  onClose: () => void;
}) {
  const t = useTranslations('handovers');
  const tc = useTranslations('common');
  const apiError = useApiError();
  const announce = useAnnounceStatusMove();
  const refresh = useRefreshShipment();
  const { formatNumber } = useNumberFormat();
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const missing = handover.toCome ?? 0;
  const rows = leg.lines.filter((l) => (l.atOrigin ?? 0) > 0);
  const given = rows.reduce((s, r) => s + (parseQty(typed[r.purchaseOrderItemId] ?? '') ?? 0), 0);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (submitting.current) return;
    const lost: { purchaseOrderItemId: string; qty: number }[] = [];
    for (const row of rows) {
      const qty = parseQty(typed[row.purchaseOrderItemId] ?? '');
      if (qty === null) {
        setRefusal(t('qtyNotNumber', { product: productNames[row.purchaseOrderItemId] ?? '' }));
        return;
      }
      if (qty !== 0) lost.push({ purchaseOrderItemId: row.purchaseOrderItemId, qty });
    }
    submitting.current = true;
    setPending(true);
    setRefusal(null);
    try {
      const res = await api.post(`/shipping/handovers/${handover.id}/all-arrived`, { on: businessToday(), lost });
      refresh();
      announce(t('allArrivedDone'), res);
      onClose();
    } catch (err) {
      setRefusal(apiError(err, t('allArrivedFailed')));
      submitting.current = false;
      setPending(false);
    }
  };

  return (
    <Dialog
      data-shipment-dialog="all-arrived"
      cardProps={{ 'data-testid': 'all-arrived-dialog' }}
      title={t('allArrivedTitle', { n: handover.number })}
      onClose={onClose}
      busy={pending}
      onSubmit={(e) => void submit(e)}
      footer={
        <>
          <DialogCancel onClick={onClose} disabled={pending} label={tc('cancel')} />
          <DialogPrimary pending={pending} label={t('allArrived')} />
        </>
      }
      bodyClassName="space-y-4"
    >
      {missing > 0 ? (
        <>
          <p data-testid="all-arrived-missing" className="rounded-lg bg-accent-50 px-3 py-2 text-sm text-accent-800">
            {t('missingSay', { pieces: handover.pieces ?? 0, arrived: handover.arrived, missing })}
          </p>
          <ul className="space-y-2">
            {rows.map((row) => {
              const id = row.purchaseOrderItemId;
              return (
                <li key={id} className="grid grid-cols-[minmax(0,1fr)_4.5rem_6rem] items-center gap-2">
                  <label htmlFor={`lost-qty-${id}`} className="min-w-0 text-sm">
                    <LatinText truncate className="font-medium text-foreground">{productNames[id] ?? '—'}</LatinText>
                  </label>
                  <span className="text-end text-sm tabular-nums text-muted-foreground">{formatNumber(row.atOrigin ?? 0)}</span>
                  <input
                    id={`lost-qty-${id}`}
                    data-testid="lost-qty"
                    inputMode="decimal"
                    autoComplete="off"
                    value={typed[id] ?? ''}
                    onChange={(e) => {
                      const v = e.target.value;
                      setTyped((p) => ({ ...p, [id]: v }));
                      setRefusal(null);
                    }}
                    placeholder="0"
                    className={qtyInputClass}
                  />
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-muted-foreground">{t('lostSoFar', { given: formatNumber(given), missing })}</p>
        </>
      ) : (
        <p data-testid="all-arrived-nothing-missing" className="text-sm text-foreground">
          {handover.pieces === null ? t('closeNoCount') : t('closeAllCame')}
        </p>
      )}
      <DialogAlert message={refusal} />
    </Dialog>
  );
}
