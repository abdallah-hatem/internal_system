'use client';

import { useTranslations } from 'next-intl';
import { AlertTriangle } from '@/components/ui/icons';
import { useNumberFormat } from '@/lib/numbers';

/**
 * What a settlement calculation wants noticed before it is approved.
 *
 * The API names each warning with a code and the numbers it needs
 * (`apps/api/src/modules/settlements/settlement-warnings.ts`); it used to send
 * English sentences, which an Arabic page printed as they came (rule 9). The
 * sentence is said here, under `settlementsPage.warnings.<code>`, in the
 * reader's language. A code this build has never heard of shows one line
 * saying so, never an empty row and never the raw code.
 */
export interface SettlementWarning {
  code: string;
  params?: Record<string, number>;
}

/** Numbers grouped the way `Money` groups them; amounts at 2dp, counts as they are. */
function formatParams(
  params: Record<string, number> = {},
  formatNumber: ReturnType<typeof useNumberFormat>['formatNumber'],
) {
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => [
      key,
      formatNumber(
        value,
        key.endsWith('Egp')
          ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
          : { maximumFractionDigits: 3 },
      ),
    ]),
  );
}

export function SettlementWarnings({ warnings }: { warnings: SettlementWarning[] }) {
  const t = useTranslations('settlementsPage.warnings');
  const { formatNumber } = useNumberFormat();
  if (warnings.length === 0) return null;

  return (
    <div role="status" className="rounded-xl border border-accent-200 bg-accent-50 p-4 space-y-1">
      {warnings.map((w, i) => (
        <p key={i} className="text-sm text-accent-800 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          {t.has(w.code) ? t(w.code, formatParams(w.params, formatNumber)) : t('unknown')}
        </p>
      ))}
    </div>
  );
}
