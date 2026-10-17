'use client';

import { useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Download, FileX, Loader2, Printer, Share2 } from 'lucide-react';

import {
  canPrintPdf,
  canSharePdf,
  documentToPdf,
  downloadBlob,
  printPdf,
  sharePdf,
} from '@/lib/document-pdf';
import { toast } from '@/components/ui/toast';

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
 * Download and Share hand over a PDF of A4 sheets (lib/document-pdf.ts), for
 * sending to the shop on WhatsApp; Share appears only where the browser can
 * share a file. Print prints that same PDF where the browser can, so the
 * sheet carries no browser header or footer and is numbered only when there
 * are several (owner, 2026-10-17); Safari and phones print the page instead,
 * through the print stylesheet.
 */
type PdfAction = 'download' | 'share' | 'print';

/** The contract's text: Plex Arabic and Plex Latin, the Arabic and basic Latin subsets. */
const CONTRACT_FONT_FACES = [
  { family: 'IBM Plex Sans Arabic', ranges: ['U+600', 'U+0-FF'] },
  { family: 'IBM Plex Sans', ranges: ['U+0-FF'] },
];

/** Whether a file can be shared does not change while the page is open. */
const noSubscribe = () => () => {};

export default function SaleContractPage() {
  const t = useTranslations('sales.contract');
  const tc = useTranslations('common');
  const apiError = useApiError();
  const router = useRouter();
  const { id, locale } = useParams<{ id: string; locale: string }>();
  const [lang, setLang] = useState<ContractLanguage>('ar');
  const [busy, setBusy] = useState<PdfAction | null>(null);
  // False on the server, which cannot know, so the button never flashes in.
  const shareable = useSyncExternalStore(noSubscribe, canSharePdf, () => false);
  const sheetRef = useRef<HTMLDivElement>(null);

  const { data, isLoading, error } = useQuery<SaleContract>({
    queryKey: ['sale', id, 'contract'],
    queryFn: () => api.get(`/sales/orders/${id}/contract`).then((r) => r.data.data ?? r.data),
    retry: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });

  const back = () => router.push(`/${locale}/sales`);

  const run = async (action: PdfAction) => {
    if (!data || busy) return;
    if (action === 'print' && !canPrintPdf()) {
      window.print();
      return;
    }
    setBusy(action);
    try {
      // The sheet mounts with the busy state, committed before the next task;
      // measuring it then forces its layout. Not requestAnimationFrame, which a
      // tab in the background never runs.
      await new Promise<void>((r) => setTimeout(r, 0));
      const sheet = sheetRef.current?.firstElementChild;
      if (!(sheet instanceof HTMLElement)) throw new Error('The PDF sheet did not render.');
      const w = CONTRACT_TEXT[lang];
      const blob = await documentToPdf(sheet, {
        pageLabel: w.page,
        dir: lang === 'ar' ? 'rtl' : 'ltr',
        canvasFont: "'IBM Plex Sans Arabic', 'IBM Plex Sans', sans-serif",
        fontFaces: CONTRACT_FONT_FACES,
      });
      const filename = `${data.number}.pdf`;
      if (action === 'download') downloadBlob(blob, filename);
      else if (action === 'share') await sharePdf(blob, filename, `${w.title} ${data.number}`);
      else await printPdf(blob);
    } catch {
      toast.error(t('pdfFailed'));
    } finally {
      setBusy(null);
    }
  };

  const action = (kind: PdfAction, label: string, Icon: typeof Download, primary = false) => (
    <button
      type="button"
      data-testid={`contract-${kind}`}
      onClick={() => void run(kind)}
      disabled={busy !== null}
      aria-busy={busy === kind}
      className={`inline-flex min-h-11 items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-0 ${
        primary
          ? 'bg-primary text-primary-foreground hover:bg-primary/90'
          : 'border border-border bg-card text-foreground hover:bg-muted'
      }`}
    >
      {busy === kind ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
      {label}
    </button>
  );

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
          {action('download', t('downloadPdf'), Download)}
          {shareable && action('share', t('sharePdf'), Share2)}
          {action('print', tc('print'), Printer, true)}
        </div>
      </div>

      <ContractDocument contract={data} lang={lang} />

      {/* The sheet the PDF is drawn from: A4 width, flat, off screen, never
          printed, and there only while a PDF is being made. */}
      {busy !== null && createPortal(
        <div ref={sheetRef} aria-hidden className="pointer-events-none fixed top-0 -z-10 print:hidden" style={{ insetInlineStart: -10000 }}>
          <ContractDocument contract={data} lang={lang} sheet />
        </div>,
        document.body,
      )}
    </div>
  );
}
