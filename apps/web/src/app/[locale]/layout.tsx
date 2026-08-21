import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { NextIntlClientProvider, hasLocale } from 'next-intl';
import { getMessages, setRequestLocale } from 'next-intl/server';
import { IBM_Plex_Sans, IBM_Plex_Sans_Arabic, IBM_Plex_Mono } from 'next/font/google';
import { routing } from '../../i18n/routing';
import { AuthProvider } from '../../lib/auth-context';
import { QueryProvider } from '../../lib/query-provider';
import { AppShell } from '../../components/layout/app-shell';
import '../globals.css';

// IBM Plex is drawn as one family across Latin and Arabic, which matters for a
// bilingual app: the two scripts share weight and rhythm instead of looking
// like two different products. Its figures are properly tabular, so money
// columns line up digit for digit.
const sans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-plex-sans',
  display: 'swap',
});

const arabic = IBM_Plex_Sans_Arabic({
  subsets: ['arabic'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-plex-arabic',
  display: 'swap',
});

// Reserved for the things that must not shift: SKUs, batch ids, references.
const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-plex-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'MotoParts Manager',
  description: 'Motorcycle Parts & Accessories Business Management System',
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

/**
 * The document lives here, inside the [locale] segment, so the locale comes
 * from the route itself.
 *
 * It used to live in the root layout, which sits outside this segment and so
 * never saw the route's locale: useLocale() fell back to the default, and every
 * locale-aware redirect sent a signed-out Arabic user to the English login
 * page. lang and dir were wrong for the same reason, which also left anything
 * portaled to document.body — Radix popovers included — rendering
 * left-to-right in an Arabic session.
 */
export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();

  // Tell next-intl which locale this render is for, rather than letting it
  // infer one from a cookie that may be stale or absent.
  setRequestLocale(locale);
  const messages = await getMessages({ locale });

  return (
    <html
      lang={locale}
      dir={locale === 'ar' ? 'rtl' : 'ltr'}
      suppressHydrationWarning
      className={`${sans.variable} ${arabic.variable} ${mono.variable}`}
    >
      <body className="min-h-screen bg-gray-50 font-sans antialiased">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <QueryProvider>
            <AuthProvider>
              <AppShell>{children}</AppShell>
            </AuthProvider>
          </QueryProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
