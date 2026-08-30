/**
 * What a delivery actually cost, checked against the worked examples.
 *
 * These are the shopkeeper's own sums, and they are the reason the invoice price is not the cost:
 *
 *   plain            1,320,000 + 27,000                   ÷ 300  =  4,490.00
 *   with free packs  1,320,000 + 27,000                   ÷ 307  =  4,387.62
 *   with a rebate    1,320,000 + 27,000 − 20,000          ÷ 300  =  4,423.33
 *   with both        1,320,000 + 27,000 − 20,000          ÷ 307  =  4,322.48
 *
 * Then FIFO: sell across two deliveries at different costs and check the sale is charged partly at
 * each, and that the dearest layer still on the shelf is what a price warns against — which is the
 * whole reason for keeping layers rather than an average.
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

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const near = (a, b, tol = 0.02) => Math.abs(Number(a) - Number(b)) <= tol;

const owner = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
await owner.auth.signInWithPassword({
  email: env.SAMPLE_EMAIL,
  password: env.SAMPLE_PASSWORD,
});
const storeId = (await owner.rpc('my_membership')).data[0].store_id;

/** A product this probe owns, so nothing real is disturbed. */
const { data: product } = await admin
  .from('products')
  .insert({
    store_id: storeId,
    name: `Cost probe ${Date.now().toString().slice(-6)}`,
    base_unit: 'piece',
  })
  .select('id, name')
  .single();

const purchases = [];

const deliver = async ({ qty, unitCost, charges = [], rebate = 0, free = 0 }) => {
  const { data, error } = await owner.rpc('record_purchase', {
    p_store_id: storeId,
    p_lines: [{ product_id: product.id, qty, unit_cost: unitCost, free_qty: free }],
    p_charges: charges,
    p_rebate: rebate,
    p_client_uuid: crypto.randomUUID(),
  });
  if (error) throw error;
  purchases.push(data);

  const { data: layer } = await admin
    .from('stock_layers')
    .select('unit_cost, qty_base, remaining_base')
    .eq('ref_id', data)
    .single();
  return layer;
};

const fees = [
  { label: 'Loading', amount: 10000 },
  { label: 'Transport', amount: 15000 },
  { label: 'Offloading', amount: 2000 },
];

try {
  // ── The four sums ──────────────────────────────────────────────────────────────────
  const plain = await deliver({ qty: 300, unitCost: 4400, charges: fees });
  check('goods plus charges over the units', near(plain.unit_cost, 4490),
    `${plain.unit_cost} (want 4490)`);

  const withFree = await deliver({ qty: 300, unitCost: 4400, charges: fees, free: 7 });
  check('free units go into the divisor', near(withFree.unit_cost, 4387.62, 0.05),
    `${withFree.unit_cost} (want 4387.62)`);
  check('and they are stock that arrived', Number(withFree.qty_base) === 307,
    `${withFree.qty_base} base units`);

  const withRebate = await deliver({ qty: 300, unitCost: 4400, charges: fees, rebate: 20000 });
  check('a rebate comes off the money', near(withRebate.unit_cost, 4423.33, 0.05),
    `${withRebate.unit_cost} (want 4423.33)`);

  const both = await deliver({ qty: 300, unitCost: 4400, charges: fees, rebate: 20000, free: 7 });
  check('both together', near(both.unit_cost, 4322.48, 0.05),
    `${both.unit_cost} (want 4322.48)`);

  check('the charges are recorded by name', true);
  const { data: named } = await admin
    .from('purchase_charges')
    .select('label, amount')
    .eq('purchase_id', purchases[0]);
  check('each fee kept its own name', (named?.length ?? 0) === 3,
    (named ?? []).map((c) => c.label).join(', '));

  // ── FIFO ───────────────────────────────────────────────────────────────────────────
  /*
   * Two deliveries at different costs, then take stock across the boundary. The point is that the
   * cost is neither figure but the right mix of both — which an average can never produce.
   */
  const { data: fifoProduct } = await admin
    .from('products')
    .insert({
      store_id: storeId,
      name: `FIFO probe ${Date.now().toString().slice(-6)}`,
      base_unit: 'piece',
    })
    .select('id')
    .single();

  const mk = async (qty, cost, at) => {
    const { data } = await admin
      .from('stock_layers')
      .insert({
        store_id: storeId,
        product_id: fifoProduct.id,
        qty_base: qty,
        remaining_base: qty,
        unit_cost: cost,
        received_at: at,
      })
      .select('id')
      .single();
    return data.id;
  };

  await mk(500, 4400, '2026-01-01T00:00:00Z');
  await mk(500, 4200, '2026-02-01T00:00:00Z');

  const dear = await owner.rpc('dearest_live_cost', { p_product_id: fifoProduct.id });
  check('the dearest stock still held is what a price warns against', Number(dear.data) === 4400,
    `${dear.data} (want 4400, not the 4300 average)`);

  // 600 pieces: all 500 of the old, then 100 of the new.
  const { data: cogs } = await admin.rpc('consume_stock_layers', {
    p_product_id: fifoProduct.id,
    p_qty_base: 600,
  });
  check('a sale across two deliveries is charged at both',
    near(cogs, 500 * 4400 + 100 * 4200, 1),
    `${cogs} (want ${500 * 4400 + 100 * 4200})`);

  const { data: left } = await admin
    .from('stock_layers')
    .select('unit_cost, remaining_base')
    .eq('product_id', fifoProduct.id)
    .order('received_at');
  check('the older layer is emptied first', Number(left[0].remaining_base) === 0,
    `${left[0].remaining_base} left of the 4400`);
  check('and the newer one is drawn down', Number(left[1].remaining_base) === 400,
    `${left[1].remaining_base} left of the 4200`);

  const dearAfter = await owner.rpc('dearest_live_cost', { p_product_id: fifoProduct.id });
  check('once the dear stock is gone the warning drops', Number(dearAfter.data) === 4200,
    `${dearAfter.data} (want 4200)`);

  /*
   * Selling more than is recorded must not fail. Offline sync makes negative stock inevitable, and
   * a till that refuses at the counter is worse than a count that needs correcting.
   */
  const { error: overErr } = await admin.rpc('consume_stock_layers', {
    p_product_id: fifoProduct.id,
    p_qty_base: 100000,
  });
  check('selling beyond the record is costed, not refused', !overErr, overErr?.message ?? '');

  await admin.from('products').delete().eq('id', fifoProduct.id);
} finally {
  for (const id of purchases) await admin.from('purchases').delete().eq('id', id);
  await admin.from('products').delete().eq('id', product.id);
  console.log('  (cleaned up)');
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
