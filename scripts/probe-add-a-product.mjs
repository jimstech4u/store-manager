/**
 * ADDING A PRODUCT THE WAY THE FORM ADDS ONE.
 *
 * Reported from the counter: adding "Zetar", sold by the pack at N6,000 with 50 packs on the
 * shelf, failed with "Not saved — column low_stock_unit_id of relation products does not exist".
 * The whole form went down, not just the low-stock box, because it saves the level on every save.
 *
 * This walks the same calls in the same order the form makes them, so the failure it reproduces
 * is the one a shop hits. It cleans up after itself.
 *
 *     node scripts/probe-add-a-product.mjs
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
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const { error: authErr } = await shop.auth.signInWithPassword({
  email: env.SAMPLE_EMAIL,
  password: env.SAMPLE_PASSWORD,
});
if (authErr) throw new Error('could not sign in: ' + authErr.message);

const { data: stores } = await shop.from('stores').select('id, name').limit(1);
const store = stores[0];
const name = `ZZ Probe Zetar ${Math.floor(Math.random() * 1e6)}`;
console.log(`\nadding "${name}" to ${store.name}\n`);

let productId = null;
try {
  const { data: id, error } = await shop.rpc('create_product', {
    p_store_id: store.id,
    p_name: name,
    p_base_unit: 'piece',
    p_pack_name: null,
    p_pack_qty: null,
    p_list_price: null,
    p_price_per_pack: false,
  });
  check('the product is created', !error, error?.message ?? '');
  productId = id;

  // A pack of twelve at N6,000, with the piece inside it not offered at the counter.
  const { data: unitRows } = await admin
    .from('store_units').select('id, name').eq('store_id', store.id).in('name', ['Pack', 'Piece']);
  const pack = (unitRows ?? []).find((u) => u.name === 'Pack');
  const piece = (unitRows ?? []).find((u) => u.name === 'Piece');
  check('the shop has Pack and Piece to measure in', Boolean(pack && piece));

  const { error: uErr } = await shop.rpc('save_product_units', {
    p_product_id: productId,
    p_units: [
      {
        id: null, store_unit_id: pack.id, is_bought: true, is_counted: true, is_deposit: false,
        is_sold: true, sell_price: 6000, is_returnable: false, whole_digit: true,
        allow_quarter: false, allow_half: true, allow_three_quarter: false,
        defined_against: null, defined_qty: null, base_qty: 12, sort_order: 0,
      },
      {
        id: null, store_unit_id: piece.id, is_bought: false, is_counted: true, is_deposit: false,
        is_sold: false, sell_price: null, is_returnable: false, whole_digit: true,
        allow_quarter: false, allow_half: false, allow_three_quarter: false,
        defined_against: null, defined_qty: null, base_qty: 1, sort_order: 1,
      },
    ],
  });
  check('its shapes save, with the price on the pack', !uErr, uErr?.message ?? '');

  // THE CALL THAT WAS FAILING. The form makes it on every save, so it took the whole form down.
  const { error: lowErr } = await shop.rpc('set_product_low_stock', {
    p_product_id: productId,
    p_level: 24,
    p_unit_id: pack.id,
  });
  check('the low-stock level saves', !lowErr, lowErr?.message ?? '');

  const { error: stockErr } = await shop.rpc('open_stock_by_count', {
    p_store_id: store.id,
    p_product_id: productId,
    p_qty: 600,                     // 50 packs of twelve
    p_unit_cost: null,
    p_note: 'Opening count',
    p_batches: null,
  });
  check('fifty packs land on the shelf', !stockErr, stockErr?.message ?? '');

  // ── And it reads back the way the form will open it ──────────────────────
  const { data: back, error: backErr } = await shop.rpc('product_units_for', {
    p_product_id: productId,
  });
  check('the form can read its shapes back', !backErr, backErr?.message ?? '');
  const readPack = (back ?? []).find((u) => u.name === 'Pack');
  check('and the price it just saved comes back',
    Number(readPack?.sell_price) === 6000, `got ${readPack?.sell_price}`);
  check('the piece is not offered for sale',
    (back ?? []).find((u) => u.name === 'Piece')?.is_sold === false);

  const { data: onHand } = await admin
    .from('stock_movements').select('qty_delta').eq('product_id', productId);
  check('and the shelf says six hundred',
    (onHand ?? []).reduce((s, m) => s + Number(m.qty_delta), 0) === 600);

  const { data: levels } = await admin
    .from('product_low_stock_levels').select('level').eq('product_id', productId);
  check('the level is kept per shape, in that shape',
    Number((levels ?? [])[0]?.level) === 2, `24 base / 12 a pack = 2 packs, got ${(levels ?? [])[0]?.level}`);
} finally {
  if (productId) {
    await admin.from('product_low_stock_levels').delete().eq('product_id', productId);
    await admin.from('stock_movements').delete().eq('product_id', productId);
    await admin.from('stock_layers').delete().eq('product_id', productId);
    await admin.from('stock_periods').delete().eq('product_id', productId);
    await admin.from('product_units').delete().eq('product_id', productId);
    await admin.from('products').delete().eq('id', productId);
    console.log('\n  (the probe product was removed)');
  }
}

console.log(`\n${failed} failed`);
process.exit(failed ? 1 : 0);
