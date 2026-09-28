/**
 * A PIECE DOES NOT COME BACK, A PACK DOES NOT COME IN HALVES, AND THE SACHET BOXES SAY WHAT THEY
 * HOLD.
 *
 *     node scripts/repair-pieces-packs-and-conversions.mjs --dry
 *     node scripts/repair-pieces-packs-and-conversions.mjs
 *
 * Idempotent: reads the live state and writes only the difference.
 *
 * ── 1. A PIECE DOES NOT COME BACK EMPTY ─────────────────────────────────────────
 *
 * When pieces and bottles stopped being sold, both were marked as coming back. That is right for a
 * bottle — the glass returns in the crate it left in — and wrong for a piece: a piece is a sachet,
 * a PET or a can, and none of them are collected. Marking them returnable puts sachets into the
 * empties screens and the yard, which is a list of obligations that do not exist.
 *
 * Bottles keep it. Only the piece is undone, back to what it was before.
 *
 * ── 2. A PACK IS NOT SOLD IN HALVES ─────────────────────────────────────────────
 *
 * `allow_half` was set on every shape in the shop by the opening import, crates and packs alike,
 * because the sheet had half crates on it. A half crate is real and stays. Half a pack is not
 * something this shop sells, and an offered half is how a pack goes out for half its price.
 *
 * Crates and cans are untouched: the shop sells half and quarter crates, and said the half exists
 * in the can.
 *
 * ── 3. WHAT THE BOXES SAY ───────────────────────────────────────────────────────
 *
 * Read off the packaging rather than guessed, and only where the photograph shows it:
 *
 *     Chelsea London Dry Gin (30mL)   carton = 14 packs        "30ml x 24 x 14 Packs"
 *     Eagle Aromatic Schnapps (750mL) carton = 12 bottles      "750ML X 12 BOTTLES"
 *     Best London Dry Gin (30mL)      pack   = 25 sachets      "25 SACHETS"
 *
 * Eagle Majesty sachet was already right — carton 14 packs of 24 — and is left alone.
 *
 * ONLY THE RELATIONSHIP IS WRITTEN, never `base_qty`. `tg_product_unit_base_qty` derives it as
 * `defined_qty * base_qty(parent)`, so saying "a carton is 14 packs" is what makes a carton 336
 * sachets. Writing both by hand is how the two drift apart, and the stored figure is the one every
 * report divides by.
 *
 * The array is ordered CHILD FIRST. `save_product_units` resolves relationships in array order and
 * the trigger multiplies by the parent's stored `base_qty`, so a carton read before its pack was
 * settled would be computed against a stale figure. `sort_order` is passed separately and keeps
 * the shop's own display order.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const DRY = process.argv.includes('--dry');

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
    }),
);

const SID = '7138327c-c81c-4486-a97c-92207b48b64e';
const PROJECT = 'zinhzpgprhhqmyxmchhm';

/** What the boxes say: product → the shape, what it is measured in, and how many. */
const FROM_THE_BOX = {
  'Chelsea London Dry Gin Sachet (30mL)': { shape: 'Carton', per: 'Pack', qty: 14 },
  'Eagle Aromatic Schnapps Bottle (750mL)': { shape: 'Carton', per: 'Bottle', qty: 12 },
  'Best London Dry Gin Sachet (30mL)': { shape: 'Pack', per: 'Piece', qty: 25 },
};

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).slice(0, 400)}`);
  return res.json();
}

const shop = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
const { error: authErr } = await shop.auth.signInWithPassword({
  email: env.SAMPLE_EMAIL,
  password: env.SAMPLE_PASSWORD,
});
if (authErr) throw new Error('could not sign in: ' + authErr.message);

console.log(`\n${DRY ? 'PLAN' : 'CORRECTING'} — ASHABI GLOBAL RESOURCES\n`);

const products = await sql(`
  select p.id, p.name,
         json_agg(json_build_object(
           'id', pu.id, 'store_unit_id', pu.store_unit_id, 'word', su.name,
           'base_qty', pu.base_qty, 'is_sold', pu.is_sold, 'is_bought', pu.is_bought,
           'is_counted', pu.is_counted, 'is_deposit', pu.is_deposit,
           'is_returnable', pu.is_returnable, 'whole_digit', pu.whole_digit,
           'allow_quarter', pu.allow_quarter, 'allow_half', pu.allow_half,
           'allow_three_quarter', pu.allow_three_quarter,
           'defined_against_id', pu.defined_against_id, 'defined_qty', pu.defined_qty,
           'sell_price', pu.sell_price, 'sort_order', pu.sort_order,
           'used', (select count(*) from public.sale_lines l where l.sale_unit_id = pu.id)
         ) order by pu.base_qty) shapes
    from public.products p
    join public.product_units pu on pu.product_id = p.id
    join public.store_units su on su.id = pu.store_unit_id
   where p.store_id = '${SID}' and p.status = 'active'
   group by p.id, p.name order by p.name`);

const planned = [];
const notes = [];

for (const p of products) {
  const shapes = p.shapes; // already smallest-first: child before parent
  const storeUnitOf = new Map(shapes.map((s) => [s.id, s.store_unit_id]));
  const byWord = new Map(shapes.map((s) => [s.word, s]));
  const box = FROM_THE_BOX[p.name];

  const wanted = shapes.map((s) => {
    let against = s.defined_against_id ? storeUnitOf.get(s.defined_against_id) : null;
    let qty = s.defined_qty === null ? null : Number(s.defined_qty);

    // ── What the box says ────────────────────────────────────────────────
    if (box && s.word === box.shape) {
      const parent = byWord.get(box.per);
      if (!parent) {
        notes.push(`${p.name}: no ${box.per} shape to measure the ${box.shape} against`);
      } else if (Number(s.used) > 0) {
        // `tg_shape_definition_is_history` would refuse it, and rightly — a recorded quantity
        // would change meaning. Said here rather than left as a silent failure.
        notes.push(`${p.name}: the ${box.shape} has been sold, so its size is now history`);
      } else {
        against = parent.store_unit_id;
        qty = box.qty;
      }
    }

    return {
      id: s.id,
      store_unit_id: s.store_unit_id,
      word: s.word,
      is_sold: s.is_sold,
      is_bought: s.is_bought,
      is_counted: s.is_counted,
      is_deposit: s.is_deposit,
      // A piece is a sachet, a PET or a can. None of them come back.
      is_returnable: s.word === 'Piece' ? false : s.is_returnable,
      sell_price: s.sell_price === null ? null : Number(s.sell_price),
      whole_digit: s.whole_digit,
      allow_quarter: s.allow_quarter,
      // A pack goes out whole. A crate and a can keep their half.
      allow_half: s.word === 'Pack' ? false : s.allow_half,
      allow_three_quarter: s.allow_three_quarter,
      defined_against: against ?? null,
      defined_qty: against ? qty : null,
      base_qty: Number(s.base_qty),
      sort_order: s.sort_order ?? 0,
    };
  });

  const changed = wanted.filter((w, i) => {
    const s = shapes[i];
    const wasAgainst = s.defined_against_id ? storeUnitOf.get(s.defined_against_id) : null;
    return (
      w.is_returnable !== s.is_returnable ||
      w.allow_half !== s.allow_half ||
      (w.defined_against ?? null) !== (wasAgainst ?? null) ||
      Number(w.defined_qty ?? 0) !== Number(s.defined_qty ?? 0)
    );
  });
  if (changed.length) planned.push({ ...p, wanted, changed, box: Boolean(box) });
}

const pieces = planned.reduce(
  (n, p) => n + p.changed.filter((c) => c.word === 'Piece' && !c.is_returnable).length, 0);
const packs = planned.reduce(
  (n, p) => n + p.changed.filter((c) => c.word === 'Pack' && !c.allow_half).length, 0);

console.log(`1. pieces that stop coming back empty: ${pieces}`);
console.log(`2. packs that stop being sold in halves: ${packs}`);
console.log(`3. conversions read off the boxes:`);
for (const p of planned.filter((x) => x.box)) {
  const c = p.changed.find((x) => x.defined_against);
  if (!c) continue;
  const parent = p.wanted.find((w) => w.store_unit_id === c.defined_against);
  console.log(`    ${p.name}`);
  console.log(`       one ${c.word.toLowerCase()} = ${c.defined_qty} ` +
    `${parent.word.toLowerCase()}${c.defined_qty === 1 ? '' : 's'}` +
    `  (${c.defined_qty * Number(parent.base_qty)} in all)`);
}
console.log(`\n   ${planned.length} products to write`);

if (!DRY) {
  let done = 0;
  const failures = [];
  for (const p of planned) {
    const { error } = await shop.rpc('save_product_units', {
      p_product_id: p.id,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      p_units: p.wanted.map(({ word, ...rest }) => rest),
    });
    if (error) failures.push(`${p.name}: ${error.message.slice(0, 100)}`);
    else done += 1;
  }
  console.log(`\n   ${done} written, ${failures.length} failed`);
  for (const f of failures) console.log('    FAIL', f);
}

// ── What is still not known ────────────────────────────────────────────────
for (const n of notes) console.log(`\n   NOTE ${n}`);

/*
 * WHAT NOBODY HAS SAID THE SIZE OF YET.
 *
 * A product whose BIGGEST shape is still worth one base unit. Whatever shapes it has, none of them
 * holds more than one of anything — so the shop can only ever sell it singly, and a "carton" on the
 * screen would go out for the price of one sachet.
 *
 * A bottle sitting at 1 is not a gap: the bottle IS the base unit, and its crate says 12.
 */
console.log('\n── nothing here holds more than one: the shop has to say the size ──');
for (const r of await sql(`
  select p.name, string_agg(su.name || ' = ' || pu.base_qty, ', ' order by pu.base_qty) shapes
    from public.products p
    join public.product_units pu on pu.product_id = p.id
    join public.store_units su on su.id = pu.store_unit_id
   where p.store_id = '${SID}' and p.status = 'active'
   group by p.id, p.name
  having max(pu.base_qty) = 1
   order by p.name`)) {
  console.log(`   ${r.name.padEnd(46)} ${r.shapes}`);
}

console.log(DRY ? '\nNothing was written. Drop --dry to correct.' : '\ndone');
