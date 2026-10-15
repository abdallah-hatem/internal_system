'use client';

import { useQueryClient } from '@tanstack/react-query';

/*
 * What every shipment dialog shares besides the dialog itself — that is the
 * office's one dialog, `components/ui/dialog.tsx`, with its footer buttons.
 */

/**
 * Everything a shipment write can change on another screen: the panel, the
 * cycle and its status, stock, the "Receive stock" list, the shipments page and
 * every profit figure. Invalidated after each write, so nothing needs a reload.
 */
export const SHIPMENT_QUERY_KEYS = [
  'shipment',
  'cycle',
  'cycles',
  'inventory',
  'inventoryBatches',
  'landedCost',
  'analytics',
  'shipments',
];

export function useRefreshShipment() {
  const queryClient = useQueryClient();
  return () => {
    for (const key of SHIPMENT_QUERY_KEYS) {
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
  };
}

/** The input every quantity field uses: 16px on phones, no spinner, no wheel. */
export const qtyInputClass =
  'w-full min-w-0 rounded-lg border border-border bg-background px-3 py-2 text-start text-base tabular-nums focus:outline-none focus:ring-2 focus:ring-ring md:text-sm';
