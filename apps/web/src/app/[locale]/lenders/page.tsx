'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HandCoins, Loader2, Plus, Search, AlertTriangle } from 'lucide-react';
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
import { LenderModal } from '@/components/lenders/lender-dialogs';

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

      <div className="relative max-w-md">
        <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          placeholder={t('search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-lg border border-border py-2 pe-4 ps-10 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
        />
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="me-2 h-5 w-5 animate-spin" /> {tc('loading')}
        </div>
      ) : (
        <>
          {/* Desktop */}
          <div className="hidden overflow-hidden rounded-xl border border-border bg-card md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted">
                  <th className="px-4 py-3 text-start font-medium text-muted-foreground">{t('name')}</th>
                  <th className="px-4 py-3 text-start font-medium text-muted-foreground">{t('phone')}</th>
                  <th className="px-4 py-3 text-start font-medium text-muted-foreground">{t('orders')}</th>
                  <th className="px-4 py-3 text-end font-medium text-muted-foreground">{t('owed')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={4}>{empty}</td>
                  </tr>
                ) : (
                  rows.map((l) => (
                    <tr key={l.id} data-testid="lender-row" className="hover:bg-muted">
                      <td className="px-4 py-3 font-medium text-foreground">
                        <span className="inline-flex items-center gap-2">
                          <LenderLink id={l.id} name={l.name} />
                          {l.overdue && <OverdueBadge label={t('overdue')} />}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{l.phone ? <span dir="ltr">{l.phone}</span> : '—'}</td>
                      <td className="px-4 py-3 text-muted-foreground tabular-nums">{l.financingCount}</td>
                      <td className="px-4 py-3 text-end">
                        <OwedList owed={l.owed} none={t('nothingOwed')} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Phone */}
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
        </>
      )}

      {creating && (
        <LenderModal title={t('create')} onClose={() => setCreating(false)}>
          <ValidatedForm
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate(ENTITY_FORMS.lender.toPayload(new FormData(e.currentTarget)));
            }}
          >
            <ENTITY_FORMS.lender.Fields />
            <FormActions
              onCancel={() => setCreating(false)}
              cancelLabel={tc('cancel')}
              submitLabel={tc('create')}
              busy={create.isPending}
            />
          </ValidatedForm>
        </LenderModal>
      )}
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
