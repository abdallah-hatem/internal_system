'use client';

import { useEffect, useState } from 'react';

import { api } from '../../lib/api';

/**
 * An image that lives behind the login.
 *
 * `/files/download` needs the bearer token and a plain `<img src>` sends no
 * headers, so it 401s and renders a broken icon. The bytes come through the
 * axios client, which attaches the token, and show from an object URL that is
 * revoked when the component goes away — without that, every thumbnail somebody
 * scrolls past stays in memory until the tab closes.
 *
 * Extracted from the product photo grid rather than copied into the second
 * screen that needed it. The storefront has its own copy because it is a
 * different app with a different client; these two are not.
 */
export function AuthedImage({
  objectKey,
  alt = '',
  className,
}: {
  objectKey: string;
  alt?: string;
  className?: string;
}) {
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
  return <img src={src} alt={alt} className={className} />;
}
