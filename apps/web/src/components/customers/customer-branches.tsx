'use client';

import { useState, type FormEvent } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { useCan } from '@/lib/can';
import { branchesKey, type CustomerBranch, type CustomerBranches } from '@/lib/customer-branches';
import { Money } from '@/components/ui/money';
import { LatinText } from '@/components/ui/latin-text';
import { Dialog, DialogAlert, DialogCancel, DialogPrimary } from '@/components/ui/dialog';
import { InputField } from '@/components/ui/fields';
import { useToast } from '@/components/ui/toast';
import { Plus, Store } from '@/components/ui/icons';
import { SkeletonGroup, SkeletonText } from '@/components/ui/skeleton';

/** What the orders and the statement are narrowed to: a branch id, `none`, or all. */
export type BranchFilter = string | null;
export const NO_BRANCH = 'none';

/**
 * The Branches card on a customer's page (BUSINESS_LOGIC §7, owner
 * 2026-10-25, from the sample he picked): each branch with what it owes, the
 * orders on no branch, and a total that is the page's "Owes us". Picking a row
 * narrows the orders and the statement below to it.
 *
 * Every figure is the server's (`GET /customers/:id/branches`) — the total is
 * not summed here, so it cannot disagree with the balance tile.
 */
/**
 * The Branches card before the customer and its branches arrive, traced from
 * its usual state — a shop with no branches: the real title, the Add link's
 * place, and the empty note's two lines. Without it the card landed above the
 * orders once the customer loaded and pushed every row down (e2e TC-SKEL-08,
 * 2026-10-28). A shop with branches still grows by its table when they land.
 */
export function BranchesCardSkeleton() {
  const t = useTranslations('branches');
  const canEdit = useCan('customer.editBranches');
  return (
    <div data-testid="customer-branches-loading" className="rounded-xl border border-border bg-card p-5 print:hidden">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Store className="h-4 w-4 text-muted-foreground" />
          {t('title')}
        </h2>
        {canEdit && (
          <span aria-hidden="true" className="inline-flex min-h-11 items-center sm:min-h-0">
            <SkeletonText size="xs" className="w-12" />
          </span>
        )}
      </div>
      <SkeletonGroup className="py-2">
        <SkeletonText size="sm" className="w-40" />
        <SkeletonText size="xs" className="w-72 max-w-full" lineClassName="mt-0.5" />
        {/* The note wraps to a second line on a phone. */}
        <SkeletonText size="xs" className="w-40" lineClassName="sm:hidden" />
      </SkeletonGroup>
    </div>
  );
}

export function BranchesCard({
  customerId,
  data,
  selected,
  onSelect,
}: {
  customerId: string;
  data: CustomerBranches;
  selected: BranchFilter;
  onSelect: (filter: BranchFilter) => void;
}) {
  const t = useTranslations('branches');
  const tc = useTranslations('common');
  const canEdit = useCan('customer.editBranches');
  const apiError = useApiError();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  /** The branch being edited; `new` for one being added. */
  const [editing, setEditing] = useState<CustomerBranch | 'new' | null>(null);
  const [archiving, setArchiving] = useState<CustomerBranch | null>(null);

  // A branch's balance moves the customer's; refresh everything that reads them.
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: branchesKey(customerId) }),
      queryClient.invalidateQueries({ queryKey: ['customer', customerId] }),
    ]);

  const action = useMutation({
    mutationFn: ({ branch, verb }: { branch: CustomerBranch; verb: 'archive' | 'restore' | 'default' }) =>
      verb === 'default'
        ? api.put(`/customers/${customerId}/branches/${branch.id}`, {
            isDefault: true,
          })
        : api.post(`/customers/${customerId}/branches/${branch.id}/${verb}`),
    onSuccess: async (_r, { verb }) => {
      await refresh();
      setArchiving(null);
      toast(verb === 'archive' ? t('archived') : verb === 'restore' ? t('restored') : t('saved'), 'success');
    },
    onError: (err) => toast(apiError(err, t('saveFailed')), 'error'),
  });

  const hasNoBranchOrders = Number(data.noBranchOwed) !== 0 || data.branches.length === 0;
  const rowClass = (filter: BranchFilter) =>
    `cursor-pointer ${selected === filter ? 'bg-primary-50' : 'hover:bg-muted'}`;

  return (
    <div data-testid="customer-branches" className="rounded-xl border border-border bg-card p-5 print:hidden">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Store className="h-4 w-4 text-muted-foreground" />
          {t('title')}
        </h2>
        {canEdit && (
          <button
            type="button"
            data-testid="branch-add"
            onClick={() => setEditing('new')}
            className="inline-flex min-h-11 cursor-pointer items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700 sm:min-h-0"
          >
            <Plus className="h-3.5 w-3.5" /> {t('add')}
          </button>
        )}
      </div>

      {data.branches.length === 0 ? (
        <div className="py-2 text-sm">
          <p className="font-medium text-foreground">{t('emptyTitle')}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('emptyHint')}</p>
        </div>
      ) : (
        <>
          <div className="scrollbar-clean overflow-x-auto">
            <table className="w-full min-w-[34rem] text-sm">
              <thead>
                <tr className="border-b border-border text-xs font-medium text-muted-foreground">
                  <th className="py-2 pe-2 text-start">{t('column')}</th>
                  <th className="px-2 py-2 text-start">
                    {t('address')} · {t('phone')}
                  </th>
                  <th className="px-2 py-2 text-end">{t('orders')}</th>
                  <th className="px-2 py-2 text-end">{t('owes')}</th>
                  {canEdit && <th className="py-2 ps-2" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.branches.map((b) => (
                  <tr
                    key={b.id}
                    data-testid="branch-row"
                    className={rowClass(b.id)}
                    onClick={() => onSelect(selected === b.id ? null : b.id)}
                  >
                    <td className="py-2 pe-2 font-medium">
                      <LatinText>{b.name}</LatinText>
                      {b.isDefault && (
                        <span
                          data-testid="branch-default"
                          className="ms-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                        >
                          {t('defaultTag')}
                        </span>
                      )}
                      {b.archivedAt && (
                        <span className="ms-1.5 rounded-full bg-accent-50 px-1.5 py-0.5 text-[10px] font-medium text-accent-800">
                          {t('archivedTag')}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-xs text-muted-foreground">
                      {b.address || '—'} · {b.phone ? <LatinText dir="ltr">{b.phone}</LatinText> : '—'}
                    </td>
                    <td className="px-2 py-2 text-end tabular-nums">{b.orderCount}</td>
                    <td
                      data-testid="branch-owed"
                      className={`px-2 py-2 text-end font-medium tabular-nums ${Number(b.owed) > 0 ? 'text-destructive' : 'text-success'}`}
                    >
                      <Money value={b.owed} />
                    </td>
                    {canEdit && (
                      <td className="py-2 ps-2 text-end" onClick={(e) => e.stopPropagation()}>
                        <span className="inline-flex flex-wrap justify-end gap-x-3 gap-y-1 text-xs">
                          {!b.isDefault && !b.archivedAt && (
                            <button
                              type="button"
                              data-testid="branch-make-default"
                              disabled={action.isPending}
                              onClick={() => action.mutate({ branch: b, verb: 'default' })}
                              className="cursor-pointer text-primary-600 hover:text-primary-700 disabled:opacity-50"
                            >
                              {t('makeDefault')}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setEditing(b)}
                            className="cursor-pointer text-muted-foreground hover:text-foreground"
                          >
                            {tc('edit')}
                          </button>
                          {b.archivedAt ? (
                            <button
                              type="button"
                              disabled={action.isPending}
                              onClick={() => action.mutate({ branch: b, verb: 'restore' })}
                              className="cursor-pointer text-muted-foreground hover:text-foreground disabled:opacity-50"
                            >
                              {t('restore')}
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setArchiving(b)}
                              className="cursor-pointer text-muted-foreground hover:text-foreground"
                            >
                              {t('archive')}
                            </button>
                          )}
                        </span>
                      </td>
                    )}
                  </tr>
                ))}
                {hasNoBranchOrders && (
                  <tr
                    data-testid="branch-row-none"
                    className={rowClass(NO_BRANCH)}
                    onClick={() => onSelect(selected === NO_BRANCH ? null : NO_BRANCH)}
                  >
                    <td className="py-2 pe-2 text-muted-foreground">{t('noBranch')}</td>
                    <td className="px-2 py-2 text-xs text-muted-foreground">{t('noBranchHint')}</td>
                    <td className="px-2 py-2" />
                    <td className="px-2 py-2 text-end font-medium tabular-nums">
                      <Money value={data.noBranchOwed} />
                    </td>
                    {canEdit && <td />}
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr className="border-t border-border font-semibold">
                  <td className="py-2 pe-2" colSpan={3}>
                    {t('total')}
                  </td>
                  <td data-testid="branches-total" className="px-2 py-2 text-end tabular-nums">
                    <Money value={data.totalOwed} />
                  </td>
                  {canEdit && <td />}
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{t('hint')}</p>
        </>
      )}

      {editing && (
        <BranchDialog
          customerId={customerId}
          branch={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() =>
            void refresh().then(() => {
              setEditing(null);
              toast(t('saved'), 'success');
            })
          }
        />
      )}

      {archiving && (
        <Dialog
          title={t('archiveTitle', { name: archiving.name })}
          description={t('archiveBody')}
          size="sm"
          onClose={() => setArchiving(null)}
          busy={action.isPending}
          footer={
            <>
              <DialogCancel onClick={() => setArchiving(null)} label={tc('cancel')} />
              <DialogPrimary
                type="button"
                pending={action.isPending}
                onClick={() => action.mutate({ branch: archiving, verb: 'archive' })}
                label={t('archive')}
              />
            </>
          }
        >
          <span />
        </Dialog>
      )}
    </div>
  );
}

/** Add a branch, or change one: name, address, phone, and whether it is the default. */
function BranchDialog({
  customerId,
  branch,
  onClose,
  onSaved,
}: {
  customerId: string;
  branch: CustomerBranch | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations('branches');
  const tc = useTranslations('common');
  const tph = useTranslations('placeholders');
  const apiError = useApiError();
  const [refusal, setRefusal] = useState<string | null>(null);
  const [isDefault, setIsDefault] = useState(branch?.isDefault ?? false);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      branch
        ? api.put(`/customers/${customerId}/branches/${branch.id}`, body)
        : api.post(`/customers/${customerId}/branches`, body),
    onSuccess: onSaved,
    onError: (err) => setRefusal(apiError(err, t('saveFailed'))),
  });

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    setRefusal(null);
    save.mutate({
      name: String(fd.get('name') ?? ''),
      address: String(fd.get('address') ?? ''),
      phone: String(fd.get('phone') ?? ''),
      // Switching the default off only says so when it was the default.
      ...(isDefault ? { isDefault: true } : branch?.isDefault ? { isDefault: false } : {}),
    });
  };

  return (
    <Dialog
      title={branch ? t('edit') : t('add')}
      onClose={onClose}
      onSubmit={submit}
      busy={save.isPending}
      cardProps={{ 'data-testid': 'branch-dialog' }}
      footer={
        <>
          <DialogCancel onClick={onClose} label={tc('cancel')} />
          <DialogPrimary pending={save.isPending} label={tc('save')} />
        </>
      }
    >
      <div className="space-y-4">
        <InputField
          label={t('name')}
          name="name"
          required
          maxLength={80}
          defaultValue={branch?.name}
          placeholder={tph('branchName')}
        />
        <InputField
          label={t('address')}
          name="address"
          maxLength={200}
          defaultValue={branch?.address ?? ''}
          placeholder={tph('branchAddress')}
        />
        <InputField
          label={t('phone')}
          name="phone"
          type="tel"
          dir="ltr"
          maxLength={200}
          defaultValue={branch?.phone ?? ''}
          placeholder={tph('phone')}
        />
        {!branch?.archivedAt && (
          // Never on for you: which branch is the default is the owner's call (§7).
          // A button with role="switch", typed so it never submits the form.
          <button
            type="button"
            role="switch"
            aria-checked={isDefault}
            data-testid="branch-default-switch"
            onClick={() => setIsDefault(!isDefault)}
            className="flex w-full cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2.5 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span
              className={`relative mt-0.5 inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${
                isDefault ? 'bg-primary' : 'bg-muted-foreground/40'
              }`}
            >
              <span
                className={`inline-block size-3 rounded-full bg-background shadow transition-transform duration-150 ${
                  isDefault ? 'translate-x-3.5 rtl:-translate-x-3.5' : 'translate-x-0.5 rtl:-translate-x-0.5'
                }`}
              />
            </span>
            <span className="min-w-0 text-sm">
              <span className="block font-medium text-foreground">{t('isDefault')}</span>
              <span className="block text-xs text-muted-foreground">{t('defaultHint')}</span>
            </span>
          </button>
        )}
        <DialogAlert message={refusal} testId="branch-refusal" />
      </div>
    </Dialog>
  );
}
