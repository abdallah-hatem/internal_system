'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Smartphone } from 'lucide-react';

import { Dialog, DialogContent } from '../ui/dialog';
import { InstallGuide, useShouldOfferInstall } from './install-guide';

/**
 * The way in to the install guide, on the account screen.
 *
 * On the account tab rather than as a banner over the catalogue: a shop is
 * there to look at parts, and a prompt across the top of that is the thing
 * people learn to dismiss without reading. The account screen is where the
 * other decisions about this app already live — signing in, alerts, language.
 *
 * Renders nothing when the app is already installed. An offer to install
 * something you are running inside is noise, and it is the kind of noise that
 * makes the rest of the screen less trustworthy.
 */
export function InstallCard() {
  const t = useTranslations('install');
  const [open, setOpen] = useState(false);
  const shouldOffer = useShouldOfferInstall();

  if (!shouldOffer) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-3 rounded-2xl bg-white p-4 text-start shadow-sm ring-1 ring-gray-200/70 ring-inset transition-colors hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
          <Smartphone className="h-5 w-5" aria-hidden />
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-gray-900">{t('title')}</span>
          <span className="mt-0.5 block text-sm text-gray-500">{t('why')}</span>
        </span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto p-5">
          <InstallGuide />
        </DialogContent>
      </Dialog>
    </>
  );
}
