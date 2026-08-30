import type { Metadata, Viewport } from 'next';
import { NextIntlClientProvider, hasLocale } from 'next-intl';
import { getMessages, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { IBM_Plex_Sans, IBM_Plex_Sans_Arabic } from 'next/font/google';

import { routing } from '../../i18n/routing';
import { Providers } from '../../lib/providers';
import '../globals.css';

const latin = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-latin',
});

const arabic = IBM_Plex_Sans_Arabic({
  subsets: ['arabic'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-arabic',
});

export const metadata: Metadata = {
  title: 'MotoParts',
  description: 'Motorcycle parts for the trade.',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, statusBarStyle: 'default', title: 'MotoParts' },
};

export const viewport: Viewport = {
  themeColor: '#1d4ed8',
  // The store is used one-handed on a phone in a workshop. Letting it zoom is
  // an accessibility floor, not a nicety — `maximumScale: 1` is the thing to
  // avoid here.
  width: 'device-width',
  initialScale: 1,
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();

  setRequestLocale(locale);
  const messages = await getMessages();
  const dir = locale === 'ar' ? 'rtl' : 'ltr';

  return (
    <html lang={locale} dir={dir} className={`${latin.variable} ${arabic.variable}`}>
      <body className="min-h-dvh bg-gray-50 text-gray-900 antialiased">
        <NextIntlClientProvider messages={messages}>
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
