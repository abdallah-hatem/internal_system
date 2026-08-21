/**
 * A passthrough. The document shell (html, body, fonts, providers) lives in
 * app/[locale]/layout.tsx so that it can read the locale from the route
 * segment; rendering it here meant the locale had to be guessed.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return children;
}
