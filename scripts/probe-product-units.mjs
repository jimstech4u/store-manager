/**
 * Saying what a product is bought in and sold in — as a signed-in shopkeeper, against the live shop.
 *
 * The cooking-oil case, end to end: bought in bags AND litres, sold only in litres. The bag has to
 * be answered for — one bag is 24 litres — or those bags arrive and can never leave.
 *
 * SIGNED IN AS THE REAL OWNER rather than through the service key, because half of what is being
 * tested only exists for an authenticated caller: `has_permission` on the write, `is_store_member`
 * on the read, and the settled check that has to hold for both. A probe running as the service role
 * proves the SQL and skips the part that decides whether a browser can do any of it.
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

const stamp = Date.now().toString().slice(-6);

// ── The shop's words for how much of something there is ──────────────────────────────────────
const litre = (await shop.rpc('create_store_unit', {
  p_store_id: storeId,
  p_name: `Litre${stamp}`,
  p_plural: `Litres${stamp}`,
})).data;
const bag = (await shop.rpc('create_store_unit', {
  p_store_id: storeId,
  p_name: `Bag${stamp}`,
  p_plural: `Bags${stamp}`,
})).data;

check('a shop can add a unit it uses', Boolean(litre && bag));

const again = (await shop.rpc('create_store_unit', {
  p_store_id: storeId,
  p_name: `Litre${stamp}`,
  p_plural: 'ignored',
})).data;
check('adding the same unit twice returns the same one', again === litre);

// ── The product ──────────────────────────────────────────────────────────────────────────────
const { data: product } = await admin
  .from('products')
  .insert({ store_id: storeId, name: `Units probe oil ${stamp}`, base_unit: 'litre' })
  .select('id')
  .single();

const unit = (over) => ({
  id: null,
  is_bought: false,
  is_sold: false,
  sell_price: null,
  is_returnable: false,
  whole_digit: true,
  allow_quarter: false,
  allow_half: false,
  allow_three_quarter: false,
  defined_against: null,
  defined_qty: null,
  base_qty: 1,
  ...over,
});

console.log('\n— a bag nobody has answered for —');

let res = await shop.rpc('save_product_units', {
  p_product_id: product.id,
  p_units: [
    unit({ store_unit_id: litre, is_bought: true, is_sold: true, sell_price: 1200 }),
    // Bought in, sold in nothing, and no sentence saying what one holds.
    unit({ store_unit_id: bag, is_bought: true }),
  ],
});
check('the save is refused', Boolean(res.error), res.error?.message?.slice(0, 60) ?? 'saved anyway');
check(
  'and the refusal names the unit, so it can be acted on',
  Boolean(res.error?.message?.includes(`Bag${stamp}`)),
  res.error?.message ?? '',
);

console.log('\n— one bag is twenty-four litres —');

res = await shop.rpc('save_product_units', {
  p_product_id: product.id,
  p_units: [
    unit({ store_unit_id: litre, is_bought: true, is_sold: true, sell_price: 1200 }),
    unit({ store_unit_id: bag, is_bought: true, defined_against: litre, defined_qty: 24 }),
  ],
});
check('it saves', !res.error, res.error?.message ?? '');

let { data: saved } = await shop.rpc('product_units_for', { p_product_id: product.id });
const savedBag = saved.find((u) => u.store_unit_id === bag);
check('the bag is worth 24 base units', Number(savedBag.base_qty) === 24, `got ${savedBag.base_qty}`);
check('and the sentence is kept, not just its answer', Number(savedBag.defined_qty) === 24);

const gaps = (await shop.rpc('product_unit_gaps', { p_product_id: product.id })).data;
check('nothing is stranded any more', gaps.length === 0, `${gaps.length} gap(s)`);

console.log('\n— the stock reads as one pool, not two piles —');

const selling = (await shop.rpc('selling_units_for_product', { p_product_id: product.id })).data;
check('only what is sold is a stock line', selling.length === 1, `${selling.length} line(s)`);
check('and that line is the litre', selling[0].unit_name === `Litre${stamp}`);

console.log('\n— correcting the sentence —');

res = await shop.rpc('save_product_units', {
  p_product_id: product.id,
  p_units: [
    unit({ store_unit_id: litre, is_bought: true, is_sold: true, sell_price: 1200 }),
    unit({ store_unit_id: bag, is_bought: true, defined_against: litre, defined_qty: 25 }),
  ],
});
check('a correction saves', !res.error, res.error?.message ?? '');

saved = (await shop.rpc('product_units_for', { p_product_id: product.id })).data;
check(
  'and carries to the figure everything is costed on',
  Number(saved.find((u) => u.store_unit_id === bag).base_qty) === 25,
);

console.log('\n— how much a customer may buy at a time —');

res = await shop.rpc('save_product_units', {
  p_product_id: product.id,
  p_units: [
    unit({
      store_unit_id: litre,
      is_bought: true,
      is_sold: true,
      sell_price: 1200,
      // Weighed: a chicken is 3.2 kg because that is what the scale said.
      whole_digit: false,
    }),
    unit({ store_unit_id: bag, is_bought: true, defined_against: litre, defined_qty: 25 }),
  ],
});
check('a weighed unit saves', !res.error, res.error?.message ?? '');

/*
 * Asked of the table the TILL reads, not the one just written.
 *
 * These were two tables holding the same fact, and nothing carried one to the other — a shop could
 * set up exactly how it sells something and find the sell screen had never heard of it. This check
 * passed vacuously on an empty list for exactly that reason, which is how it was found.
 */
const rules = (await shop.rpc('product_sale_units_for', { p_product_id: product.id })).data;
check('the till has the unit at all', rules.length === 1, `${rules.length} sale unit row(s)`);
check(
  'and is told to accept any amount',
  rules.length > 0 && rules.every((r) => r.whole_digit === false),
  JSON.stringify(rules.map((r) => ({ n: r.name, whole: r.whole_digit }))),
);
check(
  'at the price the shop set',
  rules.length > 0 && Number(rules[0].price) === 1200,
  `got ${rules[0]?.price}`,
);

console.log('\n— selling nothing at all —');

res = await shop.rpc('save_product_units', {
  p_product_id: product.id,
  p_units: [unit({ store_unit_id: bag, is_bought: true })],
});
check('an item nobody can buy is refused', Boolean(res.error), res.error?.message?.slice(0, 60) ?? 'saved anyway');

// ── Put the shop back as it was ──────────────────────────────────────────────────────────────
await admin.from('product_units').delete().eq('product_id', product.id);
await admin.from('products').delete().eq('id', product.id);
await admin.from('store_units').delete().in('id', [litre, bag]);

console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
