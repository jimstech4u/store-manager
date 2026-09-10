/**
 * A shortfall is explained in as many pieces as it took, and theft has a name on it.
 *
 * The worked case from the request: 300 crates expected, 295 crates and 1 bottle counted. That is
 * 59 bottles gone — and in a real shop it is rarely one thing. Some broke; some walked.
 *
 * `resolve_variance` used to take ONE reason for the WHOLE variance, so a shop had to pick the
 * larger one and the rest became a lie inside the one table whose purpose is to be the truth about
 * loss. Worse, the two have opposite meanings: damage is a cost of doing business and theft is a
 * person, and blending them tells an owner their breakage is 59 bottles a month when 35 of them
 * went out of the door.
 *
 * MUTATION TEST. Restore the old behaviour and this fails:
 *   · take the FIRST part only and ignore the rest → "the parts are kept apart" fails.
 *   · drop the sum check → "a gap that is only partly explained is refused" fails.
 *   · write `adjustment` for every part → "damage is booked as damage" fails.
 *
 *     node scripts/probe-loss-has-a-name.mjs
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

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const shop = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
const signIn = await shop.auth.signInWithPassword({
  email: env.SAMPLE_EMAIL,
  password: env.SAMPLE_PASSWORD,
});
const me = signIn.data.user.id;
const storeId = (await shop.rpc('my_membership')).data[0].store_id;

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const stamp = Date.now().toString().slice(-6);
let productId = null;
let periodId = null;

try {
  // ── A product with a shelf on it ──────────────────────────────────────────────────
  console.log(NL + '— a shelf that is short —');

  const { data: pid, error: pe } = await shop.rpc('create_product', {
    p_store_id: storeId,
    p_name: `ZZ Loss ${stamp}`,
    p_base_unit: 'piece',
  });
  check('a product can be made to count', !pe, pe?.message ?? '');
  if (pe) throw new Error(pe.message);
  productId = pid;

  /*
   * 300 ON THE SHELF, at a known cost, so the value of the loss is checkable.
   *
   * `open_stock_by_count` records the count and writes the movement only when something moved —
   * `stock_movements` refuses `qty_delta = 0` and is right to.
   */
  const { error: oe } = await shop.rpc('open_stock_by_count', {
    p_store_id: storeId,
    p_product_id: productId,
    p_qty: 300,
    p_unit_cost: 100,
  });
  check('and a shelf to be short of', !oe, oe?.message ?? '');

  /*
   * `ensure_open_period`, which is what the count screen calls.
   *
   * `needs_count_today(p_product_id)` is a BOOLEAN — it answers whether a count is due, not which
   * period to write into. Using it here would have handed a `true` to a uuid parameter, and the
   * two guard assertions below would then have "passed" on a type error rather than on the guard
   * firing. A probe that cannot fail for the right reason is worse than no probe.
   */
  const { data: period, error: pde } = await shop.rpc('ensure_open_period', {
    p_product_id: productId,
  });
  if (pde) throw new Error(pde.message);
  periodId = period;

  /*
   * COUNTED 241 — fifty-nine short, which is the request's own arithmetic said in pieces:
   * 300 crates of twelve is 3,600; 295 crates and one bottle is 3,541; the gap is 59.
   */
  const { data: entered, error: ee } = await shop.rpc('enter_stock_count', {
    p_period_id: periodId,
    p_counted: 241,
  });
  check('the count records the shortfall', !ee && Number(entered?.variance) === -59,
    `variance ${entered?.variance}`);

  // ── Partly explained is not explained ─────────────────────────────────────────────
  console.log(NL + '— every one has to be accounted for —');

  const { error: short } = await shop.rpc('resolve_variance', {
    p_period_id: periodId,
    p_parts: [{ qty: 24, reason: 'unlogged_damage' }],
  });
  check(
    'a gap that is only partly explained is refused',
    !!short && /add up to/.test(short.message),
    short?.message?.slice(0, 80) ?? 'it was accepted',
  );

  const { error: over } = await shop.rpc('resolve_variance', {
    p_period_id: periodId,
    p_parts: [
      { qty: 40, reason: 'unlogged_damage' },
      { qty: 40, reason: 'theft' },
    ],
  });
  check(
    'and so is one explained twice over',
    !!over && /add up to/.test(over.message),
    over?.message?.slice(0, 60) ?? 'accepted',
  );

  // ── Two reasons, kept apart ───────────────────────────────────────────────────────
  console.log(NL + '— some broke, some walked —');

  const { error: re } = await shop.rpc('resolve_variance', {
    p_period_id: periodId,
    p_parts: [
      { qty: 24, reason: 'unlogged_damage', note: 'A crate went off the tailgate' },
      {
        qty: 35,
        reason: 'theft',
        note: 'Missing over the weekend',
        charge_to_member_id: me,
        charge_amount: 5000,
      },
    ],
  });
  check('a shortfall can be explained in pieces', !re, re?.message ?? '');
  if (re) throw new Error(re.message);

  const { data: parts } = await admin
    .from('variance_resolutions')
    .select('qty, reason, value_at_cost')
    .eq('stock_period_id', periodId)
    .order('reason');

  const damage = (parts ?? []).find((p) => p.reason === 'unlogged_damage');
  const theft = (parts ?? []).find((p) => p.reason === 'theft');

  check(
    'the parts are kept apart, not blended',
    (parts ?? []).length === 2 && Number(damage?.qty) === -24 && Number(theft?.qty) === -35,
    `${(parts ?? []).length} rows: damage ${damage?.qty}, theft ${theft?.qty}`,
  );

  /*
   * AND EACH IS VALUED ON ITS OWN. 24 × ₦100 and 35 × ₦100 — not one blended 59, which is the
   * figure no report could ever separate again.
   */
  check(
    'and each is valued on its own',
    Number(damage?.value_at_cost) === 2400 && Number(theft?.value_at_cost) === 3500,
    `damage ₦${damage?.value_at_cost}, theft ₦${theft?.value_at_cost}`,
  );

  const { data: moves } = await admin
    .from('stock_movements')
    .select('kind, qty_delta')
    .eq('product_id', productId)
    .in('kind', ['damage', 'adjustment']);

  const dmg = (moves ?? []).find((m) => m.kind === 'damage');
  const adj = (moves ?? []).find((m) => m.kind === 'adjustment');
  check(
    'damage is booked as damage, and theft as an adjustment',
    Number(dmg?.qty_delta) === -24 && Number(adj?.qty_delta) === -35,
    `damage ${dmg?.qty_delta}, adjustment ${adj?.qty_delta}`,
  );

  // ── And somebody answers for the theft ────────────────────────────────────────────
  console.log(NL + '— who answers for it —');

  const { data: owed, error: oe2 } = await shop.rpc('staff_charges_owed', {
    p_store_id: storeId,
  });
  check('staff charges can be read', !oe2, oe2?.message ?? '');
  const mine = (owed ?? []).find((r) => r.member_user_id === me);
  check(
    'the theft is charged to a person',
    mine && Number(mine.charged) >= 5000,
    `charged ₦${mine?.charged}, owing ₦${mine?.owing}`,
  );

  /*
   * IT IS NOT A CUSTOMER BALANCE AND IT IS NOT TAKINGS.
   *
   * Money recovered for stolen stock is not a sale. If this leaked into either, a shop's takings
   * would climb every time something went missing, which is the exact opposite of the truth.
   */
  const owingBefore = Number(mine?.owing);
  await shop.rpc('record_staff_charge', {
    p_store_id: storeId,
    p_member_user_id: me,
    p_amount: 2000,
    p_direction: 'paid',
    p_reason: `probe ${stamp} part payment`,
  });
  const after = ((await shop.rpc('staff_charges_owed', { p_store_id: storeId })).data ?? []).find(
    (r) => r.member_user_id === me,
  );
  check(
    'and paying some of it back comes off what they owe',
    owingBefore - Number(after?.owing) === 2000,
    `${owingBefore} -> ${after?.owing}`,
  );

  const { error: noReason } = await shop.rpc('record_staff_charge', {
    p_store_id: storeId,
    p_member_user_id: me,
    p_amount: 100,
    p_direction: 'charged',
    p_reason: '   ',
  });
  check('a charge with no reason is refused', !!noReason, noReason?.message?.slice(0, 50) ?? '');

  // ── The period can close now, and could not before ────────────────────────────────
  console.log(NL + '— and the period can be closed —');
  const { error: close } = await shop.rpc('close_stock_period', { p_period_id: periodId });
  check('a fully explained period closes', !close, close?.message ?? '');

  // ── A miscount still costs nothing ────────────────────────────────────────────────
  console.log(NL + '— and a miscount still costs nothing —');
  const { data: p2 } = await shop.rpc('ensure_open_period', { p_product_id: productId });
  await shop.rpc('enter_stock_count', { p_period_id: p2, p_counted: 235 });
  const { error: mis } = await shop.rpc('resolve_variance', {
    p_period_id: p2,
    p_parts: { qty: 6, reason: 'miscount' },
  });
  check('a single reason may still be sent as one object', !mis, mis?.message ?? '');

  const { data: misRow } = await admin
    .from('variance_resolutions')
    .select('value_at_cost')
    .eq('stock_period_id', p2)
    .maybeSingle();
  check(
    'and a miscount is valued at nothing',
    Number(misRow?.value_at_cost) === 0,
    `₦${misRow?.value_at_cost}`,
  );
} catch (e) {
  console.log(`  FAIL  the probe could not finish — ${e.message}`);
  failed += 1;
} finally {
  /*
   * RETIRE, BECAUSE IT CANNOT BE DELETED.
   *
   * `stock_movements` is append-only and refuses deletes, so a probe that has received stock cannot
   * remove its product — five "Cost probe" items once sat in the shop's real picker for exactly
   * this reason. Retiring keeps it out of every list without pretending it never existed.
   */
  if (productId) {
    /*
     * Emptied first, because `archive_product` refuses an item with stock still on it — and it is
     * right to. Counting it down to nothing and calling that a miscount is what a shop would do.
     */
    const { data: last } = await shop.rpc('ensure_open_period', { p_product_id: productId });
    if (last) {
      const { data: e } = await shop.rpc('enter_stock_count', { p_period_id: last, p_counted: 0 });
      if (e && Number(e.variance) !== 0) {
        await shop.rpc('resolve_variance', {
          p_period_id: last,
          /*
           * `other`, NOT `miscount`.
           *
           * A miscount means the COUNT was wrong, so the ledger stands and the count is corrected
           * to match it — which leaves the 241 exactly where they were and `archive_product`
           * rightly refuses. Emptying the shelf means telling the ledger the stock really went.
           */
          p_parts: { qty: Math.abs(Number(e.variance)), reason: 'other' },
          p_note: 'probe tidying up',
        });
      }
    }
    const { error } = await shop.rpc('archive_product', { p_product_id: productId });
    console.log(
      NL + `  left behind: 1 retired product${error ? ` (retiring failed: ${error.message})` : ''},` +
        ' its counts, movements and one staff charge — all append-only.',
    );
  }
}

console.log(NL + (failed === 0 ? 'ALL PASS' : `${failed} FAILED`));
process.exit(failed === 0 ? 0 : 1);
