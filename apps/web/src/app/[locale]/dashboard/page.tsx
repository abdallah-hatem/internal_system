'use client';

import { useTranslations } from 'next-intl';
import { LayoutDashboard, TrendingUp, Package, AlertTriangle, DollarSign, ShoppingCart, Activity } from 'lucide-react';

const stats = [
  { key: 'revenue', value: '£ 2,450,000', change: '+12.5%', icon: DollarSign, color: 'bg-green-500' },
  { key: 'profit', value: '£ 680,000', change: '+8.2%', icon: TrendingUp, color: 'bg-blue-500' },
  { key: 'activeCycles', value: '3', change: '', icon: Activity, color: 'bg-purple-500' },
  { key: 'inventoryValue', value: '£ 1,850,000', change: '-2.1%', icon: Package, color: 'bg-orange-500' },
  { key: 'receivables', value: '£ 420,000', change: '+5.8%', icon: ShoppingCart, color: 'bg-yellow-500' },
  { key: 'lowStockAlerts', value: '7', change: '', icon: AlertTriangle, color: 'bg-red-500' },
];

export default function DashboardPage() {
  const t = useTranslations();

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

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <div key={stat.key} className="bg-white rounded-xl border border-gray-200 p-6 hover:shadow-md transition-shadow">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-500">{t(`dashboard.${stat.key}`)}</p>
                  <p className="text-2xl font-bold text-gray-900 mt-1">{stat.value}</p>
                  {stat.change && (
                    <p className={`text-sm mt-1 ${stat.change.startsWith('+') ? 'text-green-600' : 'text-red-600'}`}>
                      {stat.change}
                    </p>
                  )}
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
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Recent Activity</h3>
          <div className="space-y-3">
            {[
              { text: 'Cycle #028 status changed to Selling', time: '2 hours ago' },
              { text: 'Payment received from Honda Center - £45,000', time: '4 hours ago' },
              { text: 'New product request from Shop Al-Baraka', time: '6 hours ago' },
            ].map((item, i) => (
              <div key={i} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                <p className="text-sm text-gray-700">{item.text}</p>
                <span className="text-xs text-gray-400 whitespace-nowrap ms-4">{item.time}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Low Stock Alerts</h3>
          <div className="space-y-3">
            {[
              { name: 'Honda CBR Brake Pad', qty: 5, min: 20 },
              { name: 'Yamaha R1 Chain 520', qty: 8, min: 15 },
              { name: 'Kawasaki Z800 Oil Filter', qty: 3, min: 10 },
            ].map((item, i) => (
              <div key={i} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                <div>
                  <p className="text-sm font-medium text-gray-700">{item.name}</p>
                  <p className="text-xs text-red-500">{item.qty} remaining (min: {item.min})</p>
                </div>
                <AlertTriangle className="h-4 w-4 text-red-400" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
