/**
 * A price, as the API sent it.
 *
 * The API returns money as a decimal string — never a JavaScript number, which
 * cannot hold 0.1 + 0.2 and has no business being anywhere near a settlement.
 * This formats for display and does no arithmetic, deliberately: any sum a
 * customer sees is one the server worked out.
 */
export function Money({
  amount,
  locale,
  className,
}: {
  amount: string | null;
  locale: string;
  className?: string;
}) {
  if (amount === null) return null;

  const formatted = new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-EG', {
    style: 'currency',
    currency: 'EGP',
    maximumFractionDigits: 2,
  }).format(Number(amount));

  return <span className={className}>{formatted}</span>;
}
