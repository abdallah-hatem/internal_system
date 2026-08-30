'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ImagePlus, Loader2, Trash2 } from 'lucide-react';

import { api } from '../../lib/api';
import { useApiError } from '../../lib/api-error';
import { useToast } from '../ui/toast';

/**
 * The photographs on a product.
 *
 * The upload pipeline, the storage, the three WebP sizes and the public route
 * that serves them to the storefront all existed before this did — so a product
 * could have a photograph only if somebody posted one with curl, and the shop
 * window was going to be a wall of grey placeholders. An API with no way to
 * reach it is a feature nobody has.
 *
 * One file at a time on purpose. A shop photograph off a phone is two or three
 * megabytes, and a batch upload that fails halfway leaves the person guessing
 * which ones landed; here each is its own attempt with its own error.
 */

/**
 * An image behind a login.
 *
 * `/files/download` needs the bearer token, and a plain `<img src>` sends no
 * headers — it would 401 and render a broken icon. So the bytes are fetched
 * through the axios client, which attaches the token, and shown from an object
 * URL that is revoked when the component goes away. Without the revoke every
 * thumbnail a person scrolls past stays in memory until the tab is closed.
 */
function AuthedImage({ objectKey, className }: { objectKey: string; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;

    api
      .get(`/files/download/${objectKey}`, { responseType: 'blob' })
      .then((res) => {
        if (cancelled) return;
        url = URL.createObjectURL(res.data);
        setSrc(url);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [objectKey]);

  if (!src) return <div className={`${className ?? ''} animate-pulse bg-gray-100`} />;
  return <img src={src} alt="" className={className} />;
}

interface Asset {
  id: string;
  objectKey: string;
  derivatives: { variant: string; objectKey: string }[];
}

export function ProductPhotos({ productId }: { productId: string }) {
  const t = useTranslations('products');
  const tc = useTranslations('common');
  const toast = useToast();
  const apiError = useApiError();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const { data: photos = [] } = useQuery<Asset[]>({
    queryKey: ['product-photos', productId],
    queryFn: () => api.get(`/files/products/${productId}`).then((r) => r.data.data ?? r.data),
    enabled: !!productId,
  });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append('file', file);
      // No explicit Content-Type: the browser has to set the multipart boundary
      // itself, and naming the type strips it.
      return api.post(`/files/products/${productId}`, form);
    },
    onSuccess: () => {
      toast.success(tc('success'));
      queryClient.invalidateQueries({ queryKey: ['product-photos', productId] });
    },
    onError: (e) => toast.error(apiError(e, tc('error'))),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/files/${id}`),
    onSuccess: () => {
      toast.success(tc('success'));
      queryClient.invalidateQueries({ queryKey: ['product-photos', productId] });
    },
    onError: (e) => toast.error(apiError(e, tc('error'))),
  });

  /** Each file its own attempt, so one failure does not take the rest with it. */
  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    for (const file of Array.from(files)) {
      await upload.mutateAsync(file).catch(() => {});
    }
    setUploading(false);
    if (fileInput.current) fileInput.current.value = '';
  };

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">{t('photos')}</h2>
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={uploading}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          {uploading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ImagePlus className="h-4 w-4" />
          )}
          {t('addPhoto')}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic"
          multiple
          className="hidden"
          onChange={(e) => onFiles(e.target.files)}
        />
      </div>

      {photos.length === 0 ? (
        <p className="py-6 text-center text-sm text-gray-400">{t('noPhotos')}</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {photos.map((photo) => {
            // The card size, not the original: this is a thumbnail grid and the
            // full-size file is several times the bytes for no visible gain.
            const card =
              photo.derivatives.find((d) => d.variant === 'CARD')?.objectKey ?? photo.objectKey;
            return (
              <li key={photo.id} className="group relative">
                <AuthedImage
                  objectKey={card}
                  className="aspect-square w-full rounded-lg border border-gray-200 object-cover"
                />
                <button
                  type="button"
                  onClick={() => remove.mutate(photo.id)}
                  aria-label={tc('delete')}
                  className="absolute end-1.5 top-1.5 rounded-lg bg-white/90 p-1.5 text-gray-500 opacity-0 shadow-sm transition-opacity hover:text-red-600 focus:opacity-100 group-hover:opacity-100"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <p className="mt-3 text-xs text-gray-400">{t('photosHint')}</p>
    </div>
  );
}
