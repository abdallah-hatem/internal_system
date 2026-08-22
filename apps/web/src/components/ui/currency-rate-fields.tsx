'use client';

import { useEffect, useState } from 'react';
import { Select } from './select';
import { useCurrencyRates } from '../../lib/currency-rates';

/**
 * A currency picker and the rate that converts it to EGP, as one control.
 *
 * They were two independent fields, so the rate had to be looked up and typed
 * on every document — and a slip there is silent: it does not fail, it just
 * misstates a landed cost and every profit figure downstream of it.
 *
 * Picking a currency now fills in the current rate. It stays editable, because
 * the rate that matters is the one the deal was actually struck at, not
 * today's; the stored rate is a starting point, not a lock. EGP is fixed at 1
 * and the field steps aside, since converting EGP to EGP is not a question
 * anyone should be asked.
 */
export function CurrencyRateFields({
  currencyName = 'currency',
  rateName,
  currencies,
  defaultCurrency,
  defaultRate,
  currencyLabel,
  rateLabel,
  required,
}: {
  currencyName?: string;
  rateName: string;
  currencies: string[];
  defaultCurrency: string;
  defaultRate?: string | number;
  currencyLabel: string;
  rateLabel: string;
  required?: boolean;
}) {
  const rates = useCurrencyRates();
  const [currency, setCurrency] = useState(defaultCurrency);
  const [rate, setRate] = useState(defaultRate != null ? String(defaultRate) : '');
  // Only auto-fill when the user changes currency — not on first render, which
  // would overwrite a rate loaded from the document being edited.
  const [touched, setTouched] = useState(false);

  const known = rates[currency];

  useEffect(() => {
    if (!touched) return;
    setRate(known != null ? String(known) : '');
  }, [currency, known, touched]);

  const isBase = currency === 'EGP';

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700">{currencyLabel}</label>
        <Select
          name={currencyName}
          value={currency}
          onChange={(v) => {
            setTouched(true);
            setCurrency(v);
          }}
          options={currencies.map((c) => ({
            value: c,
            label: c,
            hint: c === 'EGP' ? undefined : rates[c] != null ? `${rates[c]} EGP` : 'no rate set',
          }))}
        />
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700">
          {rateLabel}
          {required && !isBase ? <span className="ms-1 text-red-500">*</span> : null}
        </label>
        {isBase ? (
          <>
            <input type="hidden" name={rateName} value="1" />
            <p className="px-3 py-2 text-sm text-gray-400">1.0000 — base currency</p>
          </>
        ) : (
          <>
            <input
              type="number"
              step="0.0001"
              min="0"
              name={rateName}
              required={required}
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              placeholder={known != null ? String(known) : '0'}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
            <p className="mt-1 text-xs text-gray-400">
              {known != null
                ? `Current rate: 1 ${currency} = ${known} EGP`
                : `No rate recorded for ${currency} — enter the rate used`}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
