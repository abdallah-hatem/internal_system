'use client';

import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { formatDate, timeAgo } from '../../../lib/dates';
import {
  LayoutDashboard, TrendingUp, Package, AlertTriangle, DollarSign, ShoppingCart,
  Activity, Loader2, Route,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────
interface DashboardData {
  totalRevenue: number;
  totalExpenses: number;
  netProfit: number;
  activeCycles: number;
  inventoryValue: number;
  receivables: number;
  lowStockAlerts: number;
  totalCustomers: number;
  totalProducts: number;
}

interface AuditLogEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  actor?: { email: string };
  createdAt: string;
}

interface TopProduct {
  productId: string;
  name: string;
  sku: string;
  totalQuantitySold: number;
}

// ─── Main Page ────────────────────────────────────────────────────────
export default function DashboardPage() {
  const t = useTranslations();

  const { data: dashData, isLoading: loadingDash } = useQuery({
    queryKey: ['analytics', 'dashboard'],
    queryFn: () => api.get('/analytics/dashboard').then((r) => r.data.data ?? r.data),
  });

  const { data: auditLogs = [], isLoading: loadingAudit } = useQuery({
    queryKey: ['audit-logs', 'dashboard'],
    queryFn: () => api.get('/audit-logs?limit=5').then((r) => r.data.data ?? r.data),
  });

  const { data: topProducts = [], isLoading: loadingProducts } = useQuery({
    queryKey: ['analytics', 'top-products', 'dashboard'],
    queryFn: () => api.get('/analytics/top-products?limit=5').then((r) => r.data.data ?? r.data),
  });

  const data: DashboardData = dashData ?? {
    totalRevenue: 0,
    totalExpenses: 0,
    netProfit: 0,
    activeCycles: 0,
    inventoryValue: 0,
    receivables: 0,
    lowStockAlerts: 0,
    totalCustomers: 0,
    totalProducts: 0,
  };

  const auditList: AuditLogEntry[] = Array.isArray(auditLogs) ? auditLogs : [];
  const productList: TopProduct[] = Array.isArray(topProducts) ? topProducts : [];

  const isLoading = loadingDash || loadingAudit || loadingProducts;

  const stats = [
    { key: 'revenue', value: `${data.totalRevenue?.toLocaleString() ?? 0} EGP`, icon: DollarSign, color: 'bg-green-500' },
    { key: 'netProfit', value: `${data.netProfit?.toLocaleString() ?? 0} EGP`, icon: TrendingUp, color: 'bg-blue-500' },
    { key: 'activeCycles', value: data.activeCycles?.toString() ?? '0', icon: Activity, color: 'bg-purple-500' },
    { key: 'inventoryValue', value: `${data.inventoryValue?.toLocaleString() ?? 0} EGP`, icon: Package, color: 'bg-orange-500' },
    { key: 'receivables', value: `${data.receivables?.toLocaleString() ?? 0} EGP`, icon: ShoppingCart, color: 'bg-yellow-500' },
    { key: 'lowStockAlerts', value: data.lowStockAlerts?.toString() ?? '0', icon: AlertTriangle, color: 'bg-red-500' },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t('dashboard.title')}</h1>
          <p className="text-sm text-gray-500 mt-1">Motorcycle Parts Business Overview</p>
        </div>
        <div className="flex items-center gap-2">
          <LayoutDashboard className="h-5 w-5 text-gray-400" />
        </div>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center justify-center py-12 text-gray-500">
          <Loader2 className="h-5 w-5 animate-spin me-2" /> {t('common.loading')}
        </div>
      )}

      {!isLoading && (
        <>
          {/* Stat Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {stats.map((stat) => {
              const Icon = stat.icon;
              return (
                <div key={stat.key} className="bg-white rounded-xl border border-gray-200 p-6 hover:shadow-md transition-shadow">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-gray-500">{t(`dashboard.${stat.key}`)}</p>
                      <p className="text-2xl font-bold text-gray-900 mt-1">{stat.value}</p>
                    </div>
                    <div className={`${stat.color} p-3 rounded-lg`}>
                      <Icon className="h-6 w-6 text-white" />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Recent Activity — from audit logs */}
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Recent Activity</h3>
              {auditList.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-4">{t('common.noData')}</p>
              ) : (
                <div className="space-y-3">
                  {auditList.map((item) => (
                    <div key={item.id} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium flex-shrink-0 ${
                          item.action === 'CREATE' ? 'bg-green-100 text-green-700' :
                          item.action === 'UPDATE' ? 'bg-blue-100 text-blue-700' :
                          item.action === 'DELETE' ? 'bg-red-100 text-red-700' :
                          'bg-gray-100 text-gray-600'
                        }`}>
                          {item.action}
                        </span>
                        <p className="text-sm text-gray-700 truncate">{item.entityType}</p>
                      </div>
                      <span className="text-xs text-gray-400 whitespace-nowrap ms-4 flex-shrink-0">{timeAgo(item.createdAt)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Top Products / Alerts */}
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                <Route className="h-5 w-5 text-gray-400" />
                Top Products
              </h3>
              {productList.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-4">{t('common.noData')}</p>
              ) : (
                <div className="space-y-3">
                  {productList.map((item) => (
                    <div key={item.productId} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                      <div>
                        <p className="text-sm font-medium text-gray-700">{item.name}</p>
                        <p className="text-xs text-gray-500">{item.sku}</p>
                      </div>
                      <span className="text-sm font-medium text-gray-900">{item.totalQuantitySold} sold</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
