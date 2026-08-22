'use client';

/**
 * Everything a cycle contains, at any point in its life.
 *
 * The list gave a cycle two fates: one still in the wizard opened the wizard,
 * and one past it opened a drawer of counts — "participants: 0", "purchases:
 * 1" — with no way to see what those were. A closed cycle, the one you most
 * want to look back at, showed the least.
 *
 * This page is readable in every status, and is where participants are added,
 * which nothing could do before: the API and the settlement maths both expected
 * them, and no screen ever created one. Every cycle therefore had none, and
 * settling reported "No participants found for this cycle".
 */

import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '../../../../../lib/api';
import { formatDate } from '../../../../../lib/dates';
import { Money } from '../../../../../components/ui/money';
import { Select } from '../../../../../components/ui/select';
import { useToast } from '../../../../../components/ui/toast';
import { selectOnFocus } from '../../../../../lib/select-on-focus';
import {
  ArrowLeft, Loader2, Users, ShoppingCart, Truck, Boxes, Plus, Trash2, Scale, Route,
} from 'lucide-react';

const num = (v: unknown) => Number(v ?? 0);

export default function CycleDetailsPage() {
  const t = useTranslations('cycles');
  const tc = useTranslations('common');
  const { cycleId: id, locale } = useParams<{ cycleId: string; locale: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const [adding, setAdding] = useState(false);

  const { data: cycle, isLoading } = useQuery<any>({
    queryKey: ['cycle', id],
    queryFn: () => api.get(`/cycles/${id}`).then((r) => r.data.data ?? r.data),
  });

  const { data: users = [] } = useQuery<any[]>({
    queryKey: ['users'],
    queryFn: () => api.get('/users').then((r) => r.data.data ?? r.data),
  });

  const { data: costing } = useQuery<any>({
    queryKey: ['landedCost', id],
    queryFn: () => api.get(`/costing/cycles/${id}/landed-cost`).then((r) => r.data),
    retry: false,
  });

  const addParticipant = useMutation({
    mutationFn: (body: any) => api.post(`/cycles/${id}/participants`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cycle', id] });
      queryClient.invalidateQueries({ queryKey: ['cycles'] });
      setAdding(false);
      addToast(t('participantAdded'), 'success');
    },
    onError: (e: any) =>
      addToast(
        e?.response?.data?.error?.message || e?.response?.data?.message || tc('error'),
        'error',
      ),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-gray-500">
        <Loader2 className="me-2 h-5 w-5 animate-spin" /> {tc('loading')}
      </div>
    );
  }
  if (!cycle) {
    return <div className="rounded-xl border border-gray-200 bg-white p-12 text-center text-gray-400">{tc('noData')}</div>;
  }

  const participants: any[] = cycle.participants ?? [];
  const orders: any[] = cycle.purchaseOrders ?? [];
  const legs: any[] = cycle.shippingLegs ?? [];
  const batches: any[] = cycle.inventoryBatches ?? [];
  const invested = participants.reduce((s, p) => s + num(p.contributionAmount), 0);
  const isClosed = cycle.status === 'CLOSED';

  return (
    <div className="space-y-6">
      <button
        onClick={() => router.push(`/${locale}/cycles`)}
        className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900"
      >
        <ArrowLeft className="h-4 w-4" /> {tc('back')}
      </button>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-mono text-2xl font-bold text-gray-900">{cycle.code}</h1>
          <p className="mt-1 text-sm text-gray-500">
            {cycle.originType === 'CHINA' ? t('china') : t('uaeDirect')} · {cycle.currency} ·{' '}
            {cycle.status}
          </p>
        </div>
        <button
          onClick={() => router.push(`/${locale}/settlements`)}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          <Scale className="h-4 w-4" /> {t('settlement')}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <Tile label={t('participants')} value={String(participants.length)} />
        <Tile label={t('invested')} value={<Money value={invested} />} />
        <Tile label={t('purchases')} value={String(orders.length)} />
        <Tile
          label={t('landedCost')}
          value={<Money value={num(costing?.totals?.totalLandedCostEgp)} />}
        />
      </div>

      {/* ── Participants ─────────────────────────────────────────────── */}
      <Card title={t('participants')} icon={<Users className="h-4 w-4 text-gray-400" />}>
        {participants.length === 0 && !adding && (
          <p className="pb-3 text-sm text-amber-700">
            {t('noParticipantsYet')}
          </p>
        )}

        {participants.length > 0 && (
          <Rows>
            {participants.map((p) => (
              <Row key={p.id}>
                <span className="font-medium text-gray-900">
                  {/* `partner` here is the User; the display name hangs off
                      their partner record. */}
                  {p.partner?.partner?.displayName ??
                    p.investor?.partner?.displayName ??
                    p.partner?.email ??
                    p.investor?.email ??
                    '—'}
                </span>
                <span className="text-xs text-gray-500">{p.participantType}</span>
                <span className="text-sm"><Money value={num(p.contributionAmount)} /></span>
                <span className="text-xs text-gray-500">
                  {p.customProfitPct != null ? `${p.customProfitPct}%` : t('byContribution')}
                </span>
                <span className="text-xs text-gray-400">
                  {p.investorFeePct ? `${t('fee')} ${p.investorFeePct}%` : ''}
                </span>
              </Row>
            ))}
          </Rows>
        )}

        {/* A closed cycle is history: it can be read, not rewritten. */}
        {!isClosed && (
          adding ? (
            <AddParticipantForm
              users={users}
              pending={addParticipant.isPending}
              onCancel={() => setAdding(false)}
              onSubmit={(body) => addParticipant.mutate(body)}
            />
          ) : (
            <button
              onClick={() => setAdding(true)}
              className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-primary-600 hover:text-primary-700"
            >
              <Plus className="h-4 w-4" /> {t('addParticipant')}
            </button>
          )
        )}
      </Card>

      <Card title={t('purchases')} icon={<ShoppingCart className="h-4 w-4 text-gray-400" />}>
        {orders.length === 0 ? <Empty>{tc('noData')}</Empty> : (
          <Rows>
            {orders.map((o) => (
              <Row key={o.id}>
                <span className="font-mono text-xs text-gray-500">{o.reference}</span>
                <span className="text-sm">{o.supplier?.name ?? '—'}</span>
                <span className="text-xs text-gray-400">{formatDate(o.orderedOn)}</span>
                <span className="text-sm">{o.currency} @ {num(o.fxRateToEgp)}</span>
                <span className="text-xs text-gray-500">{(o.items ?? []).length} {t('items')}</span>
              </Row>
            ))}
          </Rows>
        )}
      </Card>

      <Card title={t('shipping')} icon={<Truck className="h-4 w-4 text-gray-400" />}>
        {legs.length === 0 ? <Empty>{tc('noData')}</Empty> : (
          <Rows>
            {legs.map((l) => (
              <Row key={l.id}>
                <span className="text-sm">{l.origin} → {l.destination}</span>
                <span className="text-xs text-gray-500">{l.provider ?? '—'}</span>
                <span className="text-xs text-gray-400">
                  {l.departedOn ? formatDate(l.departedOn) : '—'}
                </span>
                <span className="text-xs text-gray-500">{l.costBasis}</span>
                <span className="text-sm"><Money value={num(l.amountEgp)} /></span>
              </Row>
            ))}
          </Rows>
        )}
      </Card>

      <Card title={t('inventory')} icon={<Boxes className="h-4 w-4 text-gray-400" />}>
        {batches.length === 0 ? <Empty>{tc('noData')}</Empty> : (
          <Rows>
            {batches.map((b) => (
              <Row key={b.id}>
                <span className="text-sm">{b.product?.name ?? '—'}</span>
                <span className="text-xs text-gray-500">{t('received')} {num(b.receivedQty)}</span>
                <span className="text-xs text-gray-500">{t('remaining')} {num(b.remainingQty)}</span>
                <span className="text-sm"><Money value={num(b.landedUnitCostEgp)} /></span>
                <span className="text-xs text-gray-400">{b.verificationStatus}</span>
              </Row>
            ))}
          </Rows>
        )}
      </Card>
    </div>
  );
}

function AddParticipantForm({
  users,
  pending,
  onCancel,
  onSubmit,
}: {
  users: any[];
  pending: boolean;
  onCancel: () => void;
  onSubmit: (body: any) => void;
}) {
  const t = useTranslations('cycles');
  const tc = useTranslations('common');
  const [type, setType] = useState('CORE_PARTNER');

  return (
    <form
      className="mt-4 space-y-4 rounded-lg border border-gray-200 bg-gray-50 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const userId = String(fd.get('userId') || '');
        const fee = String(fd.get('investorFeePct') || '');
        const custom = String(fd.get('customProfitPct') || '');
        onSubmit({
          participantType: type,
          // The field the server reads depends on the kind of participant.
          ...(type === 'TEMP_INVESTOR' ? { investorUserId: userId } : { partnerUserId: userId }),
          contributionAmount: Number(fd.get('contributionAmount') || 0),
          ...(custom ? { customProfitPct: Number(custom) } : {}),
          ...(type === 'TEMP_INVESTOR' && fee ? { investorFeePct: Number(fee) } : {}),
        });
      }}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">{t('participantType')}</label>
          <Select
            name="participantType"
            value={type}
            onChange={setType}
            options={[
              { value: 'CORE_PARTNER', label: t('corePartner') },
              { value: 'TEMP_INVESTOR', label: t('tempInvestor') },
            ]}
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">{t('person')}</label>
          <Select
            name="userId"
            required
            placeholder={t('person')}
            searchPlaceholder={tc('search')}
            options={users.map((u) => ({
              value: u.id,
              label: u.partner?.displayName ?? u.email,
              hint: u.email,
            }))}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">{t('contribution')}</label>
          <input
            name="contributionAmount" type="number" step="0.01" min="0" required
            placeholder="0.00" {...selectOnFocus}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">
            {t('customProfitPct')} <span className="text-xs font-normal text-gray-400">({tc('optional')})</span>
          </label>
          <input
            name="customProfitPct" type="number" step="0.01" min="0" max="100"
            placeholder={t('byContribution')} {...selectOnFocus}
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
        {type === 'TEMP_INVESTOR' && (
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">
              {t('investorFeePct')} <span className="text-xs font-normal text-gray-400">({tc('optional')})</span>
            </label>
            <input
              name="investorFeePct" type="number" step="0.01" min="0" max="100"
              placeholder="0" {...selectOnFocus}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
            <p className="mt-1 text-[10px] text-gray-400">{t('feeFromProfit')}</p>
          </div>
        )}
      </div>

      <div className="flex justify-end gap-3">
        <button type="button" onClick={onCancel} className="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100">
          {tc('cancel')}
        </button>
        <button
          type="submit" disabled={pending}
          className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50"
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          {tc('save')}
        </button>
      </div>
    </form>
  );
}

function Tile({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="mt-1 text-lg font-bold text-gray-900">{value}</p>
    </div>
  );
}

function Card({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900">{icon}{title}</h2>
      {children}
    </div>
  );
}

const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="py-6 text-center text-sm text-gray-400">{children}</p>
);
const Rows = ({ children }: { children: React.ReactNode }) => (
  <div className="divide-y divide-gray-100">{children}</div>
);
const Row = ({ children }: { children: React.ReactNode }) => (
  <div className="grid grid-cols-2 items-center gap-2 py-2 sm:grid-cols-5">{children}</div>
);
