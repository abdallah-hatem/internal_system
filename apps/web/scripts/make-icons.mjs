#!/usr/bin/env node
/**
 * The app icon, and every size a phone or a browser tab asks for.
 *
 * Generated from one description rather than checked in as PNGs nobody can
 * change: the day the brand colour moves, an opaque binary is a dead end.
 *
 *   node scripts/make-icons.mjs
 *
 * The mark is a crate, because that is already what this app calls itself —
 * the sidebar header has carried a `Package` on a tile since it was built.
 * This draws the same idea at a size a home screen actually renders.
 *
 * ## Why it is not the storefront's sprocket in another colour
 *
 * The two apps ship together and a person may well have both open, or both on
 * a home screen. The storefront's icon is a blue sprocket on `#1d4ed8` — and
 * `#1d4ed8` is *also* this app's `primary-700`, so "the same mark in our blue"
 * would have produced two tiles that are genuinely hard to tell apart at 48px,
 * which is the only size that matters.
 *
 * So they differ twice over, because at that size colour does most of the work
 * and silhouette does the rest:
 *
 *   storefront   round, toothed, blue     — a part you buy
 *   office       square, banded, slate    — a shipment you receive
 *
 * Slate rather than the brand blue is deliberate beyond legibility: this is the
 * internal tool, and it reading as the quieter of the two is correct.
 */

import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'icons');

/** Slate 800. Stated here once; the manifest's theme_color repeats it. */
const BRAND = '#1e293b';

/**
 * A parcel, drawn in a 100x100 box centred on (50,51).
 *
 * `scale` shrinks the mark within the box without shrinking the background,
 * which is what a maskable icon needs: Android crops the outer fifth to
 * whatever shape the launcher likes, and anything out there is gone.
 *
 * Deliberately plain. A crate with slats, tape and a shadow is a nice drawing
 * at 512 and an unreadable smudge at 48, and 48 is the size a home screen and
 * a tab strip actually use.
 */
function crate({ scale = 1, fill = '#ffffff' } = {}) {
  const cx = 50;
  const cy = 50;

  // A box with tape over it, and the tape is *thin*.
  //
  // The first attempt cut a nine-unit seam through a lid that was also offset
  // from the body, which separated the mark into two tall blocks — at 512 it
  // looked like two pillars and at 48 it looked like nothing. Straps have to
  // read as lines drawn on one solid object, not as gaps between several.
  const w = 58 * scale;
  const h = 52 * scale;
  const r = 6 * scale;
  const tape = 4.5 * scale;

  const left = cx - w / 2;
  const top = cy - h / 2;
  // Where the horizontal strap sits. Above centre, like tape across a lid
  // rather than a belt around the middle.
  const bandY = top + h * 0.34;

  return `
    <g fill="${fill}" fill-rule="evenodd">
      <path d="
        M ${left + r} ${top}
        h ${w - 2 * r}
        a ${r} ${r} 0 0 1 ${r} ${r}
        v ${h - 2 * r}
        a ${r} ${r} 0 0 1 ${-r} ${r}
        h ${-(w - 2 * r)}
        a ${r} ${r} 0 0 1 ${-r} ${-r}
        v ${-(h - 2 * r)}
        a ${r} ${r} 0 0 1 ${r} ${-r}
        Z

        M ${left} ${bandY}
        h ${w}
        v ${tape}
        h ${-w}
        Z

        M ${cx - tape / 2} ${top}
        h ${tape}
        v ${bandY - top}
        h ${-tape}
        Z
      "/>
    </g>`;
}

/** The full square: brand background, crate on top. */
function icon({ scale = 1, background = BRAND } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="1024" height="1024">
    <rect width="100" height="100" fill="${background}"/>
    ${crate({ scale })}
  </svg>`;
}

/**
 * The notification badge.
 *
 * Android draws this as a silhouette — it keeps the alpha channel and throws
 * the colours away — so it is white on transparent and carries no background.
 * A coloured badge comes out as a solid blob.
 */
function badge() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="192" height="192">
    ${crate({ scale: 1.25 })}
  </svg>`;
}

const png = (svg, size) =>
  sharp(Buffer.from(svg)).resize(size, size).png({ compressionLevel: 9 }).toBuffer();

async function main() {
  await mkdir(OUT, { recursive: true });

  const square = icon();
  // 0.72 keeps the mark inside the inner 80% every launcher shape is
  // guaranteed to show. Anything closer to the edge loses corners to a circle.
  const maskable = icon({ scale: 0.72 });

  const files = [
    ['icon-192.png', await png(square, 192)],
    ['icon-512.png', await png(square, 512)],
    ['icon-512-maskable.png', await png(maskable, 512)],
    // iOS ignores the manifest icons and takes this one, and it must not be
    // transparent — iOS composites transparency onto black.
    ['apple-touch-icon.png', await png(square, 180)],
    ['badge.png', await png(badge(), 96)],
    ['favicon-32.png', await png(square, 32)],
  ];

  for (const [name, buffer] of files) {
    await writeFile(join(OUT, name), buffer);
    console.log(`  ${name.padEnd(24)} ${(buffer.length / 1024).toFixed(1)} KB`);
  }

  await writeFile(join(OUT, 'icon.svg'), square);
  console.log(`  ${'icon.svg'.padEnd(24)} source`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
