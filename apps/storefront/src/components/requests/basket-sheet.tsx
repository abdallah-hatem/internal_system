'use client';

import { CircleAlert, Clock, LoaderCircle, ShoppingCart, Trash2 } from '@/components/ui/icons';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useState } from 'react';

import { Link } from '../../i18n/navigation';
import { useBasket, useBasketCount, useBasketHydrated } from '../../stores/basket';
import { Money } from '../ui/money';
import { Sheet, SheetBody, SheetFooter, SheetForm } from '../ui/sheet';
import { Skeleton, SkeletonRegion, SkeletonText, repeat } from '../ui/skeleton';
import { localName } from '../../lib/localized-name';
import { estimateTotal } from './decimal';
import { QuantityStepper } from './quantity-stepper';
import { useSubmitRequest } from './queries';
import { useRefusal } from './use-refusal';

/**
 * The basket, and the button that sends it.
 *
 * A sheet rather than a page, so a shop adding a fifth part does not lose its
 * place in the catalogue to check what it has already picked. It portals to
 * `document.body`: rendered where it sits, its `<form>` would land inside
 * whatever form the catalogue has around a search box, and the inner submit
 * would bubble to the outer one.
 *
 * The 48-hour hold is stated **before** the button, not after it. Sending this
 * sets stock aside that another shop then cannot be promised, and a customer
 * who only learns that from the confirmation screen was not asked.
 */

export function BasketSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations('basket');
  const tCommon = useTranslations('common');
  const tph = useTranslations('placeholders');
  const locale = useLocale();
  const refusal = useRefusal();

  const hydrated = useBasketHydrated();
  const lines = useBasket((s) => s.lines);
  const note = useBasket((s) => s.note);
  const setQuantity = useBasket((s) => s.setQuantity);
  const remove = useBasket((s) => s.remove);
  const setNote = useBasket((s) => s.setNote);
  const clear = useBasket((s) => s.clear);

  const submit = useSubmitRequest();
  // Pulled out because the mutation object is a new one on every render while
  // `reset` is stable — depending on the object would tear the Escape listener
  // down and rebuild it, and toggle the body's scroll lock, on each keystroke
  // in the note field.
  const resetSubmit = submit.reset;

  const [sent, setSent] = useState<{ id: string; requestNo: string } | null>(null);


  /**
   * One way out, used by the backdrop, the X, Escape and the confirmation.
   *
   * Every close path resets the transient state. Clearing it only on success
   * is how a refusal from last time is still on screen when the sheet is opened
   * again, over a basket that has since changed.
   */
  const close = useCallback(() => {
    setSent(null);
    resetSubmit();
    onClose();
  }, [onClose, resetSubmit]);

  if (!open) return null;

  const estimate = estimateTotal(lines);

  const send = (e: React.FormEvent) => {
    e.preventDefault();
    if (!lines.length || submit.isPending) return;

    submit.mutate(
      {
        items: lines.map((l) => ({ productId: l.productId, quantity: l.quantity })),
        note: note.trim() ? note.trim() : undefined,
      },
      {
        onSuccess: (request) => {
          // Cleared only now, with a request number in hand. A refusal — an
          // unverified shop, a line that has just sold out — leaves the basket
          // exactly as it was so the shop can act on what it is told.
          setSent({ id: request.id, requestNo: request.requestNo });
          clear();
        },
      },
    );
  };

  return (
    <Sheet open={open} onClose={close} title={t('title')}>
        {sent ? (
          <div className="flex flex-col items-center gap-4 px-6 py-10 text-center">
            <p className="text-base font-medium">{t('sent')}</p>
            <p className="font-mono text-sm text-gray-500">{sent.requestNo}</p>
            <Link
              href={`/requests/${sent.id}`}
              onClick={close}
              className="rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-medium text-white"
            >
              {t('viewRequest')}
            </Link>
          </div>
        ) : (
          <SheetForm onSubmit={send}>
            <SheetBody>
              {!hydrated ? (
                <BasketLinesSkeleton />
              ) : lines.length === 0 ? (
                <p className="py-8 text-center text-sm text-gray-500">{t('empty')}</p>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {lines.map((line) => (
                    <li key={line.productId} className="flex items-start gap-3 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-gray-900">{localName(line, locale)}</p>
                        <p className="font-mono text-xs text-gray-500">{line.sku}</p>
                        <Money
                          amount={line.unitPrice}
                          locale={locale}
                          className="text-xs text-gray-500"
                        />
                      </div>

                      <div className="flex flex-col items-end gap-1.5">
                        <QuantityStepper
                          quantity={line.quantity}
                          label={localName(line, locale)}
                          onChange={(quantity) =>
                            quantity < 1
                              ? remove(line.productId)
                              : setQuantity(line.productId, quantity)
                          }
                        />
                        <button
                          type="button"
                          onClick={() => remove(line.productId)}
                          className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-red-700"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                          {t('remove')}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {hydrated && lines.length > 0 && (
                <label className="mt-4 block">
                  <span className="text-sm font-medium text-gray-700">
                    {t('note')}{' '}
                    <span className="font-normal text-gray-400">({tCommon('optional')})</span>
                  </span>
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={3}
                    maxLength={1000}
                    placeholder={tph('basketNote')}
                    className="mt-1 w-full resize-none rounded-lg border border-gray-300 p-2 text-sm text-start outline-none focus:border-brand-600"
                  />
                </label>
              )}
            </SheetBody>

            {hydrated && lines.length > 0 && (
              <SheetFooter className="space-y-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm text-gray-600">{t('total')}</span>
                  {/* An estimate, and named as one on both sides: the label says
                      so and the note under it says why. The figure that binds is
                      the one the server puts on the order it sends back. */}
                  <Money
                    amount={estimate}
                    locale={locale}
                    className="text-lg font-semibold text-gray-900"
                  />
                </div>
                <p className="text-xs text-gray-500">{t('estimateNote')}</p>

                <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-2.5 text-xs text-amber-900">
                  <Clock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  {t('held')}
                </p>

                {submit.isError && (
                  <p
                    role="alert"
                    className="flex items-start gap-2 rounded-lg bg-red-50 p-2.5 text-xs text-red-800"
                  >
                    <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                    {refusal(submit.error)}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={submit.isPending}
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
                >
                  {submit.isPending && (
                    <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden />
                  )}
                  {t('submit')}
                </button>
              </SheetFooter>
            )}
          </SheetForm>
        )}
    </Sheet>
  );
}

/**
 * The basket's lines before the saved basket has been read back, traced from
 * the `<li>` above: name, SKU and price on the start side, the quantity
 * stepper (two 36px buttons and a 48px box inside a 1px border) and the remove
 * link on the end. Two lines — compact, since the count is not known yet.
 */
function BasketLinesSkeleton() {
  return (
    <SkeletonRegion className="divide-y divide-muted">
      {repeat(2, (i) => (
        <div key={i} data-testid="skeleton-row" className="flex items-start gap-3 py-3">
          <div className="min-w-0 flex-1">
            <SkeletonText className="w-40" />
            <SkeletonText size="xs" className="w-20" />
            {/* The price is an inline span, so its line is the block's 24px, not 16. */}
            <SkeletonText size="xs" lineClassName="h-6" className="w-16" />
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <Skeleton className="h-[38px] w-[122px] rounded-lg" />
            <SkeletonText size="xs" className="w-12" />
          </div>
        </div>
      ))}
    </SkeletonRegion>
  );
}

/**
 * The floating button that opens it, for the catalogue to drop in once.
 *
 * Kept here with the sheet so a page only has to render `<BasketLauncher />` —
 * a second copy of the open/close wiring on every screen is a second place for
 * it to be wrong. Renders nothing while the basket is empty, and nothing at all
 * until the persisted basket has been read back, so the server's "0" and the
 * client's real count never disagree on the first paint.
 */
export function BasketLauncher() {
  const t = useTranslations('basket');
  const [open, setOpen] = useState(false);
  const count = useBasketCount();
  // Stable, so the sheet's own listeners are not rebuilt on every parent render.
  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      {count > 0 && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-20 end-4 z-30 flex items-center gap-2 rounded-full bg-brand-600 px-4 py-3 text-sm font-semibold text-white shadow-lg"
          style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
        >
          <ShoppingCart className="h-5 w-5" aria-hidden />
          <span>{t('title')}</span>
          <span className="rounded-full bg-white/20 px-1.5 text-xs tabular-nums">{count}</span>
        </button>
      )}

      <BasketSheet open={open} onClose={close} />
    </>
  );
}
