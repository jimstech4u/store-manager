/**
 * A delivery that arrives in a unit the shop does not sell in.
 *
 * Cooking oil comes by the bag; the shop sells litres. One bag is 24 litres, so five bags is 120
 * litres of sellable stock — and what they cost has to be divided across 120, not across 5.
 *
 * `record_purchase` used to work this out from `product_packs`, the one-pack-per-product model
 * 0061 replaced. A shop with two bought-in units has a pack row for neither, so a delivery in bags
 * could only be entered as loose litres.
 *
 *     node scripts/probe-buy-in-units.mjs
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

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const shop = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
await shop.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });
const storeId = (await shop.rpc('my_membership')).data[0].store_id;

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};
const near = (a, b, tol = 0.02) => Math.abs(Number(a) - Number(b)) <= tol;

const stamp = Date.now().toString().slice(-6);

const litre = (await shop.rpc('create_store_unit', {
  p_store_id: storeId,
  p_name: `BLitre${stamp}`,
  p_plural: `BLitres${stamp}`,
})).data;
const bag = (await shop.rpc('create_store_unit', {
  p_store_id: storeId,
  p_name: `BBag${stamp}`,
  p_plural: `BBags${stamp}`,
})).data;

const { data: product } = await admin
  .from('products')
  .insert({ store_id: storeId, name: `ZZ Buy Units ${stamp}`, base_unit: 'litre', status: 'active' })
  .select('id')
  .single();

// Sold by the litre, bought by the bag and the litre. One bag is 24 litres.
await shop.rpc('save_product_units', {
  p_product_id: product.id,
  p_units: [
    {
      id: null, store_unit_id: litre, is_bought: true, is_sold: true, sell_price: 1500,
      is_returnable: false, whole_digit: true, allow_quarter: false, allow_half: false,
      allow_three_quarter: false, defined_against: null, defined_qty: null, base_qty: 1,
    },
    {
      id: null, store_unit_id: bag, is_bought: true, is_sold: false, sell_price: null,
      is_returnable: false, whole_digit: true, allow_quarter: false, allow_half: false,
      allow_three_quarter: false, defined_against: litre, defined_qty: 24, base_qty: 24,
    },
  ],
});

console.log('\n— what the delivery screen is offered —');
const buying = (await shop.rpc('product_buying_units', { p_store_id: storeId })).data.filter(
  (u) => u.product_id === product.id,
);
check('both bought-in units are offered', buying.length === 2, `${buying.length}`);
check(
  'the bag leads, being the larger',
  buying.find((u) => u.is_default)?.unit_name === `BBag${stamp}`,
  buying.find((u) => u.is_default)?.unit_name,
);
check(
  'and it carries what a bag holds',
  Number(buying.find((u) => u.unit_name === `BBag${stamp}`)?.base_qty) === 24,
);

console.log('\n— five bags at 30,000, delivery 10,000 —');
const bagFactor = Number(buying.find((u) => u.unit_name === `BBag${stamp}`).base_qty);

const { error } = await shop.rpc('record_purchase', {
  p_store_id: storeId,
  p_lines: [
    { product_id: product.id, qty: 5, free_qty: 0, base_factor: bagFactor, pack_id: null, unit_cost: 30000 },
  ],
  p_supplier: 'Probe supplier',
  p_invoice_ref: `BUY-${stamp}`,
  p_delivery: 0,
  p_distribution: 0,
  p_charges: [{ label: 'Delivery', amount: 10000 }],
  p_rebate: 0,
  p_client_uuid: crypto.randomUUID(),
});
check('the delivery records', !error, error?.message ?? '');

const { data: line } = await admin
  .from('purchase_lines')
  .select('entered_qty, base_qty, unit_cost_landed, purchase_id')
  .eq('product_id', product.id)
  .single();

check('five bags were entered', Number(line?.entered_qty) === 5, `${line?.entered_qty}`);
check(
  'and 120 litres landed on the shelf, not 5',
  Number(line?.base_qty) === 120,
  `${line?.base_qty}`,
);
check(
  'each litre cost 1,333.33 — (150,000 + 10,000) / 120',
  near(line?.unit_cost_landed, 1333.33),
  `${line?.unit_cost_landed}`,
);

console.log('\n— and the shelf reads in litres, the unit it is sold in —');
const selling = (await shop.rpc('selling_units_for_product', { p_product_id: product.id })).data;
check('one stock line', selling.length === 1, `${selling.length}`);
check('and it says 120', Number(selling[0]?.on_hand_units) === 120, `${selling[0]?.on_hand_units}`);

// ── Put the shop back ────────────────────────────────────────────────────────────────────────
await admin.from('stock_layers').delete().eq('product_id', product.id);
await admin.from('purchase_charges').delete().eq('purchase_id', line.purchase_id);
await admin.from('purchase_lines').delete().eq('purchase_id', line.purchase_id);
await admin.from('purchases').delete().eq('id', line.purchase_id);
await admin.from('product_units').delete().eq('product_id', product.id);
await admin.from('product_sale_units').delete().eq('product_id', product.id);
/*
 * Retired if the ledger will not let go — `stock_movements` is append-only, so a probe that
 * received stock cannot take it back out, and a silent delete failure once left five "Cost probe"
 * items sitting in the shop's real product picker.
 */
const gone = await admin.from('products').delete().eq('id', product.id);
if (gone.error) await admin.from('products').update({ status: 'archived' }).eq('id', product.id);
await admin.from('store_units').delete().in('id', [litre, bag]);

console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
