'use client';

import { useTranslations } from 'next-intl';
import { Package, ClipboardList, Ship, User } from 'lucide-react';

import { Link, usePathname } from '../i18n/navigation';
import { AlertsPrompt } from './account/alerts-prompt';

/**
 * The frame every screen sits in.
 *
 * A bottom bar rather than a sidebar: this is used one-handed on a phone in a
 * workshop, and the reachable part of a phone screen is the bottom. It stays at
 * the bottom on a desktop too — one layout that is right on the device it is
 * actually used on beats two that each half-fit.
 *
 * Logical properties throughout (`ps-`, `pe-`, `text-start`), so Arabic mirrors
 * without a second stylesheet.
 */
const TABS = [
  { href: '/', key: 'catalogue', Icon: Package },
  { href: '/requests', key: 'requests', Icon: ClipboardList },
  { href: '/imports', key: 'imports', Icon: Ship },
  { href: '/account', key: 'account', Icon: User },
] as const;

export function AppShell({ children }: { children: React.ReactNode }) {
  const t = useTranslations('nav');
  const pathname = usePathname();

  return (
    <div className="flex min-h-dvh flex-col bg-gray-50">
      <main className="flex-1 pb-20">
        {/* Above the page, on every screen but the account one. Being told
            when an order is answered is the whole point of the app having a
            login, and it should not be something you have to go and find. */}
        <div className="px-4 pt-3">
          <AlertsPrompt pathname={pathname} />
        </div>
        {children}
      </main>

      <nav
        className="fixed inset-x-0 bottom-0 z-40 border-t border-gray-200 bg-white/95 backdrop-blur"
        // The phone's home indicator sits over the bottom of the screen; without
        // this the last row of buttons is under it and cannot be tapped.
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <ul className="mx-auto flex max-w-2xl">
          {TABS.map(({ href, key, Icon }) => {
            const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
            return (
              <li key={href} className="flex-1">
                <Link
                  href={href}
                  data-tab={key}
                  aria-current={active ? 'page' : undefined}
                  className={`flex flex-col items-center gap-1 px-2 py-2.5 text-xs font-medium transition-colors ${
                    active ? 'text-brand-700' : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  <Icon className="h-5 w-5" aria-hidden />
                  {t(key)}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
