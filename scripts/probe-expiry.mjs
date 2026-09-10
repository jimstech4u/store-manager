/**
 * Stock has a date on it, and somebody is told before it passes.
 *
 * «each product from delivery entry should take expiry date (very important and also filter to get
 *  this and alarm)»
 *
 * The date lives on the LAYER, not the product: `stock_layers` already tracks each delivery with
 * its own `remaining_base` and sells oldest-first, which is exactly the grain an expiry has. Two
 * deliveries of the same milk expire on two different days, and a column on `products` could only
 * hold whichever was entered last.
 *
 * MUTATION TEST. Restore the fault and this fails:
 *   · drop `expires_on` from the layer insert in `record_purchase` → "the date reaches the shelf" fails.
 *   · make `expiring_stock` window on `received_at` instead      → "only what is inside the window" fails.
 *
 *     node scripts/probe-expiry.mjs
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const NL = String.fromCharCode(10);

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

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const day = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

const stamp = Date.now().toString().slice(-6);
let productId = null;

try {
  console.log(NL + '— a delivery with a date on it —');

  const { data: pid, error: pe } = await shop.rpc('create_product', {
    p_store_id: storeId,
    p_name: `ZZ Milk ${stamp}`,
    p_base_unit: 'piece',
  });
  if (pe) throw new Error(pe.message);
  productId = pid;

  /*
   * THREE DELIVERIES OF THE SAME ITEM, expiring on three different days — which is the whole
   * argument for putting the date on the layer. One already gone, one inside a fortnight, one far
   * enough out that it must NOT raise an alarm.
   */
  const { error: rErr } = await shop.rpc('record_purchase', {
    p_store_id: storeId,
    p_lines: [
      { product_id: productId, qty: 10, unit_cost: 500, base_factor: 1, expires_on: day(-3) },
      { product_id: productId, qty: 20, unit_cost: 500, base_factor: 1, expires_on: day(9) },
      { product_id: productId, qty: 40, unit_cost: 500, base_factor: 1, expires_on: day(200) },
    ],
    p_supplier: `ZZ Dairy ${stamp}`,
    p_client_uuid: crypto.randomUUID(),
  });
  check('a delivery can carry a date per line', !rErr, rErr?.message ?? '');
  if (rErr) throw new Error(rErr.message);

  /*
   * AND ONE WITH NO DATE, which must stay out of every expiry answer.
   *
   * Most of what this trade carries has a date nobody ever reaches. A blank is "not dated", and
   * treating it as "expires today" would bury the real warnings under a list of crates of beer.
   */
  await shop.rpc('record_purchase', {
    p_store_id: storeId,
    p_lines: [{ product_id: productId, qty: 5, unit_cost: 500, base_factor: 1 }],
    p_supplier: `ZZ Dairy ${stamp}`,
    p_client_uuid: crypto.randomUUID(),
  });

  console.log(NL + '— what is going off —');
  const { data: soon, error: se } = await shop.rpc('expiring_stock', {
    p_store_id: storeId,
    p_within_days: 30,
  });
  check('the shelf can be asked what is going off', !se, se?.message ?? '');

  const mine = (soon ?? []).filter((r) => r.product_id === productId);
  check(
    'the date reaches the shelf',
    mine.length === 2,
    `${mine.length} layers inside 30 days, expected 2`,
  );

  const gone = mine.find((r) => r.days_left < 0);
  const nearly = mine.find((r) => r.days_left >= 0);
  check(
    'what has already passed is separated from what is coming',
    gone && nearly && Number(gone.remaining) === 10 && Number(nearly.remaining) === 20,
    `expired ${gone?.remaining}, soon ${nearly?.remaining}`,
  );

  check(
    'and it is valued at what it cost',
    Number(gone?.value_at_cost) === 5000,
    `₦${gone?.value_at_cost} for 10 at ₦500`,
  );

  /*
   * THE WINDOW IS ABOUT THE EXPIRY, not about when it arrived. All four layers arrived seconds
   * ago; only two are inside thirty days of going off.
   */
  const { data: tight } = await shop.rpc('expiring_stock', {
    p_store_id: storeId,
    p_within_days: 5,
  });
  const inFive = (tight ?? []).filter((r) => r.product_id === productId);
  check(
    'only what is inside the window, and everything already gone',
    inFive.length === 1 && Number(inFive[0].remaining) === 10,
    `${inFive.length} inside 5 days`,
  );

  console.log(NL + '— the alarm —');
  const { data: sum, error: sue } = await shop.rpc('expiring_summary', {
    p_store_id: storeId,
    p_within_days: 30,
  });
  const row = Array.isArray(sum) ? sum[0] : sum;
  check('a badge can ask in one call', !sue, sue?.message ?? '');
  check(
    'and it counts what is gone apart from what is coming',
    Number(row?.expired_items) >= 1 && Number(row?.soon_items) >= 1,
    `${row?.expired_items} expired, ${row?.soon_items} soon, next ${row?.next_date}`,
  );

  console.log(NL + '— and it can be taken off the shelf —');
  const { error: we } = await shop.rpc('write_off_expired', {
    p_layer_id: gone.layer_id,
    p_reason: `probe ${stamp} out of date`,
  });
  check('expired stock can be written off', !we, we?.message ?? '');

  const { data: after } = await shop.rpc('expiring_stock', {
    p_store_id: storeId,
    p_within_days: 30,
  });
  const left = (after ?? []).filter((r) => r.product_id === productId);
  check(
    'and it stops being counted once it is gone',
    left.length === 1 && Number(left[0].remaining) === 20,
    `${left.length} left`,
  );

  /*
   * IT IS DAMAGE, NOT AN ADJUSTMENT — the distinction 0129 drew between a crate that broke and one
   * that walked. Out-of-date stock is breakage the calendar caused, and a shop's damage report
   * should carry it.
   */
  const { data: hist } = await shop.rpc('product_history', { p_product_id: productId });
  const dmg = (hist ?? []).find((h) => h.kind === 'damage');
  check(
    'and it is booked as damage, not a nameless adjustment',
    dmg && Number(dmg.qty_delta) === -10,
    dmg ? `damage ${dmg.qty_delta}` : 'no damage movement',
  );

  const { error: tooMuch } = await shop.rpc('write_off_expired', {
    p_layer_id: nearly.layer_id,
    p_qty: 999,
  });
  check('writing off more than is left is refused', !!tooMuch, tooMuch?.message?.slice(0, 50) ?? '');
} catch (e) {
  console.log(`  FAIL  the probe could not finish — ${e.message}`);
  failed += 1;
} finally {
  if (productId) {
    /*
     * EMPTIED THROUGH THE LAYERS, and ONLY through them.
     *
     * An earlier version wrote the layers off and THEN counted to nought and resolved the gap —
     * which subtracts the same stock twice. The movement trail said so plainly:
     *
     *     receive +75 … damage -10, -20, -40 … adjustment -15   → running -10
     *
     * The shelf ended at minus ten and `archive_product` rightly refused. Every layer, read from
     * the table rather than from `expiring_stock` — that reader only returns DATED layers, so the
     * undated one could never be reached through it.
     */
    const { data: layers } = await shop
      .from('stock_layers')
      .select('id')
      .eq('product_id', productId)
      .gt('remaining_base', 0);
    for (const l of layers ?? []) {
      await shop.rpc('write_off_expired', { p_layer_id: l.id, p_reason: 'probe tidying up' });
    }
    const { error } = await shop.rpc('archive_product', { p_product_id: productId });
    console.log(
      NL + `  left behind: 1 retired product and 4 delivery layers` +
        `${error ? ` (retiring failed: ${error.message})` : ''} — all append-only.`,
    );
  }
}

console.log(NL + (failed === 0 ? 'ALL PASS' : `${failed} FAILED`));
process.exit(failed === 0 ? 0 : 1);
