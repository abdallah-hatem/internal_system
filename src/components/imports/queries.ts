'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '../../lib/api';
import { useSession } from '../../lib/session';

/**
 * The shape `/portal/imports` speaks, and the five calls that use it.
 *
 * The sibling feature — order requests — asks for things we already stock. This
 * one is the other half: a shop wants a part nobody has, describes it, and
 * photographs the one in their hand. Nothing is held and nothing is promised,
 * which is why an unverified shop may send one. Nothing in this file, or in any
 * component that reads it, looks at `verified`.
 *
 * `quantity` arrives as a decimal string or null and stays a string all the way
 * to the screen, the same as every other quantity in this app. Null is "they
 * did not say", which is a different fact from zero and must not be flattened
 * into one by a nullish default.
 */

export type ImportStatus =
  | 'PENDING'
  | 'SOURCING'
  | 'ANSWERED'
  | 'DECLINED'
  /** The shop withdrew it. Deliberately not DECLINED — being turned down and
      changing your own mind are different things to read about yourself. */
  | 'CANCELLED';

export type ImportPhoto = {
  id: string;
  /**
   * An API **path**, not a URL — `/api/v1/portal/imports/<id>/photos/<assetId>`.
   * It is also behind the bearer token, so it cannot be handed to an `<img>`.
   * `photo.tsx` is the one place that turns it into something renderable.
   */
  url: string;
};

export type ImportRequest = {
  id: string;
  productName: string;
  compatibilityText: string | null;
  notes: string | null;
  supplierUrl: string | null;
  quantity: string | null;
  status: ImportStatus;
  /** The owner's reply — what was found, what it will cost, or why not. */
  decisionNote: string | null;
  photos: ImportPhoto[];
  /** Set once the part is stocked, so "you asked for this" leads to buying it. */
  product: { id: string; sku: string; name: string } | null;
  createdAt: string;
  decidedAt: string | null;
};

export type CreateImportPayload = {
  productName: string;
  compatibilityText?: string;
  quantity?: number;
  supplierUrl?: string;
  notes?: string;
};

/** One place the key is spelled, so an invalidation cannot miss by a character. */
export const importKeys = {
  all: ['portal-imports'] as const,
  detail: (id: string) => ['portal-imports', id] as const,
};

/**
 * Photos can still be added while the owner is looking, not only before.
 *
 * The API allows PENDING and SOURCING; this says the same thing on this side so
 * the button is absent rather than present and refused. It is not a second
 * definition of the rule — the API is still the one that decides, and a stale
 * tab that posts anyway gets REQUEST_ALREADY_DECIDED and shows it.
 */
export function acceptsPhotos(status: ImportStatus): boolean {
  return status === 'PENDING' || status === 'SOURCING';
}

/** Only an unanswered request can be taken back. */
export function canWithdraw(status: ImportStatus): boolean {
  return status === 'PENDING';
}

export function useImports() {
  const { signedIn, ready } = useSession();

  return useQuery({
    queryKey: importKeys.all,
    queryFn: async () => {
      const res = await api.get<{ data: ImportRequest[] }>('/portal/imports');
      return res.data.data;
    },
    // Asked for only once the browser has said whether there is a token. Firing
    // on the server's signed-out snapshot spends a request to be told 401, and
    // the screen would flash a refusal at a shop that is signed in perfectly
    // well.
    enabled: ready && signedIn,
  });
}

export function useImport(id: string) {
  const { signedIn, ready } = useSession();

  return useQuery({
    queryKey: importKeys.detail(id),
    queryFn: async () => {
      const res = await api.get<{ data: ImportRequest }>(`/portal/imports/${id}`);
      return res.data.data;
    },
    enabled: Boolean(id) && ready && signedIn,
  });
}

export function useCreateImport() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: async (payload: CreateImportPayload) => {
      const res = await api.post<{ data: ImportRequest }>('/portal/imports', payload);
      return res.data.data;
    },
    onSuccess: (request) => {
      // The record is already in hand, so seed its detail rather than make the
      // shop wait for a round trip to read back what it just typed. The photo
      // step opens on this immediately.
      client.setQueryData(importKeys.detail(request.id), request);
      client.invalidateQueries({ queryKey: importKeys.all });
    },
  });
}

/**
 * One photo, one call.
 *
 * Deliberately not part of creating the request: a shop on a workshop
 * connection uploading three photos must not lose the text they typed because
 * the second one timed out. The request exists first and each photo is its own
 * attempt, which is what makes a single failed photo retryable on its own.
 *
 * Every response carries the whole request back, so the caches are written from
 * the server's answer rather than from a guess about what the upload did.
 */
export function useAddPhoto() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      file,
      onProgress,
      signal,
    }: {
      id: string;
      file: File;
      onProgress?: (percent: number) => void;
      signal?: AbortSignal;
    }) => {
      const body = new FormData();
      body.append('file', file);

      const res = await api.post<{ data: ImportRequest }>(`/portal/imports/${id}/photos`, body, {
        signal,
        // No explicit Content-Type: the boundary is part of it, and setting the
        // header by hand drops the boundary and the API parses nothing.
        onUploadProgress: (event) => {
          if (!onProgress) return;
          // `total` is absent on some browsers for a streamed body. Reporting a
          // fabricated percentage would show a bar that lies; the caller shows
          // an indeterminate state instead.
          if (!event.total) return;
          onProgress(Math.round((event.loaded / event.total) * 100));
        },
      });
      return res.data.data;
    },
    onSuccess: (request) => {
      client.setQueryData(importKeys.detail(request.id), request);
      // The list shows a thumbnail, so it changed too.
      client.invalidateQueries({ queryKey: importKeys.all });
    },
  });
}

export function useWithdrawImport() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const res = await api.delete<{ data: ImportRequest }>(`/portal/imports/${id}`);
      return res.data.data;
    },
    onSuccess: (request) => {
      client.setQueryData(importKeys.detail(request.id), request);
      client.invalidateQueries({ queryKey: importKeys.all });
    },
  });
}
