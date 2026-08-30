'use client';

import { ImageOff, LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';

import { api } from '../../lib/api';
import { imageSrc } from '../catalogue/image-src';

/**
 * A photograph of somebody's brake caliper, which only they may see.
 *
 * The catalogue's `<ProductImage>` cannot be used here and the reason is not
 * styling. A catalogue image is public and an `<img src>` fetches it happily.
 * These are served from `/portal/imports/:id/photos/:assetId`, behind the
 * bearer token — an ownership check, deliberately, because a photo of a part
 * belongs to the shop that took it. The browser sends no Authorization header
 * on an image request, so a plain `<img src>` gets a 401 and renders the broken
 * glyph, which reads as "we lost your photo".
 *
 * So the bytes come through the axios client, which attaches the token like it
 * does everywhere else, and an object URL is made from the blob. That URL is a
 * document-lifetime handle to memory: not revoking it keeps every photo the
 * shop has scrolled past alive until the tab closes. It is revoked when the
 * effect tears down, which covers unmount and a changed `path` both.
 *
 * `imageSrc` resolves where the API is — it already answers exactly that
 * question for the catalogue, and there is no second answer here. `baseURL: ''`
 * stops axios prefixing its own base onto a path that is already whole; behind
 * the proxy the two share an origin and the path stands as it is.
 */
export function ImportPhoto({
  path,
  alt,
  className = '',
}: {
  path: string | null | undefined;
  alt: string;
  className?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const resolved = imageSrc(path);
    if (!resolved) {
      setFailed(true);
      return;
    }

    setSrc(null);
    setFailed(false);

    const controller = new AbortController();
    let objectUrl: string | null = null;
    // The component can unmount while the blob is still arriving. Setting state
    // then is a warning at best and a leaked object URL at worst, because the
    // cleanup that would revoke it has already run.
    let live = true;

    api
      .get<Blob>(resolved, { responseType: 'blob', baseURL: '', signal: controller.signal })
      .then((res) => {
        if (!live) return;
        objectUrl = URL.createObjectURL(res.data);
        setSrc(objectUrl);
      })
      .catch(() => {
        if (live) setFailed(true);
      });

    return () => {
      live = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  if (failed) {
    return (
      <div
        aria-hidden
        className={`flex items-center justify-center bg-gray-100 text-gray-300 ${className}`}
      >
        <ImageOff className="h-6 w-6" />
      </div>
    );
  }

  if (!src) {
    return (
      <div
        aria-hidden
        className={`flex items-center justify-center bg-gray-100 text-gray-300 ${className}`}
      >
        <LoaderCircle className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    // Not next/image: the bytes are an object URL in this tab's memory, which
    // the image optimiser has no way to fetch or resize.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} decoding="async" className={`bg-gray-100 object-cover ${className}`} />
  );
}
