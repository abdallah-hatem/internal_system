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

  const known = rates[currency];

  // Fill an empty rate for whatever currency is showing, including one that
  // arrived already selected — a form opened on AED should read 13.85 without
  // being made to re-pick the currency it is already set to. Rates arrive
  // asynchronously, so this cannot be done in useState.
  //
  // An existing value is never touched: a saved document keeps the rate it was
  // agreed at. Changing the currency replaces it (see onChange) because the
  // old rate belongs to the old currency.
  useEffect(() => {
    if (known == null) return;
    setRate((prev) => (prev ? prev : String(known)));
  }, [known]);

  const isBase = currency === 'EGP';

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700">{currencyLabel}</label>
        <Select
          name={currencyName}
          value={currency}
          onChange={(v) => {
            setCurrency(v);
            // A rate for the previous currency is meaningless under the new
            // one, so this replaces rather than fills.
            setRate(rates[v] != null ? String(rates[v]) : '');
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
