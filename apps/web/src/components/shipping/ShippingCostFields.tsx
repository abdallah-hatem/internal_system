'use client';

import { useState } from 'react';

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
}: {
  defaults?: ShippingCostDefaults;
  /** Namespace for field names so several legs can share one form. */
  namePrefix?: string;
  title?: string;
}) {
  const n = (field: string) => `${namePrefix}${field}`;
  const [basis, setBasis] = useState<CostBasis>(defaults?.costBasis ?? 'PER_PIECE');
  const [rate, setRate] = useState(String(defaults?.ratePerUnit ?? ''));
  const [pieces, setPieces] = useState(String(defaults?.chargeablePieces ?? ''));
  const [weight, setWeight] = useState(String(defaults?.chargeableWeightKg ?? ''));
  const [amount, setAmount] = useState(String(defaults?.amount ?? ''));
  const [currency, setCurrency] = useState(defaults?.currency ?? 'EGP');
  const [fx, setFx] = useState(String(defaults?.fxRateToEgp ?? '1'));

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
        <select
          {...{ name: n('costBasis') }}
          value={basis}
          onChange={(e) => setBasis(e.target.value as CostBasis)}
          className={input}
        >
          <option value="PER_PIECE">Per piece</option>
          <option value="PER_WEIGHT">Per weight (kg)</option>
          <option value="FLAT">Flat total</option>
        </select>
      </div>

      {basis === 'PER_PIECE' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={label}>
              Cost per piece<span className="text-red-500 ms-1">*</span>
            </label>
            <input
              type="number" step="0.0001" min="0" required
              {...{ name: n('ratePerUnit') }} value={rate} onChange={(e) => setRate(e.target.value)}
              placeholder="0.0000" className={input}
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
          </div>
        </div>
      )}

      {basis === 'PER_WEIGHT' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={label}>
              Cost per kg<span className="text-red-500 ms-1">*</span>
            </label>
            <input
              type="number" step="0.0001" min="0" required
              {...{ name: n('ratePerUnit') }} value={rate} onChange={(e) => setRate(e.target.value)}
              placeholder="0.0000" className={input}
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
          <input
            type="number" step="0.01" min="0" required
            {...{ name: n('amount') }} value={amount} onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00" className={input}
          />
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={label}>Currency</label>
          <select
            {...{ name: n('currency') }} value={currency}
            onChange={(e) => {
              setCurrency(e.target.value);
              if (e.target.value === 'EGP') setFx('1');
            }}
            className={input}
          >
            <option value="EGP">EGP</option>
            <option value="USD">USD</option>
            <option value="AED">AED</option>
            <option value="CNY">CNY</option>
          </select>
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
