/**
 * A passthrough.
 *
 * `<html>` needs `lang` and `dir`, and neither is known until the locale
 * segment is read — so the real document shell is the one inside `[locale]`.
 * Owning `<html>` here would mean an Arabic page rendered inside an
 * English-and-left-to-right document, which is how the internal app once
 * shipped Arabic screens that laid out backwards.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return children;
}
