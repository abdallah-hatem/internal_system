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
import { PushAlerts } from '../../../components/settings/push-alerts';
import { AssistantConnections } from '../../../components/settings/assistant-connections';
import { useCodeLabel } from '@/lib/labels';
import { ValidatedForm } from '@/components/ui/validated-form';
import { useApiError } from '@/lib/api-error';
import { PASSWORD_MIN_LENGTH, isStrongPassword } from '@/lib/password-rule';

// ─── Main Page ────────────────────────────────────────────────────────
export default function SettingsPage() {
  const codeLabel = useCodeLabel();
  const t = useTranslations('settings');
  const tph = useTranslations('placeholders');
  const tc = useTranslations('common');
  const { user } = useAuth();
  const { toast } = useToast();
  const [passwordSuccess, setPasswordSuccess] = useState(false);

  // ── Profile query ─────────────────────────────────────────────────
  const { data: profile, isLoading: loadingProfile } = useQuery({
    queryKey: ['profile'],
    queryFn: () => api.get('/auth/profile').then((r) => r.data.data ?? r.data),
  });

  // ── Change password ────────────────────────────────────────────────
  // Controlled, so a refusal leaves what was typed where it was (2026-10-14:
  // the form used to reset the moment it was submitted, before the answer,
  // and a wrong current password cost the reader all three fields).
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' });
  /** A field's own problem, said under it. Only the form's checks set these. */
  const [pwErrors, setPwErrors] = useState<Partial<Record<keyof typeof pw, string>>>({});
  const apiError = useApiError();
  const te = useTranslations('errors');

  const passwordMutation = useMutation({
    mutationFn: (data: { currentPassword: string; newPassword: string }) =>
      api.post('/auth/change-password', data),
    onSuccess: () => {
      // Only now. The session is kept: nothing is signed out by this.
      setPw({ currentPassword: '', newPassword: '', confirmPassword: '' });
      setPasswordSuccess(true);
      setTimeout(() => setPasswordSuccess(false), 3000);
      toast(t('passwordChanged'), 'success');
    },
  });

  const editPw = (field: keyof typeof pw) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setPw((prev) => ({ ...prev, [field]: value }));
    setPwErrors((prev) => ({ ...prev, [field]: undefined }));
    if (passwordMutation.isError) passwordMutation.reset();
  };

  // ── Handlers ──────────────────────────────────────────────────────
  const handlePasswordChange = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    // The server applies the same rule and says it in the same words; this
    // only saves the round trip.
    const problems: typeof pwErrors = {};
    if (!isStrongPassword(pw.newPassword)) {
      problems.newPassword = te('PASSWORD_TOO_WEAK', { min: PASSWORD_MIN_LENGTH });
    } else if (pw.newPassword === pw.currentPassword) {
      problems.newPassword = te('PASSWORD_SAME_AS_CURRENT');
    }
    if (pw.confirmPassword !== pw.newPassword) {
      problems.confirmPassword = t('passwordsDontMatch');
    }
    setPwErrors(problems);
    if (Object.keys(problems).length > 0) {
      const first = problems.newPassword ? 'newPassword' : 'confirmPassword';
      document.getElementById(first)?.focus();
      return;
    }

    passwordMutation.mutate({
      currentPassword: pw.currentPassword,
      newPassword: pw.newPassword,
    });
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
                  placeholder={tph('personName')}
                  readOnly
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-50 text-gray-600"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('email')}</label>
                <input
                  type="email"
                  value={profileData?.email ?? ''}
                  placeholder={tph('email')}
                  readOnly
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm bg-gray-50 text-gray-600"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t('role')}</label>
                <input
                  type="text"
                  value={profileData?.role ? codeLabel('role', profileData.role) : ''}
                  placeholder={tph('role')}
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

          {/* Alerts on this device */}
          <PushAlerts />

          {/* Claude connections — only a core partner can connect Claude */}
          {profileData?.role === 'CORE_PARTNER' && <AssistantConnections />}

          {/* Security Section */}
          <section className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-gray-400" />
              {t('security')}
            </h2>
            <ValidatedForm onSubmit={handlePasswordChange} className="space-y-4">
              <PasswordInput
                id="currentPassword"
                label={t('currentPassword')}
                placeholder={t('currentPasswordPlaceholder')}
                autoComplete="current-password"
                value={pw.currentPassword}
                onChange={editPw('currentPassword')}
                error={pwErrors.currentPassword}
              />
              <PasswordInput
                id="newPassword"
                label={t('newPassword')}
                placeholder={t('newPasswordPlaceholder')}
                autoComplete="new-password"
                value={pw.newPassword}
                onChange={editPw('newPassword')}
                error={pwErrors.newPassword}
                hint={t('passwordRule', { min: PASSWORD_MIN_LENGTH })}
              />
              <PasswordInput
                id="confirmPassword"
                label={t('confirmPassword')}
                placeholder={t('confirmPasswordPlaceholder')}
                autoComplete="new-password"
                value={pw.confirmPassword}
                onChange={editPw('confirmPassword')}
                error={pwErrors.confirmPassword}
              />

              {passwordSuccess && (
                <div className="flex items-center gap-2 text-sm text-green-600 bg-green-50 rounded-lg px-3 py-2">
                  <Check className="h-4 w-4" />
                  {t('passwordChanged')}
                </div>
              )}

              {passwordMutation.isError && (
                <div
                  role="alert"
                  data-testid="password-refusal"
                  className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2"
                >
                  {apiError(passwordMutation.error, tc('error'))}
                </div>
              )}

              <div className="flex justify-end pt-2">
                <button
                  type="submit"
                  disabled={passwordMutation.isPending}
                  className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50"
                >
                  {passwordMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                  {t('changePassword')}
                </button>
              </div>
            </ValidatedForm>
          </section>
        </>
      )}
    </div>
  );
}

/**
 * One password field: label, input, the rule under it, and its own error.
 * The label is tied to the input, and the hint and error to both, so a screen
 * reader says them and a test can find the field by its name.
 */
function PasswordInput({
  id, label, placeholder, autoComplete, value, onChange, error, hint,
}: {
  id: string;
  label: string;
  placeholder: string;
  autoComplete: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  error?: string;
  hint?: string;
}) {
  const described = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ') || undefined;
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <input
        id={id}
        type="password"
        name={id}
        required
        autoComplete={autoComplete}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        aria-invalid={error ? true : undefined}
        aria-describedby={described}
        className={`w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 ${
          error ? 'border-red-400' : 'border-gray-200'
        }`}
      />
      {hint && (
        <p id={`${id}-hint`} className="mt-1 text-xs text-gray-500">{hint}</p>
      )}
      {error && (
        <p id={`${id}-error`} data-testid={`${id}-error`} className="mt-1 text-xs text-red-600">{error}</p>
      )}
    </div>
  );
}
