'use client';

import { useTranslations } from 'next-intl';
import { useAuth } from '../../../lib/auth-context';
import { useRouter } from '../../../i18n/navigation';
import { useApiError } from '../../../lib/api-error';
import { Eye, EyeOff, Loader2 } from '@/components/ui/icons';
import { BrandMark } from '@/components/layout/brand-mark';
import { useRef, useState, useSyncExternalStore } from 'react';
import { ValidatedForm } from '@/components/ui/validated-form';

export default function LoginPage() {
  const t = useTranslations('auth');
  const tph = useTranslations('placeholders');
  const apiError = useApiError();
  const { login } = useAuth();
  const router = useRouter();
  const [showPassword, setShowPassword] = useState(false);
  // Read from the fields when the form is sent, not kept in state: on a slow
  // phone, what is typed before the page hydrates would otherwise be reset to
  // the empty state by hydration, and the form sent blank ("not valid: email,
  // password"). Uncontrolled fields keep it.
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  // False in the server's HTML, true once hydrated. Until then the button is
  // disabled: a click before then would send the browser's own empty submit.
  const hydrated = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(emailRef.current?.value ?? '', passwordRef.current?.value ?? '');
      router.push('/dashboard');
    } catch (err: any) {
      // Was `err.response?.data?.error?.message` — the API's English sentence,
      // shown verbatim on the Arabic page. The login screen was missed when the
      // thirty-six other call sites were moved onto coded errors, and nothing
      // noticed because the only refusal it could produce was a wrong password
      // and nobody reads that one twice. CLAUDE.md rule 9.
      setError(apiError(err, t('loginFailed')));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-primary-50 to-primary-100 p-4">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-2xl shadow-xl p-8">
          <div className="text-center mb-8">
            <div className="inline-flex mb-4">
              <BrandMark size={64} />
            </div>
            <h1 className="text-2xl font-bold text-gray-900">{t('loginTitle')}</h1>
            <p className="text-sm text-gray-500 mt-2">{t('loginSubtitle')}</p>
          </div>

          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
              {error}
            </div>
          )}

          <ValidatedForm onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t('email')}</label>
              <input
                type="email"
                ref={emailRef}
                autoComplete="email"
                className="w-full px-4 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                placeholder={tph('email')}
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">{t('password')}</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  ref={passwordRef}
                  autoComplete="current-password"
                  className="w-full px-4 py-2.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
                  placeholder={tph('password')}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute end-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <button
              type="submit"
              disabled={loading || !hydrated}
              className="w-full bg-primary-600 hover:bg-primary-700 disabled:bg-primary-400 text-white font-medium py-2.5 rounded-lg transition-colors flex items-center justify-center gap-2"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t('login')}
            </button>
          </ValidatedForm>
        </div>
      </div>
    </div>
  );
}
