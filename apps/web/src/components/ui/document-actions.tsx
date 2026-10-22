'use client';

import { useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { Download, Loader2, Printer, Share2 } from '@/components/ui/icons';

import {
  DOCUMENT_CANVAS_FONT,
  DOCUMENT_FONT_FACES,
  SHEET_MARGIN_PX,
  SHEET_WIDTH_PX,
  canPrintPdf,
  canSharePdf,
  documentToPdf,
  downloadBlob,
  printPdf,
  sharePdf,
} from '@/lib/document-pdf';
import { toast } from '@/components/ui/toast';

/**
 * Download PDF, Share PDF and Print for a printed document — the contract and
 * the invoice (owner, 2026-10-17: "invoice as well should have all the options
 * like the contract").
 *
 * The PDF is drawn from `sheet()`, the document laid out once more as a flat
 * A4 sheet: off screen, never printed, and there only while a PDF is being
 * made. Inside it the `sheet:` variant applies (globals.css), so the document
 * takes its printed layout on a phone as on a desk.
 *
 * Share appears only where the browser can share a file. Print prints the PDF
 * where the browser can, so the paper carries no browser header or footer and
 * is numbered only when there are several sheets; Safari and phones print the
 * page instead, through the print stylesheet.
 */
type PdfAction = 'download' | 'share' | 'print';

/** Whether a file can be shared does not change while the page is open. */
const noSubscribe = () => () => {};

export function DocumentActions({
  sheet,
  filename,
  title,
  pageLabel,
  dir,
  testIdPrefix,
}: {
  /** The document as an A4 sheet; rendered inside the off-screen frame. */
  sheet: () => ReactNode;
  filename: string;
  /** What the share sheet names the file. */
  title: string;
  /** "Page 1 of 3", in the document's language. */
  pageLabel: (page: number, pages: number) => string;
  dir: 'rtl' | 'ltr';
  /** `contract` gives contract-download, contract-share, contract-print. */
  testIdPrefix: string;
}) {
  const t = useTranslations('documents');
  const tc = useTranslations('common');
  const [busy, setBusy] = useState<PdfAction | null>(null);
  // False on the server, which cannot know, so the button never flashes in.
  const shareable = useSyncExternalStore(noSubscribe, canSharePdf, () => false);
  const frameRef = useRef<HTMLDivElement>(null);

  const run = async (action: PdfAction) => {
    if (busy) return;
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
      const doc = frameRef.current?.firstElementChild;
      if (!(doc instanceof HTMLElement)) throw new Error('The PDF sheet did not render.');

      const blob = await documentToPdf(doc, {
        pageLabel,
        dir,
        canvasFont: DOCUMENT_CANVAS_FONT,
        fontFaces: DOCUMENT_FONT_FACES,
      });
      if (action === 'download') downloadBlob(blob, filename);
      else if (action === 'share') await sharePdf(blob, filename, title);
      else await printPdf(blob);
    } catch {
      toast.error(t('pdfFailed'));
    } finally {
      setBusy(null);
    }
  };

  const button = (kind: PdfAction, label: string, Icon: typeof Download, primary = false) => (
    <button
      type="button"
      data-testid={`${testIdPrefix}-${kind}`}
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

  return (
    <>
      {button('download', t('downloadPdf'), Download)}
      {shareable && button('share', t('sharePdf'), Share2)}
      {button('print', tc('print'), Printer, true)}

      {busy !== null &&
        createPortal(
          <div
            ref={frameRef}
            aria-hidden
            className="pointer-events-none fixed top-0 -z-10 print:hidden"
            style={{ insetInlineStart: -10000 }}
          >
            {/* One A4 sheet's width, its side margins as padding. */}
            <div data-pdf-sheet dir={dir} className="bg-card" style={{ width: SHEET_WIDTH_PX, paddingInline: SHEET_MARGIN_PX }}>
              {sheet()}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
