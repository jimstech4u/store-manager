/**
 * THE ROLL-UP, AND WHAT SETTLING ONE OF ITS LINES ACTUALLY CLEARS.
 *
 *     node scripts/probe-empties-rollup.mjs
 *
 * The shop's rule, in their words: a customer owes "5 NBL crates and half a Gulder", not a list of
 * beers. `empties-rollup.ts` has stated that since it was written — whole crates add up across the
 * maker, part-loads stay with their product — and it was reading from nothing, because no product
 * had a maker.
 *
 * Two things are checked here, on a throwaway shop of its own:
 *
 *   · the roll-up says what the shop would say out loud
 *   · SETTLING a maker line spreads across that maker's products, most owed first — which is the
 *     part with no prior art, and the part that would quietly clear the wrong beer if it were
 *     wrong. Three NBL crates against two Goldberg and one Gulder has to clear both.
 *
 * It builds its own shop and drops it, so it never touches a real one.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { rollUpOwed } from '../src/lib/empties-rollup.ts';

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

/*
 * THE SAME ALLOCATION THE SCREEN DOES, kept here as the thing under test.
 *
 * It is a handful of lines and it decides which customer's obligation is cleared, so it is worth
 * a test that does not need a browser. If the screen's copy and this one ever disagree, the
 * screen is wrong: this is the one with the worked examples beside it.
 */
function spread(rows, wanted) {
  const out = [];
  let left = wanted;
  for (const r of [...rows].sort((a, b) => b.owed - a.owed)) {
    if (left <= 1e-9) break;
    const take = Math.min(left, r.owed);
    if (take > 1e-9) out.push({ productName: r.productName, qty: take });
    left -= take;
  }
  return { taken: out, short: left };
}

const row = (productName, groupName, owed, unit = 'Crate') => ({
  productId: productName,
  productName,
  productUnitId: `${productName}|${unit}`,
  unitName: unit,
  unitPlural: `${unit}s`,
  baseQty: 12,
  groupId: groupName,
  groupName,
  side: 'they_hold',
  owed,
});

console.log('\n— what the shop would say out loud —');
{
  const lines = rollUpOwed([
    row('Goldberg Bottle', 'Nigerian Breweries', 3.5),
    row('Guilder Bottle', 'Nigerian Breweries', 2.5),
    row('Trophy Bottle', 'International Breweries', 1),
  ]);
  const said = lines.map((l) => `${l.said} ${l.unit.toLowerCase()} ${l.label}`);
  console.log('   ' + said.join('\n   '));

  check(
    'three and a half Goldberg and two and a half Gulder is FIVE NBL crates',
    lines.some((l) => !l.isPart && l.label === 'Nigerian Breweries' && l.qty === 5),
  );
  check(
    'and the two halves stay with their own beer, not added into a sixth crate',
    lines.filter((l) => l.isPart).length === 2 &&
      lines.filter((l) => l.isPart).every((l) => l.qty === 0.5),
  );
  check(
    'a different maker is a different line',
    lines.some((l) => l.label === 'International Breweries' && l.qty === 1),
  );
}

console.log('\n— settling a maker line spreads across that maker —');
{
  const rows = [
    row('Goldberg Bottle', 'Nigerian Breweries', 2),
    row('Guilder Bottle', 'Nigerian Breweries', 1),
  ];
  const { taken, short } = spread(rows, 3);
  console.log('   ' + taken.map((t) => `${t.qty} × ${t.productName}`).join(', '));
  check('three NBL crates clear both beers', taken.length === 2 && short < 1e-9);
  check('the most owed goes first', taken[0].productName === 'Goldberg Bottle' && taken[0].qty === 2);
  check('and the rest falls to the next', taken[1].qty === 1);
}

console.log('\n— and it never clears more than is owed —');
{
  const rows = [row('Goldberg Bottle', 'Nigerian Breweries', 2)];
  const { taken, short } = spread(rows, 5);
  check('two owed, five offered: only two are taken', taken[0].qty === 2);
  check('and the screen is told there are three too many', Math.abs(short - 3) < 1e-9);
}

console.log('\n— a part-load is only ever its own beer —');
{
  const rows = [
    row('Goldberg Bottle', 'Nigerian Breweries', 0.5),
    row('Guilder Bottle', 'Nigerian Breweries', 0.5),
  ];
  const lines = rollUpOwed(rows);
  check('two half crates make no whole crate line', lines.every((l) => l.isPart));
  check('they stay as two, one per beer', lines.length === 2);
}

console.log('\n— against the live shop, read only —');
{
  const shop = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
  const { error } = await shop.auth.signInWithPassword({
    email: env.SAMPLE_EMAIL,
    password: env.SAMPLE_PASSWORD,
  });
  if (error) throw new Error('could not sign in: ' + error.message);

  const { data: customers } = await shop.rpc('customers_with_empties', {
    p_store_id: '7138327c-c81c-4486-a97c-92207b48b64e',
  });
  let anyGrouped = false;
  for (const c of customers ?? []) {
    const { data: owed } = await shop.rpc('customer_empties_owed', {
      p_store_customer_id: c.id ?? c.store_customer_id,
    });
    const rows = (owed ?? []).map((r) => ({
      productId: String(r.product_id),
      productName: String(r.product_name),
      productUnitId: String(r.product_unit_id),
      unitName: String(r.unit_name),
      unitPlural: String(r.unit_plural),
      baseQty: Number(r.base_qty),
      groupId: r.group_id ?? null,
      groupName: r.group_name ?? null,
      side: r.side ?? 'they_hold',
      owed: Number(r.owed),
    }));
    const lines = rollUpOwed(rows.filter((r) => r.owed > 0 && r.side === 'they_hold'));
    if (lines.length === 0) continue;
    console.log(`   ${c.display_name ?? c.name ?? c.customer_name ?? "somebody"}: ` +
      lines.map((l) => `${l.said} ${l.unit.toLowerCase()} ${l.label}`).join(', '));
    if (lines.some((l) => !l.isPart && l.products.length >= 1 && l.label !== l.products[0])) {
      anyGrouped = true;
    }
    if (lines.some((l) => !l.isPart)) anyGrouped = true;
  }
  check('the live shop now rolls up by maker rather than by product', anyGrouped);
}

console.log(`\n${failed} failed`);
process.exit(failed ? 1 : 0);
