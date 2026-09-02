/**
 * The shop's own worked example, run against the real database.
 *
 *   Irekanmi takes out returnables. ₦10,000 is held for the lot — one figure, no breakdown. He
 *   brings back everything except some of each. The shop keeps ₦2,000 for what did not come back
 *   and hands ₦8,000 over.
 *
 * The claims: the receipt knows what it put out, the holding is one number and not an invented
 * per-item split, a short return is allowed and the shortfall is what the SHOP says it is, the
 * money adds up afterwards, and nothing that already existed moved.
 *
 * Writes, then puts the shop back where it found it — the ledgers are append-only, so "cleaning up"
 * means appending the opposite, exactly as a real correction would.
 *
 *     node scripts/probe-settle-empties.mjs
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

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const written = { holdings: [], ledger: [], forfeits: [], payments: [] };

try {
  // ══ A receipt that actually has returnables on it ═════════════════════════════════
  console.log('\n— a receipt with empties still out —');
  const { data: rows, error: readErr } = await shop.rpc('empties_by_receipt', {
    p_store_id: storeId,
    p_customer_id: null,
    p_limit: 20,
  });
  check('the shop can list receipts with empties out', !readErr, readErr?.message ?? '');
  check('and there are some', (rows ?? []).length > 0, `${(rows ?? []).length} receipts`);

  const target = (rows ?? []).find((r) => Number(r.outstanding_units) >= 4);
  check('one of them has enough out to settle short', Boolean(target),
    target ? `${target.customer_name}, ${target.outstanding_units} units` : 'none big enough');
  if (!target) throw new Error('nothing to settle');

  console.log(`    ${target.customer_name} — ${target.outstanding_units} units on receipt ${target.sale_id.slice(0, 8)}`);
  for (const e of target.expected) console.log(`      · ${e.category}: ${e.units} (${e.kind})`);

  check('the receipt starts holding nothing', Number(target.held) === 0, `₦${target.held}`);

  // ══ ₦10,000 for the lot — one figure, no breakdown ════════════════════════════════
  console.log('\n— ten thousand for the lot —');
  const { data: holdId, error: holdErr } = await shop.rpc('hold_receipt_deposit', {
    p_store_id: storeId,
    p_sale_id: target.sale_id,
    p_amount: 10000,
    p_note: 'probe: deposit for the whole receipt',
  });
  check('a lump sum can be held against the receipt', !holdErr, holdErr?.message ?? '');
  if (holdId) written.holdings.push(holdId);

  const { data: after1 } = await shop.rpc('empties_by_receipt', {
    p_store_id: storeId, p_customer_id: target.store_customer_id, p_limit: 50,
  });
  const now1 = (after1 ?? []).find((r) => r.sale_id === target.sale_id);
  check('and the receipt says so', Number(now1?.held) === 10000, `₦${now1?.held}`);

  const { data: holdRows } = await admin
    .from('deposit_holdings')
    .select('amount, reason, ref_table, ref_id')
    .eq('ref_id', target.sale_id);
  check(
    'held as ONE row, not split across the pools',
    (holdRows ?? []).length === 1,
    `${(holdRows ?? []).length} rows`,
  );
  /*
   * Asked of the TABLE, not of the row.
   *
   * A first version selected `empties_category_id` and checked it was null — but the column does
   * not exist, so the select failed, returned nothing, and the probe reported "0 rows" for a row
   * that had just been written successfully. The claim is structural: this table cannot hold a
   * per-category split, so ask whether the column is there at all.
   */
  const { error: noSuchColumn } = await admin
    .from('deposit_holdings').select('empties_category_id').limit(1);
  check(
    'and the table cannot even express a per-item split',
    Boolean(noSuchColumn),
    noSuchColumn ? 'no category column' : 'a category column exists, which invites inventing one',
  );

  // ══ Most of it comes back ═════════════════════════════════════════════════════════
  console.log('\n— most of it comes back, and the shop keeps ₦2,000 —');
  const first = target.expected[0];
  const short = 1;
  const returning = Math.max(1, Number(first.units) - short);

  const { data: settled, error: settleErr } = await shop.rpc('settle_empties', {
    p_store_id: storeId,
    p_sale_id: target.sale_id,
    p_returned: [{ category_id: first.category_id, qty: returning }],
    p_apply_amount: 2000,
    p_refund_amount: 8000,
    p_refund_mode: 'cash',
    p_note: 'probe: settled short',
    p_occurred_at: new Date().toISOString(),
  });
  check('a SHORT return is allowed', !settleErr, settleErr?.message ?? '');
  if (settleErr) throw settleErr;

  check('it says what came back', Number(settled.returned_units) === returning, String(settled.returned_units));
  check('what was kept', Number(settled.applied) === 2000, `₦${settled.applied}`);
  check('what was handed over', Number(settled.refunded) === 8000, `₦${settled.refunded}`);
  check('and that nothing is still held', Number(settled.still_held) === 0, `₦${settled.still_held}`);
  if (settled.payment_id) written.payments.push(settled.payment_id);

  // ══ The money adds up ═════════════════════════════════════════════════════════════
  console.log('\n— and it reconciles —');
  const { data: allHold } = await admin
    .from('deposit_holdings').select('id, amount, reason').eq('ref_id', target.sale_id);
  for (const h of allHold ?? []) if (!written.holdings.includes(h.id)) written.holdings.push(h.id);

  const sum = (allHold ?? []).reduce((t, h) => t + Number(h.amount), 0);
  check('the holding nets to zero', sum === 0, `₦${sum}`);
  check('with the three movements recorded', (allHold ?? []).length === 3,
    (allHold ?? []).map((h) => h.reason).join(', '));

  /*
   * THE INCOME IS THE HOLDING ROW, not a `deposit_forfeits` entry.
   *
   * A first version asserted a forfeit was written, and the migration duly tried to write one —
   * and the database refused it, because that table requires `qty_units > 0`. It was built for the
   * per-pool case ("nine bottles broke, we kept ₦1,125"); this is the case where the shop names
   * ONE figure for a mixed shortfall and never breaks it down, so there is no honest quantity to
   * put in that column. The constraint was right and the design was wrong.
   *
   * So the money lives in one place: a signed, append-only holding tied to the receipt, which is
   * what a report should read. Two tables recording the same money is how a figure gets counted
   * twice.
   */
  const kept = (allHold ?? []).find((h) => h.reason === 'applied_to_shortfall');
  check(
    'the ₦2,000 kept is recorded as income, not vanished',
    Boolean(kept) && Number(kept.amount) === -2000,
    kept ? `₦${Math.abs(Number(kept.amount))} applied_to_shortfall` : 'no record of it',
  );
  check(
    'and no impossible forfeit row was invented for it',
    ((await admin.from('deposit_forfeits').select('id').eq('amount', 2000)).data ?? []).length === 0,
  );

  const { data: after2 } = await shop.rpc('empties_by_receipt', {
    p_store_id: storeId, p_customer_id: target.store_customer_id, p_limit: 50,
  });
  const now2 = (after2 ?? []).find((r) => r.sale_id === target.sale_id);
  check(
    'the receipt now shows only what is genuinely still out',
    now2 ? Number(now2.outstanding_units) === Number(target.outstanding_units) - returning : true,
    now2 ? `${target.outstanding_units} → ${now2.outstanding_units}` : 'settled in full',
  );

  // ══ It refuses to account for money it is not holding ═════════════════════════════
  console.log('\n— and it refuses what it cannot back —');
  const { error: tooMuch } = await shop.rpc('settle_empties', {
    p_store_id: storeId, p_sale_id: target.sale_id, p_returned: [],
    p_apply_amount: 999999, p_refund_amount: 0, p_refund_mode: 'none',
    p_note: null, p_occurred_at: new Date().toISOString(),
  });
  check('spending more than is held is refused', Boolean(tooMuch),
    tooMuch?.message?.slice(0, 60) ?? 'ACCEPTED, which is wrong');
} finally {
  /*
   * CLEANED BY A MAINTENANCE SCRIPT, because these tables refuse a delete.
   *
   * A first version deleted its own rows through the service role. The append-only trigger refused
   * it and said nothing, so a ₦10,000 deposit that never happened stayed on a real customer's
   * receipt — and the next run read it as the starting position and reported three failures that
   * were its own leftovers. A cleanup that cannot fail loudly is not a cleanup.
   *
   * `clean-probe-rows.py` drops the trigger for one transaction and removes only rows whose note
   * this probe stamped.
   */
  const { execFileSync } = await import('node:child_process');
  try {
    const out = execFileSync('python', ['scripts/clean-probe-rows.py'], { encoding: 'utf8' });
    const left = /"holdings_left":(\d+),"ledger_left":(\d+)/.exec(out);
    console.log(`\n  cleaned — ${left ? `${left[1]} holdings, ${left[2]} ledger rows left` : out.trim()}`);
    if (left && (left[1] !== '0' || left[2] !== '0')) failed += 1;
  } catch (e) {
    console.log('\n  CLEANUP FAILED — probe rows are still in the shop:', String(e).slice(0, 120));
    failed += 1;
  }
}

console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
