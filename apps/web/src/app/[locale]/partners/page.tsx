'use client';

import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { useState } from 'react';
import Link from 'next/link';
import { useLocale } from 'next-intl';
import { Search, Loader2, Route, TrendingUp, Wallet, Clock, Hourglass } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────
interface PartnerCycle {
  id: string;
  code: string;
  status: string;
  contributionEgp: number;
  profitShareEgp: number;
  accruedProfitEgp: number;
}

interface Participation {
  id: string;
  email: string;
  role: string;
  status?: string;
  displayName: string | null;
  cycleCount: number;
  openCycleCount: number;
  contributedEgp: number;
  returnedEgp: number;
  profitShareEgp: number;
  accruedProfitEgp: number;
  atRiskEgp: number;
  cycles: PartnerCycle[];
}

const ROLE_COLORS: Record<string, string> = {
  CORE_PARTNER: 'bg-blue-100 text-blue-700',
  TEMP_INVESTOR: 'bg-purple-100 text-purple-700',
  ADMIN: 'bg-amber-100 text-amber-700',
};

const egp = (n: number) =>
  `${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EGP`;

// ─── Main Page ────────────────────────────────────────────────────────
export default function PartnersPage() {
  const t = useTranslations('partners');
  const tc = useTranslations('common');

  const [search, setSearch] = useState('');

  /**
   * One call carrying the money, not the plain user list.
   *
   * The page used to read /users and count `cyclePartnerEntries`, a relation
   * that endpoint never includes — so every partner showed "0 Cycles" however
   * many they had funded. This endpoint does the aggregation server-side, where
   * the settlement lines are.
   */
  const { data: people = [], isLoading } = useQuery({
    queryKey: ['users', 'participation'],
    queryFn: () => api.get('/users/participation').then((r) => r.data.data ?? r.data),
  });

  // ── Derived ───────────────────────────────────────────────────────
  const list: Participation[] = Array.isArray(people) ? people : [];

  const filtered = list.filter((u) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      u.email?.toLowerCase().includes(q) ||
      u.displayName?.toLowerCase().includes(q) ||
      u.role?.toLowerCase().includes(q)
    );
  });

  const corePartners = filtered.filter((u) => u.role === 'CORE_PARTNER');
  const tempInvestors = filtered.filter((u) => u.role === 'TEMP_INVESTOR');

  const totals = corePartners.reduce(
    (acc, p) => ({
      contributed: acc.contributed + p.contributedEgp,
      profit: acc.profit + p.profitShareEgp,
      accrued: acc.accrued + p.accruedProfitEgp,
      atRisk: acc.atRisk + p.atRiskEgp,
    }),
    { contributed: 0, profit: 0, accrued: 0, atRisk: 0 },
  );

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
      </div>

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

      {isLoading && (
        <div className="flex items-center justify-center py-12 text-gray-500">
          <Loader2 className="h-5 w-5 animate-spin me-2" /> {tc('loading')}
        </div>
      )}

      {!isLoading && (
        <>
          {/* The three partners fund cycles together, so the combined position
              is worth stating once rather than making it a mental sum of the
              cards below. */}
          {corePartners.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
              <Total label={t('capitalIn')} value={egp(totals.contributed)} icon={Wallet} tone="text-emerald-600" />
              <Total label={t('profitEarned')} value={egp(totals.profit)} icon={TrendingUp} tone="text-blue-600" />
              <Total
                label={t('accrued')}
                value={egp(totals.accrued)}
                icon={Hourglass}
                tone={totals.accrued > 0 ? 'text-violet-600' : 'text-gray-400'}
                hint={t('accruedHint')}
              />
              <Total
                label={t('atRisk')}
                value={egp(totals.atRisk)}
                icon={Clock}
                tone={totals.atRisk > 0 ? 'text-amber-600' : 'text-gray-400'}
                hint={t('atRiskHint')}
              />
            </div>
          )}

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mb-4">{t('partners')}</h2>
            {corePartners.length === 0 ? (
              <Empty text={tc('noData')} />
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {corePartners.map((p) => (
                  <PartnerCard key={p.id} person={p} t={t} />
                ))}
              </div>
            )}
          </section>

          <section>
            <h2 className="text-lg font-semibold text-gray-900 mb-4">{t('investors')}</h2>
            {tempInvestors.length === 0 ? (
              <Empty text={tc('noData')} />
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {tempInvestors.map((p) => (
                  <PartnerCard key={p.id} person={p} t={t} />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

// ─── Pieces ───────────────────────────────────────────────────────────
function Empty({ text }: { text: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-12 text-center text-gray-400">
      {text}
    </div>
  );
}

function Total({
  label,
  value,
  icon: Icon,
  tone,
  hint,
}: {
  label: string;
  value: string;
  icon: any;
  tone: string;
  hint?: string;
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-gray-500">{label}</p>
          <p className={`text-xl font-bold mt-1 ${tone}`}>{value}</p>
          {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
        </div>
        <Icon className={`h-5 w-5 shrink-0 ${tone}`} />
      </div>
    </div>
  );
}

function PartnerCard({ person, t }: { person: Participation; t: any }) {
  const locale = useLocale();

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 hover:shadow-md transition-shadow">
      {/* Who */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 bg-primary-100 text-primary-700 rounded-full flex items-center justify-center text-sm font-bold">
            {person.displayName?.[0] ?? person.email?.[0]?.toUpperCase() ?? '?'}
          </div>
          <div>
            <p className="font-medium text-gray-900">{person.displayName ?? person.email}</p>
            <p className="text-xs text-gray-500">{person.email}</p>
          </div>
        </div>
        <span
          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
            ROLE_COLORS[person.role] ?? 'bg-gray-100 text-gray-600'
          }`}
        >
          {person.role === 'CORE_PARTNER' ? t('corePartner') : t('tempInvestor')}
        </span>
      </div>

      {/* Money. Put in, earned, and what has not come back yet — the third is
          the one that says whether they are exposed right now. */}
      {/* Put in, banked, still only on paper, and not yet back. The third is
          separated from the second on purpose: money the cycle has made is not
          money anyone has been paid, and it can still fall if the rest of the
          stock sells badly. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <Figure label={t('capitalIn')} value={egp(person.contributedEgp)} tone="text-gray-900" />
        <Figure label={t('profitEarned')} value={egp(person.profitShareEgp)} tone="text-blue-600" />
        <Figure
          label={t('accrued')}
          value={egp(person.accruedProfitEgp)}
          tone={person.accruedProfitEgp > 0 ? 'text-violet-600' : 'text-gray-400'}
        />
        <Figure
          label={t('atRisk')}
          value={egp(person.atRiskEgp)}
          tone={person.atRiskEgp > 0 ? 'text-amber-600' : 'text-gray-400'}
        />
      </div>

      {/* Cycles */}
      <div className="border-t border-gray-100 pt-3">
        <div className="flex items-center justify-between mb-2">
          <span className="inline-flex items-center gap-1.5 text-sm text-gray-600">
            <Route className="h-3.5 w-3.5 text-gray-400" />
            {t('cycleCount', { count: person.cycleCount })}
          </span>
          <span className="text-xs text-gray-400">
            {t('openCycles', { count: person.openCycleCount })}
          </span>
        </div>

        {person.cycles.length === 0 ? (
          <p className="text-xs text-gray-400 py-2">{t('noCyclesYet')}</p>
        ) : (
          <ul className="space-y-1">
            {person.cycles.slice(0, 4).map((c) => (
              <li key={c.id} className="flex items-center justify-between text-xs">
                <Link
                  href={`/${locale}/cycles/${c.id}/details`}
                  className="font-mono text-primary-600 hover:underline"
                >
                  {c.code}
                </Link>
                <span className="text-gray-500">
                  {egp(c.contributionEgp)}
                  {c.profitShareEgp > 0 && (
                    <span className="text-blue-600"> → +{egp(c.profitShareEgp)}</span>
                  )}
                  {c.profitShareEgp === 0 && c.accruedProfitEgp !== 0 && (
                    <span className="text-violet-600"> → ~{egp(c.accruedProfitEgp)}</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Figure({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div>
      <p className="text-[11px] text-gray-500 mb-0.5">{label}</p>
      <p className={`text-sm font-semibold ${tone}`}>{value}</p>
    </div>
  );
}
