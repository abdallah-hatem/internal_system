#!/usr/bin/env node
/**
 * A catalogue big enough to test against.
 *
 * The reference seed carries two products, which is right for a test suite and
 * useless for judging a storefront by eye: with two items you cannot tell
 * whether search works, whether the category filter narrows anything, or what a
 * grid of cards looks like when it wraps.
 *
 * These are ordinary motorcycle parts at ordinary Egyptian prices. Nothing here
 * is a fixture for an automated test — those build their own — so it is safe to
 * run against a database you are playing with and pointless against one you are
 * not.
 *
 *   node scripts/add-demo-products.mjs
 *
 * Skips anything already present by name, so running it twice adds nothing.
 * Follow it with `node scripts/stock-products.mjs` to put them on the shelf.
 */

const API = process.env.API_URL ?? 'http://localhost:3001/api/v1';
const EMAIL = process.env.SEED_EMAIL ?? 'partner.a@motoparts.com';
const PASSWORD = process.env.SEED_PASSWORD ?? 'password123';

/** name, category, trade price, retail price. */
const CATALOGUE = [
  ['Brake Disc, Front', 'Brakes', 850, 1200],
  ['Brake Cable', 'Brakes', 90, 140],
  ['Brake Fluid DOT 4', 'Brakes', 110, 165],
  ['Open Face Helmet', 'Helmets', 900, 1300],
  ['Helmet Visor, Clear', 'Helmets', 220, 330],
  ['Chain and Sprocket Kit', 'Brakes', 1400, 1950],
  ['Air Filter', 'Brakes', 180, 260],
  ['Spark Plug, Iridium', 'Brakes', 240, 350],
];

let token = '';

async function call(method, path, body) {
  const res = await fetch(`${API}/${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}\n  ${text.slice(0, 300)}`);
  const json = text ? JSON.parse(text) : {};
  return json.data ?? json;
}

const say = (m) => console.log(`\x1b[34m==>\x1b[0m ${m}`);

async function main() {
  token = (await call('POST', 'auth/login', { email: EMAIL, password: PASSWORD })).accessToken;

  const categories = await call('GET', 'categories');
  const byName = new Map((categories.items ?? categories).map((c) => [c.name, c.id]));

  const existing = await call('GET', 'products?limit=200');
  const have = new Set((existing.items ?? existing).map((p) => p.name));

  let added = 0;
  for (const [name, categoryName, b2b, b2c] of CATALOGUE) {
    if (have.has(name)) continue;

    const categoryId = byName.get(categoryName);
    const product = await call('POST', 'products', {
      name,
      ...(categoryId ? { categoryId } : {}),
      minStock: 5,
    });

    // Both channels, because an unpriced product cannot be asked for — the
    // storefront disables the button and the API refuses it.
    await call('POST', `products/${product.id}/prices`, {
      channel: 'B2B',
      currency: 'EGP',
      amount: b2b,
    });
    await call('POST', `products/${product.id}/prices`, {
      channel: 'B2C',
      currency: 'EGP',
      amount: b2c,
    });

    console.log(`  + ${product.sku.padEnd(12)} ${name.padEnd(24)} ${b2b} / ${b2c}`);
    added += 1;
  }

  console.log();
  say(added === 0 ? 'Everything was already there' : `Added ${added} product(s)`);
  if (added > 0) say('Now run: node scripts/stock-products.mjs');
}

main().catch((err) => {
  console.error(`\n\x1b[31m✗\x1b[0m ${err.message}\n`);
  process.exit(1);
});
