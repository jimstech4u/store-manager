/**
 * Does the shop's realtime channel actually join? Built exactly as `useLiveShop` builds it.
 *
 *     node scripts/diag-live-channel.mjs [only-store-id-tables]
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
const SID = '7138327c-c81c-4486-a97c-92207b48b64e';
const WITH = ['sales', 'payments', 'customer_charges', 'stock_movements', 'stock_periods', 'stock_count_edits',
  'customer_empties', 'customer_deposits', 'products', 'store_customers', 'expenses', 'stock_layers',
  'product_categories', 'purchases', 'suppliers'];
const WITHOUT = ['product_units', 'product_price_tiers', 'product_sale_units', 'product_category_links',
  'payment_allocations', 'identities'];
const tables = process.argv[2] === 'only' ? WITH : [...WITH, ...WITHOUT];

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
await supabase.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });

let ch = supabase.channel(`diag:${Date.now()}`);
for (const table of tables) {
  ch = ch.on('postgres_changes', { event: '*', schema: 'public', table, filter: `store_id=eq.${SID}` }, () => {});
}
const result = await new Promise((resolve) => {
  const t = setTimeout(() => resolve('TIMED OUT'), 20000);
  ch.subscribe((status, err) => {
    if (status === 'SUBSCRIBED' || status === 'CHANNEL_ERROR' || status === 'CLOSED' || status === 'TIMED_OUT') {
      clearTimeout(t);
      resolve(`${status}${err ? ' — ' + (err.message ?? String(err)) : ''}`);
    }
  });
});
console.log(`${tables.length} tables:`, result);
await supabase.removeChannel(ch);
process.exit(0);
