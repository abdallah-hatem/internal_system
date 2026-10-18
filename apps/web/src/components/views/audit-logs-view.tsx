'use client';
import { NoMatch } from '@/components/ui/no-match';
import { useAllRecords } from '@/lib/list-all';
import { ListCapNotice } from '@/components/ui/list-cap-notice';

import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useDateFormat } from '@/lib/dates';
import { useState, useMemo, useEffect, type ReactNode } from 'react';
import { Pagination, paginate, PAGE_SIZE } from '@/components/ui/pagination';
import { Select } from '@/components/ui/select';
import { ListToolbar } from '@/components/ui/list-toolbar';
import { Eye } from 'lucide-react';
import { useCodeLabel } from '@/lib/labels';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadingStatus, Skeleton, SkeletonGroup, SkeletonText, repeat } from '@/components/ui/skeleton';
import { DataTable, CellBadge, type Column } from '@/components/ui/data-table';
import { Dialog } from '@/components/ui/dialog';
import { AuditChanges, auditChanges } from '@/components/audit/audit-changes';
import { AuditRecord, useAuditRecordName, type AuditRecordRef } from '@/components/audit/audit-record';
import { AUDIT_ENTITY_TYPES } from '@/components/audit/audit-entity-types';

// ─── Types ────────────────────────────────────────────────────────────
interface AuditLog extends AuditRecordRef {
  id: string;
  actorUserId?: string;
  actor?: { email: string; displayName?: string };
  action: string;
  entityType: string;
  entityId: string;
  beforeJson?: any;
  afterJson?: any;
  ipAddress?: string;
  userAgent?: string;
  occurredAt: string;
}

const ACTION_COLORS: Record<string, string> = {
  CREATE: 'bg-green-100 text-green-700',
  UPDATE: 'bg-blue-100 text-blue-700',
  DELETE: 'bg-red-100 text-red-700',
  READ: 'bg-gray-100 text-gray-600',
  REVERSE: 'bg-orange-100 text-orange-700',
  LOGIN: 'bg-purple-100 text-purple-700',
};

// ─── Skeletons ────────────────────────────────────────────────────────
// The table's skeleton rows are drawn by DataTable from each column's
// `skeleton`; the phone card below is traced by hand. Change one, change the other.

function AuditLogCardSkeleton() {
  return (
    <div data-testid="skeleton-row" className="bg-card rounded-xl border border-border p-4">
      <div className="flex items-center justify-between mb-2">
        <Skeleton className="h-5 w-16 rounded-full" />
        <SkeletonText size="xs" className="w-20" />
      </div>
      <SkeletonText className="w-28" lineClassName="mb-1" />
      <SkeletonText size="xs" className="w-40" />
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────
export default function AuditLogsPage() {
  const codeLabel = useCodeLabel();
  const recordName = useAuditRecordName();
  const { formatDate } = useDateFormat();
  const t = useTranslations('auditLogs');
  const tph = useTranslations('placeholders');
  const tc = useTranslations('common');

  const [search, setSearch] = useState('');
  const [entityFilter, setEntityFilter] = useState('');
  const [viewingLog, setViewingLog] = useState<AuditLog | null>(null);
  const [page, setPage] = useState(1);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [search, entityFilter]);

  // ── Queries ───────────────────────────────────────────────────────
  const { items: logs, capped, isLoading, reloading } = useAllRecords(
    ['audit-logs', entityFilter],
    '/audit-logs',
    entityFilter ? { entityType: entityFilter } : {},
    // The record type is filtered by the API, so a new one is a new query: keep
    // the rows on screen, dimmed, until it arrives, rather than back to skeletons.
    { keepPrevious: true },
  );

  const { data: logDetail } = useQuery({
    queryKey: ['audit-log', viewingLog?.id],
    queryFn: () =>
      api.get(`/audit-logs/${viewingLog!.id}`).then((r) => r.data.data ?? r.data),
    enabled: !!viewingLog,
  });

  // ── Derived ───────────────────────────────────────────────────────
  const logList: AuditLog[] = Array.isArray(logs) ? logs : [];

  const filtered = logList.filter((log) => {
    if (!search) return true;
    const q = search.toLowerCase();
    // What the reader sees: the record's name in either language, its type
    // and action in words — not the database id, which is never shown.
    return [
      log.action,
      codeLabel('auditAction', log.action),
      log.entityType,
      codeLabel('entityType', log.entityType),
      log.entityLabel,
      log.entityLabelAr,
      recordName(log),
      log.actor?.email,
    ].some((text) => text?.toLowerCase().includes(q));
  });

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paginated = useMemo(() => paginate(filtered, page), [filtered, page]);

  // Nothing at all says what goes here and offers the first one; nothing for
  // this search or filter says only that (UX #12).
  const emptyList =
    logList.length === 0 ? (
      <EmptyState
        title={t('emptyTitle')}
        description={t('emptyHint')}
      />
    ) : (
      <NoMatch filtered={!!entityFilter} onClear={() => { setSearch(''); setEntityFilter(''); }} />
    );

  const detail = (logDetail as AuditLog) ?? viewingLog;

  // ── Columns ───────────────────────────────────────────────────────
  // Timestamp, actor, action, record type, the record by name, actions
  // (components/ui/data-table.tsx). The timestamp fits "Dec 28, 2026, 12:59 PM";
  // a long action or record type is cut with the whole of it on hover; the
  // actor takes what is left.
  const columns: Column<AuditLog>[] = [
    {
      key: 'timestamp', header: t('timestamp'), width: '10.5rem', kind: 'value', className: 'text-gray-500 text-xs',
      skeleton: { kind: 'text', size: 'xs', share: 'w-3/4' },
      cell: (log) => formatDate(log.occurredAt, { includeTime: true }),
    },
    {
      key: 'actor', header: t('actor'), width: 'auto', kind: 'name', className: 'text-gray-700',
      title: (log) => log.actor?.email ?? log.actorUserId, cell: (log) => log.actor?.email ?? log.actorUserId ?? '—',
    },
    {
      key: 'action', header: t('action'), width: '10rem', skeleton: { kind: 'pill', share: 'w-2/3' },
      cell: (log) => (
        <CellBadge className={ACTION_COLORS[log.action] ?? 'bg-gray-100 text-gray-600'} title={codeLabel('auditAction', log.action)}>
          {codeLabel('auditAction', log.action)}
        </CellBadge>
      ),
    },
    {
      key: 'entity', header: t('entity'), width: '10rem', kind: 'label', className: 'text-gray-600',
      title: (log) => codeLabel('entityType', log.entityType), skeleton: { kind: 'text', share: 'w-2/3' },
      cell: (log) => codeLabel('entityType', log.entityType),
    },
    {
      key: 'record', header: t('record'), width: '14rem', kind: 'name', className: 'text-foreground',
      title: (log) => recordName(log), skeleton: { kind: 'text', share: 'w-3/4' },
      cell: (log) => <AuditRecord log={log} />,
    },
    {
      key: 'actions', header: tc('actions'), width: '5.5rem', skeleton: { kind: 'buttons', count: 1 },
      cell: (log) => (
        <button
          onClick={() => setViewingLog(log)}
          className="p-1.5 text-gray-400 hover:text-primary-600 hover:bg-primary-50 rounded-lg transition-colors"
          title={tc('view')}
        >
          <Eye className="h-4 w-4" />
        </button>
      ),
    },
  ];

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
      </div>

      {/* Search + Filters */}
      <ListToolbar search={{ value: search, onChange: setSearch, placeholder: t('search') }}>
        <Select
          className="w-full sm:w-52"
          value={entityFilter}
          onChange={setEntityFilter}
          clearable
          placeholder={tph('allRecordTypes')}
          searchPlaceholder={tph('searchTypes')}
          options={AUDIT_ENTITY_TYPES.map((type) => ({ value: type, label: codeLabel('entityType', type) }))}
        />
      </ListToolbar>

      <ListCapNotice capped={capped} count={logs.length} />

      {/* Loading: the table's own header over skeleton rows, skeleton cards on a phone. */}
      {isLoading && <LoadingStatus />}

      {/* Desktop Table — the shared one (components/ui/data-table.tsx). */}
      <DataTable
        className="hidden md:block"
        columns={columns}
        rows={paginated}
        rowKey={(log) => log.id}
        isLoading={isLoading}
        stale={reloading}
        empty={emptyList}
      />

      {/* Mobile Cards */}
      {isLoading && (
        <SkeletonGroup className="md:hidden space-y-3">
          {repeat(PAGE_SIZE, (i) => <AuditLogCardSkeleton key={i} />)}
        </SkeletonGroup>
      )}
      {!isLoading && (
        <div aria-busy={reloading} className={`md:hidden space-y-3 transition-opacity ${reloading ? 'opacity-60' : ''}`}>
          {filtered.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200">{emptyList}</div>
          ) : (
            paginated.map((log) => (
              <div
                key={log.id}
                onClick={() => setViewingLog(log)}
                className="bg-white rounded-xl border border-gray-200 p-4 cursor-pointer hover:shadow-md transition-shadow"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${ACTION_COLORS[log.action] ?? 'bg-gray-100 text-gray-600'}`}>
                    {codeLabel('auditAction', log.action)}
                  </span>
                  <span className="text-xs text-gray-400">{formatDate(log.occurredAt)}</span>
                </div>
                <p className="text-sm font-medium text-foreground mb-1">
                  <AuditRecord log={log} />
                </p>
                <p className="text-xs text-muted-foreground mb-1">{codeLabel('entityType', log.entityType)}</p>
                <p className="text-xs text-gray-500">{log.actor?.email ?? '—'}</p>
              </div>
            ))
          )}
        </div>
      )}

      {/* Pagination */}
      {filtered.length > 0 && (
        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} totalItems={filtered.length} />
      )}

      {/* ─── View Log Detail ─────────────────────────────────────── */}
      {viewingLog && detail && (
        <Dialog title={`${t('action')}: ${codeLabel('auditAction', detail.action)}`} onClose={() => setViewingLog(null)}>
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <Detail label={t('timestamp')} value={formatDate(detail.occurredAt, { includeTime: true })} />
              <Detail label={t('actor')} value={detail.actor?.email ?? detail.actorUserId ?? '—'} />
              <Detail label={t('action')} value={codeLabel('auditAction', detail.action)} />
              <Detail label={t('entity')} value={codeLabel('entityType', detail.entityType)} />
              <Detail label={t('record')} value={<AuditRecord log={detail} />} />
              <Detail label={t('ipAddress')} value={detail.ipAddress ?? '—'} />
            </div>

            {/* What changed, field by field — not the raw before/after JSON. */}
            {auditChanges(detail.beforeJson, detail.afterJson).length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-foreground mb-2">
                  {detail.beforeJson && detail.afterJson
                    ? t('changes')
                    : detail.afterJson
                      ? t('valuesSet')
                      : t('valuesRemoved')}
                </h4>
                <AuditChanges entityType={detail.entityType} before={detail.beforeJson} after={detail.afterJson} />
              </div>
            )}

            {detail.userAgent && (
              <div>
                <h4 className="text-sm font-medium text-gray-700 mb-1">{t('userAgent')}</h4>
                <p className="text-xs text-gray-500 break-all">{detail.userAgent}</p>
              </div>
            )}
          </div>
        </Dialog>
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <span className="text-gray-500 text-xs">{label}</span>
      <p className="font-medium text-gray-900">{value}</p>
    </div>
  );
}
