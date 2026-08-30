'use client';

import { CircleAlert, LoaderCircle, Plus, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';

import { Link } from '../../i18n/navigation';
import { useSession } from '../../lib/session';
import { PhotoUploader } from './photo-uploader';
import { useCreateImport, useImport, type ImportRequest } from './queries';
import { useRefusal } from '../requests/use-refusal';

/**
 * "Bring me this." The form, and then the photographs of it.
 *
 * Two steps in one sheet, and the order matters. The text is saved first and
 * the photos are attached to a request that by then exists, which is the whole
 * reason the API splits the two calls: a shop on a workshop connection whose
 * second photo times out has still asked for the part. Going back is not
 * offered from the photo step because there is nothing to go back to — the
 * request is stored, and the detail screen is where it is edited from here.
 *
 * It portals to `document.body`. Rendered where it sits, its `<form>` would
 * land inside whatever form the page around it has, which is invalid markup and
 * makes the inner submit bubble to the outer one.
 */

/** What the API's DTO will take. Refusing here saves a round trip, nothing more. */
const LIMITS = { name: 200, fits: 500, link: 2000, notes: 1000 };
const MIN_NAME = 2;

const CONTROL =
  'block min-h-11 w-full rounded-xl border bg-white px-3 py-2.5 text-base text-start ' +
  'placeholder:text-gray-400 focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-brand-600';

/**
 * A link the way a shop types it.
 *
 * The API validates `supplierUrl` with `require_protocol`, so `example.com/part`
 * — which is what a thumb types — is refused outright. Rather than teach a shop
 * about schemes, one is added and **written back into the field**, so what is
 * about to be sent is on screen before the button is pressed. Nothing is
 * changed silently; a value that still is not a URL is refused here with a
 * sentence, not by the server with a code.
 */
export function normaliseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * A link we are prepared to hand a shop a tappable anchor for.
 *
 * `http` and `https` only. The API validates with `class-validator`, which
 * accepts `ftp://` as a URL, and a stored `javascript:` would be a URL too;
 * neither is a link to a part, and one of them is an XSS waiting for somebody
 * to render it into an `href`. The detail screen shows anything else as plain
 * text rather than as something to press.
 */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    // A `mailto:` or a `javascript:` is a URL and is not a link to a part.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return url.hostname.includes('.') && !url.hostname.startsWith('.');
  } catch {
    return false;
  }
}

/**
 * The button on the list, and the sheet it opens.
 *
 * Absent while nobody is signed in, and absent until the browser has said so —
 * the same shape the basket launcher uses. A button that opens a form which can
 * only ever be refused with a 401 is a worse answer than no button, and the
 * card underneath already says where to sign in.
 *
 * It is *not* absent for a shop that has not been verified. That is the whole
 * point of this feature: it holds no stock and promises nothing, so it is the
 * one thing an account signed up this morning can do.
 */
export function AskForPart() {
  const t = useTranslations('imports');
  const { signedIn, ready } = useSession();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  if (!ready || !signedIn) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 text-base font-semibold text-white hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
      >
        <Plus className="h-5 w-5" aria-hidden />
        {t('ask')}
      </button>

      <AskSheet open={open} onClose={close} />
    </>
  );
}

function AskSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations('imports');
  const tCommon = useTranslations('common');
  const refusal = useRefusal();

  const create = useCreateImport();
  const resetCreate = create.reset;

  const [productName, setProductName] = useState('');
  const [fits, setFits] = useState('');
  const [quantity, setQuantity] = useState('');
  const [link, setLink] = useState('');
  const [notes, setNotes] = useState('');
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [sent, setSent] = useState<ImportRequest | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  /**
   * One way out, used by the backdrop, the X, Escape and "done".
   *
   * Every close path clears the transient state, not just the successful one.
   * Clearing on success alone is how a refusal from last time is still sitting
   * on screen when the sheet is opened again, over a form that has since been
   * emptied.
   */
  const close = useCallback(() => {
    setProductName('');
    setFits('');
    setQuantity('');
    setLink('');
    setNotes('');
    setProblems({});
    setSent(null);
    resetCreate();
    onClose();
  }, [onClose, resetCreate]);

  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);

    // The sheet scrolls; the list behind it must not, or a thumb drag near the
    // edge scrolls the wrong thing.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, close]);

  if (!open || !mounted) return null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;

    const found: Record<string, string> = {};

    const name = productName.trim();
    if (name.length < MIN_NAME) found.productName = t('nameNeeded');

    // Written back into the field, so the scheme that is about to be sent is
    // visible rather than added behind the shop's back.
    const url = normaliseUrl(link);
    if (url !== link) setLink(url);
    if (url && !isHttpUrl(url)) found.link = t('linkNotValid');

    // `quantity` is a count of parts. A phone's number pad offers a minus and a
    // decimal point; the API refuses both, and being told so here is quicker.
    const wanted = quantity.trim();
    let count: number | undefined;
    if (wanted) {
      const parsed = Number(wanted);
      if (!Number.isFinite(parsed) || parsed <= 0) found.quantity = t('quantityNotValid');
      else count = parsed;
    }

    setProblems(found);
    if (Object.keys(found).length > 0) return;

    create.mutate(
      {
        productName: name,
        compatibilityText: fits.trim() || undefined,
        quantity: count,
        supplierUrl: url || undefined,
        notes: notes.trim() || undefined,
      },
      // Only now is the form done with. A refusal leaves every field exactly as
      // it was typed, which is the point of saving the text before the photos.
      { onSuccess: (request) => setSent(request) },
    );
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <button
        type="button"
        aria-label={tCommon('close')}
        onClick={close}
        className="absolute inset-0 bg-gray-900/40"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ask-title"
        className="relative flex max-h-[92dvh] w-full flex-col rounded-t-2xl bg-white shadow-xl sm:mx-auto sm:max-w-lg"
      >
        <header className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
          <h2 id="ask-title" className="text-base font-semibold">
            {sent ? t('addPhotosTitle') : t('askTitle')}
          </h2>
          <button
            type="button"
            onClick={close}
            aria-label={tCommon('close')}
            className="-me-1 flex h-11 w-11 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </header>

        {sent ? (
          <SentStep request={sent} onDone={close} />
        ) : (
          <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
              <p className="text-sm text-gray-600">{t('intro')}</p>

              <Field
                label={t('productName')}
                value={productName}
                onChange={setProductName}
                error={problems.productName}
                hint={t('productNameHint')}
                maxLength={LIMITS.name}
                required
              />

              <Field
                label={t('fits')}
                value={fits}
                onChange={setFits}
                hint={t('fitsHint')}
                maxLength={LIMITS.fits}
                optional
              />

              <Field
                label={t('quantity')}
                value={quantity}
                onChange={setQuantity}
                error={problems.quantity}
                inputMode="numeric"
                maxLength={9}
                optional
              />

              <Field
                label={t('link')}
                value={link}
                onChange={setLink}
                onBlur={() => setLink((value) => normaliseUrl(value))}
                error={problems.link}
                inputMode="url"
                maxLength={LIMITS.link}
                optional
              />

              <label className="block space-y-1.5">
                <span className="block text-sm font-medium text-gray-700">
                  {t('notes')}{' '}
                  <span className="font-normal text-gray-400">({tCommon('optional')})</span>
                </span>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                  maxLength={LIMITS.notes}
                  dir="auto"
                  className="w-full resize-none rounded-xl border border-gray-300 p-3 text-base text-start outline-none focus:border-brand-600"
                />
              </label>

              {/* The photos are asked for on the next step and said so here, so
                  a shop holding the part knows the camera is coming and does not
                  put it down. */}
              <p className="rounded-xl bg-brand-50 p-3 text-xs text-gray-700">
                {t('photosNext')}
              </p>
            </div>

            <footer className="space-y-3 border-t border-gray-200 px-4 py-3">
              {create.isError && (
                <p
                  role="alert"
                  className="flex items-start gap-2 rounded-lg bg-red-50 p-2.5 text-xs text-red-800"
                >
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  <span>{refusal(create.error)}</span>
                </p>
              )}

              <button
                type="submit"
                disabled={create.isPending}
                className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand-600 px-4 text-base font-semibold text-white disabled:opacity-60"
              >
                {create.isPending && <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />}
                {t('submit')}
              </button>
            </footer>
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Saved. Now the part in their hand.
 *
 * The request is read back from the cache rather than used as it was handed
 * over. `useCreateImport` seeded that entry with this very record, so there is
 * nothing to wait for — but each photo that lands writes the server's answer
 * into it, and a component holding the value it was given at mount would show
 * an empty grid under a progress bar that had already finished.
 */
function SentStep({ request, onDone }: { request: ImportRequest; onDone: () => void }) {
  const t = useTranslations('imports');
  const { data } = useImport(request.id);
  const live = data ?? request;

  return (
    <>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <div className="rounded-xl bg-green-50 p-3">
          <p className="text-sm font-medium text-green-900">{t('sent')}</p>
          <p dir="auto" className="mt-0.5 text-sm text-green-900/80">
            {live.productName}
          </p>
        </div>

        <PhotoUploader request={live} />
      </div>

      <footer className="flex gap-2 border-t border-gray-200 px-4 py-3">
        <Link
          href={`/imports/${request.id}`}
          onClick={onDone}
          className="flex min-h-12 flex-1 items-center justify-center rounded-xl bg-white px-4 text-sm font-medium text-gray-700 ring-1 ring-gray-200 ring-inset"
        >
          {t('viewRequest')}
        </Link>
        <button
          type="button"
          onClick={onDone}
          className="min-h-12 flex-1 rounded-xl bg-brand-600 px-4 text-sm font-semibold text-white"
        >
          {t('done')}
        </button>
      </footer>
    </>
  );
}

function Field({
  label,
  value,
  onChange,
  onBlur,
  error,
  hint,
  optional,
  required,
  inputMode,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  error?: string;
  hint?: string;
  optional?: boolean;
  required?: boolean;
  inputMode?: 'text' | 'numeric' | 'url';
  maxLength?: number;
}) {
  const tCommon = useTranslations('common');
  // `useId`, not the label: a translated label carries spaces, and an id with a
  // space in it matches nothing, so `htmlFor` and `aria-describedby` would both
  // point at nowhere on the Arabic screen this app opens in by default.
  const id = useId();
  const describedBy = [error ? `${id}-error` : null, hint ? `${id}-hint` : null]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-gray-700">
        {label}{' '}
        {optional && <span className="font-normal text-gray-400">({tCommon('optional')})</span>}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        inputMode={inputMode}
        maxLength={maxLength}
        // `aria-required`, not `required`. The native attribute answers an empty
        // field with the browser's own bubble, written in the browser's UI
        // language — which on a phone set to English says "Please fill out this
        // field" over an Arabic form, and suppresses the sentence underneath
        // that this app translated. The rule is still enforced, in `submit`.
        aria-required={required || undefined}
        // `dir="auto"` rather than the page direction: a part number and a link
        // are Latin text, and forcing them right-to-left puts the cursor and the
        // punctuation in the wrong place on an Arabic screen. An Arabic
        // description in the same field still reads right-to-left.
        dir="auto"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={`${CONTROL} ${error ? 'border-red-400' : 'border-gray-300'}`}
      />
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-gray-500">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-xs font-medium text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
