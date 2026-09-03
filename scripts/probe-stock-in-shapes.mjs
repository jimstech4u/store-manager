/**
 * Stock said the way a shop counts it.
 *
 * «we can say we have 100 crates in stock… stock now becomes 99 crates 8 bottles left»
 * «some stores do not sell pieces or bottles or can, only crate, pack… some retailers only
 *  pieces… or some stores in kg, or dirica, or paint»
 *
 * The old sentence was a division: 1,196 bottles over twelve reads "99.67 crates". No shop says
 * that, and nobody can check it against a shelf — the eight loose bottles, which are the entire
 * reason the figure is not round, vanish into a decimal.
 *
 * The decomposition is pure arithmetic over the shape tree, so it is tested as arithmetic — every
 * kind of shop the shape model has to serve, not just the one this sample happens to be.
 *
 *     node scripts/probe-stock-in-shapes.mjs
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/*
 * Compiled and imported, the way `probe-quantity-rules` does it.
 *
 * A first version imported the .ts straight from `stacks/selling-units.ts` — which pulls in React
 * and state-stack and cannot load under bare Node. The decomposition now lives in its own pure
 * file for exactly this reason: arithmetic a shop will argue with has to be runnable on its own.
 */
const out = mkdtempSync(join(tmpdir(), 'shape-qty-'));
execFileSync(
  process.execPath,
  ['node_modules/typescript/bin/tsc', 'src/lib/shape-quantities.ts', '--outDir', out,
   '--target', 'es2020', '--module', 'es2020', '--types', '--skipLibCheck'],
  { stdio: 'inherit' },
);
const { stockInShapes } = await import(
  pathToFileURL(join(out, 'shape-quantities.js')).href
);

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
const check = (what, got, want) => {
  const ok = got === want;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what} — "${got}"${ok ? '' : ` (wanted "${want}")`}`);
  if (!ok) failed += 1;
};

/** A shape, as the reader hands it over. */
const shape = (name, plural, baseQty, onHandBase, extra = {}) => ({
  productId: 'p',
  productUnitId: `${name}-${baseQty}`,
  name,
  plural,
  baseQty,
  onHandBase,
  onHand: onHandBase / baseQty,
  isDefault: false,
  isCounted: false,
  isDeposit: false,
  isSold: true,
  isBought: false,
  cost: 0,
  avgCost: 0,
  price: null,
  isReturnable: false,
  wholeDigit: true,
  allowQuarter: false,
  allowHalf: false,
  allowThreeQuarter: false,
  ...extra,
});

console.log('\n— a distributor: crates and bottles —');
const beer = (base) => [shape('Crate', 'Crates', 12, base), shape('Bottle', 'Bottles', 1, base)];
check('the case the shop described', stockInShapes(beer(1196)), '99 crates 8 bottles');
check('a round hundred', stockInShapes(beer(1200)), '100 crates');
check('under one crate', stockInShapes(beer(7)), '7 bottles');
check('exactly one', stockInShapes(beer(12)), '1 crate');
check('nothing at all', stockInShapes(beer(0)), '0 bottles');

console.log('\n— a wholesaler that sells ONLY packs —');
/*
 * Malta Guinness, 24 cans to a pack, sold by the pack alone. The can is still a shape the shop has
 * a role for — it is what a pack is defined in — so the remainder has a word. Before 0084 the
 * reader returned only SOLD shapes and this said "10 packs 0.42 packs", which is not a quantity.
 */
const malta = (base) => [
  shape('Pack', 'Packs', 24, base, { isSold: true, isCounted: true }),
  shape('Can', 'Cans', 1, base, { isSold: false, isBought: true }),
];
check('ten packs and ten loose cans', stockInShapes(malta(250)), '10 packs 10 cans');
check('whole packs only', stockInShapes(malta(240)), '10 packs');

console.log('\n— a retailer that sells only single bottles —');
const kiosk = (base) => [shape('Bottle', 'Bottles', 1, base)];
check('one shape, one figure', stockInShapes(kiosk(43)), '43 bottles');
check('and one of them', stockInShapes(kiosk(1)), '1 bottle');

console.log('\n— sold by weight, and by the local measures —');
const rice = (base) => [
  shape('Bag', 'Bags', 50, base),
  shape('Paint', 'Paints', 2, base),
  shape('Kilogram', 'Kilograms', 1, base),
];
check('a bag, a paint tin and a kilo', stockInShapes(rice(103)), '2 bags 1 paint 1 kilogram');

const garri = (base) => [shape('Dirica', 'Diricas', 4, base), shape('Kilogram', 'Kilograms', 1, base)];
check('diricas and kilos', stockInShapes(garri(19)), '4 diricas 3 kilograms');

console.log('\n— a part of the smallest shape the shop names —');
/*
 * Oil in litres, sold by the drum. Half a litre is real, and the shop has no smaller word for it,
 * so it is said as a fraction of the one it does have rather than dropped.
 */
const oil = (base) => [shape('Drum', 'Drums', 25, base), shape('Litre', 'Litres', 1, base)];
check('a fraction of a litre survives', stockInShapes(oil(50.5)), '2 drums 0.5 litres');

console.log('\n— stock below zero, which is a real state —');
/*
 * An offline sale, or a count still to be resolved. Said as one signed figure in the leading shape,
 * NOT decomposed — "minus 1 crate 4 bottles" reads like a quantity somebody could go and find.
 */
const short = [
  shape('Crate', 'Crates', 12, -16, { isCounted: true }),
  shape('Bottle', 'Bottles', 1, -16),
];
check('said plainly, not decomposed', stockInShapes(short), '-1.33 crates');

console.log('\n— and against the live shop —');
const shop = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
await shop.auth.signInWithPassword({ email: env.SAMPLE_EMAIL, password: env.SAMPLE_PASSWORD });
const storeId = (await shop.rpc('my_membership')).data[0].store_id;
const { data: rows, error } = await shop.rpc('product_selling_units', { p_store_id: storeId });
console.log(`  ${error ? 'FAIL' : 'PASS'}  the reader answers${error ? ` — ${error.message}` : ''}`);
if (error) failed += 1;

const byProduct = new Map();
for (const r of rows ?? []) {
  const u = {
    ...shape(r.unit_name, r.unit_plural, Number(r.base_qty), Number(r.on_hand_base)),
    isCounted: r.is_counted,
    isSold: r.is_sold,
  };
  const list = byProduct.get(r.product_id);
  if (list) list.push(u);
  else byProduct.set(r.product_id, [u]);
}

/*
 * A whole number of a shape must never come back as a decimal of a bigger one.
 *
 * NOT applied to stock below zero: that is said as one signed figure by design (the `-1.33 crates`
 * case above), because decomposing it would read as a quantity somebody could go and find. The
 * first version of this check matched `-0.08 packs` and reported the deliberate behaviour as the
 * defect — a probe is only worth its run if it fails for the reason it names.
 */
const decimals = [];
for (const [, units] of byProduct) {
  const said = stockInShapes(units);
  if (said.startsWith('-')) continue;
  if (/\d+\.\d+ (crates?|packs?|cartons?|bags?)/.test(said)) decimals.push(said);
}
console.log(
  `  ${decimals.length === 0 ? 'PASS' : 'FAIL'}  no product in stock reads as a fraction of a big shape — ${decimals.length} did`,
);
if (decimals.length > 0) {
  failed += 1;
  for (const d of decimals.slice(0, 5)) console.log(`      ${d}`);
}

/*
 * And the sentence must be checkable: every part is a whole number of a named shape, except at most
 * one trailing fraction of the SMALLEST shape. That is the whole claim the screen makes.
 */
let unreadable = 0;
for (const [, units] of byProduct) {
  const said = stockInShapes(units);
  if (!said || said.startsWith('-')) continue;
  const parts = said.split(/\s(?=[\d.-])/);
  parts.forEach((part, i) => {
    const n = Number(part.split(' ')[0]);
    if (!Number.isInteger(n) && i !== parts.length - 1) unreadable += 1;
  });
}
console.log(
  `  ${unreadable === 0 ? 'PASS' : 'FAIL'}  only the last part may be a fraction — ${unreadable} broke that`,
);
if (unreadable > 0) failed += 1;

console.log('\n  a few, as the stock screen now says them:');
for (const units of [...byProduct.values()].slice(0, 8)) {
  const lead = units.find((u) => u.isCounted) ?? units[0];
  console.log(`      ${lead.plural.padEnd(10)} → ${stockInShapes(units)}`);
}

console.log(failed === 0 ? '\nall passed' : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
