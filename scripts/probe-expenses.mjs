/**
 * Money that goes out, and what the shop actually kept.
 *
 * «another important thing is expense that we forgot business do have»
 *
 * Every way money could LEAVE was attached to something the shop bought or somebody it owed — a
 * delivery, a supplier payment, a deposit handed back. Rent, fuel, the generator, a staff advance,
 * the union levy: none of it had anywhere to go, so takings read as profit and the arithmetic was
 * wrong by exactly the cost of running the place.
 *
 * MUTATION TEST. Restore the fault and this fails:
 *   · drop `expenses` from `money_summary`        → "what was kept is what came in less what went out" fails.
 *   · let a reversal add instead of subtract      → "taking one back cancels it" fails.
 *   · drop the case-insensitive category lookup   → "the same heading twice is one heading" fails.
 *
 *     node scripts/probe-expenses.mjs
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

const stamp = Date.now().toString().slice(-6);
const HEADING = `ZZ Fuel ${stamp}`;
const made = [];

const window_ = async () => {
  const { data } = await shop.rpc('period_range', { p_store_id: storeId, p_kind: 'today' });
  return Array.isArray(data) ? data[0] : data;
};

const summary = async (w) => {
  const { data } = await shop.rpc('money_summary', {
    p_store_id: storeId,
    p_from: w.from_at,
    p_to: w.to_at,
  });
  return Array.isArray(data) ? data[0] : data;
};

try {
  const w = await window_();

  console.log(NL + '— money leaves, and it is not a supplier payment —');
  const before = await summary(w);
  check('the shop can be asked what it kept', !!before, `kept ${before?.kept}`);

  const { data: id, error } = await shop.rpc('record_expense', {
    p_store_id: storeId,
    p_amount: 12500,
    p_note: `probe ${stamp}: diesel for the generator`,
    p_category: HEADING,
    p_method: 'cash',
    p_paid_to: 'The filling station',
  });
  check('an expense can be recorded', !error, error?.message ?? '');
  if (error) throw new Error(error.message);
  made.push(id);

  const after = await summary(w);
  check(
    'what went out rises by what left',
    Number(after.spent) - Number(before.spent) === 12500,
    `${before.spent} -> ${after.spent}`,
  );

  /*
   * AND WHAT THE SHOP KEPT FALLS BY THE SAME.
   *
   * This is the whole point. Without it, takings were profit: a shop with ₦400,000 through the till
   * and ₦380,000 of rent, fuel and wages read as having made ₦400,000.
   */
  check(
    'what was kept is what came in less what went out',
    Number(before.kept) - Number(after.kept) === 12500 &&
      Number(after.kept) === Number(after.cameIn ?? after.came_in) - Number(after.spent),
    `kept ${before.kept} -> ${after.kept}`,
  );

  /*
   * AND IT IS NOT A SUPPLIER PAYMENT. `supplier_payments` settles an account with somebody who has
   * a balance on the other end of it; an expense has no other end. If the rent turned up in a
   * supplier's statement, that supplier's balance would be wrong.
   */
  const { count: leaked } = await shop
    .from('supplier_payments')
    .select('id', { count: 'exact', head: true })
    .eq('store_id', storeId)
    .ilike('reason', `%probe ${stamp}%`);
  check('and it is nowhere near a supplier account', (leaked ?? 0) === 0, `${leaked} row(s)`);

  // ── What it demands ───────────────────────────────────────────────────────────────
  console.log(NL + '— and it insists on being answerable —');
  const { error: noNote } = await shop.rpc('record_expense', {
    p_store_id: storeId,
    p_amount: 500,
    p_note: '   ',
  });
  check('an expense with no reason is refused', !!noNote, noNote?.message?.slice(0, 40) ?? '');

  const { error: noAmount } = await shop.rpc('record_expense', {
    p_store_id: storeId,
    p_amount: 0,
    p_note: 'nothing',
  });
  check('and one with no amount', !!noAmount, noAmount?.message?.slice(0, 40) ?? '');

  // ── Headings the shop names ───────────────────────────────────────────────────────
  console.log(NL + '— headings the shop names —');
  const { data: id2 } = await shop.rpc('record_expense', {
    p_store_id: storeId,
    p_amount: 3000,
    p_note: `probe ${stamp}: more diesel`,
    // Same heading, different case. "Fuel" and "fuel" are one cost and must total as one.
    p_category: HEADING.toUpperCase(),
  });
  made.push(id2);

  const { data: cats } = await shop.rpc('expense_category_list', { p_store_id: storeId });
  const mine = (cats ?? []).filter((c) => c.name.toLowerCase() === HEADING.toLowerCase());
  check('the same heading twice is one heading', mine.length === 1, `${mine.length} row(s)`);

  const { data: byCat } = await shop.rpc('expenses_by_category', {
    p_store_id: storeId,
    p_from: w.from_at,
    p_to: w.to_at,
  });
  const row = (byCat ?? []).find((c) => c.category?.toLowerCase() === HEADING.toLowerCase());
  check('and it totals as one', Number(row?.total) === 15500, `₦${row?.total}`);

  // ── Taking one back ───────────────────────────────────────────────────────────────
  console.log(NL + '— and one keyed wrong can be taken back —');
  const spentBefore = Number((await summary(w)).spent);

  const { data: rev, error: re } = await shop.rpc('reverse_expense', {
    p_expense_id: made[0],
    p_reason: `probe ${stamp}: keyed twice`,
  });
  check('an expense can be taken back', !re, re?.message ?? '');
  if (!re) made.push(rev);

  check(
    'taking one back cancels it',
    Number((await summary(w)).spent) === spentBefore - 12500,
    `${spentBefore} -> ${(await summary(w)).spent}`,
  );

  /*
   * AND BOTH ROWS STAY. A history with a gap in it is not a history — the trail has to read as
   * money out and then money back, which is also what makes the correction answerable.
   */
  const { data: rows } = await shop.rpc('list_expenses', {
    p_store_id: storeId,
    p_from: w.from_at,
    p_to: w.to_at,
  });
  const original = (rows ?? []).find((r) => r.id === made[0]);
  const reversal = (rows ?? []).find((r) => r.reverses_id === made[0]);
  check(
    'and both rows stay on the list',
    !!original && !!reversal && original.reversed === true,
    `original ${original ? 'kept' : 'gone'}, reversal ${reversal ? 'present' : 'missing'}`,
  );

  const { error: twice } = await shop.rpc('reverse_expense', {
    p_expense_id: made[0],
    p_reason: 'again',
  });
  check('taking it back twice is refused', !!twice, twice?.message?.slice(0, 50) ?? 'accepted');

  const { error: noWhy } = await shop.rpc('reverse_expense', {
    p_expense_id: made[1],
    p_reason: '  ',
  });
  check('and taking one back with no reason', !!noWhy, noWhy?.message?.slice(0, 40) ?? '');

  // ── Who it belongs to ─────────────────────────────────────────────────────────────
  console.log(NL + '— and it belongs to this shop —');
  const { error: theirs } = await shop.rpc('record_expense', {
    p_store_id: storeId,
    p_amount: 100,
    p_note: 'advance',
    p_member_user_id: '00000000-0000-0000-0000-000000000001',
  });
  check(
    'an advance to somebody who does not work here is refused',
    !!theirs,
    theirs?.message?.slice(0, 50) ?? 'accepted',
  );
} catch (e) {
  console.log(`  FAIL  the probe could not finish — ${e.message}`);
  failed += 1;
} finally {
  /*
   * `expenses` is append-only and refuses deletes, so nothing here can be removed — which is the
   * design. Said out loud rather than claimed clean.
   */
  console.log(
    NL + `  left behind: ${made.length} expense row(s) and one heading, all append-only.`,
  );
}

console.log(NL + (failed === 0 ? 'ALL PASS' : `${failed} FAILED`));
process.exit(failed === 0 ? 0 : 1);
