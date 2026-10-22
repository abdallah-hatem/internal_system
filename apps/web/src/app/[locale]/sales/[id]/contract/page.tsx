'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { FileX } from '@/components/ui/icons';

import { DocumentActions } from '@/components/ui/document-actions';
import { DEFAULT_DOCUMENT_LANGUAGE, DocumentLanguageSwitch } from '@/components/ui/document-language';
import { api } from '@/lib/api';
import { useApiError } from '@/lib/api-error';
import { BackLink } from '@/components/ui/back-link';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton, SkeletonRegion, SkeletonText } from '@/components/ui/skeleton';
import { CONTRACT_TEXT, type ContractLanguage } from '@/components/sales/contract-text';
import { ContractDocument, type SaleContract } from '@/components/sales/contract-document';

/**
 * A sale's instalment contract (BUSINESS_LOGIC §7, 2026-10-16), printed from
 * the sale and its plan as they are — nothing about it is stored. Arabic by
 * default whatever language the office reads in, with a switch to English.
 *
 * Download, Share and Print are the shared DocumentActions: a PDF of A4
 * sheets, numbered only when there are several (owner, 2026-10-17).
 */
export default function SaleContractPage() {
  const t = useTranslations('sales.contract');
  const apiError = useApiError();
  const router = useRouter();
  const { id, locale } = useParams<{ id: string; locale: string }>();
  const [lang, setLang] = useState<ContractLanguage>(DEFAULT_DOCUMENT_LANGUAGE);

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
        <div className="flex flex-wrap items-center gap-2">
          <DocumentLanguageSwitch testIdPrefix="contract" value={lang} onChange={setLang} />
          <DocumentActions
            testIdPrefix="contract"
            filename={`${data.number}.pdf`}
            title={`${CONTRACT_TEXT[lang].title} ${data.number}`}
            pageLabel={CONTRACT_TEXT[lang].page}
            dir={lang === 'ar' ? 'rtl' : 'ltr'}
            sheet={() => <ContractDocument contract={data} lang={lang} sheet />}
          />
        </div>
      </div>

      <ContractDocument contract={data} lang={lang} />
    </div>
  );
}
