'use client';

import { Minus, Plus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

/**
 * How many of this one.
 *
 * Two things it deliberately does not do. It has no upper bound drawn from the
 * catalogue: the basket is not told how many exist, and a limit invented here
 * would either contradict the server or leak a stock count onto the screen.
 * And it never rewrites what the customer is halfway through typing — clearing
 * the box to type `12` leaves an empty string for one keystroke, and a stepper
 * that snaps that back to `1` makes the field unusable on a phone.
 *
 * `type="button"` on both buttons is not decoration. This sits inside the
 * request form, and a bare `<button>` defaults to `type="submit"`, so reaching
 * for "one more" would send the half-built request.
 */
export function QuantityStepper({
  quantity,
  onChange,
  label,
}: {
  quantity: number;
  onChange: (quantity: number) => void;
  /** Names the product, so the box is not just "Quantity" eleven times over. */
  label: string;
}) {
  const t = useTranslations('basket');
  const [draft, setDraft] = useState(String(quantity));

  // Follows the store when the change came from somewhere else — the stepper
  // buttons, or a second tab. Typing sets both, so this is a no-op then.
  useEffect(() => {
    setDraft(String(quantity));
  }, [quantity]);

  const handleTyping = (value: string) => {
    const digits = value.replace(/[^\d]/g, '');
    setDraft(digits);
    if (digits === '') return;
    onChange(Number(digits));
  };

  return (
    <div className="inline-flex items-center rounded-lg border border-gray-300 bg-white">
      <button
        type="button"
        onClick={() => onChange(quantity - 1)}
        disabled={quantity <= 1}
        aria-label={t('decrease')}
        className="flex h-9 w-9 items-center justify-center rounded-s-lg text-gray-600 disabled:text-gray-300"
      >
        <Minus className="h-4 w-4" aria-hidden />
      </button>

      <input
        type="text"
        inputMode="numeric"
        // `numeric` rather than `decimal`: the keypad the shop gets should be
        // the one that matches what this accepts.
        value={draft}
        onChange={(e) => handleTyping(e.target.value)}
        onBlur={() => setDraft(String(quantity))}
        aria-label={`${t('quantity')} — ${label}`}
        className="h-9 w-12 border-x border-gray-300 bg-transparent text-center text-sm font-medium tabular-nums outline-none focus:bg-brand-50"
      />

      <button
        type="button"
        onClick={() => onChange(quantity + 1)}
        aria-label={t('increase')}
        className="flex h-9 w-9 items-center justify-center rounded-e-lg text-gray-600"
      >
        <Plus className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
