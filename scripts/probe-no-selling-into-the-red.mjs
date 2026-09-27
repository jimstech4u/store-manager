/**
 * A SHOP CANNOT SELL STOCK IT DOES NOT HAVE.
 *
 * Ashabi was carrying Goldberg 60cl at minus 1,512 — not a ledger fault (every movement
 * reconciles exactly against its sale) but a till that had been allowed to sell goods nobody ever
 * booked in, two hundred times over. A negative figure is worth showing; it is not worth selling
 * against, because once the count is fiction so is every margin, valuation and reorder decision
 * computed from it.
 *
 * What this proves, as the shop's own signed-in user rather than as the database owner:
 *
 *   · selling a product that is in the red is REFUSED, with a message a seller can act on
 *   · selling within what is actually on the shelf still works
 *   · the refusal happens before anything is written — no half-made sale, no stock moved
 *   · two lines of the SAME product in one basket are judged together, so the last crate
 *     cannot be sold twice
 *
 *     node scripts/probe-no-selling-into-the-red.mjs
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);

const shop = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

let failed = 0;
const check = (name, cond, detail = '') => {
  if (!cond) failed += 1;
  console.log(`  ${cond ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const { error: authErr } = await shop.auth.signInWithPassword({
  email: env.SAMPLE_EMAIL,
  password: env.SAMPLE_PASSWORD,
});
if (authErr) throw new Error('could not sign in: ' + authErr.message);

const { data: stores } = await shop.from('stores').select('id, name').limit(1);
const store = stores?.[0];
console.log(`\nsigned in to ${store.name}\n`);

/** On-hand, read the way every other reader reads it. */
async function onHand(productId) {
  const { data } = await admin
    .from('stock_movements')
    .select('qty_delta')
    .eq('product_id', productId);
  return (data ?? []).reduce((sum, m) => sum + Number(m.qty_delta), 0);
}

const { data: products } = await admin
  .from('products')
  .select('id, name')
  .eq('store_id', store.id)
  .eq('status', 'active');

let inTheRed = null;
let inStock = null;
for (const p of products ?? []) {
  const have = await onHand(p.id);
  if (have < 0 && !inTheRed) inTheRed = { ...p, have };
  if (have > 50 && !inStock) inStock = { ...p, have };
  if (inTheRed && inStock) break;
}

const salesBefore = async () =>
  (await admin.from('sales').select('id', { count: 'exact', head: true }).eq('store_id', store.id))
    .count;

// ── A product in the red ────────────────────────────────────────────────────
if (inTheRed) {
  const before = await salesBefore();
  const { error } = await shop.rpc('record_sale', {
    p_store_id: store.id,
    p_lines: [{ product_id: inTheRed.id, qty: 1, base_qty: 1, unit_price: 100, line_total: 100 }],
  });
  check(`selling ${inTheRed.name} (at ${inTheRed.have}) is refused`, Boolean(error),
    error ? error.message : 'IT WENT THROUGH');
  check('the refusal says what to do about it',
    Boolean(error && /left to sell|Book in a delivery/i.test(error.message)),
    error?.message ?? '');
  check('and nothing was written', (await salesBefore()) === before,
    `sales ${before} → ${await salesBefore()}`);
} else {
  console.log('  SKIP  no product is in the red any more');
}

// ── A product that is genuinely on the shelf ────────────────────────────────
if (inStock) {
  const before = await salesBefore();
  const { data: saleId, error } = await shop.rpc('record_sale', {
    p_store_id: store.id,
    p_lines: [{ product_id: inStock.id, qty: 1, base_qty: 1, unit_price: 100, line_total: 100 }],
  });
  check(`selling ${inStock.name} (${inStock.have} on hand) still works`, !error,
    error?.message ?? String(saleId).slice(0, 8));
  check('and it was written', (await salesBefore()) === before + 1);

  // ── The same product twice in one basket, together exceeding the shelf ────
  const have = await onHand(inStock.id);
  const { error: twiceErr } = await shop.rpc('record_sale', {
    p_store_id: store.id,
    p_lines: [
      { product_id: inStock.id, qty: have, base_qty: have, unit_price: 1, line_total: have },
      { product_id: inStock.id, qty: 1, base_qty: 1, unit_price: 1, line_total: 1 },
    ],
  });
  check('two lines of one product are judged together, not separately',
    Boolean(twiceErr), twiceErr ? twiceErr.message.slice(0, 90) : 'THE LAST CRATE SOLD TWICE');

  // Put the shelf back: this probe is a test, not a sale.
  if (saleId) {
    const { error: voidErr } = await shop.rpc('void_sale', {
      p_sale_id: saleId,
      p_reason: 'probe: proving the negative-stock guard',
    });
    check('the probe cleaned up after itself', !voidErr, voidErr?.message ?? 'voided');
  }
} else {
  console.log('  SKIP  nothing has enough stock to test the allowed path');
}

console.log(`\n${failed} failed`);
process.exit(failed ? 1 : 0);
