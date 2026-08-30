#!/usr/bin/env node
/**
 * Put stock on the shelf, the way the business actually does it.
 *
 * The reference seed carries no cycles, so it carries no inventory — which is
 * correct (a cycle is the thing you are testing, not scenery) and leaves the
 * storefront showing every product as out of stock. This walks one cycle
 * through to a verified receipt so there is something to sell.
 *
 * Through the API, not the database. Stock only exists behind a cycle, a
 * purchase order, a shipping leg with real dates and a verified receipt; an
 * INSERT into `inventory_batches` would produce a batch the business could not
 * have produced, and `check-data.sh` would be right to complain about it.
 *
 *   node scripts/stock-products.mjs            # 50 of everything
 *   node scripts/stock-products.mjs 12         # 12 of everything
 *
 * Idempotent in the sense that matters: running it twice lands a second cycle
 * with more stock, which is exactly what a second shipment does.
 */

const API = process.env.API_URL ?? 'http://localhost:3001/api/v1';
const EMAIL = process.env.SEED_EMAIL ?? 'partner.a@motoparts.com';
const PASSWORD = process.env.SEED_PASSWORD ?? 'password123';

const QTY = Number(process.argv[2] ?? 50);
if (!Number.isFinite(QTY) || QTY <= 0) {
  console.error('Quantity must be a positive number.');
  process.exit(1);
}

const day = (back) => {
  const d = new Date();
  d.setDate(d.getDate() - back);
  return d.toISOString().slice(0, 10);
};

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
  if (!res.ok) {
    // The API's own explanation, not a generic failure — it is usually exact
    // about what is wrong, and hiding it would make this script the hard part.
    throw new Error(`${method} ${path} → ${res.status}\n  ${text.slice(0, 400)}`);
  }
  const json = text ? JSON.parse(text) : {};
  return json.data ?? json;
}

const say = (msg) => console.log(`\x1b[34m==>\x1b[0m ${msg}`);

async function main() {
  token = (await call('POST', 'auth/login', { email: EMAIL, password: PASSWORD })).accessToken;

  const productList = await call('GET', 'products?limit=200');
  const products = (productList.items ?? productList).filter((p) => p.status === 'ACTIVE');
  if (products.length === 0) throw new Error('No active products. Run `npm run db:reset` first.');

  const suppliers = await call('GET', 'suppliers?limit=50');
  const supplier = (suppliers.items ?? suppliers)[0];
  if (!supplier) throw new Error('No suppliers. Run `npm run db:reset` first.');

  say(`Stocking ${products.length} product(s) with ${QTY} each`);

  const cycle = await call('POST', 'cycles', { originType: 'UAE_DIRECT', currency: 'EGP' });
  say(`Cycle ${cycle.code}`);

  await call('POST', `cycles/${cycle.id}/purchases`, {
    supplierId: supplier.id,
    currency: 'EGP',
    fxRateToEgp: 1,
    orderedOn: day(30),
    // A cost, so landed cost and therefore profit are not zero. A cycle that
    // cost nothing makes every margin look perfect and tests nothing.
    items: products.map((p) => ({ productId: p.id, orderedQty: QTY, unitPrice: 60 })),
  });

  await call('POST', `cycles/${cycle.id}/shipping-legs`, {
    sequence: 1,
    origin: 'Dubai, UAE',
    destination: 'Cairo, Egypt',
    provider: 'Gulf Air Cargo',
    costBasis: 'FLAT',
    amount: 4000,
    currency: 'EGP',
    fxRateToEgp: 1,
    // A cycle cannot pass a stage its shipment has not reached, so these are
    // not decoration.
    departedOn: day(20),
    arrivedOn: day(5),
  });

  for (const status of [
    'FUNDING',
    'PURCHASING',
    'ARRIVED_UAE',
    'IN_TRANSIT_TO_EGYPT',
    'ARRIVED_EGYPT',
    'VERIFICATION',
  ]) {
    await call('POST', `cycles/${cycle.id}/transition`, { status });
  }
  say('Walked to VERIFICATION');

  const full = await call('GET', `cycles/${cycle.id}`);
  const items = full.purchaseOrders[0].items;

  await call('POST', 'receipts/verify', {
    cycleId: cycle.id,
    items: items.map((item) => ({
      purchaseOrderItemId: item.id,
      productId: item.productId,
      receivedQty: QTY,
    })),
  });
  say('Receipt verified — the stock is on the shelf');

  // Selling, so the cycle is in the state an order expects rather than one
  // still being received.
  await call('POST', `cycles/${cycle.id}/transition`, { status: 'SELLING' });

  console.log();
  const catalogue = await (await fetch(`${API}/portal/catalogue?limit=60`)).json();
  for (const item of catalogue.data.items) {
    console.log(`  ${item.sku.padEnd(12)} ${item.name.padEnd(22)} ${String(item.price).padEnd(9)} ${item.stock}`);
  }
  console.log();
  say('Reload the storefront — http://localhost:3002');
}

main().catch((err) => {
  console.error(`\n\x1b[31m✗\x1b[0m ${err.message}\n`);
  process.exit(1);
});
