'use client';

import { useTranslations, useLocale } from 'next-intl';
import { Link, usePathname } from '../../i18n/navigation';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth-context';
import { ToastProvider, ToastBridge } from '../ui/toast';
import { NotificationBell } from './notification-bell';
import { AccountMenu } from './account-menu';
import {
  BadgePercent,
  BarChart3,
  Bell,
  BookOpen,
  Boxes,
  Building2,
  CalendarClock,
  ChevronDown,
  CreditCard,
  Factory,
  Globe,
  Handshake,
  LayoutDashboard,
  LogOut,
  Menu,
  Package,
  PackageSearch,
  Route,
  Scale,
  Settings,
  ShieldCheck,
  HandCoins,
  ShoppingCart,
  Store,
  Tag,
  Truck,
  Users,
  X,
} from 'lucide-react';

import { PhoneBar } from './phone-bar';
import {
  isActiveHref,
  navForRole,
  phoneBarItems,
  systemForRole,
  type NavItem,
} from './nav-model';
import { BrandMark } from './brand-mark';

type Icon = React.ComponentType<{ className?: string }>;

/** The icon for each nav key. What the menu holds, and who sees it, lives in
 *  `nav-model.ts`; only the drawing is decided here. */
const NAV_ICONS: Record<string, Icon> = {
  dashboard: LayoutDashboard,
  analytics: BarChart3,
  cycles: Route,
  purchases: ShoppingCart,
  suppliers: Factory,
  shipments: Truck,
  // A distinct icon from Shipments: the two shared Truck and were hard to
  // tell apart at a glance.
  providers: Building2,
  products: Package,
  categories: Tag,
  inventory: Boxes,
  orderRequests: Store,
  importRequests: PackageSearch,
  sales: BadgePercent,
  customers: Users,
  payments: CreditCard,
  paymentPlans: CalendarClock,
  lenders: HandCoins,
  ledger: BookOpen,
  partners: Handshake,
  settlements: Scale,
  notifications: Bell,
  auditLogs: ShieldCheck,
  settings: Settings,
};

function NavLink({
  item,
  label,
  active,
  onNavigate,
}: {
  item: NavItem;
  label: string;
  active: boolean;
  onNavigate: () => void;
}) {
  const Icon = NAV_ICONS[item.key] ?? Package;
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
  const { user, isLoading, logout } = useAuth();
  const [signingOut, setSigningOut] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  // One reading of the role for every surface, so the sidebar, "More" and the
  // phone bar cannot disagree about what this person may open.
  const groups = navForRole(user?.role);
  const systemItems = systemForRole(user?.role);
  const barItems = phoneBarItems(user?.role);

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

  // Signed out on a protected page: the redirect above is on its way. Draw
  // nothing meanwhile — not the chrome, not the page — so a tab brought back
  // by the back button after sign-out shows no one's screens.
  if (!isLoading && !user) return null;

  return (
    <ToastProvider>
      <ToastBridge />
      <div data-app-frame className="flex h-dvh overflow-hidden bg-gray-50" dir={locale === 'ar' ? 'rtl' : 'ltr'}>
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div data-print-hide className="fixed inset-0 bg-black/50 z-40 lg:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar — never on paper (globals.css, print). */}
      <aside data-print-hide className={`
        fixed lg:static inset-y-0 ${locale === 'ar' ? 'right-0' : 'left-0'}
        w-64 bg-white border-e border-gray-200 z-50
        transform transition-transform duration-200 ease-in-out
        ${sidebarOpen ? 'translate-x-0' : locale === 'ar' ? 'translate-x-full lg:translate-x-0' : '-translate-x-full lg:translate-x-0'}
      `}>
        <div className="flex items-center justify-between h-16 px-4 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <BrandMark size={32} />
            <span className="font-bold text-gray-900 text-sm">S&amp;F</span>
          </div>
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            aria-label={t('closeMenu')}
            className="lg:hidden -me-2 flex h-11 w-11 cursor-pointer items-center justify-center text-gray-400 hover:text-gray-600"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* `dvh`, because `vh` on a phone is the height with the address bar
            hidden, and the last links fell under it. The open drawer sits
            above the phone bar (z-50 over z-30), so it needs no room for it. */}
        <nav className="flex h-[calc(100dvh-4rem)] flex-col overflow-y-auto overscroll-contain p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))]">
          {groups.map((group) => (
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
            {/* The way out on a phone or tablet, where this drawer is "More".
                On a wide screen the header's account menu holds it. */}
            <button
              type="button"
              data-testid="drawer-logout"
              disabled={signingOut}
              onClick={() => {
                if (signingOut) return;
                setSigningOut(true);
                void logout();
              }}
              className="lg:hidden mt-0.5 flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-start text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 disabled:cursor-wait disabled:opacity-70"
            >
              <LogOut aria-hidden="true" className="h-[18px] w-[18px] flex-shrink-0 rtl:-scale-x-100" />
              <span>{t('logout')}</span>
            </button>
          </div>
        </nav>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <header data-print-hide className="h-16 bg-white border-b border-gray-200 flex items-center justify-between px-4">
          {/* Below md the phone bar's "More" opens the menu, so this button
              is for tablet widths only. The search box that sat beside it was
              never wired to anything and is gone (spec A #6). */}
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            aria-label={t('openMenu')}
            className="hidden md:flex lg:hidden -ms-2 h-11 w-11 cursor-pointer items-center justify-center text-gray-500 hover:text-gray-700"
          >
            <Menu className="h-6 w-6" />
          </button>

          <div className="ms-auto flex items-center gap-3">
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

            <AccountMenu />
          </div>
        </header>

        {/* Page content */}
        {/* Below md the page is padded by the phone bar's height and the
            home-indicator inset, so the last row and a page's own buttons
            can always be scrolled clear of the bar. */}
        <main className="flex-1 overflow-y-auto px-4 pt-4 pb-[calc(4.5rem+env(safe-area-inset-bottom,0px))] sm:px-6 sm:pt-6 md:pb-6">
          {children}
        </main>
      </div>

      <PhoneBar
        items={barItems}
        icons={NAV_ICONS}
        pathname={pathname}
        menuOpen={sidebarOpen}
        onMore={() => setSidebarOpen((open) => !open)}
      />
    </div>
    </ToastProvider>
  );
}
