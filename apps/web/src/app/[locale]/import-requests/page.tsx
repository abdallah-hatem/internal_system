'use client';

import { useState } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, PackageSearch, Search, X } from 'lucide-react';

import { api } from '../../../lib/api';
import { useApiError } from '../../../lib/api-error';
import { useToast } from '../../../components/ui/toast';
import { AuthedImage } from '../../../components/ui/authed-image';
import { CustomerLink } from '../../../components/ui/entity-link';
import { Select } from '../../../components/ui/select';
import { formatDate } from '../../../lib/dates';

/**
 * What shops have asked us to bring in.
 *
 * The API for this existed before the screen did, so answering one meant
 * Swagger — which is a way of saying the feature was half-built: a shop could
 * ask and nobody could reply without a terminal.
 *
 * The photographs are the reason this screen is worth looking at rather than
 * reading as a list. A part number is often wrong or missing, and the picture
 * of the thing in somebody's hand is what actually identifies it. So they are
 * shown large enough to recognise a part from, not as thumbnails to be squinted
 * at.
 *
 * Three answers, and they are genuinely different:
 *
 * - **Looking for it** tells a shop the request was seen. It is not a decision,
 *   so it does not close the request and does not date it as decided.
 * - **Answered** is the reply itself, optionally naming the product it became so
 *   the shop can go from "you asked for this" straight to buying it.
 * - **Cannot source it** closes it, and needs a reason like any refusal.
 */

interface ImportRequest {
  id: string;
  productName: string;
  compatibilityText: string | null;
  quantity: string | null;
  supplierUrl: string | null;
  notes: string | null;
  status: string;
  decisionNote: string | null;
  photos: { id: string; url: string }[];
  product: { id: string; sku: string; name: string } | null;
  customer: { id: string; displayName: string; verified: boolean };
  createdAt: string;
}

export default function ImportRequestsPage() {
  const t = useTranslations('importRequests');
  const tc = useTranslations('common');
  const toast = useToast();
  const apiError = useApiError();
  const queryClient = useQueryClient();

  const { data: requests = [], isLoading } = useQuery<ImportRequest[]>({
    queryKey: ['import-requests'],
    queryFn: () => api.get('/import-requests').then((r) => r.data.data),
    refetchInterval: 60_000,
  });

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
          <PackageSearch className="mx-auto h-8 w-8 text-gray-300" />
          <p className="mt-3 text-sm text-gray-500">{t('empty')}</p>
        </div>
      )}

      <div className="space-y-4">
        {requests.map((request) => (
          <RequestCard
            key={request.id}
            request={request}
            onDone={() => queryClient.invalidateQueries({ queryKey: ['import-requests'] })}
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
  onDone,
  onError,
  onSuccess,
}: {
  request: ImportRequest;
  onDone: () => void;
  onError: (e: unknown) => void;
  onSuccess: (message: string) => void;
}) {
  const t = useTranslations('importRequests');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [note, setNote] = useState('');
  const [productId, setProductId] = useState('');
  const [needsReason, setNeedsReason] = useState(false);

  // Only fetched when the answer might name one, so opening the page does not
  // pull the whole product list per card.
  const [linking, setLinking] = useState(false);
  const { data: products = [] } = useQuery<any[]>({
    queryKey: ['products'],
    queryFn: () => api.get('/products', { params: { limit: 200 } }).then((r) => r.data.data ?? r.data),
    enabled: linking,
  });

  const answer = useMutation({
    mutationFn: (status: 'SOURCING' | 'ANSWERED' | 'DECLINED') =>
      api.post(`/import-requests/${request.id}/answer`, {
        status,
        decisionNote: note,
        ...(status === 'ANSWERED' && productId ? { productId } : {}),
      }),
    onSuccess: () => {
      onSuccess(t('sent'));
      onDone();
    },
    onError,
  });

  /** Every answer carries a reason — a reply with none tells the shop nothing. */
  const send = (status: 'SOURCING' | 'ANSWERED' | 'DECLINED') => {
    if (!note.trim()) return setNeedsReason(true);
    setNeedsReason(false);
    answer.mutate(status);
  };

  const busy = answer.isPending;
  const productList: any[] = Array.isArray(products) ? products : [];

  return (
    <div className="rounded-xl border border-gray-200 bg-white">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-100 px-5 py-4">
        <div className="min-w-0">
          <p className="font-semibold text-gray-900">{request.productName}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
            <CustomerLink id={request.customer.id} name={request.customer.displayName} />
            {!request.customer.verified && (
              <span className="rounded-full bg-amber-50 px-2 py-0.5 font-medium text-amber-800">
                {t('unverifiedShop')}
              </span>
            )}
            <span>{formatDate(request.createdAt, { includeTime: true })}</span>
          </div>
        </div>

        <span
          className={`rounded-full px-3 py-1 text-xs font-medium ${
            request.status === 'SOURCING'
              ? 'bg-blue-50 text-blue-800'
              : 'bg-amber-50 text-amber-800'
          }`}
        >
          {t(request.status === 'SOURCING' ? 'sourcing' : 'pending')}
        </span>
      </div>

      <div className="space-y-4 px-5 py-4">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {request.compatibilityText && (
            <Detail label={t('fits')} value={request.compatibilityText} />
          )}
          {request.quantity && <Detail label={t('quantity')} value={request.quantity} />}
          {request.notes && <Detail label={t('notes')} value={request.notes} />}
          {request.supplierUrl && (
            <div>
              <dt className="text-xs text-gray-500">{t('link')}</dt>
              <dd className="truncate">
                {/* `noreferrer` because this URL came from a customer, and the
                    referrer would tell wherever it points that the office
                    clicked it. */}
                <a
                  href={request.supplierUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary-600 hover:underline"
                >
                  {request.supplierUrl}
                </a>
              </dd>
            </div>
          )}
        </dl>

        {request.photos.length > 0 && (
          <div>
            <p className="mb-2 text-xs text-gray-500">{t('photos')}</p>
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {request.photos.map((photo) => (
                <li key={photo.id}>
                  {/* Large enough to recognise a part from. A part number is
                      often wrong or absent and this is what identifies it. */}
                  <AuthedImage
                    objectKey={photo.url.replace('/api/v1/files/download/', '')}
                    alt={request.productName}
                    className="aspect-square w-full rounded-lg border border-gray-200 object-cover"
                  />
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="space-y-3 border-t border-gray-100 px-5 py-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">{t('reply')}</label>
          <textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t('replyPlaceholder')}
            className="w-full resize-y rounded-lg border border-gray-200 px-3 py-2 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
          {needsReason && <p className="mt-1 text-sm text-red-600">{t('reasonNeeded')}</p>}
        </div>

        {linking && (
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              {t('nowStockedAs')}
            </label>
            <Select
              value={productId}
              onChange={setProductId}
              placeholder={t('pickProduct')}
              searchPlaceholder={tc('search')}
              clearable
              options={productList.map((p) => ({ value: p.id, label: p.name, hint: p.sku }))}
            />
          </div>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          {!linking && (
            <button
              type="button"
              disabled={busy}
              onClick={() => setLinking(true)}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {t('linkProduct')}
            </button>
          )}

          <button
            type="button"
            disabled={busy}
            onClick={() => send('DECLINED')}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            <X className="h-4 w-4" />
            {t('cannotSource')}
          </button>

          {request.status !== 'SOURCING' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => send('SOURCING')}
              className="inline-flex items-center gap-2 rounded-lg border border-primary-200 bg-primary-50 px-4 py-2 text-sm font-medium text-primary-700 hover:bg-primary-100 disabled:opacity-50"
            >
              <Search className="h-4 w-4" />
              {t('lookingForIt')}
            </button>
          )}

          <button
            type="button"
            disabled={busy}
            onClick={() => send('ANSWERED')}
            className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            {t('answer')}
          </button>
        </div>
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="text-gray-900">{value}</dd>
    </div>
  );
}
