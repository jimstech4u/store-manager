/**
 * Does a change to a table with no store_id reach a signed-in till? Subscribed the way useLiveShop
 * now subscribes (no filter), then a no-op update to one shape of the shop.
 *
 *     node scripts/diag-live-event.mjs
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }),
);
const till = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
await till.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const CAN = '217d0d07-54e9-4176-a312-fe29407721f1'; // Malta Guinness Can's Can shape
let heard = 0;
const ch = till.channel(`diag-ev:${Date.now()}`)
  .on('postgres_changes', { event: '*', schema: 'public', table: 'product_units' }, (p) => {
    if ((p.new?.id ?? p.old?.id) === CAN) heard += 1;
  });
await new Promise((r) => ch.subscribe((s) => s === 'SUBSCRIBED' && r()));
const { data: row } = await admin.from('product_units').select('sort_order').eq('id', CAN).single();
await admin.from('product_units').update({ sort_order: row.sort_order }).eq('id', CAN);
await new Promise((r) => setTimeout(r, 6000));
console.log(heard > 0 ? `HEARD the shape change (${heard})` : 'NOT heard');
await till.removeChannel(ch);
process.exit(0);
