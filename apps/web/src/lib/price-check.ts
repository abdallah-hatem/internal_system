'use client';

import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * Selling below cost (BUSINESS_LOGIC §4, DECIDED 2026-10-11): a warning,
 * never a refusal. The server decides it — `POST /sales/price-check`,
 * which costs each line at the FIFO units it would draw (`common/below-cost.ts`
 * in the API). Every screen that sets a selling price asks it through this
 * hook; none works the cost out for itself, so the form, a draft's confirm,
 * a request's approval and a product's price cannot disagree.
 */

export interface PriceCheckItem {
  productId: string;
  quantity: number | string;
  unitPrice: number | string;
  discount?: number | string | null;
}

export interface PriceCheckLine {
  line: number;
  productId: string;
  costed: boolean;
  reason?: 'NO_STOCK' | 'INCOMPLETE' | 'CURRENCY';
  belowCost: boolean;
  code: string | null;
  unitCostEgp: string | null;
  unitPriceEgp: string | null;
  lossEgp: string | null;
}

export interface PriceCheckResult {
  currency: string;
  compared: boolean;
  lines: PriceCheckLine[];
  belowCostLines: number;
  totalLossEgp: string;
}

/** How long the lines must sit still before they are asked about. */
const SETTLE_MS = 250;

function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * The price check for these lines, asked again whenever a product, quantity,
 * price or discount changes (once typing pauses). The answer is kept while the
 * next one loads, so a warning does not flicker away on each keystroke — but it
 * is only handed back when it is about as many lines as are on screen, so a
 * line added or removed never borrows its neighbour's warning.
 */
export function usePriceCheck(
  items: PriceCheckItem[],
  currency: string,
  { enabled = true }: { enabled?: boolean } = {},
): PriceCheckResult | undefined {
  const body = JSON.stringify({
    currency,
    items: items.map((i) => ({
      productId: i.productId,
      quantity: Number(i.quantity) || 0,
      unitPrice: Number(i.unitPrice) || 0,
      discount: Number(i.discount) || 0,
    })),
  });
  const settled = useSettled(body, SETTLE_MS);
  const anything = items.some((i) => i.productId && Number(i.quantity) > 0);

  const { data } = useQuery<PriceCheckResult>({
    queryKey: ['price-check', settled],
    queryFn: () =>
      api
        .post('/sales/price-check', JSON.parse(settled) as unknown)
        .then((r) => (r.data?.data ?? r.data) as PriceCheckResult),
    // Only once the lines have stopped moving. Enabling on the lines as they
    // are now, while the key still held the settled lines from before, sent
    // the old body: a price field going from empty to 850 was checked at a
    // price of 0, and a loss for a price nobody typed was shown until the real
    // answer came (found by spec 99-below-cost, TC-BC-07).
    enabled: enabled && anything && settled === body,
    placeholderData: keepPreviousData,
    // Stock moves with every sale: a cost read a minute ago may be gone.
    staleTime: 0,
    gcTime: 60_000,
    retry: false,
  });

  if (!enabled || !anything || !data) return undefined;
  if (data.lines.length !== items.length) return undefined;
  return data;
}
