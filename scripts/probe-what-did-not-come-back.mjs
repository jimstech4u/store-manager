/**
 * Returns counted in shapes, and an answer for the ones that did not come back.
 *
 * «log what came back maybe 5 NBL crate and 3 bottles of goldberg and then we get asked for where
 *  the 9 pieces so we can enter money paid for it or on trust»
 *
 * Three things happen to a container and the shop could record two of them. It came back. It is
 * still owed. Or it is GONE — and the only version of gone `settle_empties` understood was one
 * covered by a deposit the shop happened to be holding. On trust, broken, paid for at the counter:
 * nowhere to put it, so the containers stayed outstanding for ever against a customer who had
 * already settled, and the shop's "still out" list filled with obligations nobody owed.
 *
 * `deposit_forfeits` has existed since 0004 for exactly this, with a trigger and an RLS policy and
 * no writer at all. This drives the writer.
 *
 * WRITES, against a real receipt, because there is no way to make a fake one: a sale moves stock and
 * `stock_movements` is append-only with no void path. So it settles a receipt the shop already has
 * and puts the containers back with a BALANCING LEDGER ROW, which is the only reversal an
 * append-only ledger allows and the same one a shop would use to correct a miscount.
 *
 * One row it cannot take back: the `deposit_forfeits` entry, which is append-only by design because
 * it is income. The probe says so at the end rather than leaving it to be found.
 *
 *     node scripts/probe-what-did-not-come-back.mjs
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
await shop.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });
const storeId = (await shop.rpc('my_membership')).data[0].store_id;

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

/*
 * A real receipt with containers out, chosen rather than created.
 *
 * Making a sale would move stock, and `stock_movements` is append-only with no void path — so this
 * settles against a receipt the shop already has, and puts the containers back afterwards with a
 * balancing ledger row, which is the only reversal an append-only ledger allows.
 */
const { data: receipts, error: readErr } = await shop.rpc('empties_by_receipt', {
  p_store_id: storeId,
  p_customer_id: null,
  p_limit: 20,
});
if (readErr) {
  console.log(`  FAIL  could not read what is out — ${readErr.message}`);
  process.exit(1);
}

const subject = (receipts ?? []).find((r) => Number(r.outstanding_units) >= 12);
if (!subject) {
  console.log('  SKIP  no receipt in this shop has enough out to settle a shape against');
  process.exit(0);
}

const pool = subject.expected[0];
const OUT = Number(pool.units);
console.log(`\n  ${subject.customer_name} — ${OUT} ${pool.category} still out\n`);

const written = [];

try {
  // ══ The shapes a pool comes back in ═══════════════════════════════════════════════
  console.log('— counted the way a shop counts —');
  const { data: units } = await shop.rpc('return_units_for', { p_category_id: pool.category_id });
  console.log(
    `      comes back in: ${(units ?? []).map((u) => `${u.name} of ${u.base_qty}`).join(', ') || '(nothing declared)'}`,
  );

  const biggest = (units ?? []).sort((a, b) => Number(b.base_qty) - Number(a.base_qty))[0];
  const each = biggest ? Number(biggest.base_qty) : 1;

  /*
   * A SHORTFALL ON PURPOSE, because the shortfall is the whole subject.
   *
   * A first version brought back whole shapes and settled the lot. It passed every check and
   * exercised nothing: this pool declares no return shapes, so everything came back, `short` was
   * zero, and the three assertions about the forfeit path were all true of an empty list. "Nine of
   * twelve came back" is the ordinary Tuesday this exists for, so the probe arranges one.
   */
  const wantShort = Math.max(1, Math.min(9, OUT - each));
  const whole = Math.max(1, Math.floor((OUT - wantShort) / each));
  const backUnits = Math.min(whole * each, OUT);
  const short = OUT - backUnits;

  check(
    'there is something to be short of',
    short > 0,
    `${backUnits} back of ${OUT}, ${short} short`,
  );
  console.log(
    `      ${whole} × ${biggest?.name ?? 'unit'} = ${backUnits} back, ${short} not coming back\n`,
  );

  // ══ What is gone, and paid for ════════════════════════════════════════════════════
  console.log('— and an answer for the rest —');
  const PAID = 750;
  const forfeitsBefore =
    (await admin.from('deposit_forfeits').select('id', { count: 'exact', head: true })).count ?? 0;

  const { data: result, error } = await shop.rpc('settle_empties', {
    p_store_id: storeId,
    p_sale_id: subject.sale_id,
    p_returned: backUnits > 0 ? [{ category_id: pool.category_id, qty: backUnits }] : [],
    p_paid_for: short > 0 ? [{ category_id: pool.category_id, qty: short, amount: PAID }] : [],
    p_apply_amount: 0,
    p_refund_amount: 0,
    p_refund_mode: 'none',
    p_note: 'probe — what did not come back',
    p_occurred_at: new Date().toISOString(),
  });
  check('it settles', !error, error?.message ?? '');
  if (error) throw error;

  written.push({ category_id: pool.category_id, qty: OUT });

  check(
    'the whole shapes are recorded as returned',
    Number(result.returned_units) === backUnits,
    `${result.returned_units} of ${backUnits}`,
  );
  check(
    'and the remainder is written off rather than left owing',
    Number(result.written_off_units) === short,
    `${result.written_off_units} of ${short}`,
  );
  check(
    'with the money against it',
    short === 0 || Number(result.paid_for) === PAID,
    `₦${result.paid_for}`,
  );

  const { count: forfeitsAfter } = await admin
    .from('deposit_forfeits')
    .select('id', { count: 'exact', head: true });
  check(
    'deposit_forfeits finally has a writer',
    short === 0 || (forfeitsAfter ?? 0) === forfeitsBefore + 1,
    `${forfeitsBefore} → ${forfeitsAfter}`,
  );

  // ══ Nothing is left owing ═════════════════════════════════════════════════════════
  console.log('\n— what the customer still owes —');
  const { data: now } = await shop.rpc('empties_by_receipt', {
    p_store_id: storeId,
    p_customer_id: null,
    p_limit: 50,
    p_sale_id: subject.sale_id,
  });
  const after = (now ?? [])[0];
  check(
    'the receipt is clear — none of it is still hanging over them',
    after == null || Number(after.outstanding_units) === 0,
    after ? `${after.outstanding_units} still out` : 'gone from the list entirely',
  );

  /*
   * AND THE MONEY IS NOT A PAYMENT.
   *
   * It was handed over for broken bottles, not against what the customer owes. Allocating it would
   * pay down whatever sale happened to be oldest, which is not what anybody agreed to.
   */
  const { count: paid } = await admin
    .from('payments')
    .select('id', { count: 'exact', head: true })
    .eq('reference', 'probe — what did not come back');
  check('and it was not booked as a payment against their account', (paid ?? 0) === 0);
} finally {
  /*
   * PUT THE CONTAINERS BACK.
   *
   * `deposit_ledger` is append-only and refuses a delete, so the reversal is another row — which is
   * how a ledger is corrected and the only honest way to undo this. The `deposit_forfeits` row
   * CANNOT be reversed and stays; it is said plainly rather than left to be discovered.
   */
  console.log('\n— putting it back —');
  for (const w of written) {
    const { error } = await admin.from('deposit_ledger').insert({
      store_id: storeId,
      store_customer_id: (
        await admin.from('sales').select('store_customer_id').eq('id', subject.sale_id).single()
      ).data.store_customer_id,
      empties_category_id: w.category_id,
      direction: 'collected',
      qty_units: w.qty,
      deposit_per_unit: 0,
      ref_table: 'sales',
      ref_id: subject.sale_id,
      note: 'probe reversal — the containers were never really returned',
    });
    console.log(`  ${error ? 'FAIL' : 'ok'}  ${w.qty} put back${error ? ` — ${error.message}` : ''}`);
    if (error) failed += 1;
  }
  const { count: stuck } = await admin
    .from('deposit_forfeits')
    .select('id', { count: 'exact', head: true })
    .eq('note', 'probe — what did not come back');
  if ((stuck ?? 0) > 0) {
    console.log(
      `  ..    ${stuck} forfeit row(s) stay: the table is append-only and refuses a delete, by design`,
    );
  }
}

console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
