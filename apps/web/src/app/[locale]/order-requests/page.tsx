'use client';

import { useMemo, useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Clock, Loader2, Store, X } from 'lucide-react';

import { api } from '../../../lib/api';
import { useApiError } from '../../../lib/api-error';
import { useToast } from '../../../components/ui/toast';
import { MoneyInput } from '../../../components/ui/money-input';
import { CustomerLink } from '../../../components/ui/entity-link';
import { formatDate } from '../../../lib/dates';

/**
 * Answering what the shops have asked for.
 *
 * Until this existed a request could only be answered with curl, which meant
 * the storefront could take orders nobody could fill. It is the other half of
 * the feature, not a nicety.
 *
 * Two things this screen is built around:
 *
 * **The hold is running.** Every pending request is sitting on stock, and the
 * clock is what makes answering urgent rather than optional. It is shown as
 * time remaining rather than a timestamp, because "expires in 4 hours" is what
 * decides whether to deal with it now.
 *
 * **Approving is editing.** Ten asked for, six in stock: approve six, say why,
 * and the shop sees both numbers. So the quantities are inputs, not labels,
 * and `couldGive` is beside each one — what could still be given INCLUDING
 * this request's own hold, so the request is not counted against itself.
 */

interface RequestLine {
  productId: string;
  name: string;
  sku: string;
  qtyRequested: string;
  unitPrice: string;
  couldGive: string;
}

interface PendingRequest {
  id: string;
  requestNo: string;
  customer: { id: string; displayName: string; type: string };
  note: string | null;
  createdAt: string;
  hold: { live: boolean; expiresAt: string | null };
  items: RequestLine[];
}

export default function OrderRequestsPage() {
  const t = useTranslations('orderRequests');
  const tc = useTranslations('common');
  const locale = useLocale();
  const toast = useToast();
  const apiError = useApiError();
  const queryClient = useQueryClient();

  const { data: requests = [], isLoading } = useQuery<PendingRequest[]>({
    queryKey: ['order-requests', 'pending'],
    queryFn: () => api.get('/order-requests/pending').then((r) => r.data.data),
    // These arrive while the office is looking at the screen, and each one is
    // holding stock. A minute-old list is a minute of someone waiting.
    refetchInterval: 60_000,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['order-requests'] });
    // An approval raises a confirmed order and moves stock, so the screens that
    // show either are now wrong.
    queryClient.invalidateQueries({ queryKey: ['sales'] });
    queryClient.invalidateQueries({ queryKey: ['inventory'] });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
        <p className="mt-1 text-sm text-gray-500">{t('subtitle')}</p>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-12 text-gray-500">
          <Loader2 className="me-2 h-5 w-5 animate-spin" /> {tc('loading')}
        </div>
      )}

      {!isLoading && requests.length === 0 && (
        <div className="rounded-xl border border-dashed border-gray-200 bg-white py-16 text-center">
          <Store className="mx-auto h-8 w-8 text-gray-300" />
          <p className="mt-3 text-sm text-gray-500">{t('empty')}</p>
        </div>
      )}

      <div className="space-y-4">
        {requests.map((request) => (
          <RequestCard
            key={request.id}
            request={request}
            locale={locale}
            onDone={invalidate}
            onError={(e) => toast.error(apiError(e, tc('error')))}
            onSuccess={(m) => toast.success(m)}
          />
        ))}
      </div>
    </div>
  );
}

function RequestCard({
  request,
  locale,
  onDone,
  onError,
  onSuccess,
}: {
  request: PendingRequest;
  locale: string;
  onDone: () => void;
  onError: (e: unknown) => void;
  onSuccess: (message: string) => void;
}) {
  const t = useTranslations('orderRequests');
  const tc = useTranslations('common');

  /**
   * The approved quantity per line, seeded from what was asked for.
   *
   * Seeded rather than empty because approving in full is the common case, and
   * a screen that makes the common case the most typing is a screen people
   * avoid.
   */
  const [lines, setLines] = useState(() =>
    Object.fromEntries(
      request.items.map((i) => [i.productId, { qty: i.qtyRequested, price: i.unitPrice }]),
    ),
  );
  const [decisionNote, setDecisionNote] = useState('');
  const [declining, setDeclining] = useState(false);

  const approve = useMutation({
    mutationFn: () =>
      api.post(`/order-requests/${request.id}/approve`, {
        lines: request.items.map((i) => ({
          productId: i.productId,
          qtyApproved: Number(lines[i.productId].qty || 0),
          unitPrice: Number(lines[i.productId].price || 0),
        })),
        decisionNote: decisionNote || undefined,
      }),
    onSuccess: (res) => {
      onSuccess(t('approved', { orderNo: res.data.data.orderNo }));
      onDone();
    },
    onError,
  });

  const decline = useMutation({
    mutationFn: () => api.post(`/order-requests/${request.id}/decline`, { decisionNote }),
    onSuccess: () => {
      onSuccess(t('declined'));
      onDone();
    },
    onError,
  });

  const busy = approve.isPending || decline.isPending;

  // Whether anything was changed from what the shop asked for. Used to warn
  // before approving something they did not ask for, and to require a note.
  const changed = useMemo(
    () =>
      request.items.some(
        (i) =>
          Number(lines[i.productId].qty) !== Number(i.qtyRequested) ||
          Number(lines[i.productId].price) !== Number(i.unitPrice),
      ),
    [lines, request.items],
  );

  const total = request.items.reduce(
    (sum, i) => sum + Number(lines[i.productId].qty || 0) * Number(lines[i.productId].price || 0),
    0,
  );

  return (
    <div className="rounded-xl border border-gray-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm font-semibold text-gray-900">
              {request.requestNo}
            </span>
            <CustomerLink id={request.customer.id} name={request.customer.displayName} />
          </div>
          <p className="mt-0.5 text-xs text-gray-500">
            {formatDate(request.createdAt, { includeTime: true })}
          </p>
        </div>

        <HoldClock expiresAt={request.hold.expiresAt} live={request.hold.live} />
      </div>

      {request.note && (
        <p className="border-b border-gray-100 bg-gray-50 px-5 py-3 text-sm text-gray-700">
          {request.note}
        </p>
      )}

      <div className="divide-y divide-gray-100">
        {request.items.map((item) => {
          const line = lines[item.productId];
          const short = Number(line.qty) > Number(item.couldGive);
          return (
            <div key={item.productId} className="flex flex-wrap items-end gap-3 px-5 py-4">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-gray-900">{item.name}</p>
                <p className="text-xs text-gray-500">
                  {item.sku} · {t('asked', { qty: item.qtyRequested })} ·{' '}
                  <span className={short ? 'font-medium text-red-600' : ''}>
                    {t('couldGive', { qty: item.couldGive })}
                  </span>
                </p>
              </div>

              <label className="w-24">
                <span className="mb-1 block text-xs text-gray-500">{t('approveQty')}</span>
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={line.qty}
                  onChange={(e) =>
                    setLines((s) => ({
                      ...s,
                      [item.productId]: { ...s[item.productId], qty: e.target.value },
                    }))
                  }
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-start text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </label>

              <label className="w-32">
                <span className="mb-1 block text-xs text-gray-500">{t('unitPrice')}</span>
                <MoneyInput
                  value={line.price}
                  onChange={(raw) =>
                    setLines((s) => ({
                      ...s,
                      [item.productId]: { ...s[item.productId], price: raw },
                    }))
                  }
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-start text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </label>
            </div>
          );
        })}
      </div>

      <div className="space-y-3 border-t border-gray-100 px-5 py-4">
        {changed && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {t('changedWarning')}
          </p>
        )}

        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">
            {t('noteToShop')}
          </label>
          <textarea
            rows={2}
            value={decisionNote}
            onChange={(e) => setDecisionNote(e.target.value)}
            placeholder={t('notePlaceholder')}
            className="w-full resize-y rounded-lg border border-gray-200 px-3 py-2 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-gray-600">
            {t('orderTotal')}{' '}
            <span className="font-semibold text-gray-900">
              {total.toLocaleString(locale === 'ar' ? 'ar-EG' : 'en-EG', {
                style: 'currency',
                currency: 'EGP',
              })}
            </span>
          </p>

          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (!decisionNote.trim()) {
                  // The API refuses a decline with no reason, and saying so
                  // here saves a round trip to learn it.
                  setDeclining(true);
                  return;
                }
                decline.mutate();
              }}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              <X className="h-4 w-4" />
              {t('decline')}
            </button>

            <button
              type="button"
              disabled={busy}
              onClick={() => approve.mutate()}
              className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50"
            >
              {approve.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              {t('approve')}
            </button>
          </div>
        </div>

        {declining && !decisionNote.trim() && (
          <p className="text-sm text-red-600">{t('declineNeedsReason')}</p>
        )}
      </div>
    </div>
  );
}

/**
 * How long the stock stays held.
 *
 * Time remaining, not a timestamp: "in 4 hours" is what decides whether to deal
 * with this now, and a date needs arithmetic done in the reader's head first.
 * Turns red inside six hours, and says plainly when it has already lapsed —
 * an expired hold does not close the request, it only means the units went back
 * on the shelf and approving will re-check them.
 */
function HoldClock({ expiresAt, live }: { expiresAt: string | null; live: boolean }) {
  const t = useTranslations('orderRequests');
  if (!expiresAt) return null;

  const hours = (new Date(expiresAt).getTime() - Date.now()) / 3_600_000;

  if (!live || hours <= 0) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-600">
        <Clock className="h-3.5 w-3.5" />
        {t('holdExpired')}
      </span>
    );
  }

  const urgent = hours <= 6;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
        urgent ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-800'
      }`}
    >
      <Clock className="h-3.5 w-3.5" />
      {hours < 1
        ? t('holdMinutes', { minutes: Math.max(1, Math.round(hours * 60)) })
        : t('holdHours', { hours: Math.round(hours) })}
    </span>
  );
}
