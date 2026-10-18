'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HandCoins, Plus, AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { useCan } from '@/lib/can';
import { useToast } from '@/components/ui/toast';
import { Money } from '@/components/ui/money';
import { EmptyState } from '@/components/ui/empty-state';
import { NoMatch } from '@/components/ui/no-match';
import { LenderLink } from '@/components/ui/entity-link';
import { ValidatedForm } from '@/components/ui/validated-form';
import { FormActions } from '@/components/ui/fields';
import { ENTITY_FORMS } from '@/components/entities/entity-forms';
import { Dialog } from '@/components/ui/dialog';
import { LoadingStatus, SkeletonGroup, SkeletonText, repeat } from '@/components/ui/skeleton';
import { DataTable } from '@/components/ui/data-table';
import { ListToolbar } from '@/components/ui/list-toolbar';

/**
 * Friends who pay a supplier for us and are repaid in pounds (BUSINESS_LOGIC
 * §18), with what each is still owed in his own currency. Created through the
 * shared entity form, so the `+` beside a lender picker asks for the same.
 */
interface LenderRow {
  id: string;
  name: string;
  phone: string | null;
  financingCount: number;
  owed: { currency: string; owed: string }[];
  overdue: boolean;
}

export default function LendersPage() {
  const t = useTranslations('lenders');
  const tc = useTranslations('common');
  const apiError = useApiError();
  const { addToast } = useToast();
  const queryClient = useQueryClient();
  const mayCreate = useCan('lender.create');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);

  const { data = [], isLoading } = useQuery<LenderRow[]>({
    queryKey: ['lenders'],
    queryFn: () => api.get('/lenders').then((r) => r.data.data ?? r.data),
  });

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post('/lenders', body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['lenders'] });
      setCreating(false);
      addToast(t('createSuccess'), 'success');
    },
    onError: (e) => addToast(apiError(e, t('createFailed')), 'error'),
  });

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? data.filter((l) => l.name.toLowerCase().includes(q) || (l.phone ?? '').includes(q)) : data;
  }, [data, search]);

  const empty =
    data.length === 0 ? (
      <EmptyState
        icon={HandCoins}
        title={t('emptyTitle')}
        description={t('emptyHint')}
        action={mayCreate ? { label: t('create'), onClick: () => setCreating(true) } : undefined}
      />
    ) : (
      <NoMatch onClear={() => setSearch('')} />
    );

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        {mayCreate && (
          <button
            type="button"
            data-testid="create-action"
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary-700"
          >
            <Plus className="h-4 w-4" /> {t('create')}
          </button>
        )}
      </div>

      <ListToolbar search={{ value: search, onChange: setSearch, placeholder: t('search') }} />

      {isLoading && <LoadingStatus />}
          {/* Desktop — the shared table (components/ui/data-table.tsx). Name,
              phone, orders paid for, still owed; the owed figures fit
              "-123,456.00 USD", one line per currency; the name takes the rest. */}
          <DataTable
            className="hidden md:block"
            skeletonRows={LENDER_SKELETONS}
            isLoading={isLoading}
            rows={rows}
            rowKey={(l) => l.id}
            rowProps={() => ({ 'data-testid': 'lender-row' })}
            empty={empty}
            columns={[
              {
                key: 'name', header: t('name'), width: 'auto', className: 'font-medium text-foreground',
                cell: (l: LenderRow) => (
                  // The name wraps to two lines and is cut after them; the badge keeps its line.
                  <span className="flex items-center gap-2" title={l.name}>
                    <span className="min-w-0 line-clamp-2 break-words"><LenderLink id={l.id} name={l.name} /></span>
                    {l.overdue && <OverdueBadge label={t('overdue')} />}
                  </span>
                ),
              },
              {
                key: 'phone', header: t('phone'), width: '10rem', kind: 'label', className: 'text-muted-foreground',
                title: (l: LenderRow) => l.phone, skeleton: { kind: 'text', share: 'w-3/4' },
                cell: (l: LenderRow) => (l.phone ? <span dir="ltr">{l.phone}</span> : '—'),
              },
              {
                key: 'orders', header: t('orders'), width: '8.5rem', kind: 'value', className: 'text-muted-foreground',
                skeleton: { kind: 'text', share: 'w-1/5' }, cell: (l: LenderRow) => l.financingCount,
              },
              {
                key: 'owed', header: t('owed'), width: '10rem', kind: 'value', align: 'end',
                skeleton: { kind: 'text', share: 'w-2/3' },
                cell: (l: LenderRow) => <OwedList owed={l.owed} none={t('nothingOwed')} />,
              },
            ]}
          />

          {/* Phone */}
          {isLoading ? (
            <SkeletonGroup className="space-y-3 md:hidden">
              {repeat(LENDER_SKELETONS, (i) => <LenderCardSkeleton key={i} />)}
            </SkeletonGroup>
          ) : (
          <div className="space-y-3 md:hidden">
            {rows.length === 0 ? (
              <div className="rounded-xl border border-border bg-card">{empty}</div>
            ) : (
              rows.map((l) => (
                <div key={l.id} data-testid="lender-card" className="rounded-xl border border-border bg-card p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <LenderLink id={l.id} name={l.name} className="font-medium text-foreground" truncate />
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {t('orders')}: <span className="tabular-nums">{l.financingCount}</span>
                        {l.phone && (
                          <>
                            {' · '}
                            <span dir="ltr">{l.phone}</span>
                          </>
                        )}
                      </p>
                    </div>
                    {l.overdue && <OverdueBadge label={t('overdue')} />}
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3 text-sm">
                    <span className="text-muted-foreground">{t('owed')}</span>
                    <OwedList owed={l.owed} none={t('nothingOwed')} />
                  </div>
                </div>
              ))
            )}
          </div>
          )}

      {creating && (
        <Dialog
          title={t('create')}
          onClose={() => setCreating(false)}
          footer={
            <FormActions form="lender-create-form"
              onCancel={() => setCreating(false)}
              cancelLabel={tc('cancel')}
              submitLabel={tc('create')}
              busy={create.isPending}
            />
          }
        >
          <ValidatedForm
            id="lender-create-form"
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate(ENTITY_FORMS.lender.toPayload(new FormData(e.currentTarget)));
            }}
          >
            <ENTITY_FORMS.lender.Fields />
          </ValidatedForm>
        </Dialog>
      )}
    </div>
  );
}

/** Lenders are a handful of friends, not a page of ten. */
const LENDER_SKELETONS = 4;

// The table's skeleton rows are drawn by DataTable from each column's
// `skeleton`; the lender card above is traced here: name, phone, count and
// one owed figure (one currency, the usual case). Change one, change the other.

function LenderCardSkeleton() {
  return (
    <div data-testid="skeleton-row" className="rounded-xl border border-border bg-card p-4">
      <div className="min-w-0">
        <SkeletonText size="base" className="w-36" />
        <SkeletonText size="xs" className="w-32" lineClassName="mt-0.5" />
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3">
        <SkeletonText className="w-16" />
        <SkeletonText className="w-24" />
      </div>
    </div>
  );
}

function OwedList({ owed, none }: { owed: { currency: string; owed: string }[]; none: string }) {
  if (owed.length === 0) return <span className="text-muted-foreground">{none}</span>;
  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      {owed.map((o) => (
        <Money key={o.currency} value={o.owed} currency={o.currency} className="font-semibold text-foreground" />
      ))}
    </span>
  );
}

function OverdueBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
      <AlertTriangle className="h-3 w-3" /> {label}
    </span>
  );
}
