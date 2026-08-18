'use client';

import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { useState } from 'react';
import {
  Users, Search, Loader2, Mail, Briefcase, Route,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────
interface User {
  id: string;
  email: string;
  role: string;
  status?: string;
  createdAt: string;
  partner?: {
    id: string;
    displayName: string;
  };
  cyclePartnerEntries?: any[];
  cycleInvestorEntries?: any[];
}

const ROLE_COLORS: Record<string, string> = {
  CORE_PARTNER: 'bg-blue-100 text-blue-700',
  TEMP_INVESTOR: 'bg-purple-100 text-purple-700',
  ADMIN: 'bg-amber-100 text-amber-700',
};

// ─── Main Page ────────────────────────────────────────────────────────
export default function PartnersPage() {
  const t = useTranslations('partners');
  const tc = useTranslations('common');

  const [search, setSearch] = useState('');

  // ── Queries ───────────────────────────────────────────────────────
  const { data: users = [], isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get('/users').then((r) => r.data.data ?? r.data),
  });

  // ── Derived ───────────────────────────────────────────────────────
  const userList: User[] = Array.isArray(users) ? users : [];

  const filtered = userList.filter((u) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      u.email?.toLowerCase().includes(q) ||
      u.partner?.displayName?.toLowerCase().includes(q) ||
      u.role?.toLowerCase().includes(q)
    );
  });

  const corePartners = filtered.filter((u) => u.role === 'CORE_PARTNER');
  const tempInvestors = filtered.filter((u) => u.role === 'TEMP_INVESTOR');

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
      </div>

      {/* Search */}
      <div className="relative max-w-md">
        <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
        <input
          type="text"
          placeholder={t('search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full ps-10 pe-4 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
        />
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center justify-center py-12 text-gray-500">
          <Loader2 className="h-5 w-5 animate-spin me-2" /> {tc('loading')}
        </div>
      )}

      {!isLoading && (
        <>
          {/* Core Partners */}
          <section>
            <h2 className="text-lg font-semibold text-gray-900 mb-4">{t('partners')}</h2>
            {corePartners.length === 0 ? (
              <div className="bg-white rounded-xl border border-gray-200 p-12 text-center text-gray-400">{tc('noData')}</div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {corePartners.map((user) => (
                  <PartnerCard key={user.id} user={user} t={t} tc={tc} />
                ))}
              </div>
            )}
          </section>

          {/* Temp Investors */}
          <section>
            <h2 className="text-lg font-semibold text-gray-900 mb-4">{t('investors')}</h2>
            {tempInvestors.length === 0 ? (
              <div className="bg-white rounded-xl border border-gray-200 p-12 text-center text-gray-400">{tc('noData')}</div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {tempInvestors.map((user) => (
                  <PartnerCard key={user.id} user={user} t={t} tc={tc} />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

// ─── Partner Card ─────────────────────────────────────────────────────
function PartnerCard({ user, t, tc }: { user: User; t: any; tc: any }) {
  const cycleCount = user.role === 'CORE_PARTNER'
    ? (user.cyclePartnerEntries ?? []).length
    : (user.cycleInvestorEntries ?? []).length;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 bg-primary-100 text-primary-700 rounded-full flex items-center justify-center text-sm font-bold">
            {user.partner?.displayName?.[0] ?? user.email?.[0]?.toUpperCase() ?? '?'}
          </div>
          <div>
            <p className="font-medium text-gray-900">{user.partner?.displayName ?? user.email}</p>
            <p className="text-xs text-gray-500">{user.email}</p>
          </div>
        </div>
        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${ROLE_COLORS[user.role] ?? 'bg-gray-100 text-gray-600'}`}>
          {user.role === 'CORE_PARTNER' ? t('corePartner') : t('tempInvestor')}
        </span>
      </div>
      <div className="flex items-center gap-4 text-sm text-gray-600">
        <span className="inline-flex items-center gap-1">
          <Route className="h-3.5 w-3.5 text-gray-400" />
          {cycleCount} {t('cycles')}
        </span>
        {user.status && (
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${user.status === 'ACTIVE' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-600'}`}>
            {user.status}
          </span>
        )}
      </div>
    </div>
  );
}
