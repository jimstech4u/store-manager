/**
 * THE MAKERS, PUT BACK.
 *
 *     node scripts/restore-maker-groups.mjs --dry
 *     node scripts/restore-maker-groups.mjs
 *
 * Idempotent: `create_product_group` returns an existing group by that name rather than refusing,
 * and `set_product_groups` replaces a product's groups with the set it is given.
 *
 * ── WHY THIS MATTERS MORE THAN IT LOOKS ─────────────────────────────────────────
 *
 * The shop reported the empties screen offering "Amstel Malta Bottle — ½ crates owed" one product
 * at a time, when what a customer actually owes is "5 NBL crates, and half a Gulder".
 *
 * Everything needed for that was already built and correct. `empties-rollup.ts` states the rule in
 * the shop's own words — "three and a half crates of Goldberg and two and a half of Gulder is FIVE
 * NBL crates, half a Goldberg and half a Gulder" — because whole crates are interchangeable within
 * a maker and part-loads are not. `groups_with_returnables`, `group_return_units` and
 * `record_customer_empties_for_group` are all there.
 *
 * And every one of them was reading from nothing: the opening import created no groups at all, and
 * not one of 104 products belonged to one. The roll-up had nothing to roll up by, so it fell back
 * to naming products. This is the missing half.
 *
 * ── WHAT IS GROUPED, AND WHAT IS DELIBERATELY NOT ───────────────────────────────
 *
 * A maker per group, because that is what a crate goes back to and what the yard is counted in. A
 * Goldberg crate settles a Gulder crate; it does not settle a Trophy crate, which goes back to
 * International Breweries.
 *
 * ONLY WHERE THE MAKER IS ACTUALLY KNOWN. A product whose maker I am not sure of is left out and
 * listed at the end rather than guessed into a pool — a wrong pool does not fail, it quietly makes
 * one shop's crates settle another's, and the error only ever surfaces as a yard that will not
 * reconcile months later.
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

/**
 * Maker → the products it makes, by the shop's own name for them.
 *
 * Written out in full rather than matched on a prefix. "Origin Bitters" and "Origin" are one
 * maker and two products; "Eagle" and "Eaglejie" are two makers and look like one prefix. A rule
 * clever enough to split those is a rule nobody can check against a shelf.
 */
const MAKERS = {
  'Nigerian Breweries': [
    '33 Bottle (600mL)',
    'Amstel Malta Bottle (330mL)',
    'Amstel Malta Can (330mL)',
    'Desperado Bottle (450mL)',
    'Fayrouz Bottle (330mL)',
    'Fayrouz Can (330mL)',
    'Goldberg Bottle (600mL)',
    'Goldberg Can (500mL)',
    'Guilder Bottle (600mL)',
    'Heineken Big Bottle (600mL)',
    'Heineken Original Can (33cl)',
    'Heineken Small Bottle (450mL)',
    'Legend Extra Stout Bottle (60cl)',
    'Maltina Classic Big PET (50cl)',
    'Maltina Classic Bottle (33cl)',
    'Maltina Classic Can (33cl)',
    'Maltina Classic Small PET (35cl)',
    'Star Radler Bottle (45cl)',
    'Turbo King Bottle (60cl)',
  ],
  'Guinness Nigeria': [
    'Guinness Big Bottle (600mL)',
    'Guinness Can (440mL)',
    'Guinness Medium Bottle (450mL)',
    'Guinness Small Bottle (325mL)',
    'Malta Guinness Can (330mL)',
    'Origin Bitters Bottle (750mL)',
    'Origin Bitters PET (20cl)',
    'Origin Bottle (60cl)',
    'Smirnoff Ice Big Bottle (600mL)',
    'Smirnoff Ice Can (440mL)',
    'Smirnoff Ice Small Bottle (300mL)',
  ],
  'International Breweries': [
    'Budweiser Bottle (600mL)',
    'Castle Lite Bottle (600mL)',
    'Flying Fish Bottle (420mL)',
    'Hero Bottle (600mL)',
    'Trophy Bottle (600mL)',
    'Trophy Can (500mL)',
    'Trophy Stout (600mL)',
  ],
  'Coca-Cola (NBC)': [
    '5-Alive Pulpy Orange Big PET (85cl)',
    '5-Alive Pulpy Orange Small PET (30cl)',
    'Coca-Cola Big Bottle (50cl)',
    'Coca-Cola Big PET (60cl)',
    'Coca-Cola Small Bottle Black (35cl)',
    'Coca-Cola Small Bottle Red (35cl)',
    'Coca-Cola Small PET (50cl)',
    'Eva Big Water (150cl)',
    'Eva Small Water (75cl)',
    'Fanta Big PET (60cl)',
    'Fanta Small PET (50cl)',
    'Predator Energy PET (400mL)',
    'Schweppes Can (25cl)',
    'Schweppes PET (40cl)',
    'Sprite PET (50cl)',
  ],
  'Seven-Up (SBC)': [
    '7up Bottle (35cl)',
    '7up PET (60cl)',
    'Aquafina Water (75cl)',
    'Pepsi Bottle (50cl)',
    'Pepsi PET (60cl)',
    'Teem PET (50cl)',
  ],
  'Rite Foods': [
    'Bigi Apple PET (350mL)',
    'Bigi Bitter Lemon PET (600mL)',
    'Bigi Cola PET (350mL)',
    'Bigi Tropical PET (350mL)',
    'Bigi Water (750mL)',
    'Fearless Energy Drink Can (500mL)',
    'Fearless Energy Drink PET (500mL)',
    'Sosa Big PET (1L)',
    'Sosa Small PET (35cl)',
  ],
  'Chi Limited': [
    'Chivita Active (1L)',
    'Chivita Active Zest Can (330mL)',
    'Chivita Exotic (1L)',
    'Hollandia Yoghurt (1L)',
  ],
  'Intercontinental Distillers': [
    'Action Bitters Bottle (325mL)',
    'Action Bitters PET (200mL)',
    'Action Bitters Sachet (50mL)',
    'Chelsea London Dry Gin Sachet (30mL)',
    'Eagle Aromatic Schnapps Bottle (750mL)',
    'Eagle Original Aromatic Schnapps Majesty Sachet (30mL)',
  ],
  'La Casera': ['La Casera PET (35cl)'],
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

console.log(`\n${DRY ? 'PLAN' : 'RESTORING'} — the makers\n`);

const products = await sql(`
  select p.id, p.name, bool_or(pu.is_returnable) comes_back
    from public.products p
    join public.product_units pu on pu.product_id = p.id
   where p.store_id = '${SID}' and p.status = 'active'
   group by p.id, p.name order by p.name`);

const idByName = new Map(products.map((p) => [p.name, p.id]));
const claimed = new Set();
const missing = [];

for (const [maker, names] of Object.entries(MAKERS)) {
  for (const n of names) {
    if (!idByName.has(n)) missing.push(`${maker}: ${n}`);
    else claimed.add(n);
  }
}

console.log(`${Object.keys(MAKERS).length} makers over ${claimed.size} products`);
for (const [maker, names] of Object.entries(MAKERS)) {
  const here = names.filter((n) => idByName.has(n));
  const back = here.filter((n) => products.find((p) => p.name === n)?.comes_back).length;
  console.log(`   ${maker.padEnd(30)} ${String(here.length).padStart(2)} products, ${back} that come back`);
}

if (missing.length) {
  console.log(`\n   NAMED HERE BUT NOT IN THE SHOP (a rename, or my typo):`);
  for (const m of missing) console.log(`     ${m}`);
}

if (!DRY) {
  let done = 0;
  const failures = [];
  for (const [maker, names] of Object.entries(MAKERS)) {
    const { data: groupId, error } = await shop.rpc('create_product_group', {
      p_store_id: SID,
      p_name: maker,
    });
    if (error) {
      failures.push(`${maker}: ${error.message.slice(0, 80)}`);
      continue;
    }
    for (const n of names) {
      const id = idByName.get(n);
      if (!id) continue;
      const { error: linkErr } = await shop.rpc('set_product_groups', {
        p_product_id: id,
        p_group_ids: [groupId],
      });
      if (linkErr) failures.push(`${n}: ${linkErr.message.slice(0, 80)}`);
      else done += 1;
    }
  }
  console.log(`\n   ${done} products attached, ${failures.length} failed`);
  for (const f of failures) console.log('    FAIL', f);
}

// ── What is left without a maker ───────────────────────────────────────────
const orphans = products.filter((p) => !claimed.has(p.name));
console.log(`\n── no maker set: ${orphans.length} ──`);
for (const p of orphans) {
  console.log(`   ${p.name.padEnd(46)} ${p.comes_back ? 'COMES BACK — needs one' : ''}`);
}

console.log(
  DRY
    ? '\nNothing was written. Drop --dry to restore.'
    : '\ndone — the empties roll-up now has makers to roll up by',
);
