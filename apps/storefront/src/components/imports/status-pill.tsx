'use client';

import { useTranslations } from 'next-intl';

import type { ImportStatus } from './queries';

/**
 * The label on an import request.
 *
 * Not `requests/format`'s `StatusPill`, and the difference is not cosmetic:
 * that one is typed to an order request's four states, of which only PENDING
 * and DECLINED exist here. An import request can be SOURCING — we are out
 * looking for it — and ANSWERED, and neither has an equivalent there. Widening
 * that component to cover both vocabularies would let a caller pass a state the
 * other feature cannot have, and the type would stop catching it.
 *
 * The date helper, which has no such disagreement, is imported from there
 * rather than written again.
 */

const STATUS_STYLE: Record<ImportStatus, string> = {
  PENDING: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  SOURCING: 'bg-blue-50 text-blue-800 ring-blue-600/20',
  ANSWERED: 'bg-green-50 text-green-700 ring-green-600/20',
  DECLINED: 'bg-red-50 text-red-700 ring-red-600/20',
  // Grey, not red. A shop that changed its own mind has not been refused, and
  // colouring it like a refusal is the same lie the API used to tell by
  // recording it as DECLINED.
  CANCELLED: 'bg-gray-100 text-gray-600 ring-gray-500/20',
};

const STATUS_KEY: Record<
  ImportStatus,
  'pending' | 'sourcing' | 'answered' | 'declined' | 'withdrawn'
> = {
  PENDING: 'pending',
  SOURCING: 'sourcing',
  ANSWERED: 'answered',
  DECLINED: 'declined',
  CANCELLED: 'withdrawn',
};

export function ImportStatusPill({ status }: { status: ImportStatus }) {
  const t = useTranslations('imports');

  return (
    <span
      data-status={status}
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_STYLE[status]}`}
    >
      {t(STATUS_KEY[status])}
    </span>
  );
}
