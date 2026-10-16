'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { FileX, Printer } from 'lucide-react';

import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { BackLink } from '@/components/ui/back-link';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton, SkeletonRegion, SkeletonText } from '@/components/ui/skeleton';
import { type ContractLanguage } from '@/components/sales/contract-text';
import { ContractDocument, type SaleContract } from '@/components/sales/contract-document';

/**
 * A sale's instalment contract (BUSINESS_LOGIC §7, 2026-10-16), printed from
 * the sale and its plan as they are — nothing about it is stored. Arabic by
 * default whatever language the office reads in, with a switch to English;
 * Print is the browser's own, through the app's print stylesheet, onto one A4
 * sheet for a typical sale.
 */
export default function SaleContractPage() {
  const t = useTranslations('sales.contract');
  const tc = useTranslations('common');
  const apiError = useApiError();
  const router = useRouter();
  const { id, locale } = useParams<{ id: string; locale: string }>();
  const [lang, setLang] = useState<ContractLanguage>('ar');

  const { data, isLoading, error } = useQuery<SaleContract>({
    queryKey: ['sale', id, 'contract'],
    queryFn: () => api.get(`/sales/orders/${id}/contract`).then((r) => r.data.data ?? r.data),
    retry: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });

  const back = () => router.push(`/${locale}/sales`);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="mt-3">
          <BackLink onClick={back} label={t('back')} />
        </div>
        <SkeletonRegion>
          <div className="mx-auto max-w-[794px] space-y-4 rounded-xl border border-border bg-card p-8">
            <Skeleton className="h-12 w-full" />
            <SkeletonText className="w-1/2" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        </SkeletonRegion>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="space-y-4">
        <BackLink onClick={back} label={t('back')} />
        <div className="rounded-xl border border-border bg-card" data-testid="contract-refused">
          <EmptyState
            icon={FileX}
            title={t('notAvailable')}
            description={apiError(error, t('notAvailable'))}
            action={{ label: t('back'), onClick: back }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div className="mt-3">
          <BackLink onClick={back} label={t('back')} />
        </div>
        <div className="flex items-center gap-2">
          <div role="group" aria-label={t('language')} className="inline-flex rounded-lg border border-border p-0.5">
            {(['ar', 'en'] as const).map((l) => (
              <button
                key={l}
                type="button"
                data-testid={`contract-lang-${l}`}
                aria-pressed={lang === l}
                onClick={() => setLang(l)}
                className={`rounded-md px-3 py-1.5 text-sm ${
                  lang === l ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-muted'
                }`}
              >
                {l === 'ar' ? 'العربية' : 'English'}
              </button>
            ))}
          </div>
          <button
            type="button"
            data-testid="contract-print"
            onClick={() => window.print()}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 sm:min-h-0"
          >
            <Printer className="h-4 w-4" />
            {tc('print')}
          </button>
        </div>
      </div>

      <ContractDocument contract={data} lang={lang} />
    </div>
  );
}
