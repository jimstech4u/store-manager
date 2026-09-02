/**
 * Walk the empties journey end to end and report what is reachable, what is missing, and what
 * exists in the database with no way in.
 *
 * READ-ONLY. This writes nothing: it is a survey taken before designing, so the plan is built on
 * what the shop actually has rather than on what the migrations imply. Every "MISSING" here is a
 * claim that can be checked by clicking.
 *
 *     node scripts/simulate-empties-flow.mjs
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
await shop.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });
const storeId = (await shop.rpc('my_membership')).data[0].store_id;

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const say = (label, value, verdict = '') =>
  console.log(`  ${label.padEnd(46)} ${String(value).padEnd(28)} ${verdict}`);

const head = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 62 - t.length))}`);

/** Does an RPC exist and answer? Asked by calling it, not by reading a migration. */
async function rpcExists(name, args) {
  const { error } = await shop.rpc(name, args);
  if (!error) return 'yes';
  if (/does not exist|Could not find/i.test(error.message)) return 'NO';
  return `yes (refused: ${error.message.slice(0, 40)})`;
}

head('What the shop has declared');

const { data: cats } = await admin
  .from('empties_categories')
  .select('id, name, kind, deposit')
  .eq('store_id', storeId);
say('empties categories (the NBL-style pools)', (cats ?? []).length, (cats ?? []).length ? '' : '← none declared');
for (const c of cats ?? []) say(`  · ${c.name}`, `${c.kind}, default ₦${c.deposit}`);

const { data: rets } = await admin
  .from('product_returnables')
  .select('product_id, empties_category_id, qty_per_base_unit, products!inner(name, store_id)')
  .eq('products.store_id', storeId);
say('products marked returnable', (rets ?? []).length, (rets ?? []).length ? '' : '← nothing is returnable yet');
for (const r of (rets ?? []).slice(0, 6)) say(`  · ${r.products.name}`, `per base unit: ${r.qty_per_base_unit ?? 'container'}`);

head('What is owed, and what is held');

const { data: led } = await admin
  .from('deposit_ledger')
  .select('store_customer_id, empties_category_id, direction, qty_units, deposit_per_unit, ref_table, ref_id')
  .eq('store_id', storeId);
say('deposit_ledger rows', (led ?? []).length);
const collected = (led ?? []).filter((r) => r.direction === 'collected');
say('  · obligations created', collected.length);
say('  · tied to a receipt', collected.filter((r) => r.ref_table === 'sales' && r.ref_id).length,
  '← the receipt link already exists');
const moneyBearing = collected.filter((r) => Number(r.deposit_per_unit) > 0);
say('  · carrying a per-unit deposit figure', moneyBearing.length);

const { data: forfeits } = await admin.from('deposit_forfeits').select('id').eq('store_id', storeId);
say('deposit_forfeits rows (breakage kept)', (forfeits ?? []).length);

head('The RPCs — asked by calling them');

const fake = '00000000-0000-0000-0000-000000000000';
say('return_empties', await rpcExists('return_empties', {
  p_store_id: storeId, p_customer_id: fake, p_category_id: fake, p_qty: 0,
  p_occurred_at: new Date().toISOString(), p_client_uuid: fake, p_refund_mode: 'none',
}));
say('take_deposit', await rpcExists('take_deposit', {
  p_store_id: storeId, p_customer_id: fake, p_category_id: fake, p_qty: 0,
  p_per_unit: null, p_note: null, p_occurred_at: new Date().toISOString(),
}));
say('refund_deposit', await rpcExists('refund_deposit', {
  p_store_id: storeId, p_customer_id: fake, p_category_id: fake, p_qty: 0,
  p_note: null, p_occurred_at: new Date().toISOString(),
}));
say('forfeit_deposit', await rpcExists('forfeit_deposit', {
  p_store_id: storeId, p_customer_id: fake, p_category_id: fake, p_qty: 0,
  p_amount: 0, p_note: null, p_occurred_at: new Date().toISOString(),
}));
say('backfill_debtor (opening money)', await rpcExists('backfill_debtor', {
  p_store_id: storeId, p_customer_id: fake, p_amount: 0, p_as_of: '2020-01-01', p_note: null,
}));
say('backfill_empties (opening empties)', await rpcExists('backfill_empties', {
  p_store_id: storeId, p_customer_id: fake, p_category_id: fake, p_qty: 0, p_as_of: '2020-01-01',
}));
say('quick_add_sellable (mid-sale product)', await rpcExists('quick_add_sellable', {
  p_store_id: storeId, p_name: '', p_unit_name: '', p_unit_plural: '', p_price: 0,
}));
say('empties_by_receipt  ← for the page asked for', await rpcExists('empties_by_receipt', {
  p_store_id: storeId,
}));
say('open_stock_by_count ← start from the shelf', await rpcExists('open_stock_by_count', {
  p_store_id: storeId, p_product_id: fake, p_qty: 0, p_unit_id: fake, p_unit_cost: 0,
}));
// Called with the arguments it actually takes: PostgREST resolves an overload by NAME, so a call
// missing a required parameter is indistinguishable from a function that does not exist.
say('settle_empties      ← one receipt, short return', await rpcExists('settle_empties', {
  p_store_id: storeId, p_sale_id: fake, p_returned: [], p_apply_amount: 0,
  p_refund_amount: 0, p_refund_mode: 'cash', p_note: null,
  p_occurred_at: new Date().toISOString(),
}));
say('hold_receipt_deposit', await rpcExists('hold_receipt_deposit', {
  p_store_id: storeId, p_sale_id: fake, p_amount: 0, p_note: null,
  p_occurred_at: new Date().toISOString(),
}));

head('Where a shop can reach these (screens wired today)');

const files = {
  'Account actions page (per customer, per pool)': 'src/app/(app)/main/people-stack/account-action-page/account-action-page.tsx',
  'Receipt prints empties expected': 'src/app/(app)/main/sell-stack/sell-page/Receipt.tsx',
  'Customer form takes opening balances': 'src/app/(app)/main/people-stack/customer-form-page/customer-form-page.tsx',
  'Mid-sale product sheet': 'src/components/sell/QuickAddItem.tsx',
};
for (const [label, path] of Object.entries(files)) {
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { /* absent */ }
  const has = {
    'Account actions page (per customer, per pool)': /return_empties|take_deposit/.test(text),
    'Receipt prints empties expected': /empties/.test(text),
    'Customer form takes opening balances': /backfill_debtor|opening/i.test(text),
    /*
     * Asked of the FIELDS, not of the file.
     *
     * A first version matched /count/ anywhere in the source and reported this sheet as wired — it
     * was matching the word in a comment about counting a shelf. A check that a component "mentions
     * stock" is not a check that it asks for any.
     */
    'Mid-sale product sheet': /label="[^"]*on the shelf|label="[^"]*returnab/i.test(text),
  }[label];
  say(label, has ? 'wired' : 'MISSING', has ? '' : '←');
}

console.log('\nRead-only; nothing was written.');
