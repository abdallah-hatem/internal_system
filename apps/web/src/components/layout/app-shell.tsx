'use client';

import { useTranslations, useLocale } from 'next-intl';
import { Link, usePathname } from '../../i18n/navigation';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth-context';
import { ToastProvider, ToastBridge } from '../ui/toast';
import { NotificationBell } from './notification-bell';
import {
  LayoutDashboard, Route, ShoppingCart, Truck, Package, Boxes,
  BadgePercent, Users, CreditCard, BookOpen, BarChart3,
  Bell, ShieldCheck, Settings, Menu, X, ChevronDown,
  Globe, Tag, Scale, CalendarClock, Building2, Handshake,
  Factory,
} from 'lucide-react';

/**
 * The sidebar follows the shape of the business rather than the order the
 * screens were built in: goods are bought and brought in, they become stock,
 * the stock is sold, the money is collected, and what is left is split between
 * the partners. A flat list of nineteen links made related screens — a cycle
 * and the shipment on it, a payment and the plan it belongs to — sit
 * arbitrarily far apart.
 */
const navGroups = [
  {
    key: 'overview',
    items: [
      { key: 'dashboard', icon: LayoutDashboard, href: '/dashboard' },
      { key: 'analytics', icon: BarChart3, href: '/analytics' },
    ],
  },
  {
    key: 'importing',
    items: [
      { key: 'cycles', icon: Route, href: '/cycles' },
      { key: 'purchases', icon: ShoppingCart, href: '/purchases' },
      // Suppliers sit with purchases — they are who the goods are bought from,
      // as distinct from providers below, who move them.
      { key: 'suppliers', icon: Factory, href: '/suppliers' },
      { key: 'shipments', icon: Truck, href: '/shipments' },
      // Providers are the shipping companies, so they belong beside the
      // shipments rather than with suppliers. A distinct icon from Shipments:
      // the two shared Truck and were hard to tell apart at a glance.
      { key: 'providers', icon: Building2, href: '/providers' },
    ],
  },
  {
    key: 'catalogue',
    items: [
      { key: 'products', icon: Package, href: '/products' },
      { key: 'categories', icon: Tag, href: '/categories' },
      { key: 'inventory', icon: Boxes, href: '/inventory' },
    ],
  },
  {
    key: 'selling',
    items: [
      { key: 'sales', icon: BadgePercent, href: '/sales' },
      { key: 'customers', icon: Users, href: '/customers' },
    ],
  },
  {
    key: 'money',
    items: [
      { key: 'payments', icon: CreditCard, href: '/payments' },
      { key: 'paymentPlans', icon: CalendarClock, href: '/payment-plans' },
      { key: 'ledger', icon: BookOpen, href: '/ledger' },
    ],
  },
  {
    key: 'partners',
    items: [
      { key: 'partners', icon: Handshake, href: '/partners' },
      { key: 'settlements', icon: Scale, href: '/settlements' },
    ],
  },
];

/** Pinned to the foot of the sidebar — reached occasionally, not part of the
 *  daily flow, and better out of the way than padding the list above. */
const systemItems = [
  { key: 'notifications', icon: Bell, href: '/notifications' },
  { key: 'auditLogs', icon: ShieldCheck, href: '/audit-logs' },
  { key: 'settings', icon: Settings, href: '/settings' },
];
/**
 * Match on a whole path segment. A plain `includes` would light up two entries
 * as soon as one route's path appeared inside another's.
 */
function isActiveHref(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function NavLink({
  item,
  label,
  active,
  onNavigate,
}: {
  item: { key: string; icon: React.ComponentType<{ className?: string }>; href: string };
  label: string;
  active: boolean;
  onNavigate: () => void;
}) {
  const Icon = item.icon;
  return (
    // Link, not <a>. A plain anchor made every tab click a full document
    // navigation: the bundle re-parsed, React remounted, and the query cache
    // went with it — so every page refetched from scratch and the sidebar,
    // being a new DOM node each time, lost its scroll position.
    //
    // This Link comes from the i18n navigation module and adds the locale
    // itself, so the href must NOT carry it or it lands on /en/en/....
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={`
        flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium
        transition-colors duration-150
        ${active
          ? 'bg-primary-50 text-primary-700'
          : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'}
      `}
    >
      <Icon className={`h-[18px] w-[18px] flex-shrink-0 ${active ? '' : 'text-gray-400'}`} />
      <span>{label}</span>
    </Link>
  );
}

export function AppShell({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = useTranslations('nav');
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const { user, isLoading } = useAuth();
  const displayName = user?.partner?.displayName ?? user?.email ?? '';
  const roleLabel = user?.role
    ? user.role.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())
    : '';
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);

  const isLoginPage = pathname.includes('/login');

  useEffect(() => {
    if (!isLoading && !user && !isLoginPage) {
      // Deliberately the plain Next router with an explicit prefix. The
      // locale-aware one infers the locale (from a cookie that may be stale or
      // absent) and sent signed-out Arabic users to the English login page.
      // Naming the path removes the inference entirely.
      //
      // replace, not push: the page they could not see should not sit in
      // history for the back button to return to.
      router.replace(`/${locale}/login`);
    }
  }, [user, isLoading, router, isLoginPage, locale]);

  const switchLocale = (newLocale: string) => {
    // next-intl reads NEXT_LOCALE. Writing `locale` meant the choice was never
    // persisted: switching language only worked because of the hard navigation
    // below, and any later redirect fell back to the default locale.
    document.cookie = `NEXT_LOCALE=${newLocale};path=/;max-age=31536000;samesite=lax`;
    window.location.href = `/${newLocale}${pathname}`;
  };

  // Login page renders without chrome
  if (isLoginPage) {
    return (
      <ToastProvider>
        <ToastBridge />
        {children}
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <ToastBridge />
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

        <nav className="flex h-[calc(100vh-4rem)] flex-col overflow-y-auto p-3">
          {navGroups.map((group) => (
            <div key={group.key} className="mb-3">
              <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                {t(`groups.${group.key}` as any)}
              </p>
              <div className="space-y-0.5">
                {group.items.map((item) => (
                  <NavLink
                    key={item.key}
                    item={item}
                    label={t(item.key as any)}
                    active={isActiveHref(pathname, item.href)}
                    onNavigate={() => setSidebarOpen(false)}
                  />
                ))}
              </div>
            </div>
          ))}

          {/* mt-auto pins this to the foot on a tall window, and it simply
              follows the list on a short one rather than overlapping it. */}
          <div className="mt-auto border-t border-gray-100 pt-3">
            <div className="space-y-0.5">
              {systemItems.map((item) => (
                <NavLink
                  key={item.key}
                  item={item}
                  label={t(item.key as any)}
                  active={isActiveHref(pathname, item.href)}
                  onNavigate={() => setSidebarOpen(false)}
                />
              ))}
            </div>
          </div>
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

            <NotificationBell />

            <div className="flex items-center gap-2 ps-3 border-s border-gray-200">
              {/* Was a hardcoded "A / Admin / Core Partner", so every partner
                  saw the same name and could not tell whose session they were
                  in — on a system where every action is attributed. */}
              <div className="h-8 w-8 bg-primary-100 text-primary-700 rounded-full flex items-center justify-center text-sm font-bold uppercase">
                {(displayName || user?.email || '?').charAt(0)}
              </div>
              <div className="hidden sm:block">
                <p className="text-sm font-medium text-gray-900">{displayName || user?.email}</p>
                <p className="text-xs text-gray-500">{roleLabel}</p>
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
    </ToastProvider>
  );
}
