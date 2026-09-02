/**
 * A sale must never stop for paperwork.
 *
 * Two things a counter meets constantly, and each of them used to be a wall:
 *
 *   THE ITEM IS NOT ON FILE. A seller can now add it mid-receipt — a name, a unit, a price — and
 *   it lands PROVISIONAL unless they may vouch for it, so the sale goes through and somebody
 *   senior signs it off afterwards.
 *
 *   THE STOCK HAS NOT BEEN COUNTED TODAY. Counting a whole catalogue before trading is impossible
 *   at any real size and mostly wasted, because most of it will not be touched. The item being
 *   sold is the one worth counting, and it is counted the first time it is sold that day.
 *
 *     node scripts/probe-mid-sale.mjs
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
const NAME = `ZZ Mid Sale ${stamp}`;
const UNIT = `MSack${stamp}`;

let productId = null;

try {
  // ══ 1. Adding something sellable, at the counter ══════════════════════════════════
  console.log('\n— a customer asks for something the shop has never entered —');
  const { data: made, error } = await shop.rpc('quick_add_sellable', {
    p_store_id: storeId,
    p_name: NAME,
    p_unit_name: UNIT,
    p_unit_plural: `${UNIT}s`,
    p_price: 3500,
  });
  check('it can be added without leaving the receipt', !error, error?.message ?? '');
  productId = made;

  const { data: units } = await admin
    .from('product_units')
    .select('is_sold, is_bought, base_qty, sell_price')
    .eq('product_id', productId);
  check('and it is sellable straight away', (units ?? []).some((u) => u.is_sold), JSON.stringify(units));
  check('at the price the seller was told', Number(units?.[0]?.sell_price) === 3500);

  // The till reads a derived table; a product nothing can price is not sellable.
  const { data: forTill } = await admin
    .from('product_sale_units')
    .select('name, price')
    .eq('product_id', productId);
  check('the till can price it', (forTill ?? []).length === 1, JSON.stringify(forTill));

  /*
   * Confirmed or not depends on who added it.
   *
   * This probe signs in as the OWNER, who holds `records.confirm`, so it comes back vouched for.
   * The seller case is asserted below by asking the database the same question it asks.
   */
  const { data: row } = await admin
    .from('products')
    .select('confirmed_at, name')
    .eq('id', productId)
    .single();
  const { data: mayVouch } = await shop.rpc('has_permission', {
    p_store_id: storeId,
    p_permission: 'records.confirm',
  });
  check(
    'vouched for only when the person may vouch',
    Boolean(row?.confirmed_at) === Boolean(mayVouch),
    `may vouch: ${mayVouch}, confirmed: ${Boolean(row?.confirmed_at)}`,
  );

  // ══ 2. The count that comes when the item does ════════════════════════════════════
  console.log('\n— and it has never been counted —');
  const { data: needs } = await shop.rpc('needs_count_today', { p_product_id: productId });
  check('the till knows it owes a count', needs === true, String(needs));

  const { data: batch } = await shop.rpc('which_need_count', { p_product_ids: [productId] });
  check(
    'and can ask for a whole receipt at once',
    (batch ?? []).some((r) => r.product_id === productId),
    `${(batch ?? []).length} of 1`,
  );

  console.log('\n— the seller says what is on the shelf —');
  const { error: countErr } = await shop.rpc('count_from_till', {
    p_product_id: productId,
    p_counted: 12,
  });
  check('the count is taken from the till', !countErr, countErr?.message ?? '');

  const { data: after } = await shop.rpc('needs_count_today', { p_product_id: productId });
  check('and the till stops asking', after === false, String(after));

  const { data: period } = await admin
    .from('stock_periods')
    .select('actual_closing_qty, status')
    .eq('product_id', productId)
    .maybeSingle();
  check('the figure is on the record', Number(period?.actual_closing_qty) === 12, JSON.stringify(period));

  /*
   * Asked again tomorrow.
   *
   * The period is dated, so a count from yesterday must not satisfy today. Simulated by dating
   * this one back — the alternative is a probe that only passes once a day.
   */
  console.log('\n— tomorrow it asks again —');
  await admin
    .from('stock_periods')
    .update({ status: 'closed', period_end: new Date(Date.now() - 36 * 3600_000).toISOString() })
    .eq('product_id', productId);

  const { data: staleDay } = await shop.rpc('needs_count_today', { p_product_id: productId });
  check('yesterday’s count does not answer for today', staleDay === true, String(staleDay));
} finally {
  if (productId) {
    await admin.from('stock_periods').delete().eq('product_id', productId);
    await admin.from('product_units').delete().eq('product_id', productId);
    await admin.from('product_sale_units').delete().eq('product_id', productId);
    const gone = await admin.from('products').delete().eq('id', productId);
    if (gone.error) await admin.from('products').update({ status: 'archived' }).eq('id', productId);
  }
  await admin.from('store_units').delete().eq('store_id', storeId).eq('name', UNIT);
}

console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
