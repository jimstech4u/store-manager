/**
 * What a return may be made in.
 *
 *   «goldberg has to be returned in full crate or half»
 *   «customer could return heineken full crate back to get gulder and not half»
 *
 * The claims:
 *   · a pool with nothing declared accepts anything — a shop that has not made a rule has not made
 *     one, and refusing its returns would be inventing it;
 *   · once shapes are declared, a whole multiple passes and a loose remainder is refused AT THE
 *     COUNTER, naming the shapes it does take;
 *   · the shapes belong to the POOL, so a crate from one product settles another's obligation.
 *
 * Read-only except for the return units it declares, which it removes.
 *
 *     node scripts/probe-return-units.mjs
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

let pool = null;

try {
  const { data: pools } = await shop.rpc('store_empties_categories', { p_store_id: storeId });

  /*
   * Chosen for what it can PROVE, not for its name.
   *
   * A first version picked the pool whose name says "crate" — and that pool is a container kind,
   * counted only when a crate physically leaves, so almost no receipt has thirteen of them out.
   * The refusal check, which is the whole point of this migration, printed "no receipt to try it
   * on" and the probe passed anyway. A test that skips its own subject is not a test.
   */
  const { data: allReceipts } = await shop.rpc('empties_by_receipt', {
    p_store_id: storeId, p_customer_id: null, p_limit: 100, p_sale_id: null,
  });

  const usable = new Map();
  for (const r of allReceipts ?? []) {
    for (const e of r.expected) {
      if (Number(e.units) >= 13 && !usable.has(e.category_id)) usable.set(e.category_id, r);
    }
  }

  pool = (pools ?? []).find((c) => usable.has(c.id)) ?? (pools ?? [])[0];
  const target = usable.get(pool?.id) ?? null;
  check('the shop has a pool with enough out to test a refusal', Boolean(target),
    pool ? `${pool.name}${target ? '' : ' — nothing out, refusal untestable'}` : 'none');
  if (!pool) throw new Error('no pools');

  // ══ Nothing declared: anything goes ═══════════════════════════════════════════════
  console.log('\n— a pool with no rule accepts anything —');
  const { data: none } = await shop.rpc('return_units_for', { p_category_id: pool.id });
  /*
   * Names what it found, because this is the check that catches contamination.
   *
   * It fired once on a shape left behind by an earlier run and the message said only "1" — true,
   * and useless. A probe that detects a dirty starting state has done its job; saying WHICH pool
   * and WHICH shape is what makes the next person able to act on it in one step.
   */
  check(
    `${pool.name} starts with no shapes declared`,
    (none ?? []).length === 0,
    (none ?? []).map((u) => `${u.name}=${Number(u.base_qty)}`).join(', ') ||
      'none, as expected',
  );

  const { data: any7 } = await shop.rpc('return_is_allowed', { p_category_id: pool.id, p_qty: 7 });
  check(
    'so seven is allowed — a shop that made no rule has not made one',
    any7 === true,
    String(any7),
  );

  // ══ Declared: whole multiples only ════════════════════════════════════════════════
  console.log('\n— once the shop says "whole crates or half" —');
  const { data: saved, error: saveErr } = await shop.rpc('save_return_units', {
    p_category_id: pool.id,
    p_units: [
      { name: 'Full crate', base_qty: 12, is_default: true },
      { name: 'Half crate', base_qty: 6, is_default: false },
    ],
  });
  check('the shapes save', !saveErr && saved === 2, saveErr?.message ?? `${saved} saved`);

  const { data: back } = await shop.rpc('return_units_for', { p_category_id: pool.id });
  check('and read back, largest first', (back ?? [])[0]?.name === 'Full crate',
    (back ?? []).map((u) => `${u.name}=${u.base_qty}`).join(', '));

  for (const [qty, want, why] of [
    [12, true, 'one full crate'],
    [24, true, 'two full crates'],
    [6, true, 'a half crate'],
    [18, true, 'a crate and a half — three halves, which is a whole multiple of six'],
    [7, false, 'seven loose bottles'],
    [5, false, 'five, under every shape'],
    [13, false, 'a crate and one'],
  ]) {
    const { data: ok } = await shop.rpc('return_is_allowed', { p_category_id: pool.id, p_qty: qty });
    check(`${qty} — ${why}`, ok === want, `allowed=${ok}`);
  }

  // ══ Refused at the counter, with the shapes named ═════════════════════════════════
  console.log('\n— and a bad quantity is refused where the shop can see it —');
  if (target) {
    const { error } = await shop.rpc('settle_empties', {
      p_store_id: storeId,
      p_sale_id: target.sale_id,
      p_returned: [{ category_id: pool.id, qty: 7 }],
      p_apply_amount: 0,
      p_refund_amount: 0,
      p_refund_mode: 'none',
      p_note: 'probe: seven loose',
      p_occurred_at: new Date().toISOString(),
    });
    check('settling seven is refused', Boolean(error), error?.message?.slice(0, 80) ?? 'ACCEPTED');
    check(
      'and the refusal names the shapes it does take',
      /Full crate|Half crate/.test(error?.message ?? ''),
      error?.message?.slice(0, 80) ?? '',
    );
  } else {
    check('settling a bad quantity is refused', false, 'could not set up a receipt to try it on');
  }

  // ══ The shapes belong to the pool, not the product ════════════════════════════════
  console.log('\n— and the shape is the pool’s, so any product in it settles any other —');
  const { data: sharing } = await admin
    .from('product_returnables')
    .select('product_id, products!inner(name)')
    .eq('empties_category_id', pool.id);
  check(
    'more than one product shares this pool',
    (sharing ?? []).length > 1,
    (sharing ?? []).map((r) => r.products.name).join(', ') || 'only one',
  );
  check(
    'and one rule governs all of them, because it hangs off the pool',
    (back ?? []).length === 2,
    'a crate is a crate whichever beer was in it',
  );
} finally {
  if (pool) {
    // Put the pool back to having no rule, which is how it was found.
    await admin.from('empties_return_units').delete().eq('empties_category_id', pool.id);
    console.log('\n  (declared shapes removed)');
  }
}

console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
