'use client';

import { useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Banknote, CheckCheck, CheckCircle2, Clock, PackageOpen, Plus, Trash2, Undo2 } from '@/components/ui/icons';
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
import { useToast } from '@/components/ui/toast';
import {
  fieldValue,
  parseQty,
  type FreightPayer,
  type FreightPayment,
  type Handover,
  type ShipmentLeg,
} from './shipment-model';

/**
 * A UAE leg in handovers (BUSINESS_LOGIC §1, §2, §18 — owner 2026-11-20,
 * mockup A approved): one box per lot handed to the forwarder, with its
 * arrivals under it, and the dialogs that record them. Every figure is the
 * server's (`legHandovers`): the freight a piece, whether it is final, what
 * each lot still has to bring, what of its freight is paid and what is still
 * to pay (§2, 2026-11-20, mockup approved). Nothing is worked out here.
 */

/** Which handover dialog is open — one value, so every close clears it. */
type Open =
  | { kind: 'handOver' }
  | { kind: 'arrival'; handoverId?: string }
  | { kind: 'allArrived'; handoverId: string }
  | { kind: 'undoAllArrived'; handoverId: string }
  | { kind: 'undoHandover'; handoverId: string }
  | { kind: 'undoArrival'; arrivalId: string }
  | { kind: 'payment'; handoverId: string }
  | { kind: 'undoPayment'; paymentId: string }
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
  payers = [],
}: {
  cycleId: string;
  leg: ShipmentLeg;
  productNames: Record<string, string>;
  frozen: boolean;
  /** Who a freight payment can name besides the business — the server's `freightPayers`. */
  payers?: FreightPayer[];
}) {
  const t = useTranslations('handovers');
  const { formatDate } = useDateFormat();
  const { formatNumber } = useNumberFormat();
  const may = useCan('shipment.handover') && !frozen;
  const locale = useLocale();
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
      {may && <PageRateMoved leg={leg} />}

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
              <FreightLines
                h={h}
                may={may}
                onPay={() => setOpen({ kind: 'payment', handoverId: h.id })}
                onUndo={(paymentId) => setOpen({ kind: 'undoPayment', paymentId })}
              />
              {h.arrivals.length > 0 && (
                <ul className="mt-2">
                  {h.arrivals.map((a) => (
                    <li
                      key={a.id}
                      data-testid="handover-arrival"
                      className="flex items-center justify-between gap-3 border-t border-dashed border-border py-1.5 ps-3 text-sm text-foreground/80"
                    >
                      {/* The day on its own line, the products under it, the count at the end:
                          on a phone the list wraps under the date instead of squeezing the count. */}
                      <span className="min-w-0">
                        <span data-testid="arrival-day" className="block">{t('arrivedOn', { date: formatDate(a.arrivedOn) })}</span>
                        <span data-testid="arrival-products" className="block text-xs text-muted-foreground">
                        {a.lines.map((l, i) => (
                          <span key={l.purchaseOrderItemId}>
                            {i > 0 && t('listSeparator')}
                            {/* Name and count isolated from each other and from the list,
                                so "SU8" and "×30" never run together in Arabic. */}
                            {/* Its direction is the reader's: an isolate holding only
                                isolates has no letters of its own to take one from. */}
                            <bdi dir={locale === 'ar' ? 'rtl' : 'ltr'}>
                              <LatinText>{productNames[l.purchaseOrderItemId] ?? '—'}</LatinText>{' '}
                              <bdi dir="ltr">×{n(l.qty)}</bdi>
                            </bdi>
                          </span>
                        ))}
                        </span>
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

      {open?.kind === 'handOver' && <HandOverDialog leg={leg} cycleId={cycleId} payers={payers} onClose={close} />}
      {open?.kind === 'payment' && byId(open.handoverId) && (
        <FreightPaymentDialog handover={byId(open.handoverId)!} payers={payers} onClose={close} />
      )}
      {open?.kind === 'undoPayment' && (
        <ConfirmActionDialog
          testId="undo-payment"
          title={t('undoPaymentTitle')}
          message={t('undoPaymentConfirm')}
          confirmLabel={t('undoPayment')}
          successMessage={t('undonePayment')}
          failMessage={t('undoFailed')}
          action={() => api.delete(`/shipping/freight-payments/${open.paymentId}`)}
          onClose={close}
        />
      )}
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

// ─── Freight paid in parts (§2, owner 2026-11-20, mockup approved) ─────────

const payBtn =
  'inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 sm:min-h-0';

/** A rate as typed on a payment: 14.80, 15.2345. */
function useRate() {
  const { formatNumber } = useNumberFormat();
  return (rate: string | number) => formatNumber(Number(rate), { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

/** "4,000.00 AED × 14.80", one left-to-right run in both languages. */
function AmountTimesRate({ amount, currency, rate }: { amount: string; currency: string; rate: string }) {
  const fmt = useRate();
  return (
    <bdi dir="ltr" className="tabular-nums">
      <Money value={amount} currency={currency} /> × {fmt(rate)}
    </bdi>
  );
}

/**
 * A handover's freight: a green row per payment ("Paid Nov 20 · by Mohammed
 * Youssef · 4,000.00 AED × 14.80 · 59,200.00 EGP"), an amber row for what is
 * still to pay at the rate it is counted at, with Record payment, and the
 * pill "Freight paid · 8,000.00 AED" once nothing is left.
 */
export function FreightLines({
  h,
  may,
  onPay,
  onUndo,
}: {
  h: Handover;
  may: boolean;
  onPay: () => void;
  onUndo: (paymentId: string) => void;
}) {
  const t = useTranslations('handovers');
  const { formatDate } = useDateFormat();
  const rates = useCurrencyRates();
  if (Number(h.freightAmount) === 0 && h.payments.length === 0) return null;
  const toPay = Number(h.freightToPay) > 0;
  const page = rates[h.freightCurrency];
  // "(today)" only when the rest is counted at the page's rate as it is now.
  const atPage = h.freightCurrency === 'EGP' || (page != null && Number(page) === Number(h.freightRateToEgp));
  const row =
    'grid grid-cols-1 gap-1 border-t border-border px-3 py-2 first:border-t-0 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center sm:gap-3';
  const owed = (p: FreightPayment) => p.owed && Number(p.owed.owed) > 0;

  return (
    <div data-testid="handover-freight" className="mt-2">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{t('freight')}</span>
        {!toPay && (
          <span
            data-testid="freight-paid-pill"
            className="whitespace-nowrap rounded-full bg-success/10 px-2.5 py-0.5 text-xs font-medium text-success"
          >
            {t.rich('freightPaidPill', { amount: () => <Money value={h.freightAmount} currency={h.freightCurrency} /> })}
          </span>
        )}
      </div>
      <ul className="overflow-hidden rounded-lg border border-border text-sm">
        {h.payments.map((p) => (
          <li key={p.id} data-testid="freight-payment" className={row}>
            <span className="flex min-w-0 items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
              <span data-testid="freight-payment-who" className="min-w-0">
                {t.rich('paidRow', {
                  date: formatDate(p.paidOn),
                  who: () => (p.paidBy ? <LatinText>{p.paidBy.name}</LatinText> : t('theBusiness')),
                })}
              </span>
            </span>
            <span className="text-foreground/80">
              <AmountTimesRate amount={p.amount} currency={h.freightCurrency} rate={p.rateToEgp} />
            </span>
            <span className="flex items-center gap-1 sm:justify-end">
              <b className="font-semibold tabular-nums">
                <Money value={p.amountEgp} />
              </b>
              {may && (
                <button
                  type="button"
                  data-testid="undo-payment"
                  aria-label={t('undoPayment')}
                  title={t('undoPayment')}
                  onClick={() => onUndo(p.id)}
                  className={quiet}
                >
                  <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </span>
          </li>
        ))}
        {toPay && (
          <li data-testid="freight-to-pay" className={cn(row, 'bg-accent-50')}>
            <span className="flex min-w-0 items-center gap-1.5">
              <Clock className="h-4 w-4 shrink-0 text-accent-700" aria-hidden="true" />
              <span>{t('toPayRow')}</span>
            </span>
            <span className="text-muted-foreground">
              <AmountTimesRate amount={h.freightToPay} currency={h.freightCurrency} rate={h.freightRateToEgp} />
              {atPage && <span className="ms-1 text-xs">{t('today')}</span>}
            </span>
            <span className="flex flex-wrap items-center gap-2 sm:justify-end">
              <span className="text-muted-foreground">
                ≈ <Money value={h.freightToPayEgp} />
              </span>
              {may && (
                <button type="button" data-testid="record-payment" onClick={onPay} className={payBtn}>
                  <Banknote className="h-3.5 w-3.5" aria-hidden="true" /> {t('recordPayment')}
                </button>
              )}
            </span>
          </li>
        )}
      </ul>
      {h.payments.filter(owed).map((p) => (
        <p key={p.id} data-testid="handover-owed" className="mt-1 text-xs text-muted-foreground">
          {t.rich('owedTo', {
            name: p.paidBy?.name ?? '—',
            amount: () => <Money value={p.owed!.owed} currency={p.owed!.currency} className="font-semibold text-foreground" />,
          })}
        </p>
      ))}
    </div>
  );
}

/**
 * The page's rate moved after the rest to pay was counted (§2, GUESS
 * 2026-11-20): a change on the Exchange rates page restates nothing by
 * itself (§22), so the card says so and offers to count it at today's rate.
 */
export function PageRateMoved({ leg }: { leg: ShipmentLeg }) {
  const t = useTranslations('handovers');
  const rates = useCurrencyRates();
  const fmt = useRate();
  const toast = useToast();
  const apiError = useApiError();
  const refresh = useRefreshShipment();
  const [pending, setPending] = useState(false);
  const moved = (leg.handovers?.toPayByCurrency ?? []).filter(
    (c) => c.currency !== 'EGP' && rates[c.currency] != null && Number(rates[c.currency]) !== Number(c.rateToEgp),
  );
  if (moved.length === 0) return null;
  const recount = async () => {
    if (pending) return;
    setPending(true);
    try {
      await api.post(`/shipping/legs/${leg.legId}/freight/recount`, {});
      refresh();
      toast.success(t('recounted'));
    } catch (err) {
      toast.error(apiError(err, t('recountFailed')));
    } finally {
      setPending(false);
    }
  };
  return (
    <div
      data-testid="page-rate-moved"
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-accent-200 bg-accent-50 px-3 py-2 text-xs text-accent-800"
    >
      <p className="min-w-0">
        {moved.map((c) => (
          <span key={c.currency} className="block">
            {t('pageMoved', { currency: c.currency, rate: fmt(rates[c.currency]), counted: fmt(c.rateToEgp) })}
          </span>
        ))}
      </p>
      <button type="button" data-testid="recount" disabled={pending} onClick={() => void recount()} className={btn}>
        {t('recount')}
      </button>
    </div>
  );
}

// ─── The forms ──────────────────────────────────────────────────────────────

interface Provider {
  id: string;
  name: string;
  contactPerson?: string | null;
}

const BUSINESS = 'business';
const CURRENCIES = ['AED', 'USD', 'EGP'];

/** "Paid by": the business, then the server's partners and this cycle's investors. */
function usePayerOptions(payers: FreightPayer[]) {
  const t = useTranslations('handovers');
  return useMemo(
    () => [
      { value: BUSINESS, label: t('paidByBusiness') },
      ...payers.map((p) => ({
        value: p.id,
        label: p.name,
        hint: p.kind === 'INVESTOR' ? t('investorTag') : undefined,
      })),
    ],
    [payers, t],
  );
}

/** What naming him as paying means: owed to a partner; an investor's is his contribution. */
function PayerHint({ payer, currency }: { payer: FreightPayer | undefined; currency: string }) {
  const t = useTranslations('handovers');
  if (!payer) return null;
  return (
    <p data-testid="handover-paid-by-hint" className="mt-1 text-xs text-muted-foreground">
      {payer.kind === 'PARTNER' ? t('paidByHint', { partner: payer.name, currency }) : t('paidByInvestorHint')}
    </p>
  );
}

/** The rate field and the line under it: "4000 AED × 14.8 = 59,200.00 EGP · Exchange rates page: …". */
function RateField({
  id,
  name,
  label,
  amount,
  currency,
  rate,
  onRate,
  hintTestId,
}: {
  id: string;
  name: string;
  label: string;
  amount: string;
  currency: string;
  rate: string;
  onRate: (v: string) => void;
  hintTestId: string;
}) {
  const t = useTranslations('handovers');
  const tph = useTranslations('placeholders');
  const rates = useCurrencyRates();
  const inEgp = Number(amount) * Number(rate);
  return (
    <>
      {currency !== 'EGP' && (
        <div className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2">
          <label htmlFor={id} className="text-xs text-muted-foreground">
            {label}
          </label>
          <input
            id={id}
            name={name}
            inputMode="decimal"
            dir="ltr"
            value={rate}
            onChange={(e) => onRate(e.target.value.replace(/[^\d.]/g, ''))}
            placeholder={tph('fxRate')}
            className="w-full min-w-0 rounded-lg border border-border bg-background px-3 py-1.5 text-start text-base tabular-nums focus:outline-none focus:ring-2 focus:ring-ring md:text-sm"
          />
        </div>
      )}
      <p data-testid={hintTestId} className="mt-1 text-xs text-muted-foreground">
        {/* The sum the form saves, at the rate typed here (owner 2026-11-20:
            "I typed 14.8 it shows 15.2 as current"). The Exchange rates
            page's rate follows only when it differs, named as that page's. */}
        {Number.isFinite(inEgp) && amount !== '' && (
          <>
            {currency !== 'EGP' && (
              <>
                {t.rich('freightTimesRate', {
                  amount,
                  currency,
                  rate,
                  ltr: (run) => <bdi dir="ltr">{run}</bdi>,
                })}{' '}
              </>
            )}
            <Money value={inEgp.toFixed(2)} />
          </>
        )}
        {currency !== 'EGP' && rates[currency] != null && Number(rate) !== Number(rates[currency]) && (
          <>
            {' · '}
            <CurrentRateHint currency={currency} rate={rates[currency]} />
          </>
        )}
      </p>
    </>
  );
}

/**
 * Hand over goods: the day, the forwarder, the lot's freight in full (amount
 * and currency), what is paid now (the full freight unless changed, at the
 * rate got — the Exchange rates page's, editable — and by whom), the pieces
 * when known. Paying less leaves the rest to pay later, its rate asked then
 * (§2, owner 2026-11-20, mockup approved). No products: they are counted on
 * arrival. Every refusal is the server's, shown in the dialog with what was
 * typed kept.
 */
export function HandOverDialog({
  leg,
  cycleId,
  payers = [],
  onClose,
}: {
  leg: ShipmentLeg;
  cycleId: string;
  payers?: FreightPayer[];
  onClose: () => void;
}) {
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
  const options = usePayerOptions(payers);

  const [day, setDay] = useState(() => businessToday());
  const [providerId, setProviderId] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('AED');
  const [typedRate, setTypedRate] = useState<string | null>(null);
  // Paid now follows the freight until it is typed in (owner's mockup: "default the full freight").
  const [typedPaid, setTypedPaid] = useState<string | null>(null);
  const [pieces, setPieces] = useState('');
  const [paidBy, setPaidBy] = useState(BUSINESS);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);

  const paid = typedPaid ?? amount;
  const rate = currency === 'EGP' ? '1' : (typedRate ?? (rates[currency] != null ? String(rates[currency]) : ''));
  const waiting = leg.handovers ? leg.handovers.stillInUae : (leg.atOrigin ?? 0);
  const payer = paidBy === BUSINESS ? undefined : payers.find((p) => p.id === paidBy);
  const rest = Number(amount) - Number(paid || 0);
  const paysNothing = paid.trim() === '' || Number(paid) === 0;

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (submitting.current) return;
    if (amount.trim() === '') {
      setRefusal(t('freightRequired'));
      return;
    }
    if (Number(paid || 0) > Number(amount)) {
      setRefusal(t('paidNowMore'));
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
        paidAmount: paysNothing ? 0 : Number(paid),
        ...(currency === 'EGP' || rate === '' || paysNothing ? {} : { freightRateToEgp: Number(rate) }),
        pieces: count,
        paidByUserId: paidBy === BUSINESS || paysNothing ? undefined : paidBy,
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

  const inputClass =
    'w-full min-w-0 rounded-lg border border-border bg-background px-3 py-2 text-start text-base focus:outline-none focus:ring-2 focus:ring-ring md:text-sm';

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
          {t('freightForLot')}
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
            className={inputClass}
          />
          <Select
            name="freightCurrency"
            placeholder={tph('chooseCurrency')}
            value={currency}
            onChange={(v) => {
              setCurrency(v);
              setTypedRate(null);
            }}
            options={CURRENCIES.map((c) => ({ value: c, label: c }))}
          />
        </div>
      </div>

      <div data-testid="paid-now" className="space-y-3 rounded-lg border border-dashed border-border p-3">
        <div>
          <label htmlFor="handover-paid-now" className="mb-1 block text-sm font-medium text-foreground">
            {t('paidNow')}
          </label>
          <MoneyInput
            id="handover-paid-now"
            name="paidAmount"
            value={paid}
            onChange={(v) => {
              setTypedPaid(v);
              setRefusal(null);
            }}
            placeholder={tph('money')}
            className={inputClass}
          />
          {!paysNothing && (
            <RateField
              id="handover-rate"
              name="freightRateToEgp"
              label={t('rateFor', { currency })}
              amount={paid}
              currency={currency}
              rate={rate}
              onRate={setTypedRate}
              hintTestId="handover-freight-hint"
            />
          )}
        </div>
        {!paysNothing && (
          <div>
            <label className="mb-1 block text-sm font-medium text-foreground">{t('paidBy')}</label>
            <Select name="paidBy" value={paidBy} placeholder={tph('choosePayer')} onChange={(v) => setPaidBy(v || BUSINESS)} options={options} />
            <PayerHint payer={payer} currency={currency} />
          </div>
        )}
        {amount !== '' && Number.isFinite(rest) && rest > 0 && (
          <p data-testid="left-to-pay" className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <Clock className="mt-px h-3.5 w-3.5 shrink-0 text-accent-700" aria-hidden="true" />
            <span>{t.rich('leftToPay', { amount: () => <Money value={rest.toFixed(2)} currency={currency} /> })}</span>
          </p>
        )}
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

      <DialogAlert message={refusal} />
    </Dialog>
  );
}

/**
 * Record freight payment (§2, owner 2026-11-20, mockup approved): the day it
 * was paid, how much (the rest still to pay unless changed — less leaves the
 * rest), the rate got (the Exchange rates page's, editable, with the shipped
 * hint "4000 AED × 15.5 = 62,000.00 EGP · Exchange rates page: 1 AED = 15.2
 * EGP"), and who paid. Refusals are the server's, coded.
 */
export function FreightPaymentDialog({
  handover,
  payers = [],
  onClose,
}: {
  handover: Handover;
  payers?: FreightPayer[];
  onClose: () => void;
}) {
  const t = useTranslations('handovers');
  const tc = useTranslations('common');
  const tph = useTranslations('placeholders');
  const apiError = useApiError();
  const toast = useToast();
  const refresh = useRefreshShipment();
  const rates = useCurrencyRates();
  const { formatNumber } = useNumberFormat();
  const options = usePayerOptions(payers);
  const currency = handover.freightCurrency;
  const toPay = handover.freightToPay;

  const [day, setDay] = useState(() => businessToday());
  const [amount, setAmount] = useState(() => String(Number(toPay)));
  const [typedRate, setTypedRate] = useState<string | null>(null);
  const [paidBy, setPaidBy] = useState(BUSINESS);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);

  const rate = currency === 'EGP' ? '1' : (typedRate ?? (rates[currency] != null ? String(rates[currency]) : ''));
  const payer = paidBy === BUSINESS ? undefined : payers.find((p) => p.id === paidBy);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (submitting.current) return;
    if (amount.trim() === '') {
      setRefusal(t('amountRequired'));
      return;
    }
    submitting.current = true;
    setPending(true);
    setRefusal(null);
    try {
      await api.post(`/shipping/handovers/${handover.id}/freight-payments`, {
        paidOn: day,
        amount: Number(amount),
        ...(currency === 'EGP' || rate === '' ? {} : { rateToEgp: Number(rate) }),
        paidByUserId: paidBy === BUSINESS ? undefined : paidBy,
      });
      refresh();
      toast.success(t('paymentRecorded'));
      onClose();
    } catch (err) {
      setRefusal(apiError(err, t('paymentFailed')));
      submitting.current = false;
      setPending(false);
    }
  };

  return (
    <Dialog
      data-shipment-dialog="freight-payment"
      cardProps={{ 'data-testid': 'freight-payment-dialog' }}
      title={t('paymentTitle')}
      description={
        <span data-testid="freight-payment-hint">
          {t.rich('paymentHint', {
            n: handover.number,
            amount: () => <Money value={toPay} currency={currency} />,
          })}
        </span>
      }
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
          {t('paidOn')}
          <span aria-hidden="true" className="ms-1 text-destructive">*</span>
        </label>
        <DatePicker name="paidOn" required disableFuture value={day} onChange={(v) => setDay(v || businessToday())} />
      </div>

      <div>
        <label htmlFor="freight-payment-amount" className="mb-1 block text-sm font-medium text-foreground">
          {t('amount')}
          <span aria-hidden="true" className="ms-1 text-destructive">*</span>
        </label>
        <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-2">
          <MoneyInput
            id="freight-payment-amount"
            name="amount"
            value={amount}
            onChange={(v) => {
              setAmount(v);
              setRefusal(null);
            }}
            placeholder={tph('money')}
            className="w-full min-w-0 rounded-lg border border-border bg-background px-3 py-2 text-start text-base focus:outline-none focus:ring-2 focus:ring-ring md:text-sm"
          />
          <span className="flex items-center rounded-lg border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
            {currency}
          </span>
        </div>
        <p data-testid="less-leaves-rest" className="mt-1 text-xs text-muted-foreground">
          {t('lessLeavesRest', { amount: formatNumber(Number(toPay), { maximumFractionDigits: 2 }) })}
        </p>
      </div>

      <div>
        <span className="mb-1 block text-sm font-medium text-foreground">{t('rateGot')}</span>
        <RateField
          id="freight-payment-rate"
          name="rateToEgp"
          label={t('rateFor', { currency })}
          amount={amount}
          currency={currency}
          rate={rate}
          onRate={setTypedRate}
          hintTestId="freight-payment-rate-hint"
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-foreground">{t('paidBy')}</label>
        <Select name="paidBy" value={paidBy} placeholder={tph('choosePayer')} onChange={(v) => setPaidBy(v || BUSINESS)} options={options} />
        <PayerHint payer={payer} currency={currency} />
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
  const tph = useTranslations('placeholders');
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
                  placeholder={tph('quantitySmall')}
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
  const tph = useTranslations('placeholders');
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
                    placeholder={tph('quantitySmall')}
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

/**
 * The leg's header while some of its freight is still to pay (§2, owner
 * 2026-11-20, mockup approved): "4,000.00 AED paid · 4,000.00 AED to pay",
 * then "≈ 120,000.00 EGP so far · to pay counted at 15.20 until paid".
 */
function LegFreightToPay({ s }: { s: NonNullable<ShipmentLeg['handovers']> }) {
  const t = useTranslations('handovers');
  const fmt = useRate();
  const list = (rows: { currency: string; amount: string }[]) => (
    <>
      {rows.map((c, i) => (
        <span key={c.currency}>
          {i > 0 && ' + '}
          <Money value={c.amount} currency={c.currency} />
        </span>
      ))}
    </>
  );
  return (
    <div data-testid="leg-cost" className="text-end">
      <p data-testid="leg-freight-paid" className="text-sm text-muted-foreground">
        {t.rich('paidAndToPay', {
          b: (chunks) => <b className="font-semibold text-foreground">{chunks}</b>,
          paid: () => (s.paidByCurrency.length > 0 ? list(s.paidByCurrency) : <Money value="0" currency={s.toPayByCurrency[0].currency} />),
          toPay: () => list(s.toPayByCurrency),
        })}
      </p>
      <p data-testid="leg-cost-so-far" className="text-xs text-muted-foreground">
        {t.rich('soFar', {
          amount: () => <Money value={s.freightEgp} />,
          rate: s.toPayByCurrency.map((c) => fmt(c.rateToEgp)).join(', '),
        })}
      </p>
    </div>
  );
}

/**
 * A handover leg's header figure (owner's coordinator, 2026-11-20): what was
 * actually paid — "10,200.00 AED paid · 141,270.00 EGP", each handover at its
 * own rate — and, while the freight is an estimate, what the whole leg comes
 * to at it, labelled as such. The leg's stored cost (that extrapolation in
 * EGP) is never shown bare beside the freight paid.
 */
export function HandoverLegCost({ leg }: { leg: ShipmentLeg }) {
  const t = useTranslations('handovers');
  const { formatNumber } = useNumberFormat();
  const s = leg.handovers;
  if (!s || s.handovers.length === 0) {
    return (
      <p data-testid="leg-cost" className="text-sm font-semibold text-accent-600">
        {t('nothingPaidYet')}
      </p>
    );
  }
  if (s.toPayByCurrency.length > 0) return <LegFreightToPay s={s} />;
  const foreign = s.freightByCurrency.filter((c) => c.currency !== 'EGP');
  return (
    <div data-testid="leg-cost" className="text-end">
      <p data-testid="leg-freight-paid" className="text-sm font-semibold text-foreground">
        {foreign.length > 0 ? (
          <>
            {t.rich('paid', {
              amount: () => (
                <>
                  {foreign.map((c, i) => (
                    <span key={c.currency}>
                      {i > 0 && ' + '}
                      <Money value={c.amount} currency={c.currency} />
                    </span>
                  ))}
                </>
              ),
            })}
            <span className="font-normal text-muted-foreground">
              {' · '}
              <Money value={s.freightEgp} />
            </span>
          </>
        ) : (
          t.rich('paid', { amount: () => <Money value={s.freightEgp} /> })
        )}
      </p>
      {!s.final && s.perPiece && s.covered < s.pieces && (
        <p data-testid="leg-cost-estimate" className="text-xs text-muted-foreground">
          {t.rich('wholeLegAtEstimate', {
            // From the freight itself, not the rounded per-piece figure: 10,200 × 400 ÷ 190.
            amount: () => (
              <Money
                value={((Number(foreign[0]?.amount ?? s.freightEgp) * s.pieces) / s.covered).toFixed(2)}
                currency={s.perPiece!.currency}
              />
            ),
            count: formatNumber(s.pieces),
          })}
        </p>
      )}
    </div>
  );
}

/**
 * A handover leg's one status (2026-11-20): handovers leave and arrive
 * together, so "partly departed" says nothing. Nothing handed over: not left;
 * handed over, nothing back yet: in transit; then partly arrived / arrived.
 */
export function handoverLegStatus(leg: ShipmentLeg): string {
  const s = leg.handovers;
  if (!s || s.handovers.length === 0) return 'PENDING';
  if (leg.delivered === 0 && leg.lost === 0) return 'IN_TRANSIT';
  return leg.status === 'ARRIVED' ? 'ARRIVED' : 'PARTLY_ARRIVED';
}
