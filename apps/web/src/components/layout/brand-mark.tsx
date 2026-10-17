import Image from 'next/image';

/** The business's name beside its logo — a name, the same in every language. */
export const BRAND_NAME = 'S&F';

/**
 * The S&F logo (owner, 2026-10-14) — the same image as the installed app's
 * icon, defined once so the sidebar and the sign-in page cannot drift apart.
 */
export function BrandMark({ size }: { size: number }) {
  return (
    <Image
      src="/icons/icon-192.png"
      alt="S&F"
      width={size}
      height={size}
      className="shrink-0 rounded-full"
      priority
    />
  );
}
