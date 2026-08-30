#!/usr/bin/env node
/**
 * The app icon, and every size a phone asks for.
 *
 * Generated from one description rather than checked in as four PNGs nobody can
 * change: the day the brand colour moves, an opaque binary is a dead end.
 *
 *   node scripts/make-icons.mjs
 *
 * The mark is a chain sprocket. A generic box would say "an app"; a sprocket
 * says what this shop sells, and it survives being shrunk to the 48px a home
 * screen actually renders — which is the only size that matters, however good
 * something looks at 512.
 */

import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'icons');

/** The theme colour from the manifest. One definition, stated here. */
const BRAND = '#1d4ed8';

/**
 * A sprocket, drawn in a 100×100 box centred on (50,50).
 *
 * `scale` shrinks the mark within the box without shrinking the background —
 * which is what a maskable icon needs, because Android crops the outer fifth to
 * whatever shape the launcher likes and anything out there is gone.
 */
function sprocket({ scale = 1, fill = '#ffffff' } = {}) {
  const cx = 50;
  const cy = 50;

  // A chain sprocket, not a gear. The difference matters: nine deep teeth read
  // as a settings cog, which is what the first version looked like on a home
  // screen. A sprocket has many shallow teeth and bolt holes around the hub,
  // and those two things are what make it read as a motorcycle part at 48px.
  const teeth = 16;
  const outer = 36 * scale;
  const body = 30 * scale;
  const hub = 13 * scale;
  const toothWidth = 5.2 * scale;
  const toothHeight = 8 * scale;
  const toothRadius = 1.4 * scale;

  const bolts = 5;
  const boltRadius = 2.6 * scale;
  const boltRing = 21 * scale;

  const rim = Array.from({ length: teeth }, (_, i) => {
    const angle = (360 / teeth) * i;
    return `<rect x="${cx - toothWidth / 2}" y="${cy - outer}" width="${toothWidth}" height="${toothHeight}" rx="${toothRadius}" transform="rotate(${angle} ${cx} ${cy})"/>`;
  }).join('');

  // Cut out with evenodd: the hub hole, and the bolt holes drilled through the
  // web between hub and rim.
  const holes = Array.from({ length: bolts }, (_, i) => {
    const angle = ((360 / bolts) * i - 90) * (Math.PI / 180);
    const bx = cx + boltRing * Math.cos(angle);
    const by = cy + boltRing * Math.sin(angle);
    return `M ${bx} ${by - boltRadius} a ${boltRadius} ${boltRadius} 0 1 1 -0.01 0 Z`;
  }).join(' ');

  return `
    <g fill="${fill}" fill-rule="evenodd">
      ${rim}
      <path d="
        M ${cx} ${cy - body} a ${body} ${body} 0 1 0 0.01 0 Z
        M ${cx} ${cy - hub} a ${hub} ${hub} 0 1 1 -0.01 0 Z
        ${holes}
      "/>
    </g>`;
}

/** The full square: brand background, sprocket on top. */
function icon({ scale = 1, background = BRAND } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="1024" height="1024">
    <rect width="100" height="100" fill="${background}"/>
    ${sprocket({ scale })}
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
    ${sprocket({ scale: 1.25 })}
  </svg>`;
}

const png = (svg, size) =>
  sharp(Buffer.from(svg)).resize(size, size).png({ compressionLevel: 9 }).toBuffer();

async function main() {
  await mkdir(OUT, { recursive: true });

  const square = icon();
  // 0.72 keeps the mark inside the inner 80% that every launcher shape is
  // guaranteed to show. Anything closer to the edge loses teeth to a circle.
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

  // The source, so the next person can see what these came from.
  await writeFile(join(OUT, 'icon.svg'), square);
  console.log(`  ${'icon.svg'.padEnd(24)} source`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
