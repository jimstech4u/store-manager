/**
 * A LEVEL FOR EACH SHAPE, AND THE RULE THAT ANY ONE OF THEM CAN FIRE.
 *
 * The shop sets one general level and it means that many of whatever shape you are looking at —
 * ten crates, and ten bottles. An item can then disagree per shape. This checks the arithmetic
 * that follows, as the shop's own signed-in user, because `set_shape_low_stock` is behind
 * `has_permission` and answers nothing to the database owner.
 *
 *     node scripts/probe-shape-low-levels.mjs
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
const store = stores[0];
console.log(`\nsigned in to ${store.name}\n`);

/** The binding threshold in base units, which is what everything else compares against. */
const binding = async (productId) =>
  Number((await admin.rpc('product_low_threshold', { p_product_id: productId })).data);

// An item with two shapes of different sizes is the whole point of this.
/*
 * Read straight from `product_units` rather than embedded from `products`.
 *
 * Asking the child table directly sidesteps any disambiguation hint, which would only rot the
 * next time a foreign key is added between the two.
 */
const { data: products } = await admin
  .from('products').select('id, name').eq('store_id', store.id).eq('status', 'active');
const { data: allUnits } = await admin
  .from('product_units').select('id, product_id, base_qty, store_units(name)')
  .in('product_id', (products ?? []).map((p) => p.id));
for (const p of products ?? []) {
  p.product_units = (allUnits ?? []).filter((u) => u.product_id === p.id);
}

const item = (products ?? []).find(
  (p) => (p.product_units ?? []).length > 1 && (p.product_units ?? []).some((u) => Number(u.base_qty) > 1),
);
if (!item) throw new Error('no product with two shapes to test against');

const units = [...item.product_units].sort((a, b) => Number(b.base_qty) - Number(a.base_qty));
const big = units[0];
const small = units[units.length - 1];
console.log(`  ${item.name}: ${big.store_units.name} of ${big.base_qty}, ${small.store_units.name} of ${small.base_qty}`);

const { data: settings } = await admin
  .from('store_settings').select('low_stock_threshold').eq('store_id', store.id).maybeSingle();
const general = Number(settings.low_stock_threshold);
console.log(`  the shop's general level: ${general}\n`);

// ── With no rows, every shape follows the shop ─────────────────────────────
await shop.rpc('clear_shape_low_stock', { p_product_id: item.id, p_unit_id: big.id });
await shop.rpc('clear_shape_low_stock', { p_product_id: item.id, p_unit_id: small.id });
check('with no levels of its own, the shop’s level applies to every shape',
  (await binding(item.id)) === general * Number(big.base_qty),
  `expected ${general} x ${big.base_qty} = ${general * Number(big.base_qty)}, got ${await binding(item.id)}`);

// ── One shape overridden ───────────────────────────────────────────────────
const { error: setErr } = await shop.rpc('set_shape_low_stock', {
  p_product_id: item.id, p_unit_id: big.id, p_level: 25,
});
check('a shop member can set one shape’s level', !setErr, setErr?.message ?? '');
check(`${big.store_units.name} at 25 binds at 25 x ${big.base_qty}`,
  (await binding(item.id)) === 25 * Number(big.base_qty),
  `got ${await binding(item.id)}`);

// ── The other shape too, and the one that bites first wins ────────────────
await shop.rpc('set_shape_low_stock', { p_product_id: item.id, p_unit_id: small.id, p_level: 5 });
check('with both set, the rule that fires first is the binding one',
  (await binding(item.id)) === Math.max(25 * Number(big.base_qty), 5 * Number(small.base_qty)),
  `got ${await binding(item.id)}`);

// ── Removing a line is not setting it to zero ─────────────────────────────
await shop.rpc('clear_shape_low_stock', { p_product_id: item.id, p_unit_id: big.id });
check('removing a line puts that shape back under the shop, not to zero',
  (await binding(item.id)) === Math.max(general * Number(big.base_qty), 5 * Number(small.base_qty)),
  `got ${await binding(item.id)}`);

// ── A shape that is not this product's is refused ─────────────────────────
const other = (products ?? []).find((p) => p.id !== item.id && (p.product_units ?? []).length > 0);
if (other) {
  const { error } = await shop.rpc('set_shape_low_stock', {
    p_product_id: item.id, p_unit_id: other.product_units[0].id, p_level: 3,
  });
  check('a shape belonging to another product is refused', Boolean(error),
    error ? error.message.slice(0, 70) : 'IT WAS ACCEPTED');
}

// Put it back as it was found.
await shop.rpc('clear_shape_low_stock', { p_product_id: item.id, p_unit_id: small.id });
check('cleaned up', (await binding(item.id)) === general * Number(big.base_qty));

console.log(`\n${failed} failed`);
process.exit(failed ? 1 : 0);
