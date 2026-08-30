// A plain default import, which needs `esModuleInterop`. That flag was absent
// from this tsconfig — only `allowSyntheticDefaultImports`, which silences the
// type error without emitting the interop helper — so `import sharp from
// 'sharp'` compiled to `sharp_1.default`, which is undefined at runtime for a
// CommonJS module. Every valid photograph was refused as "not an image".
import sharp, { type Metadata } from 'sharp';

import { badRequest } from '../../common/api-error';

/**
 * Turning whatever arrived into images we are willing to serve.
 *
 * The endpoint this feeds used to write any buffer to disk with the mime type
 * and size the caller claimed. That was survivable while only the office could
 * reach it. It stops being survivable the day a stranger can post to it, which
 * is what the storefront's "here is a photo of the part I want" does.
 *
 * The type check is not what makes this safe — a re-encode is. A file that
 * survives being decoded and written back out as WebP is an image, whatever its
 * extension claimed and whatever was hidden in its metadata. An SVG with a
 * script in it does not survive; a renamed executable does not survive; and the
 * GPS coordinates in a phone photo do not survive either, which matters because
 * a shop owner has not agreed to tell us where they were standing.
 */

/** Bigger than any photograph of a brake pad needs to be. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

/**
 * What we are prepared to decode.
 *
 * SVG is absent deliberately: it is a document that can carry script, not a
 * photograph, and sharp will happily rasterise one.
 */
const ACCEPTED = new Set(['jpeg', 'jpg', 'png', 'webp', 'heif', 'heic', 'avif']);

export interface Derivative {
  variant: 'ORIGINAL' | 'CARD' | 'THUMB';
  bytes: Buffer;
  width: number;
  height: number;
  mimeType: 'image/webp';
}

/** The widths a catalogue actually renders at. */
const SIZES = [
  { variant: 'ORIGINAL' as const, width: 1600, quality: 82 },
  { variant: 'CARD' as const, width: 800, quality: 80 },
  { variant: 'THUMB' as const, width: 200, quality: 75 },
];

export async function processImage(input: Buffer): Promise<Derivative[]> {
  if (input.length === 0) {
    throw badRequest('FILE_EMPTY', 'That file is empty.');
  }
  if (input.length > MAX_UPLOAD_BYTES) {
    throw badRequest('FILE_TOO_LARGE', 'That image is larger than 8 MB.', {
      maxMb: 8,
    });
  }

  let meta: Metadata;
  try {
    meta = await sharp(input).metadata();
  } catch (err) {
    // Narrow on purpose. The first version caught everything and answered
    // "that is not an image", which is what a broken `sharp` import looked
    // like from the outside: every valid photograph refused, with a message
    // pointing at the file rather than at the code. A catch that can only
    // report one cause must only catch that cause.
    if (err instanceof TypeError || err instanceof ReferenceError) throw err;
    throw badRequest('FILE_NOT_AN_IMAGE', 'That file is not an image we can read.');
  }

  // The format sharp actually found, not the extension or the declared type.
  if (!meta.format || !ACCEPTED.has(meta.format)) {
    throw badRequest('FILE_NOT_AN_IMAGE', 'That file is not an image we can read.', {
      format: meta.format ?? 'unknown',
    });
  }

  // A decompression bomb: small on disk, enormous once decoded.
  const pixels = (meta.width ?? 0) * (meta.height ?? 0);
  if (pixels > 50_000_000) {
    throw badRequest('FILE_TOO_LARGE', 'That image has too many pixels to process.');
  }

  const out: Derivative[] = [];
  for (const size of SIZES) {
    const pipeline = sharp(input, { failOn: 'error' })
      // `withoutEnlargement` so a small photo is not upscaled into a blurry
      // one just to fill a slot it was never big enough for.
      .rotate() // Applies the EXIF orientation before the metadata is dropped.
      .resize({ width: size.width, withoutEnlargement: true })
      .webp({ quality: size.quality });

    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    out.push({
      variant: size.variant,
      bytes: data,
      width: info.width,
      height: info.height,
      mimeType: 'image/webp',
    });
  }

  return out;
}
