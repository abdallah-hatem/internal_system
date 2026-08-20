'use client';

/**
 * Render a monetary amount so it stays readable in both writing directions.
 *
 * Arabic pages are RTL, and the bidi algorithm will push a leading minus sign
 * to the far side of the digits — "-2,395.69" displays as "2,395.69-", which
 * reads as a positive number at a glance. Money is always a left-to-right run,
 * so isolate it explicitly.
 */
export function Money({
  value,
  currency = 'EGP',
  className,
}: {
  value: number | string | null | undefined;
  currency?: string;
  className?: string;
}) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return <span className={className}>—</span>;

  const text = n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  return (
    <span className={className} dir="ltr" style={{ unicodeBidi: 'isolate' }}>
      {text} {currency}
    </span>
  );
}
