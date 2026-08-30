'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../../lib/api';

/**
 * The shape `/portal/requests` speaks, and the four calls that use it.
 *
 * Quantities and money arrive as decimal strings and stay strings all the way
 * to the screen. `qtyApproved` is null while the request is unanswered and
 * `"0"` when the owner dropped the line — two different facts that a nullish
 * default would flatten into one.
 */

export type RequestStatus = 'PENDING' | 'APPROVED' | 'DECLINED' | 'CANCELLED';

export type RequestItem = {
  productId: string;
  name: string;
  sku: string;
  qtyRequested: string;
  qtyApproved: string | null;
  unitPrice: string;
};

export type PortalRequest = {
  id: string;
  requestNo: string;
  status: RequestStatus;
  note: string | null;
  /** The owner's reply. Why it was declined, or what changed on approval. */
  decisionNote: string | null;
  hold: {
    // Decided by the server against the server's clock. A phone set to the
    // wrong date would otherwise show a lapsed hold as still running.
    live: boolean;
    expiresAt: string | null;
    releasedAt: string | null;
  };
  items: RequestItem[];
  order: { id: string; orderNo: string; total: string; status: string } | null;
  createdAt: string;
  decidedAt: string | null;
};

export type SubmitRequestPayload = {
  items: { productId: string; quantity: number }[];
  note?: string;
};

/** One place the key is spelled, so an invalidation cannot miss by a character. */
export const requestKeys = {
  all: ['portal-requests'] as const,
  detail: (id: string) => ['portal-requests', id] as const,
};

export function useRequests() {
  return useQuery({
    queryKey: requestKeys.all,
    queryFn: async () => {
      const res = await api.get<{ data: PortalRequest[] }>('/portal/requests');
      return res.data.data;
    },
  });
}

export function useRequest(id: string) {
  return useQuery({
    queryKey: requestKeys.detail(id),
    queryFn: async () => {
      const res = await api.get<{ data: PortalRequest }>(`/portal/requests/${id}`);
      return res.data.data;
    },
    enabled: Boolean(id),
  });
}

export function useSubmitRequest() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: async (payload: SubmitRequestPayload) => {
      const res = await api.post<{ data: PortalRequest }>('/portal/requests', payload);
      return res.data.data;
    },
    onSuccess: (request) => {
      // The new request is already in hand, so seed its detail rather than make
      // the shop wait for a round trip to read what it just sent.
      client.setQueryData(requestKeys.detail(request.id), request);
      client.invalidateQueries({ queryKey: requestKeys.all });
    },
  });
}

export function useWithdrawRequest() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const res = await api.delete<{ data: PortalRequest }>(`/portal/requests/${id}`);
      return res.data.data;
    },
    onSuccess: (request) => {
      client.setQueryData(requestKeys.detail(request.id), request);
      // The list carries the hold banner and the status pill, both of which the
      // withdrawal just changed.
      client.invalidateQueries({ queryKey: requestKeys.all });
    },
  });
}
