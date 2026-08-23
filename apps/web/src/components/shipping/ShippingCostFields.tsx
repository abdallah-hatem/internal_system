'use client';

import { useEffect, useState } from 'react';
import { Select } from '../ui/select';
import { MoneyInput } from '../ui/money-input';
import { useCurrencyRates } from '../../lib/currency-rates';

export type CostBasis = 'PER_PIECE' | 'PER_WEIGHT' | 'FLAT';

export interface ShippingCostDefaults {
  costBasis?: CostBasis;
  ratePerUnit?: number | string | null;
  chargeablePieces?: number | string | null;
  chargeableWeightKg?: number | string | null;
  currency?: string | null;
  fxRateToEgp?: number | string | null;
  amount?: number | string | null;
}

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Cost capture for a single shipping leg.
 *
 * Shipping is usually quoted per piece, sometimes by weight, and occasionally
 * as one agreed figure (the UAE->Egypt payment that bundles service, customs
 * and handling). The rate-based options derive the total instead of asking for
 * it, so the per-piece rate itself stays on the record.
 */
export function ShippingCostFields({
  defaults,
  namePrefix = '',
  title = 'Shipment Cost',
  orderedPieces,
}: {
  defaults?: ShippingCostDefaults;
  /** Namespace for field names so several legs can share one form. */
  namePrefix?: string;
  title?: string;
  /**
   * Total quantity ordered on the cycle, used to seed the piece count.
   *
   * It is a starting value, not the answer: this field is what the forwarder
   * billed for, which is often cartons rather than units, and a leg may carry
   * only part of the order. Those cases are the reason the number is asked for
   * at all — but the common case is "all of it, billed per unit", and there is
   * no sense making someone retype a number the order already carries.
   */
  orderedPieces?: number;
}) {
  const n = (field: string) => `${namePrefix}${field}`;
  const [basis, setBasis] = useState<CostBasis>(defaults?.costBasis ?? 'PER_PIECE');
  const [rate, setRate] = useState(String(defaults?.ratePerUnit ?? ''));
  const [pieces, setPieces] = useState(
    String(defaults?.chargeablePieces ?? (orderedPieces ? orderedPieces : '')),
  );
  const [weight, setWeight] = useState(String(defaults?.chargeableWeightKg ?? ''));
  const [amount, setAmount] = useState(String(defaults?.amount ?? ''));
  const [currency, setCurrency] = useState(defaults?.currency ?? 'EGP');
  const [fx, setFx] = useState(
    // Not `?? '1'`: a leg in AED with no rate yet would have been costed one
    // to one against the pound, silently and with no sign anything was wrong.
    defaults?.fxRateToEgp != null ? String(defaults.fxRateToEgp) : '',
  );
  const rates = useCurrencyRates();

  // Fill in the rate for the currency already on the form. A leg loaded in AED
  // should read 13.85 without the currency being re-picked; a rate already
  // stored on the leg is left exactly as it was.
  useEffect(() => {
    if (currency === 'EGP') return;
    const known = rates[currency];
    if (known == null) return;
    setFx((prev) => (prev ? prev : String(known)));
  }, [currency, rates]);

  const native =
    basis === 'PER_PIECE'
      ? num(rate) * num(pieces)
      : basis === 'PER_WEIGHT'
        ? num(rate) * num(weight)
        : num(amount);
  const egp = native * (currency === 'EGP' ? 1 : num(fx) || 1);

  const input =
    'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500';
  const label = 'block text-sm font-medium text-gray-700 mb-1';

  return (
    <div className="space-y-4 rounded-xl border border-gray-200 p-4 bg-gray-50/60">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        <span className="text-xs text-gray-500">How this leg is charged</span>
      </div>

      <div>
        <label className={label}>Charged by</label>
        <Select
          name={n('costBasis')}
          value={basis}
          onChange={(v) => setBasis(v as CostBasis)}
          options={[
            { value: 'PER_PIECE', label: 'Per piece' },
            { value: 'PER_WEIGHT', label: 'Per weight (kg)' },
            { value: 'FLAT', label: 'Flat total' },
          ]}
        />
      </div>

      {basis === 'PER_PIECE' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={label}>
              Cost per piece<span className="text-red-500 ms-1">*</span>
            </label>
            <MoneyInput
              required
              {...{ name: n('ratePerUnit') }} value={rate} onChange={setRate}
              placeholder="0.00" className={`${input} text-end`}
            />
          </div>
          <div>
            <label className={label}>
              Number of pieces<span className="text-red-500 ms-1">*</span>
            </label>
            <input
              type="number" step="0.001" min="0" required
              {...{ name: n('chargeablePieces') }} value={pieces} onChange={(e) => setPieces(e.target.value)}
              placeholder="0" className={input}
            />
            {orderedPieces ? (
              <p className="mt-1 text-xs text-gray-500">
                {num(pieces) === orderedPieces ? (
                  <>Pieces the forwarder billed for — prefilled from the {orderedPieces} ordered. Change it if they charged by carton.</>
                ) : (
                  <>
                    The order has {orderedPieces} pieces.{' '}
                    <button
                      type="button"
                      onClick={() => setPieces(String(orderedPieces))}
                      className="font-medium text-primary-600 underline underline-offset-2 hover:text-primary-700"
                    >
                      Use that
                    </button>
                  </>
                )}
              </p>
            ) : null}
          </div>
        </div>
      )}

      {basis === 'PER_WEIGHT' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={label}>
              Cost per kg<span className="text-red-500 ms-1">*</span>
            </label>
            <MoneyInput
              required
              {...{ name: n('ratePerUnit') }} value={rate} onChange={setRate}
              placeholder="0.00" className={`${input} text-end`}
            />
          </div>
          <div>
            <label className={label}>
              Total weight (kg)<span className="text-red-500 ms-1">*</span>
            </label>
            <input
              type="number" step="0.001" min="0" required
              {...{ name: n('chargeableWeightKg') }} value={weight} onChange={(e) => setWeight(e.target.value)}
              placeholder="0.000" className={input}
            />
          </div>
        </div>
      )}

      {basis === 'FLAT' && (
        <div>
          <label className={label}>
            Total shipment cost<span className="text-red-500 ms-1">*</span>
          </label>
          <MoneyInput
            required
            {...{ name: n('amount') }} value={amount} onChange={setAmount}
            placeholder="0.00" className={`${input} text-end`}
          />
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={label}>Currency</label>
          <Select
            name={n('currency')}
            value={currency}
            onChange={(v) => {
              setCurrency(v);
              // Fill in the current rate. It stays editable: a leg should be
              // costed at the rate the shipment was actually paid at.
              setFx(v === 'EGP' ? '1' : rates[v] != null ? String(rates[v]) : '');
            }}
            options={['EGP', 'USD', 'AED', 'CNY'].map((c) => ({
              value: c,
              label: c,
              hint: c === 'EGP' ? undefined : rates[c] != null ? `${rates[c]} EGP` : 'no rate set',
            }))}
          />
        </div>
        {currency !== 'EGP' && (
          <div>
            <label className={label}>
              FX rate to EGP<span className="text-red-500 ms-1">*</span>
            </label>
            <input
              type="number" step="0.0001" min="0" required
              {...{ name: n('fxRateToEgp') }} value={fx} onChange={(e) => setFx(e.target.value)}
              className={input}
            />
            <p className="mt-1 text-xs text-gray-400">
              {rates[currency] != null
                ? `Current rate: 1 ${currency} = ${rates[currency]} EGP`
                : `No rate recorded for ${currency} — enter the rate used`}
            </p>
          </div>
        )}
      </div>
      {currency === 'EGP' && <input type="hidden" {...{ name: n('fxRateToEgp') }} value="1" />}

      <div
        data-testid={`leg-cost-preview${namePrefix ? "-" + namePrefix.replace(/\W/g, "") : ""}`}
        className="flex items-center justify-between rounded-lg bg-white border border-gray-200 px-3 py-2"
      >
        <span className="text-sm text-gray-600">Leg total</span>
        <span className="text-sm font-semibold text-gray-900">
          {egp.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EGP
          {currency !== 'EGP' && (
            <span className="ms-2 text-xs font-normal text-gray-500">
              ({native.toLocaleString(undefined, { maximumFractionDigits: 2 })} {currency})
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

/** Pull the cost fields out of a submitted form into an API payload. */
export function readShippingCostFields(fd: FormData, namePrefix = '') {
  const g = (k: string) => fd.get(`${namePrefix}${k}`);
  const basis = String(g('costBasis') || 'FLAT') as CostBasis;
  const opt = (k: string) => {
    const v = g(k);
    return v === null || v === '' ? undefined : Number(v);
  };
  return {
    costBasis: basis,
    ratePerUnit: opt('ratePerUnit'),
    chargeablePieces: opt('chargeablePieces'),
    chargeableWeightKg: opt('chargeableWeightKg'),
    amount: opt('amount'),
    currency: String(g('currency') || 'EGP'),
    fxRateToEgp: opt('fxRateToEgp') ?? 1,
  };
}
