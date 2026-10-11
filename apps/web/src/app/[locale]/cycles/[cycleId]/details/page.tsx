'use client';
import { GoodsLocationCards } from '@/components/cycles/goods-location-cards';
import { LatinText } from '@/components/ui/latin-text';
import { useAllRecords } from '@/lib/list-all';

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
import { Money } from '../../../../../components/ui/money';
import { Select } from '../../../../../components/ui/select';
import { useToast } from '../../../../../components/ui/toast';
import { selectOnFocus } from '../../../../../lib/select-on-focus';
import { MoneyInput } from '../../../../../components/ui/money-input';
import {
  Loader2, Users, ShoppingCart, Boxes, Plus, Scale, TrendingUp,
} from 'lucide-react';

import { useApiError } from '../../../../../lib/api-error';
import { BackLink } from '../../../../../components/ui/back-link';
import { ContinueSetupLink } from '@/components/cycles/continue-setup';
import { CycleStatusButton } from '@/components/cycles/cycle-status-button';
import { useCodeLabel } from '../../../../../lib/labels';
import { useDateFormat } from '../../../../../lib/dates';
import { ShipmentPanel, useShipment } from '../../../../../components/shipment/ShipmentPanel';
import { ValidatedForm } from '@/components/ui/validated-form';
import { useCan } from '@/lib/can';
import { EmptyState } from '@/components/ui/empty-state';
import { useNumberFormat } from '@/lib/numbers';
import { PaidByFriend } from '@/components/lenders/paid-by-friend';

/**
 * One cycle's line from the analytics profitability figure — the same one the
 * cycle list and the Analytics page read, so profit is defined once (rule 11).
 * A cycle with nothing received yet has no line.
 */
interface CycleProfit {
  cycleCode: string;
  profit: number;
  totalRevenue: number;
  totalCost: number;
  lossesEgp?: number;
  supplierRefundsEgp?: number;
  roiPct: number | null;
}
const num = (v: unknown) => Number(v ?? 0);

export default function CycleDetailsPage() {
  const apiError = useApiError();
  const t = useTranslations('cycles');
  const tc = useTranslations('common');
  const { cycleId: id, locale } = useParams<{ cycleId: string; locale: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { addToast } = useToast();
  const [adding, setAdding] = useState(false);
  // An investor reads their own cycle and acts on nothing (R1b). The people
  // list only feeds the add-participant picker, and GET /users refuses an
  // investor, so it is not asked for unless that picker can be offered.
  const canAddParticipant = useCan('cycle.addParticipant');
  const canEditParticipant = useCan('cycle.editParticipant');
  const canListUsers = useCan('users.list');
  const canAddPurchase = useCan('purchase.create');
  const { formatNumber } = useNumberFormat();

  const { data: cycle, isLoading } = useQuery<any>({
    queryKey: ['cycle', id],
    queryFn: () => api.get(`/cycles/${id}`).then((r) => r.data.data ?? r.data),
  });

  const { items: users } = useAllRecords(['users'], '/users', undefined, {
    enabled: canListUsers && canAddParticipant,
  });

  const codeLabel = useCodeLabel();
  const { formatDate: formatLocalDate } = useDateFormat();
  const { data: shipment } = useShipment(id);
  const { data: profitability = [] } = useQuery<CycleProfit[]>({
    queryKey: ['analytics', 'cycle-profitability'],
    queryFn: () => api.get('/analytics/cycle-profitability').then((r) => r.data.data ?? r.data),
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
        apiError(e, tc('error')),
        'error',
      ),
  });

  /**
   * Give each partner an equal share of what the cycle actually cost.
   *
   * The three of them fund a cycle equally by default, but the amount is not
   * known until the goods and shipping are recorded — so this is the moment it
   * can be filled in rather than guessed at creation.
   *
   * Split to the piastre: thirds of 75,645.50 do not divide evenly, so the
   * last partner absorbs the residual and the parts re-sum to the total
   * exactly. Left uneven, capital returned at settlement would not match
   * capital put in.
   *
   * Temporary investors are untouched — they put in a specific amount that is
   * theirs, not a share of the whole.
   */
  const splitEqually = useMutation({
    mutationFn: async () => {
      const partners = participants.filter((p) => p.participantType === 'CORE_PARTNER');
      if (partners.length === 0) throw new Error('no partners on this cycle');

      const investors = participants
        .filter((p) => p.participantType !== 'CORE_PARTNER')
        .reduce((sum, p) => sum + num(p.contributionAmount), 0);

      // What the partners are funding: the cycle's cost less what friends
      // paid suppliers for it (§18, the server's `toFundEgp`) and less
      // whatever an investor already put in.
      const toFund = num(costing?.totals?.toFundEgp ?? costing?.totals?.landedEgp);
      const total = Math.max(toFund - investors, 0);
      const cents = Math.round(total * 100);
      const each = Math.floor(cents / partners.length);

      for (let i = 0; i < partners.length; i++) {
        const isLast = i === partners.length - 1;
        const amount = (isLast ? cents - each * (partners.length - 1) : each) / 100;
        await api.put(`/cycles/participants/${partners[i].id}`, {
          contributionAmount: amount,
        });
      }
      return total;
    },
    onSuccess: (total) => {
      queryClient.invalidateQueries({ queryKey: ['cycle', id] });
      queryClient.invalidateQueries({ queryKey: ['cycles'] });
      addToast(t('splitDone', { total: formatNumber(total, { maximumFractionDigits: 2 }) }), 'success');
    },
    onError: (e: any) =>
      addToast(
        e?.response?.data?.error?.message || e?.message || tc('error'),
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
    return (
      <div className="rounded-xl border border-gray-200 bg-white">
        <EmptyState
          title={t('notFoundTitle')}
          description={t('notFoundHint')}
          action={{ label: t('backToCycles'), href: '/cycles' }}
        />
      </div>
    );
  }

  const participants: any[] = cycle.participants ?? [];
  const orders: any[] = cycle.purchaseOrders ?? [];
  const batches: any[] = cycle.inventoryBatches ?? [];
  const invested = participants.reduce((s, p) => s + num(p.contributionAmount), 0);
  const isClosed = cycle.status === 'CLOSED';

  return (
    <div className="space-y-6">
      <BackLink onClick={() => router.push(`/${locale}/cycles`)} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-mono text-2xl font-bold text-gray-900">{cycle.code}</h1>
          <p className="mt-1 text-sm text-gray-500">
            {cycle.originType === 'CHINA' ? t('china') : t('uaeDirect')} · {cycle.currency} ·{' '}
            <span data-testid="cycle-status">{codeLabel('cycleStatus', cycle.status)}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ContinueSetupLink
            cycleId={cycle.id}
            status={cycle.status}
            className="inline-flex items-center gap-1 rounded-lg bg-primary-600 px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-700 touch-manipulation"
          />
          <CycleStatusButton cycleId={cycle.id} status={cycle.status} />
          <button
            type="button"
            onClick={() => router.push(`/${locale}/settlements`)}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            <Scale className="h-4 w-4" /> {t('settlement')}
          </button>
        </div>
      </div>

      {/* Where the goods are — layout A, chosen by the owner (I3). */}
      <GoodsLocationCards originType={cycle.originType} shipment={shipment} batches={batches} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <Tile label={t('participants')} value={String(participants.length)} />
        <Tile label={t('invested')} value={<Money value={invested} />} />
        <Tile label={t('purchases')} value={String(orders.length)} />
        <Tile
          label={t('landedCost')}
          value={<Money value={num(costing?.totals?.landedEgp)} />}
        />
      </div>

      <ProfitCard figure={(Array.isArray(profitability) ? profitability : []).find((p) => p.cycleCode === cycle.code)} />

      <ShipmentPanel cycle={cycle} />

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
                <span className="text-xs text-gray-500">{codeLabel('role', p.participantType)}</span>
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
        {!isClosed && canAddParticipant && (
          adding ? (
            <AddParticipantForm
              users={users}
              pending={addParticipant.isPending}
              onCancel={() => setAdding(false)}
              onSubmit={(body) => addParticipant.mutate(body)}
            />
          ) : (
            <div className="mt-3 flex flex-wrap items-center gap-4">
              <button
                onClick={() => setAdding(true)}
                className="inline-flex items-center gap-1.5 text-sm font-medium text-primary-600 hover:text-primary-700"
              >
                <Plus className="h-4 w-4" /> {t('addParticipant')}
              </button>
              {canEditParticipant &&
                participants.some((p) => p.participantType === 'CORE_PARTNER') &&
                num(costing?.totals?.landedEgp) > 0 && (
                  <button
                    onClick={() => splitEqually.mutate()}
                    disabled={splitEqually.isPending}
                    className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-600 hover:text-gray-900 disabled:opacity-50"
                  >
                    {splitEqually.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Scale className="h-4 w-4" />
                    )}
                    {t('splitEqually')}
                  </button>
                )}
            </div>
          )
        )}
      </Card>

      {/* A friend who paid a supplier for us (§18): who, how much, still owed. */}
      {orders.length > 0 && (
        <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
          <PaidByFriend
            cycleId={cycle.id}
            orders={orders.map((o) => ({ id: o.id, reference: o.reference, currency: o.currency }))}
            closed={['SETTLEMENT', 'CLOSED', 'CANCELLED'].includes(cycle.status)}
          />
        </div>
      )}

      <Card title={t('purchases')} icon={<ShoppingCart className="h-4 w-4 text-gray-400" />}>
        {orders.length === 0 ? (
          <EmptyState
            size="compact"
            icon={ShoppingCart}
            title={t('noPurchasesTitle')}
            description={t('noPurchasesHint')}
            action={canAddPurchase && !isClosed ? { label: t('goToPurchases'), href: '/purchases' } : undefined}
          />
        ) : (
          <Rows>
            {orders.map((o) => (
              <Row key={o.id}>
                <span className="font-mono text-xs text-gray-500">{o.reference}</span>
                <span className="text-sm"><LatinText>{o.supplier?.name ?? '—'}</LatinText></span>
                <span className="text-xs text-gray-400">{formatLocalDate(o.orderedOn)}</span>
                <span className="text-sm"><bdi dir="ltr">{o.currency} @ {num(o.fxRateToEgp)}</bdi></span>
                <span className="text-xs text-gray-500">{(o.items ?? []).length} {t('items')}</span>
              </Row>
            ))}
          </Rows>
        )}
      </Card>

      <Card title={t('inventory')} icon={<Boxes className="h-4 w-4 text-gray-400" />}>
        {batches.length === 0 ? (
          <EmptyState size="compact" icon={Boxes} title={t('noBatchesTitle')} description={t('noBatchesHint')} />
        ) : (
          <Rows>
            {batches.map((b) => (
              <Row key={b.id}>
                <span className="text-sm">{b.product?.name ?? '—'}</span>
                <span className="text-xs text-gray-500">{t('received')} {num(b.receivedQty)}</span>
                <span className="text-xs text-gray-500">{t('remaining')} {num(b.remainingQty)}</span>
                <span className="text-sm"><Money value={num(b.landedUnitCostEgp)} /></span>
                <span className="text-xs text-gray-400">{codeLabel('verificationStatus', b.verificationStatus)}</span>
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
    <ValidatedForm
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
      <div className="field-row grid grid-cols-1 gap-4 sm:grid-cols-2">
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
            /* Only people who can actually hold a share.
             *
             * This listed every user, including the storefront logins, and
             * picking one put a shop owner on a cycle — a share of the
             * partners' profit at settlement and every cycle notification
             * with everyone's figures in it. The server refuses it now; the
             * form should not have offered it in the first place.
             *
             * Same rule as `assertCanParticipate`, stated where the choice is
             * made rather than only where it is rejected. */
            options={users
              .filter(
                (u) =>
                  u.status === 'ACTIVE' &&
                  (u.role === 'CORE_PARTNER' || u.role === 'TEMP_INVESTOR'),
              )
              .map((u) => ({
                value: u.id,
                label: u.partner?.displayName ?? u.email,
                hint: u.email,
              }))}
          />
        </div>
      </div>

      <div className="field-row grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">{t('contribution')}</label>
          <MoneyInput
            name="contributionAmount" required placeholder="0.00"
            className="w-full rounded-lg border border-gray-200 px-3 py-2 text-end text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
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
    </ValidatedForm>
  );
}

/** Profit as the analytics figure states it — revenue less cost of goods sold, plus refunds, less losses. */
function ProfitCard({ figure }: { figure?: CycleProfit }) {
  const t = useTranslations('cycles');
  return (
    <div data-testid="cycle-profit-card" className="rounded-xl border border-border bg-card p-5">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
        <TrendingUp className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        {t('profit')}
      </h2>
      {!figure ? (
        <p className="text-sm text-muted-foreground">{t('profitNotYet')}</p>
      ) : (
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          <div>
            <dt className="text-xs text-muted-foreground">{t('profit')}</dt>
            <dd data-testid="cycle-profit-value" className={`text-lg font-bold ${figure.profit < 0 ? 'text-destructive' : 'text-foreground'}`}>
              <Money value={figure.profit} />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('roi')}</dt>
            <dd className="text-lg font-bold text-foreground">
              {figure.roiPct === null ? '—' : <span dir="ltr">{figure.roiPct}%</span>}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('profitRevenue')}</dt>
            <dd className="text-sm text-foreground"><Money value={figure.totalRevenue} /></dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('profitCost')}</dt>
            <dd className="text-sm text-foreground"><Money value={figure.totalCost} /></dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('profitLosses')}</dt>
            <dd data-testid="cycle-profit-losses" className="text-sm text-foreground"><Money value={figure.lossesEgp ?? 0} /></dd>
          </div>
        </dl>
      )}
    </div>
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

const Rows = ({ children }: { children: React.ReactNode }) => (
  <div className="divide-y divide-gray-100">{children}</div>
);
const Row = ({ children }: { children: React.ReactNode }) => (
  <div className="grid grid-cols-2 items-center gap-2 py-2 sm:grid-cols-5">{children}</div>
);
