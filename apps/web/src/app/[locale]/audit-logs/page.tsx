'use client';
import { NoMatch } from '@/components/ui/no-match';
import { useAllRecords } from '@/lib/list-all';
import { ListCapNotice } from '@/components/ui/list-cap-notice';

import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { useDateFormat } from '../../../lib/dates';
import { useState, useMemo, useEffect } from 'react';
import { Pagination, paginate, PAGE_SIZE } from '../../../components/ui/pagination';
import { Select } from '../../../components/ui/select';
import {
  ShieldCheck, Search, Eye, X,
  ChevronDown, ChevronRight,
} from 'lucide-react';
import { useCodeLabel } from '@/lib/labels';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadingStatus, Skeleton, SkeletonGroup, SkeletonText, repeat } from '@/components/ui/skeleton';

// ─── Types ────────────────────────────────────────────────────────────
interface AuditLog {
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

const ENTITY_TYPES = [
  'Product', 'Customer', 'SaleOrder', 'Payment', 'PurchaseOrder',
  'Shipment', 'InventoryBatch', 'Cycle', 'Settlement', 'User', 'LedgerEntry',
];

// ─── Skeletons ────────────────────────────────────────────────────────
// The log row and card below, traced: the 28px View button sets the row's
// height. Change one, change the other.
function AuditLogRowSkeleton() {
  return (
    <tr data-testid="skeleton-row">
      <td className="px-4 py-3"><SkeletonText size="xs" className="w-28" /></td>
      <td className="px-4 py-3"><SkeletonText className="w-40" /></td>
      <td className="px-4 py-3"><Skeleton className="h-5 w-16 rounded-full" /></td>
      <td className="px-4 py-3"><SkeletonText className="w-24" /></td>
      <td className="px-4 py-3"><SkeletonText size="xs" className="w-20" /></td>
      <td className="px-4 py-3"><Skeleton className="size-7 rounded-lg" /></td>
    </tr>
  );
}

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
    return (
      log.action?.toLowerCase().includes(q) ||
      log.entityType?.toLowerCase().includes(q) ||
      log.entityId?.toLowerCase().includes(q) ||
      log.actor?.email?.toLowerCase().includes(q)
    );
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

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
      </div>

      {/* Search + Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="text"
            placeholder={t('search')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full ps-10 pe-4 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>
        <Select
          className="w-full sm:w-52"
          value={entityFilter}
          onChange={setEntityFilter}
          clearable
          placeholder={tph('allRecordTypes')}
          searchPlaceholder={tph('searchTypes')}
          options={ENTITY_TYPES.map((type) => ({ value: type, label: codeLabel('entityType', type) }))}
        />
      </div>

      <ListCapNotice capped={capped} count={logs.length} />

      {/* Loading: the table's own header over skeleton rows, skeleton cards on a phone. */}
      {isLoading && <LoadingStatus />}

      {/* Desktop Table */}
        <div aria-busy={reloading} className={`hidden md:block bg-white rounded-xl border border-gray-200 overflow-hidden transition-opacity ${reloading ? 'opacity-60' : ''}`}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('timestamp')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('actor')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('action')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('entity')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{t('entityId')}</th>
                  <th className="text-start px-4 py-3 font-medium text-gray-600">{tc('actions')}</th>
                </tr>
              </thead>
              {isLoading ? (
                <SkeletonGroup as="tbody" className="divide-y divide-muted">
                  {repeat(PAGE_SIZE, (i) => <AuditLogRowSkeleton key={i} />)}
                </SkeletonGroup>
              ) : (
              <tbody className="divide-y divide-gray-100">
                {filtered.length === 0 ? (
                  <tr><td colSpan={6}>{emptyList}</td></tr>
                ) : (
                  paginated.map((log) => (
                    <tr key={log.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 text-gray-500 text-xs">{formatDate(log.occurredAt, { includeTime: true })}</td>
                      <td className="px-4 py-3 text-gray-700">{log.actor?.email ?? log.actorUserId ?? '—'}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${ACTION_COLORS[log.action] ?? 'bg-gray-100 text-gray-600'}`}>
                          {codeLabel('auditAction', log.action)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-600">{codeLabel('entityType', log.entityType)}</td>
                      <td className="px-4 py-3 text-gray-500 font-mono text-xs truncate max-w-[120px]">{log.entityId?.slice(0, 8)}...</td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => setViewingLog(log)}
                          className="p-1.5 text-gray-400 hover:text-primary-600 hover:bg-primary-50 rounded-lg transition-colors"
                          title={tc('view')}
                        >
                          <Eye className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              )}
            </table>
          </div>
        </div>

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
                <p className="text-sm font-medium text-gray-900 mb-1">{codeLabel('entityType', log.entityType)}</p>
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
        <Modal title={`${t('action')}: ${codeLabel('auditAction', detail.action)}`} onClose={() => setViewingLog(null)}>
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <Detail label={t('timestamp')} value={formatDate(detail.occurredAt, { includeTime: true })} />
              <Detail label={t('actor')} value={detail.actor?.email ?? detail.actorUserId ?? '—'} />
              <Detail label={t('action')} value={codeLabel('auditAction', detail.action)} />
              <Detail label={t('entity')} value={codeLabel('entityType', detail.entityType)} />
              <Detail label={t('entityId')} value={detail.entityId ?? '—'} />
              <Detail label={t('ipAddress')} value={detail.ipAddress ?? '—'} />
            </div>

            {/* Before / After JSON */}
            {(detail.beforeJson || detail.afterJson) && (
              <div className="space-y-3">
                {detail.beforeJson && (
                  <div>
                    <h4 className="text-sm font-medium text-gray-700 mb-1">{t('before')}</h4>
                    <pre className="bg-gray-50 rounded-lg p-3 text-xs text-gray-700 overflow-x-auto max-h-48 overflow-y-auto">
                      {JSON.stringify(detail.beforeJson, null, 2)}
                    </pre>
                  </div>
                )}
                {detail.afterJson && (
                  <div>
                    <h4 className="text-sm font-medium text-gray-700 mb-1">{t('after')}</h4>
                    <pre className="bg-gray-50 rounded-lg p-3 text-xs text-gray-700 overflow-x-auto max-h-48 overflow-y-auto">
                      {JSON.stringify(detail.afterJson, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            )}

            {detail.userAgent && (
              <div>
                <h4 className="text-sm font-medium text-gray-700 mb-1">{t('userAgent')}</h4>
                <p className="text-xs text-gray-500 break-all">{detail.userAgent}</p>
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 overflow-hidden">
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 shrink-0">
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="h-5 w-5" /></button>
        </div>
        <div className="p-6 overflow-y-auto min-h-0">{children}</div>
      </div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-gray-500 text-xs">{label}</span>
      <p className="font-medium text-gray-900">{value}</p>
    </div>
  );
}
