'use client';

import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { formatDate } from '../../../lib/dates';
import { useState, useMemo, useEffect } from 'react';
import { Pagination, paginate, PAGE_SIZE } from '../../../components/ui/pagination';
import {
  ShieldCheck, Search, Eye, X, Loader2,
  ChevronDown, ChevronRight,
} from 'lucide-react';

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
  createdAt: string;
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

// ─── Main Page ────────────────────────────────────────────────────────
export default function AuditLogsPage() {
  const t = useTranslations('auditLogs');
  const tc = useTranslations('common');

  const [search, setSearch] = useState('');
  const [entityFilter, setEntityFilter] = useState('');
  const [viewingLog, setViewingLog] = useState<AuditLog | null>(null);
  const [page, setPage] = useState(1);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [search, entityFilter]);

  // ── Queries ───────────────────────────────────────────────────────
  const { data: logs = [], isLoading } = useQuery({
    queryKey: ['audit-logs', entityFilter],
    queryFn: () => {
      const params: Record<string, string> = {};
      if (entityFilter) params.entityType = entityFilter;
      return api.get('/audit-logs', { params }).then((r) => r.data.data ?? r.data);
    },
  });

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
        <select
          value={entityFilter}
          onChange={(e) => setEntityFilter(e.target.value)}
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
        >
          <option value="">{t('filter')}</option>
          {ENTITY_TYPES.map((type) => (
            <option key={type} value={type}>{type}</option>
          ))}
        </select>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center justify-center py-12 text-gray-500">
          <Loader2 className="h-5 w-5 animate-spin me-2" /> {tc('loading')}
        </div>
      )}

      {/* Desktop Table */}
      {!isLoading && (
        <div className="hidden md:block bg-white rounded-xl border border-gray-200 overflow-hidden">
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
              <tbody className="divide-y divide-gray-100">
                {filtered.length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-12 text-center text-gray-400">{t('noLogs')}</td></tr>
                ) : (
                  paginated.map((log) => (
                    <tr key={log.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3 text-gray-500 text-xs">{formatDate(log.createdAt, { includeTime: true })}</td>
                      <td className="px-4 py-3 text-gray-700">{log.actor?.email ?? log.actorUserId ?? '—'}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${ACTION_COLORS[log.action] ?? 'bg-gray-100 text-gray-600'}`}>
                          {log.action}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-600">{log.entityType}</td>
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
            </table>
          </div>
        </div>
      )}

      {/* Mobile Cards */}
      {!isLoading && (
        <div className="md:hidden space-y-3">
          {filtered.length === 0 ? (
            <div className="bg-white rounded-xl border border-gray-200 p-12 text-center text-gray-400">{t('noLogs')}</div>
          ) : (
            paginated.map((log) => (
              <div
                key={log.id}
                onClick={() => setViewingLog(log)}
                className="bg-white rounded-xl border border-gray-200 p-4 cursor-pointer hover:shadow-md transition-shadow"
              >
                <div className="flex items-center justify-between mb-2">
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${ACTION_COLORS[log.action] ?? 'bg-gray-100 text-gray-600'}`}>
                    {log.action}
                  </span>
                  <span className="text-xs text-gray-400">{formatDate(log.createdAt)}</span>
                </div>
                <p className="text-sm font-medium text-gray-900 mb-1">{log.entityType}</p>
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
        <Modal title={`${t('action')}: ${detail.action}`} onClose={() => setViewingLog(null)}>
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <Detail label={t('timestamp')} value={formatDate(detail.createdAt, { includeTime: true })} />
              <Detail label={t('actor')} value={detail.actor?.email ?? detail.actorUserId ?? '—'} />
              <Detail label={t('action')} value={detail.action} />
              <Detail label={t('entity')} value={detail.entityType} />
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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 sticky top-0 bg-white z-10">
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="h-5 w-5" /></button>
        </div>
        <div className="p-6">{children}</div>
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
