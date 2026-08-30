'use client';

import { useState } from 'react';
import { ImageOff } from 'lucide-react';

import { imageSrc } from './image-src';

/**
 * A product's photograph, or an honest gap where one would be.
 *
 * Most of the catalogue has no image yet. A broken-image glyph in a grid reads
 * as a broken page, so a missing file and a missing record land on the same
 * neutral placeholder — and it is `aria-hidden`, because the product's name is
 * already next to it and a screen reader does not need to hear "no image" once
 * per card.
 */
export function ProductImage({
  src,
  alt,
  className = '',
  priority = false,
}: {
  src: string | null;
  alt: string;
  className?: string;
  priority?: boolean;
}) {
  const resolved = imageSrc(src);
  const [failed, setFailed] = useState(false);

  if (!resolved || failed) {
    return (
      <div
        aria-hidden
        className={`flex items-center justify-center bg-gray-100 text-gray-300 ${className}`}
      >
        <ImageOff className="h-8 w-8" />
      </div>
    );
  }

  return (
    // Not next/image: the images come from the API's origin, and teaching
    // next.config.ts about that host is not this screen's file to edit.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={resolved}
      alt={alt}
      loading={priority ? 'eager' : 'lazy'}
      decoding="async"
      onError={() => setFailed(true)}
      className={`bg-gray-100 object-cover ${className}`}
    />
  );
}
