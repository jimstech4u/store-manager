/**
 * THE WHATSAPP ASSISTANT ACTS AS THE MEMBER — checked against the real project.
 *
 * The bot opens a session for a linked member the way Supabase opens a magic-link sign-in (an
 * admin-made link, verified on the server, nothing emailed) and makes every lookup with it, so the
 * member's own permissions apply. This proves that session opens for the sample shop's owner, that
 * `auth.uid()` is them, and that every RPC the tools call answers for it. Reads only.
 *
 *     node scripts/probe-whatsapp-session.mjs
 */
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);
let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
const owner = list.users.find((u) => u.email === env.SAMPLE_EMAIL);
check('the shop owner exists', Boolean(owner));

const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email: owner.email });
check('an admin-made sign-in link (nothing emailed)', !linkErr && Boolean(link?.properties?.hashed_token), linkErr?.message);
const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
const { data: verified, error: vErr } = await anon.auth.verifyOtp({ type: 'magiclink', token_hash: link.properties.hashed_token });
check('verified on the server into a real session', !vErr && Boolean(verified?.session?.access_token), vErr?.message);

const asUser = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { headers: { Authorization: `Bearer ${verified.session.access_token}` } },
});
const { data: mem } = await asUser.rpc('my_membership');
const store = (mem ?? [])[0];
check('the session IS the owner: my_membership answers', Boolean(store?.store_id), store?.store_name);

const call = async (fn, params) => {
  const { data, error } = await asUser.rpc(fn, params);
  return { data, error: error?.message ?? null };
};
const S = store.store_id;
const items = await call('search_products', { p_store_id: S, p_query: 'trophy', p_limit: 8, p_offset: 0 });
check('find_items: search_products', !items.error && items.data.length > 0, items.error ?? `${items.data.length} found`);
const units = await call('product_selling_units', { p_store_id: S });
check('find_items: product_selling_units', !units.error && units.data.length > 0, units.error ?? '');
const low = await call('list_products', { p_store_id: S, p_after_name: null, p_after_id: null, p_limit: 40, p_filter: 'low' });
check('low_stock: list_products(low)', !low.error, low.error ?? `${low.data.length}`);
const sales = await call('sales_summary', { p_store_id: S, p_from: new Date(Date.now() - 86400000).toISOString(), p_to: null, p_staff: null, p_customer: null });
check('sales_summary', !sales.error && Array.isArray(sales.data), sales.error ?? JSON.stringify(sales.data?.[0]));
const cust = await call('list_customers', { p_store_id: S, p_query: 'busayo', p_after_name: null, p_after_id: null, p_limit: 6, p_filter: null });
check('find_customer: list_customers', !cust.error && cust.data.length > 0, cust.error ?? cust.data.map((c) => c.display_name).join(', '));
const cid = cust.data?.[0]?.id;
const st = await call('customer_statement_detail', { p_store_customer_id: cid, p_from: null, p_to: null });
check('customer_statement: customer_statement_detail', !st.error && st.data, st.error ?? `closing ${st.data?.closing}`);
const rec = await call('customer_statement', { p_store_customer_id: cid, p_limit: 6 });
check('recent_receipts: customer_statement', !rec.error && rec.data.length > 0, rec.error ?? `${rec.data.length}`);
const debt = await call('debtors_aged', { p_store_id: S });
check('who_owes: debtors_aged', !debt.error, debt.error ?? `${debt.data.length} owe`);

// And the session's sign-out, so the probe leaves nothing open.
await createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
  global: { headers: { Authorization: `Bearer ${verified.session.access_token}` } },
}).auth.admin;
await admin.auth.admin.signOut(verified.session.access_token).catch(() => {});

console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
