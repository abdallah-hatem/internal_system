'use client';

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { api } from '../../lib/api';
import { useToast } from './toast';
import { useApiError } from '../../lib/api-error';
import { FormActions } from './fields';
import { ENTITY_FORMS, type EntityName } from '../entities/entity-forms';

/**
 * Create the thing a picker is missing, without leaving the form.
 *
 * Adding a product needed a category that did not exist yet, so the answer was:
 * abandon the half-filled form, go to Categories, create one, come back, start
 * again. The same dead end sits behind every picker in the app — supplier on a
 * purchase order, provider on a shipping leg, customer on a sale.
 *
 * A `+` beside the field opens **the entity's own create form** — the same one
 * its tab shows, from `entity-forms` — saves it, refreshes the list the picker
 * reads, and selects it. The half-filled form underneath is untouched.
 *
 * It renders the real form rather than a cut-down copy on purpose: a second
 * definition of the same form drifts on the first change, and then the `+`
 * quietly creates records missing a field the tab asks for.
 */

export type QuickCreateEntity = EntityName;

/**
 * It nests.
 *
 * The first version refused to — the product form's category picker got no `+`,
 * on the reasoning that a modal opening a modal is a stack. But the person
 * creating a product from a purchase line is in exactly the position the whole
 * feature exists for: they need a category, there isn't one, and the only way
 * out was to throw the purchase order away. Refusing to nest just moved the
 * dead end one level deeper.
 *
 * Nesting needs no depth counter. Every dialog portals to <body>, so they are
 * siblings in mount order, and at equal z-index the later one paints on top —
 * which is the inner one, always. An earlier version computed 60, 70, 80… per
 * depth; flattening it to a constant changed nothing any test could tell apart,
 * so it was machinery holding up nothing, and it is gone.
 *
 * The scale it sits in: page modals at 50, these at 60, the pickers at 90 (see
 * `popover.tsx` — they have to clear this), the toasts at 100.
 */

export function QuickCreate({
  entity,
  onCreated,
  title,
}: {
  entity: QuickCreateEntity;
  /** The saved record. Callers use its id to select what was just made. */
  onCreated: (record: any) => void;
  /** Tooltip override; defaults to the entity's own create label. */
  title?: string;
}) {
  const config = ENTITY_FORMS[entity];
  const t = useTranslations(config.namespace);
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* type="button": this sits inside another form, and a bare button would
          submit the half-filled record the person is in the middle of. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={title ?? t(config.titleKey)}
        aria-label={title ?? t(config.titleKey)}
        data-quick-create={entity}
        className="shrink-0 inline-flex h-[38px] w-[38px] items-center justify-center rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-gray-700 focus:outline-none focus:ring-2 focus:ring-primary-500"
      >
        <Plus className="h-4 w-4" />
      </button>

      {open && (
        <QuickCreateModal
          entity={entity}
          onClose={() => setOpen(false)}
          onCreated={(record) => {
            setOpen(false);
            onCreated(record);
          }}
        />
      )}
    </>
  );
}

function QuickCreateModal({
  entity,
  onClose,
  onCreated,
}: {
  entity: EntityName;
  onClose: () => void;
  onCreated: (record: any) => void;
}) {
  const config = ENTITY_FORMS[entity];
  const t = useTranslations(config.namespace);
  const tc = useTranslations('common');
  const toast = useToast();
  const apiError = useApiError();
  const queryClient = useQueryClient();
  const Fields = config.Fields;

  const create = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api.post(config.endpoint, payload).then((r) => r.data.data ?? r.data),
    onSuccess: async (record) => {
      // Refresh the list the picker reads BEFORE handing the id back, or the
      // caller selects an id the dropdown does not yet contain and the field
      // renders blank — created, and apparently not.
      await queryClient.invalidateQueries({ queryKey: config.queryKey });
      toast.success(tc('success'));
      onCreated(record);
    },
    onError: (err: any) => toast.error(apiError(err, tc('error'))),
  });

  /**
   * Rendered into `document.body`, not where it sits in the tree.
   *
   * The trigger lives inside the form it is helping to fill, so rendering here
   * would put a `<form>` inside a `<form>` — invalid markup, and the inner
   * submit bubbles to the outer one, saving the very record the person has not
   * finished. A portal puts it beside them instead of inside.
   */
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      data-quick-create-dialog={entity}
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
    >
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />
      <div className="relative flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl bg-white shadow-xl">
        <div className="flex shrink-0 items-center justify-between border-b border-gray-200 px-6 py-4">
          <h2 className="text-lg font-semibold text-gray-900">{t(config.titleKey)}</h2>
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            // The outer form is a portal away, not an ancestor, so nothing
            // bubbles — but stopping here keeps that true if the markup moves.
            e.stopPropagation();
            create.mutate(config.toPayload(new FormData(e.currentTarget)));
          }}
          data-quick-create-form={entity}
          className="space-y-4 overflow-y-auto p-6"
        >
          <Fields />
          <FormActions
            onCancel={onClose}
            cancelLabel={tc('cancel')}
            submitLabel={tc('create')}
            busy={create.isPending}
          />
        </form>
      </div>
    </div>,
    document.body,
  );
}

/**
 * A picker with its own `+`, laid out so the two line up.
 *
 * Every call site otherwise repeats the same flex wrapper, and the second copy
 * of a layout is where they start drifting apart.
 */
export function FieldWithQuickCreate({
  entity,
  onCreated,
  children,
}: {
  entity: QuickCreateEntity;
  onCreated: (record: any) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-end gap-2">
      <div className="min-w-0 flex-1">{children}</div>
      <QuickCreate entity={entity} onCreated={onCreated} />
    </div>
  );
}
