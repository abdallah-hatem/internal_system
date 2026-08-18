'use client';

import { useTranslations } from 'next-intl';
import { useQuery, useMutation } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { useAuth } from '../../../lib/auth-context';
import { useToast } from '../../../components/ui/toast';
import { useState } from 'react';
import {
  Settings as SettingsIcon, User, ShieldCheck, Globe, Loader2, Check,
} from 'lucide-react';

// ─── Main Page ────────────────────────────────────────────────────────
export default function SettingsPage() {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const { user } = useAuth();
  const { toast } = useToast();
  const [passwordSuccess, setPasswordSuccess] = useState(false);

  // ── Profile query ─────────────────────────────────────────────────
  const { data: profile, isLoading: loadingProfile } = useQuery({
    queryKey: ['profile'],
    queryFn: () => api.get('/auth/profile').then((r) => r.data.data ?? r.data),
  });

  // ── Change password mutation ───────────────────────────────────────
  const passwordMutation = useMutation({
    mutationFn: (data: { currentPassword: string; newPassword: string }) =>
      api.post('/auth/change-password', data),
    onSuccess: () => {
      setPasswordSuccess(true);
      setTimeout(() => setPasswordSuccess(false), 3000);
      toast('Password changed successfully', 'success');
    },
  });

  // ── Handlers ──────────────────────────────────────────────────────
  const handlePasswordChange = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const newPass = fd.get('newPassword') as string;
    const confirmPass = fd.get('confirmPassword') as string;

    if (newPass !== confirmPass) return;

    passwordMutation.mutate({
      currentPassword: fd.get('currentPassword') as string,
      newPassword: newPass,
    });

    // Reset form
    (e.target as HTMLFormElement).reset();
  };

  const switchLocale = (newLocale: string) => {
    document.cookie = `locale=${newLocale};path=/;max-age=31536000`;
    window.location.href = `/${newLocale}/settings`;
  };

  const profileData = profile ?? user;

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div className="space-y-6 max-w-2xl">
      {/* Header */}
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
      </div>

      {/* Loading */}
      {loadingProfile && (
        <div className="flex items-center justify-center py-12 text-gray-500">
          <Loader2 className="h-5 w-5 animate-spin me-2" /> {tc('loading')}
        </div>
      )}

      {!loadingProfile && (
        <>
          {/* Profile Section */}
          <section className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <User className="h-5 w-5 text-gray-400" />
              {t('profile')}
            </h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('displayName')}</label>
                <input
                  type="text"
                  value={profileData?.partner?.displayName ?? profileData?.displayName ?? ''}
                  readOnly
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-50 text-gray-600"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('email')}</label>
                <input
                  type="email"
                  value={profileData?.email ?? ''}
                  readOnly
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-50 text-gray-600"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('role')}</label>
                <input
                  type="text"
                  value={profileData?.role ?? ''}
                  readOnly
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-50 text-gray-600"
                />
              </div>
            </div>
          </section>

          {/* Language Section */}
          <section className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <Globe className="h-5 w-5 text-gray-400" />
              {t('language')}
            </h2>
            <div className="flex gap-3">
              <button
                onClick={() => switchLocale('en')}
                className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium border border-gray-200 hover:bg-gray-50 transition-colors"
              >
                🇬🇧 {t('english')}
              </button>
              <button
                onClick={() => switchLocale('ar')}
                className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium border border-gray-200 hover:bg-gray-50 transition-colors"
              >
                🇪🇬 {t('arabic')}
              </button>
            </div>
          </section>

          {/* Security Section */}
          <section className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-gray-400" />
              {t('security')}
            </h2>
            <form onSubmit={handlePasswordChange} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('currentPassword')}</label>
                <input
                  type="password"
                  name="currentPassword"
                  required
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('newPassword')}</label>
                <input
                  type="password"
                  name="newPassword"
                  required
                  minLength={6}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('confirmPassword')}</label>
                <input
                  type="password"
                  name="confirmPassword"
                  required
                  minLength={6}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>

              {passwordSuccess && (
                <div className="flex items-center gap-2 text-sm text-green-600 bg-green-50 rounded-lg px-3 py-2">
                  <Check className="h-4 w-4" />
                  {t('saved')}
                </div>
              )}

              {passwordMutation.isError && (
                <div className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">
                  {tc('error')}
                </div>
              )}

              <div className="flex justify-end pt-2">
                <button
                  type="submit"
                  disabled={passwordMutation.isPending}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50"
                >
                  {passwordMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                  {t('save')}
                </button>
              </div>
            </form>
          </section>
        </>
      )}
    </div>
  );
}
