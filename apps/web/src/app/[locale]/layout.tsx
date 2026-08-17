'use client';

import { useTranslations, useLocale } from 'next-intl';
import { useRouter, usePathname } from '../../i18n/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth-context';
import {
  LayoutDashboard, Route, ShoppingCart, Truck, Package, Boxes,
  BadgePercent, Users, CreditCard, BookOpen, BarChart3,
  Bell, ShieldCheck, Settings, Menu, X, ChevronDown,
  Globe, LogOut
} from 'lucide-react';

const navItems = [
  { key: 'dashboard', icon: LayoutDashboard, href: '/dashboard' },
  { key: 'cycles', icon: Route, href: '/cycles' },
  { key: 'purchases', icon: ShoppingCart, href: '/purchases' },
  { key: 'shipments', icon: Truck, href: '/shipments' },
  { key: 'products', icon: Package, href: '/products' },
  { key: 'inventory', icon: Boxes, href: '/inventory' },
  { key: 'sales', icon: BadgePercent, href: '/sales' },
  { key: 'customers', icon: Users, href: '/customers' },
  { key: 'payments', icon: CreditCard, href: '/payments' },
  { key: 'ledger', icon: BookOpen, href: '/ledger' },
  { key: 'partners', icon: Users, href: '/partners' },
  { key: 'analytics', icon: BarChart3, href: '/analytics' },
  { key: 'notifications', icon: Bell, href: '/notifications' },
  { key: 'auditLogs', icon: ShieldCheck, href: '/audit-logs' },
  { key: 'settings', icon: Settings, href: '/settings' },
];

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = useTranslations('nav');
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const { user, isLoading } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);

  const isLoginPage = pathname.includes('/login');

  useEffect(() => {
    if (!isLoading && !user && !isLoginPage) {
      router.push('/login');
    }
  }, [user, isLoading, router, isLoginPage]);

  const switchLocale = (newLocale: string) => {
    document.cookie = `locale=${newLocale};path=/;max-age=31536000`;
    window.location.href = `/${newLocale}${pathname}`;
  };

  // Login page renders without chrome
  if (isLoginPage) {
    return <>{children}</>;
  }

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50" dir={locale === 'ar' ? 'rtl' : 'ltr'}>
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 bg-black/50 z-40 lg:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar */}
      <aside className={`
        fixed lg:static inset-y-0 ${locale === 'ar' ? 'right-0' : 'left-0'}
        w-64 bg-white border-e border-gray-200 z-50
        transform transition-transform duration-200 ease-in-out
        ${sidebarOpen ? 'translate-x-0' : locale === 'ar' ? 'translate-x-full lg:translate-x-0' : '-translate-x-full lg:translate-x-0'}
      `}>
        <div className="flex items-center justify-between h-16 px-4 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <div className="bg-primary-600 text-white p-1.5 rounded-lg">
              <Package className="h-5 w-5" />
            </div>
            <span className="font-bold text-gray-900 text-sm">MotoParts</span>
          </div>
          <button onClick={() => setSidebarOpen(false)} className="lg:hidden text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="p-3 space-y-1 overflow-y-auto h-[calc(100vh-4rem)]">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = pathname.includes(item.href);
            return (
              <a
                key={item.key}
                href={`/${locale}${item.href}`}
                onClick={() => setSidebarOpen(false)}
                className={`
                  flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium
                  transition-colors duration-150
                  ${isActive
                    ? 'bg-primary-50 text-primary-700'
                    : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'}
                `}
              >
                <Icon className="h-5 w-5 flex-shrink-0" />
                <span>{t(item.key as any)}</span>
              </a>
            );
          })}
        </nav>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <header className="h-16 bg-white border-b border-gray-200 flex items-center justify-between px-4">
          <button onClick={() => setSidebarOpen(true)} className="lg:hidden text-gray-500 hover:text-gray-700">
            <Menu className="h-6 w-6" />
          </button>

          <div className="flex-1 mx-4">
            <div className="relative max-w-md">
              <input
                type="text"
                placeholder="Search..."
                className="w-full ps-10 pe-4 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Language Switcher */}
            <div className="relative">
              <button
                onClick={() => setLangOpen(!langOpen)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg"
              >
                <Globe className="h-4 w-4" />
                <span>{locale === 'ar' ? 'عربي' : 'EN'}</span>
                <ChevronDown className="h-3 w-3" />
              </button>
              {langOpen && (
                <div className="absolute end-0 mt-1 w-36 bg-white border border-gray-200 rounded-lg shadow-lg z-50">
                  <button
                    onClick={() => { switchLocale('en'); setLangOpen(false); }}
                    className={`w-full text-start px-4 py-2 text-sm hover:bg-gray-50 ${locale === 'en' ? 'text-primary-600 font-medium' : 'text-gray-700'}`}
                  >
                    English
                  </button>
                  <button
                    onClick={() => { switchLocale('ar'); setLangOpen(false); }}
                    className={`w-full text-start px-4 py-2 text-sm hover:bg-gray-50 ${locale === 'ar' ? 'text-primary-600 font-medium' : 'text-gray-700'}`}
                  >
                    العربية
                  </button>
                </div>
              )}
            </div>

            <button className="relative p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg">
              <Bell className="h-5 w-5" />
              <span className="absolute -top-0.5 -end-0.5 h-4 w-4 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">3</span>
            </button>

            <div className="flex items-center gap-2 ps-3 border-s border-gray-200">
              <div className="h-8 w-8 bg-primary-100 text-primary-700 rounded-full flex items-center justify-center text-sm font-bold">
                A
              </div>
              <div className="hidden sm:block">
                <p className="text-sm font-medium text-gray-900">Admin</p>
                <p className="text-xs text-gray-500">Core Partner</p>
              </div>
            </div>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
