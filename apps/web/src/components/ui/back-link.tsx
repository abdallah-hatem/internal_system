'use client';

import { useTranslations } from 'next-intl';
import { ArrowLeft } from 'lucide-react';

/**
 * The "← Back" at the top of a detail page. It was a bare text button 20px
 * tall, which a thumb misses on a phone. The tap target is now 44px; the
 * negative top and side margins give most of the extra size back to the
 * layout, so it looks and sits nearly as it did. Only the top: the parent's
 * `space-y-*` sets the bottom margin, and overriding it would swallow the gap
 * to the heading below. The arrow turns round under Arabic, where back is to
 * the right.
 */
export function BackLink({ onClick, label }: { onClick: () => void; label?: string }) {
  const tc = useTranslations('common');
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="back-link"
      className="-mx-2 -mt-3 inline-flex min-h-11 cursor-pointer items-center gap-1.5 px-2 text-sm text-muted-foreground transition-colors hover:text-foreground touch-manipulation"
    >
      <ArrowLeft className="h-4 w-4 rtl:rotate-180" /> {label ?? tc('back')}
    </button>
  );
}
